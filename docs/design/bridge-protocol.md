---
title: Bridge 协议
status: active
updated: 2026-10-13
summary: 小工具页与原生/Rust 之间的消息格式（v2）、会话与取消、方法命名、错误码、大数据与安全约定
---
## TL;DR
- 一问一答的异步 JSON 消息，靠 `id` 配对；原生主动推送用事件。
- 方法名 `域.模块.动作`，域只有 `native`（原生能力）和 `rust`（核心库）。
- 大数据（图片、音频）不进 JSON，只传文件路径，实际文件放 App 缓存目录。
- v2：通道为 `WebMessageListener`（只放行 `https://appassets.androidplatform.net`），处理器是挂起函数，有会话号、取消、订阅号、握手与生命周期事件。
- 协议与传输通道解耦：原生核心 `ArkliBridge` 不依赖 android.webkit，回传经 `ReplyIo` 抽象。

## 请求

```json
{ "v": 2, "id": "7f3a", "method": "rust.ocr.recognize", "params": { "path": "cache/in-001.png" } }
```

| 字段 | 说明 |
|---|---|
| `v` | 协议版本，目前为 2；不兼容变更时递增。原生不校验请求里的 v，响应一律带 2 |
| `id` | 请求编号，由页面生成，响应原样带回 |
| `method` | `域.模块.动作`，如 `native.clipboard.write` |
| `params` | 对象，由具体方法定义 |

## 响应

成功：

```json
{ "v": 2, "id": "7f3a", "ok": true, "data": { "text": "..." } }
```

失败：

```json
{ "v": 2, "id": "7f3a", "ok": false, "error": { "code": "PERMISSION_DENIED", "message": "需要相机权限" } }
```

## 事件（原生 → 页面）

```json
{ "v": 2, "event": "download.progress", "sub": "s1", "data": { "name": "ocr-model", "percent": 42 } }
```

页面通过统一的 `on(event, handler)` 订阅，离开页面时取消订阅。`sub` 是订阅类方法返回的订阅号，没有订阅的事件不带该字段。

生命周期事件：`app.pause`（退后台）、`app.resume`（回前台），data 为 null。

## 会话、取消与长任务
- **会话号**：每建一个 WebView、主文档重新加载、渲染进程崩溃重建，会话号递增（进程内单调）。旧会话的在途请求被取消，迟到的响应与事件丢弃，不会串到新页面。`native.hello` 返回当前会话号。
- **取消**：`native.task.cancel { id }`，id 为请求 id 或任务号；返回 `{ cancelled: boolean }`，被取消的原请求以 `CANCELLED` 响应（即使处理器还没开始运行也会补发，每个请求恰好一个响应）。页面侧 `call(..., { signal })` 即走此路径。
- **长任务**：处理器可调 `ctx.launchTask` 启动随会话存活的后台任务，先回 `{ taskId }`，再推事件；任务里抛出的异常转成 `task.error { taskId, error }` 事件。长任务页面侧用 `timeoutMs: 0` 取消超时。
- 同一会话内在途请求 id 不可重复，重复返回 `BAD_PARAMS`。

## 错误码

| code | 含义 |
|---|---|
| `UNKNOWN_METHOD` | 方法不存在 |
| `BAD_PARAMS` | 参数缺失或类型不对 |
| `PERMISSION_DENIED` | 用户拒绝了所需权限 |
| `NOT_READY` | 依赖未就绪，如模型还没下载 |
| `INTERNAL` | 原生或 Rust 内部错误，message 里给简述 |
| `TIMEOUT` | 超时 |
| `CANCELLED` | 调用已被取消（`native.task.cancel` 或会话关闭前的取消） |
| `NETWORK` | 网络错误 |
| `FORMAT_MISMATCH` | 输出格式与要覆盖的原图格式不一致（仅 `native.file.overwrite`）。前端 `BridgeErrorCode` 联合类型需要补上这个值 |

## 通道细节
- 页面发：`window.ArkliNative.postMessage(string)`，只能发字符串；收：`ArkliNative.onmessage = e => ...`，`e.data` 为 JSON 字符串。
- 原生必须在页面加载前 `addWebMessageListener`，晚注册的页面里对象不出现。
- 不支持 ArrayBuffer 的 WebView（`binary=false`，如本机华为 Chromium 114）会安装 `addDocumentStartJavaScript` 守卫，页面发非字符串直接抛 TypeError，避免 App 进程崩溃。
- 监听回调带 `isMainFrame`，原生传入 `CallContext.isMainFrame`，敏感方法应只接受主 frame。

## 大数据

- 页面把文件交给原生保存，或原生把结果写到缓存目录，双方只传相对路径。
- 页面读取原生产出的文件，走 `https://appassets.androidplatform.net/files/` 前缀暴露的只读路径，不用 `file://`：
  - `/files/cache/**` 对应 `cacheDir/arkli/`，`/files/packs/**` 对应 `filesDir/packs/`（数据包，只读）。页面里的相对路径就是去掉 `/files/` 的部分，如 `cache/out/w1/a.bin`。
  - 响应器是 `FilesPathServer`，在 `shouldInterceptRequest` 里先于 WebViewAssetLoader 接管该前缀（PathHandler 拿不到请求头，没法支持 Range，所以不走它）。支持 GET/HEAD、`Accept-Ranges: bytes`、单段 Range（`a-b`、`a-`、`-N`），视频可拖进度条。越界 Range 在 WebView 里表现为 fetch 失败（Chromium 自己拒绝），不会拿到 416 页面。
  - **Chromium 会对拦截到的流按 Range 起点再 skip 一次**（真机 Chromium 114 实测：`a-b`、`a-` 如此，后缀 `-N` 不跳）。原生按 206 响应并在流头垫 `a` 个虚拟字节，吃掉这次 skip；某个 WebView 不 skip 时，首次 read 虚拟前缀自动作废，结果仍然正确。
  - 路径规范化后必须落在对应根目录内：含 `..`、`.`、空段、反斜杠、NUL、符号链接逃逸一律 404（不区分不存在与非法，免得探测）。
- 单次 JSON 消息体积建议不超过 256KB，超过就改走文件。

## 安全

- WebView 只加载应用自己的 assets 域，禁用 `file://` 与任意外链。
- 敏感方法（读写文件、剪贴板、权限相关）原生侧再做一次校验，不信任页面传来的路径，路径一律归一化后限制在缓存目录内。
- 方法白名单：原生侧注册表里有才可调用，没有就返回 `UNKNOWN_METHOD`。

## 内置方法

| 方法 | params | 成功时的 data |
|---|---|---|
| `native.ping` | 无 | `{ "pong": true, "ts": 1760000000000 }`，`ts` 为原生侧毫秒时间戳 |
| `native.hello` | 无 | `{ "protocol": 2, "session": 1, "features": { "binary": false }, "methods": ["native.clipboard.read", "…"] }`。`binary` 为原生探测的 ArrayBuffer 支持情况，页面只能据此选帧类型；`methods` 是已注册的全部方法名（升序），页面用它探测某个能力在当前原生版本里是否存在 |
| `native.task.cancel` | `{ id }` | `{ "cancelled": true }` |
| `rust.core.version` | 无 | `{ "version": "0.1.0" }`，取自 Rust 核心库 |
| `native.file.pick` / `save` / `openWrite` / `write` / `closeWrite` | 见下节"文件方法" | |
| `native.image.compress` | 见"图片方法" | |
| `native.image.preview` | 见"图片方法" | |
| `native.clipboard.*` / `share` / `settings.open` / `intent.*` / `haptic.vibrate` / `screen.*` / `device.*` / `permission.*` | 见"系统能力方法" | |
| `native.notify.show` / `native.alarm.*` | 见"提醒方法" | |
| `native.tts.*` | 见"文字转语音方法" | |
| `native.shortcut.pin` | 见"网页转应用" | |
| `native.apps.*` | 见"应用管理方法" | |

## 文件方法

以下方法都只接受主 frame（`CallContext.isMainFrame`），子 frame 调用返回 `PERMISSION_DENIED`。页面里的路径统一为 `cache/...` 相对路径（见"大数据"），原生一律规范化后限制在缓存目录内。

### `native.file.pick`
图片、视频的相册选择一律走自带选择页 `ImagePickerActivity`（图片 / 视频 / 图文混选，单选点一项即换，视频格显示时长；需 `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO`，被拒回退系统选择器）；指定单个 mime 与普通文件仍走系统选择器。

| 项 | 说明 |
|---|---|
| params | `{ mime?: string = "image/*", multiple?: boolean = false, max?: number = 20, keepSource?: boolean = false, camera?: boolean = false }`。`camera` 为 true（仅图片）时单选多选一律走自带选图页，页内右下固定一个拍照圆钮，点它丢弃已选并返回 `camera: true`；权限被拒回退系统选择器时没有该按钮。`keepSource` 为 true 时图片项多返回 `sourceHandle`（见下方 `native.file.overwrite`）。`mime` 取值：`image/*`、`video/*`、`image/*,video/*`、具体媒体类型（如 `image/png`）走 Photo Picker；其他（如 `text/plain`、`*/*`）走系统文档选择器。`max` 上限 50 |
| 返回 | `{ items: Item[], failed: { name, message }[] }` |
| 图片 Item | `{ kind: "image", path, url, name, mime, size, width?, height?, orientation }`。文件原样拷进 `cache/pick/`（保留 EXIF），≤ 128MB，超过进 `failed`。`width/height` 是按 EXIF 方向摆正后的显示尺寸，`orientation` 为 EXIF 方向值 1~8；页面用 `createImageBitmap(..., { imageOrientation: 'from-image' })` 摆正 |
| `sourceHandle` | 仅 `keepSource: true` 的图片 Item 才有：`"uri:<随机 id>"`，不透明句柄，真实 URI 只留在原生侧的会话句柄表里（与视频句柄同一张表），随会话失效；只能交给 `native.file.overwrite` |
| HEIC/HEIF | API 28+ 用平台 `ImageDecoder` 转成 JPEG（质量 92，输出已摆正且不带 EXIF，`orientation` 恒为 1，`name` 扩展名换成 `.jpg`）；超过 2500 万像素按采样率缩小防 OOM。API 24~27 无法转换，该文件进 `failed` 并提示换格式 |
| 视频 Item | `{ kind: "video", handle: "uri:<随机 id>", name, mime, size, width?, height?, durationMs? }`。不拷贝、不读入内存，真实 content URI 只存在原生侧的会话句柄表里，页面拿不到；句柄随会话失效，只能交给原生方法使用 |
| 其他文件 Item | `{ kind: "file", path, url, name, mime, size }`，≤ 64MB 拷进缓存，更大的进 `failed` |
| 点拍照按钮 | 仅 `camera: true` 时可能出现：返回 `{ items: [], failed: [], camera: true }`，调用方应回到拍照；其他情况不带 `camera` 字段 |
| 用户取消 | 用户直接关掉选择器：成功返回 `{ items: [], failed: [] }`，**不是**错误。`CANCELLED` 只用于 `native.task.cancel` 或会话关闭 |
| 错误 | `BAD_PARAMS`（mime 格式不对）、`NOT_READY`（已有选择器在显示）、`PERMISSION_DENIED`（非主 frame） |

说明：华为等没有 Photo Picker 的机型（实测 STG-AL00 / Android 12），androidx.activity 自动回退到系统文档选择器，对页面透明。单个文件失败不影响同批其他文件。调用被取消时已拷进缓存的文件会被删掉。

### `native.file.save`
把缓存里的文件保存到公共目录，按 `items` 顺序保存。

| 项 | 说明 |
|---|---|
| params | `{ items: [{ path: "cache/...", name?: string, mime?: string }] }`，1~100 项。`name` 缺省取文件名，缺扩展名按 mime 补；`mime` 缺省按扩展名猜 |
| 目录 | 图片 `Pictures/Arkli`、视频 `Movies/Arkli`、音频 `Music/Arkli`，其余 `Download/Arkli` |
| 返回 | `{ items: [{ uri, name, size, dir }], failed: [{ path, message }] }`；`name` 是最终显示名（重名时系统会追加 `(1)`）。全部失败时返回 `INTERNAL` |
| API 29+ | MediaStore 插入，`IS_PENDING` 流程，写完置 0，失败回滚删除条目；不需要权限 |
| API 24~28 | 需要 `WRITE_EXTERNAL_STORAGE`（Manifest 已声明 `maxSdkVersion=28`）。没有时在 save 里临时申请，被拒返回 `PERMISSION_DENIED`；`native.permission.*` 落地后改走它。直接写公共目录后用 `MediaScannerConnection` 通知媒体库 |
| 错误 | `BAD_PARAMS`（items 不合法、path 不在缓存内或文件不存在）、`PERMISSION_DENIED`、`INTERNAL` |

### `native.file.openWrite` / `write` / `closeWrite`
页面产出的大文件分块写进缓存。**必须以 `native.hello` 的 `features.binary` 为准选帧类型**：目前只实现字符串帧（`binary=false` 是常态），ArrayBuffer 帧未实现，不要依赖。

流程：`openWrite` 拿 `handle` → 按 seq 从 0 递增、**串行**（等上一块确认再发下一块）调 `write` → `closeWrite`。

| 方法 | params | 返回 |
|---|---|---|
| `native.file.openWrite` | `{ name: string, size?: number, sha256?: string }`。`name` 会被清洗（去路径与非法字符）；声明 `size` / `sha256` 则关闭时校验 | `{ handle, chunkBytes: 1048576, encodings: ["latin1", "base64"] }` |
| `native.file.write` | `{ handle, seq, offset, data, encoding?: "latin1" \| "base64" = "latin1" }` | `{ seq, written }`（`written` 为已写总字节数） |
| `native.file.closeWrite` | `{ handle, size?, sha256?, abort?: boolean }` | `{ path, url, name, size, sha256 }`；`abort: true` 时返回 `{ aborted: boolean }` 并丢弃已写内容 |

约定：
- **帧编码**：`latin1` 每个字符对应一个字节（字符码 ≤ 0xFF，否则 `BAD_PARAMS`），`base64` 为兜底。单块 1 字节~1MB（原始字节数，不是字符串长度）。
- **seq / offset**：`seq` 必须等于下一个期望值，`offset` 必须等于已写字节数；缺口、乱序返回 `BAD_PARAMS`，message 里给出期望值。
- **幂等**：`seq` 小于下一个期望值视为重发，`offset` 与长度和原块一致就直接回确认、不重复写，不一致返回 `BAD_PARAMS`。`closeWrite` 重复调用返回同一结果。
- **校验**：sha256 随写入累计，关闭时不回读文件。`size` / `sha256` 不符则句柄作废、临时文件删除，返回 `BAD_PARAMS`，需要重头来过。
- **产物**：落盘到 `cache/out/<handle>/<name>`，`url` 可直接给 `<img>`、`<video>`、`fetch` 用。
- **上限**：单文件 256MB、同时打开 8 个句柄（超过返回 `NOT_READY`）、句柄空闲 10 分钟视为遗弃。
- **清理**：会话关闭（页面重载、渲染进程崩溃、销毁）、空闲超时、写盘失败，都会删除未关闭句柄的临时文件；进程被杀后残留的由启动清理收走。
- 校验失败、磁盘错误（`INTERNAL`）之后句柄都已作废，要重新 `openWrite`；其余 `BAD_PARAMS`（如 seq 缺口）句柄仍然有效，按提示重发即可。

吞吐参考：真机 STG-AL00 上串行等确认约 3~5MB/s（24MB、latin1），几十 MB 以上建议后续走回环 HTTP 或不透明句柄，见 platform-infrastructure.md。

页面侧示例：

```ts
const { handle, chunkBytes } = await call('native.file.openWrite', { name: 'out.bin', size: blob.size })
for (let seq = 0, off = 0; off < blob.size; seq++) {
  const u8 = new Uint8Array(await blob.slice(off, off + chunkBytes).arrayBuffer())
  await call('native.file.write', { handle, seq, offset: off, data: latin1(u8) })
  off += u8.length
}
const { path, url } = await call('native.file.closeWrite', { handle })
await call('native.file.save', { items: [{ path, name: 'out.bin' }] })
```

### `native.file.overwrite`
把缓存里的成品写回 `native.file.pick`（带 `keepSource: true`）选中的原图。

| 项 | 说明 |
|---|---|
| params | `{ path: "cache/...", handle: "uri:<sourceHandle>" }` |
| 返回 | `{ uri, size }`：`uri` 是实际写入的 MediaStore 地址（仅供日志，页面别拿来读），`size` 是写入字节数 |
| 格式校验 | 先于一切写入与授权框：原图 mime（内容解析器给出）与 `path` 扩展名对应的格式必须一致（jpg/jpeg、png、webp；`image/jpg` 等别名归一）。不一致或任一方认不出返回 `FORMAT_MISMATCH`，message 固定为「格式与原图不同，请把输出格式改成一致」 |
| 授权 | **需要用户确认**：原生弹系统的「要允许 Arkli 修改这 1 张照片吗？」（`MediaStore.createWriteRequest`，API 30+）。用户拒绝返回 `PERMISSION_DENIED`（「没有获得修改原图的授权」）。API 29 及以下返回 `NOT_READY`（「覆盖原图需要 Android 11 及以上」），未实现 |
| 定位原图 | 从选图 URI 认出 MediaStore 图片 id（相册文档 URI `…media.documents/document/image:<id>`、Photo Picker URI 末段 id、`content://media/…/images/media/<id>`），再推导出 `content://media/external/images/media/<id>`。授权后会核对该行与选图 URI 的显示名一致，对不上就中止（`INTERNAL`，「无法确认原图位置，已取消覆盖」）。认不出 id 的来源（如其他 SAF 提供者）退回直接 `openOutputStream(uri,"wt")`，不可写时报 `PERMISSION_DENIED` |
| 安全 | 写前把原图备份到 `cache/tmp/ov_*.part`；写失败、被取消或写后读回大小不符，用备份还原原图再报错；备份在结束时删除。写完 `notifyChange` 并按 `_data` 路径触发一次媒体扫描 |
| 错误 | `BAD_PARAMS`（`path` 非缓存路径或文件不存在、`handle` 无效/过期）、`FORMAT_MISMATCH`、`PERMISSION_DENIED`（非主 frame、用户拒绝、来源不可写）、`NOT_READY`（Android 10 及以下、已有授权框在显示）、`INTERNAL` |

**真机验证（2026-10-14，STG-AL00，Android 12 / API 31，EMUI 14.2，无系统 Photo Picker，`PickVisualMedia` 自动回退到 DocumentsUI 的 `ACTION_OPEN_DOCUMENT`）**：
1. 选图器给出的 URI 是 `content://com.android.providers.media.documents/document/image%3A47`。`checkUriPermission` 显示读写都已授权，但 `COLUMN_FLAGS=16389`（不含 `FLAG_SUPPORTS_WRITE`），`openOutputStream(uri, "wt" | "w" | "rwt")` 三种模式全部抛 `IllegalArgumentException: Media is read-only`。给 OPEN_DOCUMENT 加 `FLAG_GRANT_WRITE_URI_PERMISSION` 结果相同。**结论：选图器 URI 不能直接写。**
2. 把该 URI 推导成 `content://media/external/images/media/47`：未授权时读写都报 `SecurityException`；调 `MediaStore.createWriteRequest` 弹出系统确认框，点「允许」后 `openOutputStream(…, "wt")` 写入成功，点「拒绝」得到 `PERMISSION_DENIED`。
3. 端到端（`native.file.pick {keepSource:true}` → `native.image.stitch` 出 JPEG → `native.file.overwrite`）：原图 4430 字节 600×400，覆盖后 MediaStore 行 `_size=10775 width=256 height=512 mime_type=image/jpeg`，磁盘文件与成品 md5 一致（`97cdcea0…`）；`tmp/` 下无备份残留。PNG 覆盖 JPG 原图直接返回 `FORMAT_MISMATCH`，不弹框。
4. **没验证**：API 33+ 真 Photo Picker 的 URI（`content://media/picker/<user>/<authority>/media/<id>`，代码按末段 id 取，若该 id 不是 MediaStore id 会被显示名核对拦下，不会误写）；自带多选图片页返回的 `content://media/external/images/media/<id>`（走同一条路径，未实测）；API 29 的 `RecoverableSecurityException` 路径（没做）；写入中途失败的备份还原分支（只有代码，没造出失败场景）。
探针代码：`app/src/debug/kotlin/com/let188/arkli/debug/OverwriteProbeActivity.kt`（仅 debug 源集，`am start -n com.let188.arkli/.debug.OverwriteProbeActivity --es mode pickvm|opendoc|opendocplain [--ez ms true]`，结果看 logcat 标签 `OvProbe`）。

### `native.file.discard`
丢弃 `cache/out/` 里不再需要的成品（页面确认保存、放弃或换了新结果时调用）。

| 项 | 说明 |
|---|---|
| params | `{ paths: string[1..200] }`，缓存相对路径 |
| 返回 | `{ deleted: number }`，实际删除的文件数 |
| 范围 | 只允许 `cache/out/` 内的文件。任一路径穿越、不在 `out/` 内（含 `pick/`、`tmp/`、`packs/`）、是目录，则**整体拒绝**（`BAD_PARAMS`），一个都不删；不存在的路径忽略 |
| 缩略图联动 | 删 `stitch_<id>.<ext>` 时连带删 `stitch_thumb_<id>.jpg`（只在传的是拼图成品而不是缩略图时） |
| 错误 | `BAD_PARAMS`、`PERMISSION_DENIED`（非主 frame） |

### `native.cache.stats` / `native.cache.clear`
设置页的「缓存占用」与「清理缓存」。缓存统一在 `cacheDir/arkli/`（`FileRoots.cacheRoot`）一个根下。

| 方法 | params | 返回 |
|---|---|---|
| `native.cache.stats` | 无 | `{ bytes, files, byDir: { pick: { bytes, files }, out: {…}, tmp: {…}, … } }`，`byDir` 按缓存根下第一级目录分组，根目录直属文件归入 `_root`，没有文件的目录不出现 |
| `native.cache.clear` | 无 | `{ freedBytes, deleted, skipped }`，`skipped` 是保留的文件数 |

`clear` 删除缓存根下全部文件并清掉空目录，但**跳过**：① 活跃写句柄的临时文件（`tmp/*.part`，由各会话的 `WriteRegistry` 提供）；② 最近 1 分钟内修改过的文件（可能正在被写入，或页面刚拿到还在用）。没有“正在使用的文件”登记表，所以第②条是近似判断：超过 1 分钟还在被读的成品（如预览中的图）会被删，页面需要重新生成。策略是纯函数 `CacheMaintenance.planClear`，遍历与活跃句柄判断复用 `CacheJanitor`/`WriteRegistry.activeParts`。错误：`PERMISSION_DENIED`（非主 frame）。

**out/ 的自动清理**：`out/` 里只有**拼图遗留**（`stitch_` 前缀，含 `stitch_thumb_`、`.part`）会被主动清：App 进程启动时（`FileEnv.cleanup(startup=true)`，进程重启后没有会话，这些都是孤儿）与 `MainActivity.onDestroy`（非配置变更）时尽力清。压缩、视频、TTS、壁纸等其他工具的产物（也在 `out/`，可能被页面在窗口期内继续使用）一概不碰，仍走 24 小时 / 总量上限策略。

## 图片方法

只接受主 frame，子 frame 调用返回 `PERMISSION_DENIED`。图片的解码、缩放、编码全在原生（Kotlin）完成，不经过 Rust、不进 WebView 的 Canvas，所以不受页面 `MAX_CANVAS_PIXELS` 约束，也不会在页面里堆大位图。

### `native.image.compress`
批量压缩，同时承担格式转换：输出格式是参数。典型流程：`native.file.pick` 选图 → 本方法 → 页面用 `/files/<path>` 回显 → `native.file.save` 保存。

| 项 | 说明 |
|---|---|
| params | `{ items: [{ path: string, name?: string }], format: "jpeg" \| "webp" \| "png", quality?: 1..100 = 80, maxEdge?: 64..16384, targetBytes?: number, png?: { mode: "lossless" \| "palette", colors?: 2..256 = 256, dither?: boolean = false }, keepExif?: boolean = false }` |
| `items` | 1~50 项。`path` 是 pick 返回的缓存路径（`cache/pick/a.jpg`），经路径解析限制在缓存目录内；`name` 决定输出文件的主名（去目录与扩展名、非法字符换成 `_`），缺省取源文件名 |
| `quality` | jpeg/webp 的质量；设了 `targetBytes` 时作为质量上限 |
| `maxEdge` | 最长边上限，等比缩小，**不放大**。缺省不缩。解码阶段按 2 的幂降采样（`inSampleSize`）省内存，再用带滤波的缩放，缩小倍率超过 2 时逐级减半 |
| `targetBytes` | 仅 jpeg/webp 生效（png 下被忽略）。在 `[1, quality]` 里二分找体积不超过目标的最高质量，最多编码 9 次。压不进目标时输出最低质量（1）的结果，该项 `targetReached = false` |
| `png.mode` | `lossless`：无损，颜色数 ≤ 256 时自动转索引色（PLTE + tRNS，位深 1/2/4/8），否则 RGB（全不透明）/RGBA，逐行自适应滤波 + Deflater level 9；`palette`：缩色，中位切分量化到 `colors` 色的索引色 PNG，`dither` 开启 Floyd-Steinberg 抖动 |
| `keepExif` | 仅 jpeg 输出生效。复制常用标签（拍摄时间、机型、曝光参数、GPS），方向标签复位为正常（像素已摆正）。默认不带，顺手去掉 GPS 等隐私信息 |
| 返回 | `{ items: [{ path, name, mime, width, height, bytes, srcBytes, ratio, targetReached? }], failed: [{ index, name?, code, message }] }`。`path` 为 `cache/out/<主名>-<8 位十六进制>.<ext>`，`name` 为不带随机后缀的建议保存名（给 `native.file.save`），`ratio = bytes / srcBytes`，`targetReached` 仅设了 `targetBytes` 时出现 |
| 进度事件 | `image.progress`，data `{ done, total, name }`，每处理完一张（无论成败）推一次，无 `sub` |
| 取消 | 页面取消（`native.task.cancel`）或会话关闭会取消协程，处理在张与张之间、解码/缩放/编码之间检查取消。取消时**本次调用已写出的全部成品和半成品都会删掉**（页面拿不到这批结果，留着只是垃圾），然后返回 `CANCELLED` |
| 错误 | 整体：`BAD_PARAMS`（参数缺失、类型不对、越界，或任一 `items[i].path` 不是有效的缓存路径——会在处理前整体拒绝，不处理一半）、`PERMISSION_DENIED`（非主 frame）、`CANCELLED`。单张失败不影响其余，记入 `failed`：`BAD_PARAMS`（源文件不存在、图片太大）、`INTERNAL`（无法解码、内存不足） |

### `native.image.stitch`
多图拼接，原生合成：成品与缩略图写到 `cache/out/`，页面只拿路径，缩略图回显，点击预览走 `native.image.preview`。布局算法与 `web/src/shared/image-calc.ts` 的 `stitchLayout` 等价（含 JS `Math.round` 的 x.5 进位），Kotlin 单测与 web 用例对拍。

| 项 | 说明 |
|---|---|
| params | `{ items: [{ path }], direction: "v" \| "h", gap?: 0..200 = 0, bg?: "#rrggbb" = "#ffffff", align?: "start" \| "center" \| "end" = "center", unify?: boolean = true, format?: "png" \| "jpeg" = "png", quality?: 0..1 = 0.92 }` |
| `items` | 2~20 项，`path` 是缓存相对路径，经路径解析限制在缓存目录内；任一非法**整体拒绝**。`direction: "v"` 纵拼（`unify` 统一为最窄的宽），`"h"` 横拼（统一为最矮的高）。`gap` 只加在相邻两张之间。`align` 只在 `unify` 为 false 时影响交叉轴位置 |
| 返回 | `{ path, thumbPath, name, width, height, size }`。`path` 为 `cache/out/stitch_<毫秒时间戳>.png\|jpg`（同毫秒撞名追加 `-n`），`thumbPath` 为 `cache/out/stitch_thumb_<同 id>.jpg`（最长边 256 的 JPEG，质量 80），`size` 是成品字节数 |
| 内存与上限 | 画布一张 `ARGB_8888` 位图，源图逐张按目标尺寸降采样解码、绘制后立即回收。画布单边 ≤ 30000、像素数 ≤ 4000 万（约 160MB），超出 `BAD_PARAMS`，message 提示「减少图片、开启统一宽度/高度或调小间距」。PNG 按行读像素、**流式编码**（逐行滤波压缩，压好一块写一块，`.part` 文件随编码增长，不攒整幅 `IntArray`/`ByteArray`），先铺底色所以恒不透明；JPEG 直接 `Bitmap.compress` 写文件 |
| EXIF | 按 EXIF 方向摆正后参与布局与绘制 |
| 进度事件 | `image.progress`，data `{ done, total, name, phase, percent? }`，共 `total = n+1` 大步。**旧字段 `done/total/name` 含义不变**，新增 `phase`（`"draw"` \| `"encode"` \| `"done"`）与仅 encode 阶段才有的 `percent`（整数 0..100）。序列：每画完一张推一条 `phase:"draw"`（`done` 为 1..n）；然后编码阶段推若干条 `phase:"encode"`，此时 `done` 固定为 `n`，`percent` 是按行算的编码百分比，**节流**：首条（0）必推，之后百分比每涨 ≥2 个点推一条，或距上次 ≥250ms 且有进展也推，100 必推，所以最多约 51 条；最后推一条 `phase:"done"`（`done = total`，`name` 为成品文件名）。JPEG 由系统编码器一次写完，只有 `percent:100` 一条 encode 事件（若只想显示一个总进度条，用 `(done + percent/100) / total` 即可，encode 阶段没有 `percent` 时按 `done/total`）。无 `sub` |
| 取消 | 张与张之间、PNG 每行检查取消；取消或失败会删掉本次已写的成品、缩略图与 `.part` |
| 错误 | `BAD_PARAMS`（参数不合法、路径非法、文件不存在、画布超限）、`INTERNAL`（某张无法解码、内存不足）、`PERMISSION_DENIED`（非主 frame）、`CANCELLED` |

真机（STG-AL00）：3 张 4000×3000 纵拼 JPEG（画布 4000×9000，3600 万像素）与横拼 PNG（12040×3000）均成功；EXIF 摆正、gap、底色、透明图铺底色目测正确；4 万像素宽的画布被拒；任务取消后 `out/` 无残留。

**PNG 编码提速（2026-10-14，STG-AL00）**：两张相册原图（各约 5MB、1200 万像素）纵拼成 3072×8192（2520 万像素）PNG。优化前整幅一次压完返回 `ByteArray` 才写盘，`.part` 在编码期间一直是 0 字节。分段计时（优化前 → 后）：探测 10ms → 10ms；解码+绘制 456ms → 454ms；**编码 136093ms → 4132ms（约 33 倍）**；写盘 37ms → 0（边压边写，已含在编码里）；缩略图 413ms → 152ms；总计约 137s → 约 4.8s；成品 19,432,247B → 20,481,329B（+5.4%）。优化后 `.part` 在编码中每秒约增长 6~7MB，取消（编码中途）后无残留。成品与优化前的 PNG 逐像素一致（无损），WebView 能正常加载并 `decode()` 3072×8192 的 PNG 与缩略图。
- **做法**：`PngEncoder.writeRgb` 流式写出（签名 + IHDR + 每 64KB 一个 IDAT + IEND，不关闭传入的流）；压缩调优抽成参数 `PngTuning(level, filters)`：`PngTuning.BEST`（级别 9，五种滤波全试）是默认值，压缩工具 `native.image.compress` 的 PNG 完全不变；拼接用 `PngTuning.FAST`（级别 3，只在 Sub / Up 里按字节绝对值之和挑）。
- **参数取舍依据**（主机 JVM，同一张 3072×8192 真图，每个组合跑一次；设备上绝对值约为主机的 2.5 倍）：级别 1 + Sub/Up 0.97s / 23.6MB；级别 2 + Sub/Up 1.07s / 23.0MB；**级别 3 + Sub/Up 1.79s / 21.0MB**；级别 6 + Sub/Up 5.9s / 19.9MB；级别 3 + 五种滤波 2.4s / 22.4MB；级别 9 + 五种滤波（`BEST`）54s / 19.4MB。级别 3 + Sub/Up 比 `BEST` 大约 8%（设备实测 +5.4%），快 30 倍以上；Paeth 与 Average 在照片上几乎不赚体积却贵，所以拼接不试。
- 另外 `filterRow` 对 None / Sub / Up 改成无分支的专用循环，输出与原通用实现逐字节相同（压缩工具略快，体积不变）。

### `native.image.preview`
打开原生全屏图片预览：左右翻页、双指缩放、放大后拖动、双击放大/还原、单击或返回键关闭。立即返回，不等用户关闭。

| 项 | 说明 |
|---|---|
| params | `{ paths: string[1..50], index?: number = 0 }`。`paths` 是缓存相对路径（如 `cache/out/a.png`），经路径解析限制在缓存目录内；`index` 起始下标，越界会夹到范围内 |
| 返回 | `{ shown: number }` |
| 错误 | `BAD_PARAMS`（`paths` 缺失、数量不对、任一项不是有效缓存路径或文件不存在，整体拒绝）、`PERMISSION_DENIED`（非主 frame） |

实现取舍：
- **超长图分块解码**：整图只解一份缩小的底图（长边 ≤ 4096、总像素 ≤ 1600 万，按 2 的幂降采样），放大后手势停下 150ms 再用 `BitmapRegionDecoder` 解可见区域的高清局部叠上去。1080×20000 的 PNG 在 STG-AL00 上实测：底图 109ms，局部 1000px 一块 8~106ms（越靠后越慢）。
- **EXIF 旋转**：局部解码不处理方向，带旋转标记的图只显示底图（底图用 `ImageDecoder`，会摆正）。
- **前端接法**：结果图在前端是 Blob，要先 `writeBlobToCache` 写进缓存再传路径；`previewBlob()`（`web/src/shared/image-io.ts`）封装了这一步并按 Blob 缓存路径，同一张图只写一次。浏览器里没有宿主，回退到 vant 的 `showImagePreview`。
- **返回键**：由 Activity 自己处理，不经过前端的返回栈。

约定与取舍：
- **像素上限**：解码后像素数不得超过 6400 万（与 web 侧 `MAX_CANVAS_PIXELS` 一致），超过时需要设置更小的 `maxEdge`，否则该张 `BAD_PARAMS`。PNG 路径要把像素读成 `IntArray`，上限更低：1600 万像素（约 64MB），超过同样要求设 `maxEdge`。
- **JPEG 与透明**：JPEG 不支持透明，透明区先铺白底。WebP、PNG 保留透明。
- **WebP**：API 30+ 用 `WEBP_LOSSY`，更低版本用旧的 `WEBP`（同样是有损）。
- **HEIC**：API 28+ 由 `ImageDecoder` 解码；24~27 解不了，该张 `INTERNAL`，message 提示需要 Android 9 及以上。
- **EXIF 方向**：解码时按 EXIF 摆正，输出像素即显示方向。
- **PNG 缩色的取舍**：自写量化器，不引 libimagequant（GPL）等库。alpha 当第 4 个通道参与聚类，alpha 为 0 的像素统一归一不占调色板名额，调色板按 alpha 升序放，tRNS 只写前缀。直接在 sRGB 通道上做，不做感知色彩空间转换，视觉质量略逊于 pngquant。**缩色对照片、噪声类图能明显省体积，对平滑渐变反而可能更大**（量化出的色带打乱了滤波与 Deflater 依赖的规律，抖动尤其明显）；页面应在选择缩色时提示，并在结果比原图大时给出提示。
- **成品生命周期**：成品落在缓存根的 `out/`，与其他缓存产物一样受缓存清理策略管理（保留 24 小时，超总量时最近 10 分钟写入的不动）。页面拿到结果后回显与保存都在这个窗口内；窗口外再用需要重新压缩。

## 系统能力方法

全部只接受主 frame（子 frame 返回 `PERMISSION_DENIED`），参数缺失或类型不对返回 `BAD_PARAMS`。前端封装在 `web/src/native/system.ts`，无宿主时的降级写在各函数的 JSDoc 里。

| 方法 | params | 成功时的 data | 错误 |
|---|---|---|---|
| `native.clipboard.write` | `{ text: string, sensitive?: boolean }`，text 上限 20 万字符 | `{ written: true }`。`sensitive` 为 true 时给剪贴板打敏感标记：API 33+ 用 `ClipDescription.EXTRA_IS_SENSITIVE`，24~32 用同值字面量 `android.content.extra.IS_SENSITIVE`（系统预览隐藏内容） | `BAD_PARAMS`（缺 text、过长）、`PERMISSION_DENIED`（系统拒绝写入） |
| `native.clipboard.read` | 无 | `{ text: string \| null }`。Android 10+ 应用不在前台、剪贴板为空或非文本时是 null，**不抛错** | 仅主 frame 限制 |
| `native.share` | `{ text?: string, path?: string, mime?: string, title?: string }`，text 与 path 至少一个 | `{ started: boolean }`，false 表示没能拉起选择器。`path` 是缓存相对路径（经 `resolveCache` 防穿越），经 FileProvider 发 `content://` URI 并授予读权限，用 `Intent.createChooser` 拉起；`mime` 缺省按扩展名猜（猜不出 `application/octet-stream`），纯文本为 `text/plain` | `BAD_PARAMS`（都没给、path 无效或文件不存在、path 不在可分享目录） |
| `native.settings.open` | `{ page }`，page 取 `wifi` / `display` / `battery` / `developer` / `app` / `notification` / `date` / `locale` / `accessibility` / `bluetooth` / `storage` | `{ opened: boolean }`。`app` 打开本应用详情页；`notification` 在 API 26 以下退回应用详情页 | `BAD_PARAMS`（page 不在白名单） |
| `native.intent.open` | `{ kind: "url" \| "dial" \| "sms" \| "mail" \| "map" \| "market", value: string }` | `{ opened: boolean }`，false 表示没有能处理的应用。scheme 白名单：url→`https`/`http`（必须自带），dial→`tel`（`ACTION_DIAL`，不直接拨出），sms→`smsto`，mail→`mailto`，map→`geo`，market→`market`；除 url 外 value 可只写主体，原生补 scheme（如 `10086`→`tel:10086`、包名→`market://details?id=…`）。value 长度 ≤ 2000、不含控制字符；`javascript:` / `file:` / `content:` / `intent:` / `data:` 一律拒绝，种类与 scheme 不匹配也拒绝 | `BAD_PARAMS` |
| `native.intent.processText` | `{ text: string }`，1~5 万字符 | `{ handled: boolean }`。用 `ACTION_PROCESS_TEXT`（`EXTRA_PROCESS_TEXT_READONLY=true`）转交已装的翻译等应用，没有应用接手为 false | `BAD_PARAMS` |
| `native.haptic.vibrate` | `{ pattern: number[], repeat?: number }` 或 `{ cancel: true }`。pattern 为 `[停, 震, 停, 震…]` 毫秒数，个数 1~100，元素为 0~10000 的整数，总长 ≤ 30 秒且大于 0；`repeat` 为循环起点下标，缺省 / -1 不循环 | `{ vibrated: boolean }`，设备没有马达为 false；`cancel` 恒返回 false。API 31+ 走 `VibratorManager`，26+ 用 `createWaveform`，24~25 用旧 `vibrate(long[], int)` | `BAD_PARAMS` |
| `native.screen.keepAwake` | `{ on: boolean }` | `{ on }`。设窗口 `FLAG_KEEP_SCREEN_ON`，只影响本应用窗口 | `BAD_PARAMS` |
| `native.screen.brightness` | `{ value: number }`，0~1，`-1` 跟随系统 | `{ value }`（实际生效值）。0 会夹到 0.01，免得部分机型直接熄屏；只影响本应用窗口 | `BAD_PARAMS` |
| `native.screen.orientation` | `{ mode: 'landscape' \| 'portrait' }` | `{ mode }`。`landscape` 为传感器横屏（`SCREEN_ORIENTATION_SENSOR_LANDSCAPE`，两个横向都跟随重力，翻过手机自动正过来），`portrait` 还原竖屏；清单里的 `configChanges` 已含 `orientation`，页面不重建，只会触发一次 `resize`。页面用完必须还原。目前只有打字板全屏展示使用 | `BAD_PARAMS` |
| `native.screen.immersive` | `{ on: boolean }` | `{ on }`。用 `WindowInsetsControllerCompat` 隐藏 / 显示系统栏，隐藏后上滑边缘临时唤出 | `BAD_PARAMS` |
| `native.device.info` | 无 | 静态信息：`brand` `model` `device` `manufacturer` `androidVersion` `sdkInt` `securityPatch` `abis[]` `harmonyOs`（反射 `com.huawei.system.BuildEx.getOsBrand()`，失败为 false/null）`osBrand` `totalMemBytes` `display{…}` `sensors[{name,type,typeName}]`（≤100 条）`locale` `timeZone` `features{nfc,bluetooth,bluetoothLe,wifi,telephony,fingerprint,camera,cameraFront,cameraFlash,gps,microphone,gyroscope,accelerometer,compass,barometer,lightSensor,proximity,usbHost,infrared}`（`hasSystemFeature`）。取不到的字段为 null，不抛 | 仅主 frame 限制 |
| `native.device.status` | 无 | 动态状态：`batteryPercent` `charging` `chargeStatus`（`charging`/`discharging`/`not_charging`/`full`/`unknown`）`chargeStatusText` `plugType`（`ac`/`usb`/`wireless`/`dock`/`none`）`plugText` `batteryTempC` `batteryVoltageMv`（sticky 广播取）`availMemBytes` `lowMemory` `storageTotalBytes` `storageFreeBytes`（`StatFs` 内部存储）`networkType`（`wifi`/`cellular`/`ethernet`/`bluetooth`/`vpn`/`other`/`none`）`networkText` `powerSave`。取不到为 null，不抛。网络只分到传输类型，不区分 4G/5G（需要电话状态权限，没要） | 同上 |
| `native.device.display` | 无 | `{ widthPx, heightPx, xdpi, ydpi, densityDpi, density, refreshRate }`，真实屏幕尺寸（含系统栏），取不到为 null | 同上 |
| `native.permission.check` | `{ name: "camera" \| "microphone" \| "notifications" \| "media_images" }` | `{ granted: boolean, reason?: "not_declared" }`，只查不弹窗。映射：camera→`CAMERA`，microphone→`RECORD_AUDIO`，notifications→`POST_NOTIFICATIONS`（API 33+，低版本恒 granted），media_images→`READ_MEDIA_IMAGES`（33+）/ `READ_EXTERNAL_STORAGE`。清单没声明该权限时返回 `{ granted: false, reason: "not_declared" }` | `BAD_PARAMS`（name 不在白名单） |
| `native.permission.request` | 同上 | 同上。已授予直接返回不弹窗；否则复用 `ActivityHost.requestPermission` 弹系统对话框。被永久拒绝时系统不再弹窗，直接返回 `granted: false`，页面可引导 `native.settings.open { page: "app" }` | `BAD_PARAMS` |

清单相关说明：
- 已声明：`VIBRATE`、`ACCESS_NETWORK_STATE`（均为普通权限，安装即授予）、`POST_NOTIFICATIONS`，以及已有的图片读取权限。
- **刻意没声明 `CAMERA` / `RECORD_AUDIO`**：等对应工具（扫码、录音等）落地时再加。在此之前 `native.permission` 对 camera / microphone 返回 `not_declared`，不会崩。
- 分享用的 FileProvider（authority `<applicationId>.fileprovider`）只暴露缓存的 `arkli/out/`（页面产出的成品）。要分享别处的文件，先写进缓存 `out/`。
- `startIntent` 一律直接 `startActivity`，找不到处理者（`ActivityNotFoundException`）或被系统拒绝返回 false，所以系统能力方法本身不需要 `<queries>`。清单里的 `<queries>` 是后面应用管理和 TTS 引擎要用的，见各自章节。

## 提醒方法

前端封装在 `web/src/native/reminder.ts`。全部只接受主 frame（`PERMISSION_DENIED`），参数缺失、类型不对或校验不过返回 `BAD_PARAMS`。代码在 `com.let188.arkli.alarm`。

| 方法 | params | 成功时的 data | 错误 |
|---|---|---|---|
| `native.notify.show` | `{ id?: number, title: string, text?: string }`。`id` 为 0~2^31-1 的整数，缺省按当前时间生成；title 去首尾空白后 1~100 字，text ≤ 500 字 | `{ shown: true, id: number }`。通知渠道 `arkli_reminder`（高优先级，API 26+ 自动创建），点击通知回到 App | `BAD_PARAMS`；`PERMISSION_DENIED`（API 33+ 未授予 `POST_NOTIFICATIONS`，或用户在系统里关了本应用通知） |
| `native.alarm.set` | `{ id: string, atEpochMs: number, title: string, text?: string }`。id 1~64 字符不含控制字符；`atEpochMs` 为整数毫秒时间戳，必须在**未来**且**不超过 366 天**；title / text 限制同上 | `{ set: true }`。用 `AlarmManager.setAlarmClock`（**不需要精确闹钟权限**，状态栏会显示闹钟图标，Doze 下也准时）。同 id 再设会覆盖。到点由 `AlarmReceiver`（`exported=false`）发通知并删掉记录 | `BAD_PARAMS`；`PERMISSION_DENIED`（系统拒绝设置闹钟） |
| `native.alarm.cancel` | `{ id: string }` | `{ cancelled: boolean }`，记录原先不存在为 false，不报错 | `BAD_PARAMS` |
| `native.alarm.list` | 无 | `{ items: [{ id, atEpochMs, title, text }] }`，按触发时间升序；过点超过 1 分钟的视为失效不列出 | 仅主 frame 限制 |

约定与取舍：
- **记录**：待触发闹钟存在 `SharedPreferences`（文件 `arkli_alarms`，一条 JSON 数组），触发或取消后删除。校验与 JSON 编解码是纯函数（`ReminderPolicy`），有单测。
- **不做开机恢复**：设计已定，不加 `RECEIVE_BOOT_COMPLETED`。设备重启后系统会丢掉所有闹钟，未触发的提醒失效（`alarm.list` 里可能还残留，过点超 1 分钟后就不再显示）。页面要把这点告诉用户。
- **厂商省电**：`setAlarmClock` 在多数 ROM 上不受后台限制，但个别国产 ROM 的「自启动管理 / 电池优化」仍可能拦截，需用户手动放行，无真机时未验证。
- **通知权限**：页面应先 `requestPermission('notifications')`。闹钟到点时没有通知权限，通知发不出来，记录照常删除。

## 文字转语音方法

前端封装在 `web/src/native/tts.ts`（无宿主时 speak / stop / status 退回浏览器 `speechSynthesis`，save 抛 `NativeUnavailableError`）。全部只接受主 frame，代码在 `com.let188.arkli.tts`。引擎是系统 `TextToSpeech`，**按会话创建、随会话关闭释放**（`bridge.onClose`），首次调用时异步初始化。

| 方法 | params | 成功时的 data | 错误 |
|---|---|---|---|
| `native.tts.speak` | `{ text: string, lang?: string = "zh-CN", rate?: number = 1, pitch?: number = 1 }`。text 1~8000 字符且不能全是空白；`lang` 接受 `zh-CN` / `zh_cn` / `en` 等写法并规范化（语言小写、地区大写）；`rate`、`pitch` 取 0.5~2 | `{ id: string }`，引擎就绪、入队后立即返回。超过引擎单次输入上限（`getMaxSpeechInputLength()`，通常约 4000）时按句分段排队。会打断正在进行的朗读 | `BAD_PARAMS`；`NOT_READY`（引擎起不来，或该语言没有语音数据，message 提示去「系统设置 > 语言和输入法 > 文字转语音」安装）；`INTERNAL`（引擎拒绝入队） |
| `native.tts.stop` | 无 | `{ stopped: true }`，没有在读时什么也不发生 | 仅主 frame 限制 |
| `native.tts.status` | 无 | `{ available: boolean, langs: string[] }`。引擎起不来时 `available=false`、`langs=[]`，**不抛错**；`langs` 是引擎报告的可用语言标签（`Locale.toLanguageTag()`，去重排序） | 仅主 frame 限制 |
| `native.tts.save` | `{ text, lang?, rate?, pitch? }`，同 speak，但 text 不能超过引擎单次上限，超了 `BAD_PARAMS` | `{ path: string, name: string }`。`synthesizeToFile` 合成 wav 到缓存 `out/tts-<随机>/` 下，`path` 可交给 `native.share` / `native.file.save`。合成超时 120 秒返回 `TIMEOUT`，失败会删残留文件 | `BAD_PARAMS`；`NOT_READY`；`TIMEOUT`；`INTERNAL` |

事件（`ctx.emit`，无 `sub`）：
- `tts.done`：`{ id }`，一次朗读（含全部分段）自然读完。
- `tts.stopped`：`{ id, error?: true }`，被 `stop`、被新的 `speak` 顶掉、或引擎出错（带 `error: true`）。每个 `id` 只会收到 `done` / `stopped` 之一。

约定与取舍：
- **TTS 引擎可见性**：API 30+ 绑定语音引擎需要清单 `<queries>` 里声明 `android.intent.action.TTS_SERVICE`，已加。
- **语言数据**：`speak` / `save` 每次都先 `setLanguage`，返回缺数据或不支持即 `NOT_READY`。设备上有没有中文语音要看引擎，无真机时未验证。
- **引擎状态是全局的**：语速、音调、语言设在引擎上，所以同一会话里 save 前会先停掉正在进行的朗读。

## 网页转应用

前端封装在 `web/src/native/shortcut.ts`，只接受主 frame，代码在 `com.let188.arkli.shortcut`。

| 方法 | params | 成功时的 data | 错误 |
|---|---|---|---|
| `native.shortcut.pin` | `{ id: string, label: string, url: string }`。id 1~64 字符；label 去首尾空白后 1~24 字；url 只允许 `https` / `http`（复用 `IntentPolicy` 的 `url` 规则，必须自带协议，`javascript:` 等一律拒绝） | `{ requested: boolean, reason?: "unsupported" }`。`requested: true` 表示系统确认弹窗已发出，用户是否点了「添加」拿不到结果；桌面不支持固定快捷方式时 `{ requested: false, reason: "unsupported" }` | `BAD_PARAMS` |

约定：用 `ShortcutManagerCompat.requestPinShortcut`，快捷方式 Intent 是 `ACTION_VIEW` 打开该网址（走系统默认浏览器，不是独立 App）。图标为「名称首字 + 圆角彩色底」位图（192px，`IconCompat.createWithBitmap`），底色按名称哈希从 10 色色板取，首字按码点取（不劈开 emoji）。同 id 再次固定是更新。华为等桌面对固定快捷方式的支持因机型而异，无真机时未验证。

## 应用管理方法

前端封装在 `web/src/native/apps.ts`，只接受主 frame，代码在 `com.let188.arkli.apps`。`pkg` 必须匹配 `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$`，否则 `BAD_PARAMS`；应用不存在或不可见同样 `BAD_PARAMS`。

**包可见性**：**不使用 `QUERY_ALL_PACKAGES`**。清单 `<queries>` 只声明了 `MAIN` + `LAUNCHER` 的 intent，所以只能看到桌面上有图标的应用（以及本应用自己），没有桌面入口的后台应用不可见。各 ROM 下实际能列出多少个，无真机时未验证。

| 方法 | params | 成功时的 data | 错误 |
|---|---|---|---|
| `native.apps.list` | `{ includeSystem?: boolean = false }` | `{ items: [{ pkg, label, versionName, versionCode, firstInstallMs, lastUpdateMs, isSystem, apkBytes }] }`，按应用名排序（中文 Collator）。`isSystem` 含「被更新过的系统应用」；`apkBytes` 是 base APK 大小。在 `Dispatchers.IO` 执行 | `BAD_PARAMS` |
| `native.apps.open` | `{ pkg }` | `{ opened: boolean }`，应用没有启动入口或被系统拒绝为 false | `BAD_PARAMS` |
| `native.apps.settings` | `{ pkg }` | `{ opened: boolean }`。打开系统「应用详情」页（`ACTION_APPLICATION_DETAILS_SETTINGS`），用户可在那里卸载。**不直接卸载**，没有 `REQUEST_DELETE_PACKAGES` | `BAD_PARAMS` |
| `native.apps.exportApk` | `{ pkg }` | `{ path, name, bytes }`。把 base APK 分块拷到缓存 `out/apk-<随机>/<应用名>_<版本名>.apk`，上限 300MB（超了 `BAD_PARAMS`），拷贝响应取消，失败或取消删残留。分包安装（split APK）的应用只导出 base，装不上完整功能 | `BAD_PARAMS`、`CANCELLED` |
| `native.apps.icon` | `{ pkg, size?: number = 96 }`，size 为 48~192 的整数 | `{ path }`。把应用图标（含自适应图标）渲染成 PNG 放进缓存 `out/app-icons/<pkg>_<size>.png`；同包同尺寸且应用没更新过时复用文件。页面用 `/files/<path>` 显示 | `BAD_PARAMS` |

## 联网方法

前端封装在 `web/src/native/net.ts`，代码在 `com.let188.arkli.net`。页面自己的出站网络被 CSP 与 `NetPolicy` 封死，所有联网工具都走这几个方法。全部只接受主 frame，可取消（取消时关闭底层连接）。不引入第三方依赖，只用 `HttpURLConnection` / `Socket`。

错误码：参数不合法（含越界）`BAD_PARAMS`；超时 `TIMEOUT`；DNS/TLS/连接失败 `NETWORK`；目标被拒 `PERMISSION_DENIED`（message 固定为「目标地址不允许」）。

| 方法 | params | 成功时的 data |
|---|---|---|
| `native.net.http` | `{ url, method?: "GET"\|"HEAD" = "GET", headers?, followRedirects?: true, maxRedirects?: 5（0~10）, timeoutMs?: 10000（1~20000，每一跳单独计）, maxBytes?: 2097152（1~2097152）, responseType?: "text"\|"base64" = "text" }` | `{ status, statusText, url（最终地址）, redirects: [{ url, status, location }], headers（小写键，同名头用 ", " 合并）, body, bodyEncoding, truncated, elapsedMs }` |
| `native.net.resolve` | `{ host }` | `{ addresses: [{ ip, family: 4\|6 }], elapsedMs }`。**只解析，不做内网判断**，原样返回（IP 查询页要拿结果去查） |
| `native.net.tcp` | `{ host, port（1~65535）, timeoutMs?: 5000（1~15000） }` | `{ ok, elapsedMs, error? }`。连不上、超时、域名解析失败都返回 `ok:false` 不抛错；目标在内网才抛 `PERMISSION_DENIED` |
| `native.net.whois` | `{ query, server? }` | `{ server（最终应答的服务器）, text, truncated }`。`query` 只允许字母数字与 `.-:`（≤253）；`server` 缺省 `whois.iana.org`，连 43 端口发 `query\r\n`；应答里的 `refer:` / `whois:` / `ReferralServer:` 行指向下一级，最多再跟 2 级；每次 8 秒超时，文本上限 64KB。后续级失败（被拒、超时、连不上）回退到上一级的结果，第一级失败才抛错 |
| `native.net.speed` | `{ url, maxBytes?: 26214400（≤52428800）, durationMs?: 8000（≤15000） }` | `{ bytes, elapsedMs, bps }`。流式下载并丢弃，到量或到时即停，`bps = bytes*8/秒`；`elapsedMs` 从响应头到达后算起（不含建连与握手）；最多跟 3 跳重定向；非 2xx 抛 `NETWORK` |
| `native.ai.status` | `{}` | `{ models: { ocr, upscale, classify, matte, fuse, colorize } }`，布尔。原生 AI 运行时未接入，目前恒为全 `false`，本地模型的 `native.ai.ocr` 等不注册；待 sherpa / ort 接入后替换（识物已经接入 ORT，但**不看它**，页面用 `native.ai.providers` 里 `local-clip` 的可用性，`classify` 在此仍报 `false` 以保持既有行为）。提供者类方法见下面「AI 提供者方法」 |

**`native.net.http` 细节**

- 只允许 http / https；url 不能带用户名密码；url 里显式写的端口只允许 80 / 443 / 8080 / 8443，否则 `BAD_PARAMS`（重定向目标的端口不在其中则 `PERMISSION_DENIED`）。`timeoutMs` 等参数超过上限是 `BAD_PARAMS`，不会静默截断。
- 请求头白名单：只放行 `accept`、`accept-language`、`user-agent`，其余忽略；值含换行 `BAD_PARAMS`。缺省 UA 是常见移动 Chrome 串，缺省 `accept: */*`。不发送 Cookie，`useCaches=false`。
- 重定向手动处理（`instanceFollowRedirects=false`）：301/302/303/307/308 且带 `Location` 才跟随，相对地址按当前 URL 解析，每一跳重新做目标校验；`https→http` 降级允许，记入 `redirects`。超过 `maxRedirects` 返回已经跟随到的最后一个响应（不报错）；`followRedirects:false` 只返回首个响应，`redirects` 为空。
- 响应体最多读 `maxBytes`，再多一个字节就置 `truncated:true`（text 与 base64 一样）。text 按 Content-Type 的 `charset` 解码，缺省或不认识时用 UTF-8。

**SSRF 防护范围**（`NetTargetPolicy`）：`http`、`tcp`、`whois`（含引荐出的下级服务器）、`speed` 在连接前、以及每一跳重定向前，先解析主机，**解析出的任何一个地址**落在下列范围就拒绝。`resolve` 不做这项判断。

- IPv4：`0.0.0.0/8`、`10/8`、`100.64/10`（CGNAT）、`127/8`、`169.254/16`（含云元数据 `169.254.169.254`）、`172.16/12`、`192.168/16`、`224/4`（组播）、`240/4`（保留，含广播）。
- IPv6：`::`、`::1`、`fc00::/7`、`fe80::/10`、`ff00::/8`；IPv4 映射 `::ffff:a.b.c.d`、IPv4 兼容 `::a.b.c.d`、NAT64 `64:ff9b::/96` 按内嵌的 v4 判断。
- 主机名：`localhost`、`*.localhost`、`*.local`、`*.internal`、`*.localdomain`、`*.lan`、`*.home.arpa`、`*.intranet`、`*.corp`，以及不含点的单标签名，直接拒绝（不解析）。
- IP 字面量的 url 走同样的判断。

**已知局限**：校验时解析一次，`HttpURLConnection` 连接时会再解析一次，**DNS 重绑定（两次解析结果不同）在这一层无法完全消除**；也没有按 IP 直连（直连会破坏 TLS 的 SNI 与证书校验）。威胁模型是「本地 App、用户自己输入网址」，这套校验是纵深防御，不是安全边界。另外：DNS 解析本身（`getaddrinfo`）不可中断，取消时要等它返回；`HttpURLConnection` 建连阶段的取消依赖 `disconnect()`，各 Android 版本的实际表现无真机时未验证。

## AI 提供者方法

前端封装在 `web/src/native/ai.ts`（`aiProviders()` / `aiRun()` / `aiClassifyImage()`）与 `useAiProviders`。全部只接受主 frame（`PERMISSION_DENIED`）。代码在 `com.let188.arkli.ai`，决策见 [0004](../decisions/0004-ai-provider-abstraction.md)。页面只看**能力**，不认厂商；提供者不可用时页面隐藏入口或降级。

| 方法 | params | 成功时的 data | 错误 |
|---|---|---|---|
| `native.ai.providers` | `{}` | `{ providers: [{ id, displayName, available, reason?, tasks[] }], capabilities: string[] }`。`providers` 含不可用的（带 `reason`），按注册顺序；本地模型类提供者（现在有 `local-clip`、`local-nllb`）额外带 `modelId`（对应 `native.model.*` 的清单 id）、`downloaded`（已安装且 sha256 校验通过）、`sizeBytes`（磁盘占用，含未完成的 `.part`）、`downloading`（正在下载或校验），其余提供者没有这四项，旧页面忽略即可；`capabilities` 是**可用**提供者 `tasks` 的并集，按固定顺序排列。`reason` 取 `no_handler`（系统里没有能接手文本的应用）/ `unsupported_device` / `not_installed` / `not_configured`，页面遇到不认识的值按“不可用”处理。`tasks` 取 `summarize` / `proofread` / `rewrite` / `describeImage` / `prompt` / `translate` / `classifyImage` | 仅主 frame 限制 |
| `native.ai.run` | `{ provider: string, task: string, input: string }`。`provider` 1~64 字符；`task` 取上面六个之一；`input` 去空白后非空、≤ 50000 字符。`describeImage` 与 `classifyImage` 要图片输入，本方法只收文本，一律 `BAD_PARAMS`（识图走 `native.ai.classify`） | 交接类：`{ handoff: true, handled: boolean }`，`handled=false` 表示没有应用接手，拿不回结果；直接结果类（将来）：`{ handoff: false, handled: true, text: string }` | `BAD_PARAMS`（字段缺失或类型不对、task 未知、provider 未注册、provider 不支持该 task、input 为空或超长）；`NOT_READY`（提供者当前不可用，message 带 `reason`） |
| `native.ai.classify` | `{ provider?: string, path: string, topK?: number }`。`path` 是缓存相对路径（如 `cache/pick/a.jpg`，防穿越，沿用 `native.image.*` 的写法）；`provider` 缺省取第一个支持 `classifyImage` 的提供者（现在只有 `local-clip`）；`topK` 1~10，默认 3 | `{ items: [{ id, nameZh, nameEn, category, score }], categories: [{ category, name, prob }], confidence, uncertain, elapsedMs, inferMs, modelId }`。`items` 是 top-k 物品，`score` 为与图像的余弦相似度（4 位小数）；`categories` 是全部分类的聚合概率（`softmax(100×余弦)` 按分类求和，降序，和为 1）；`confidence` 为最大分类概率，**低于 0.8 时 `uncertain=true`，页面应提示“拿不准”**；`category` 取 `R` 可回收物 / `H` 有害垃圾 / `W` 湿垃圾 / `D` 干垃圾（**词表分类是草稿，待对照官方指引核对**）；`elapsedMs` 含解码缩放与模型首次加载，`inferMs` 为 Rust 侧缩放 + 推理 + 分类；`modelId` 现为 `siglip2-q4_half` | `BAD_PARAMS`（`path` 缺失、不是有效缓存图片或穿越，`topK` 越界，`provider` 未知或不支持）；`NOT_READY`（模型文件未就绪，message 带 `not_installed` 与模型路径；Rust 侧报“未加载”也映射到这里）；`INTERNAL`（图片无法解码、ORT 库加载失败、推理失败）；`PERMISSION_DENIED`（非主 frame） |
| `native.ai.translate` | `{ text: string, src: string, tgt: string, numBeams?: number }`。`text` 去空白后非空、≤ 2000 字符；`src`/`tgt` 取 `zh-CN` / `en` / `fr` / `es` / `ru` / `ar`（区分大小写，必须不同）；**`src` 还可以是 `'auto'`（小写，按句自动识别源语言），`tgt` 不可以**，auto 与任何目标都不冲突；`numBeams` 为 1~4 的整数，缺省取模型缺省（2） | `{ text, elapsedMs, modelId, src, tgt, detectedSrc: string[], unrecognized: boolean }`。`src` 原样回显请求值（可能是 `auto`）。**`detectedSrc`**：按出现顺序去重的、被识别出的应用语言码，没识别出为空数组；`src` 不是 auto 时恒为 `[src]`。**`unrecognized`**：auto 下有句子的语言无法识别而被**原样放进 `text`**（不翻译，保留标点与空白）时为 true；`src` 不是 auto 时恒为 false。auto 的做法：引擎先分句，对每句用 Rust 的 `whatlang`（纯 Rust、MIT、无模型文件）识别，候选限定在当前模型支持的语言内；句子去掉网址/邮箱后字母不足 2 个、置信度不足（下限 0.04，`is_reliable` 为真则放行）、或不先限定语言时明显（置信度≥0.1）是模型不支持的语言（德/意/葡等），都算无法识别。识别出的语言与目标相同的句子原样保留，记入 `detectedSrc`，不算无法识别；全部句子都无法识别时 `text` 就是原文、`detectedSrc=[]`、`unrecognized=true`，不报错。中文一律识别为 `zh-CN`（本包只有简体 token，繁体无法区分）。已知局限：很短的句子（单词级）和很短的非支持语言句（如 `Ich liebe dich.`）可能识别错，按最像的支持语言翻译。`elapsedMs` 是总耗时（会话里首次使用时含模型加载），`modelId` 现为 `nllb600m-un6-ccm-int4`。提供者取第一个声明 `translate` 且支持语言对的（现在只有 `local-nllb`，`intent-handoff` 不带语言对，不参与）；模型首次使用才加载，模型文件变化（长度或修改时间）自动重载；走 `AiHeavyGate`（与识物共用，同一时刻只跑一个 AI 重任务，后来者排队），在 IO 线程执行；只接受主 frame | `BAD_PARAMS`（`text` 缺失、为空或过长，`tgt` 不在六种内（含 `auto`），`src` 不在六种内且不是 `auto`，`src` 等于 `tgt`，`numBeams` 越界或不是整数）；`NOT_READY`（模型未安装或未校验通过，message 带 `reason`）；`INTERNAL`（模型加载或推理失败）；`CANCELLED` |
| `native.ai.warmup` | `{ provider: string }`，现支持 `local-nllb`（加载翻译会话）与 `local-clip`（加载词表与识物会话） | `{ provider, loaded: true, elapsedMs }`。只加载模型会话，不推理；已加载则幂等，立刻返回（`elapsedMs` 约 0）；走 `AiHeavyGate` 排队、IO 线程；可取消，加载期间被取消会在加载完后立刻卸掉，不留半加载状态；只接受主 frame。实测 `local-nllb` 约 2.7 s、`local-clip` 约 0.56 s | `BAD_PARAMS`（`provider` 缺失或不是字符串、不认识、不支持预热如 `intent-handoff`）；`NOT_READY`（模型未安装，message 带 `not_installed`）；`INTERNAL`（加载失败）；`CANCELLED` |
| `native.ai.unload` | `{ provider?: string }`，缺省或 `null` = 卸载全部已加载的会话（翻译 + 识物） | `{ unloaded: string[] }`，只列实际卸掉的提供者 id，本来没加载的不在内；幂等；走 `AiHeavyGate`，有推理在跑时排在它后面，不会打断；卸载后会让分配器把空闲堆页还给系统（Rust 侧 `mallopt(M_PURGE)`），RSS 才会真的回落；下次翻译或识物会自动重新加载；只接受主 frame | `BAD_PARAMS`（`provider` 不是字符串、不认识、没有可卸载的会话）；`CANCELLED` |

当前提供者：

| id | 说明 |
|---|---|
| `intent-handoff` | 系统应用交接。支持全部文本类任务（除 `describeImage`）。可用性：`queryIntentActivities(ACTION_PROCESS_TEXT, text/plain)` 非空。执行：`ACTION_PROCESS_TEXT`（`EXTRA_PROCESS_TEXT_READONLY=true`）经 `ActivityHost.startIntent` 拉起；`task` 只用于页面文案，**不会传给对方应用**，因为系统接口只能带文本 |
| `local-clip` | 本地识物（L1，SigLIP2 `q4_half`，决策 [0005](../decisions/0005-ai-four-layers.md)）。只声明 `classifyImage`，入口是 `native.ai.classify`，`native.ai.run` 不适用。可用性：模型已由 `native.model.*` 安装并**校验通过**（`installed`，见下节），否则 `available=false, reason=not_installed`；注意 adb 手动放进去的文件是 `unverified`，要先调一次 `native.model.verify` 才算可用。流程：原生 `AndroidImageCodec` 解码 + EXIF 摆正 + 降采样（最长边约 896）→ 取 RGB 传给 Rust（UniFFI `clip_classify`）→ Rust 按 PIL 的抗锯齿 bilinear 缩到 224×224、`(v/255-0.5)/0.5`、NCHW 推理、L2 归一化 → 与随包词表（`assets/ai/garbage_vocab.json` + `.f16`，182 条英文裸词向量）做余弦。会话在进程内复用（首次识别时才加载，约 0.5 秒）；模型文件长度或修改时间变了会自动重载。**同一时刻只跑一个 AI 重任务**（`AiHeavyGate`，后来者排队），耗时在 IO 线程，不占主线程 |
| `local-nllb` | 本地翻译（L1，NLLB-200 distilled 600M 裁剪词表 + int4，6 种联合国语言 `zh-CN`/`en`/`fr`/`es`/`ru`/`ar`，任意两种互译，决策 [0005](../decisions/0005-ai-four-layers.md)）。只声明 `translate`，入口是 `native.ai.translate`，`native.ai.run` 不适用（`BAD_PARAMS`）。可用性：模型 `nllb600m-un6-ccm-int4` 已由 `native.model.*` 安装并校验通过（`installed`），否则 `available=false, reason=not_installed`；`native.ai.providers` 里额外带 `modelId`、`downloaded`、`sizeBytes`、`downloading`。推理在 Rust（`arkli-ai::translate`，移植自 Cisox snow-translator，GPL-3.0-only，作者本人）：encoder + 带 KV cache 的 merged decoder、束搜索、中日文全角标点后处理，与识物共用同一份 sherpa 自带的 ORT。模型 6 个文件共 404,501,627 字节（含两个 `.onnx_data` 外部权重，必须与 `.onnx` 同目录，ORT 内存映射加载）；删除模型前经 `addReleaseHook` 调 `translate_unload`（排在重任务闸门后） |
- **AI 会话回收（原生侧）**：页面进入时用 `native.ai.warmup` 预热、离开时用 `native.ai.unload` 卸载由前端接线；原生侧另有兜底（`AiRecycle`，tag `ArkliAi`）：① `MainActivity.onDestroy` 且 `isFinishing`（真正退出，不含旋转重建）时、以及**按返回键退到底回桌面时**（`exitToHome()`：先 `AiRecycle.releaseAll("back-exit")` 再 `moveTaskToBack`，不 finish，用户 2026-10-15 决定）异步卸载翻译与识物会话；② `onTrimMemory` 为 `TRIM_MEMORY_RUNNING_CRITICAL`（15）或 `TRIM_MEMORY_COMPLETE`（80）时同样卸载，`UI_HIDDEN`/`BACKGROUND`/`MODERATE` 不卸；③ 退到后台、页面会话销毁（WebView 重建）都**不**卸载。卸载在进程级协程里排在 `AiHeavyGate` 后，不阻塞主线程、不打断正在跑的推理。注意：返回键到底仍走 `moveTaskToBack`、不 finish，所以 `onDestroy` 不会调；Home 键、最近任务切走（onStop 且未 finishing）**仍不卸载**；再从桌面图标回来，下次翻译会自动重新加载（首次多约 2.7 秒）；华为“最近任务”划掉是系统直接杀进程，不走 onDestroy（内存随进程一并回收）。
- **回收实测（STG-AL00，`/proc/<pid>/status` 与 `smaps_rollup`，口径见 status.md）**：冷启动基线 VmRSS 193MB；两模型都加载 604MB；卸载后（含 `M_PURGE`）217MB，比基线多约 24MB。不做 `M_PURGE` 时卸载后只回落到 495MB（比基线高约 300MB，全是匿名页，分配器没还）。调试：`adb shell "am broadcast -a com.let188.arkli.debug.CMD --es cmd finish"`（仅 debug）模拟正常退出，logcat 看 `ArkliAi : 回收 AI 会话（activity-finish）`。

约定与取舍：
- **清单**：API 30+ 的包可见性限制下，探测 `ACTION_PROCESS_TEXT` 响应者需要清单 `<queries>` 声明该 Intent（`text/plain`），已加。
- 校验、可用性汇总、能力合并、结果序列化是纯函数（`AiPolicy`），登记处是 `ProviderRegistry`，都有 JVM 单测。
- **ORT 运行时**：随包的 `libonnxruntime.so`（sherpa-onnx 1.13.8 的 ORT 1.28.2，arm64，22.25MB）由 Gradle 任务 `fetchOrtRuntime` 构建时下载并校验 sha256，见 `app/build.gradle.kts`；Rust 的 `ort`（load-dynamic）以**裸名** `libonnxruntime.so` dlopen，真机上从 APK 内直接映射（`/proc/<pid>/maps` 里能看到 APK 内该 so 的偏移）。不要再加 `onnxruntime-android` AAR。
- **debug 真机验证**：现在走 `native.model.ensure` 下载（见下节与 [模型下载管理](model-download.md)）；仍想手动放文件时，debug 构建下用 adb 放到约定目录，再 `native.model.verify`：`adb push q4_half.onnx /data/local/tmp/` 再 `adb shell run-as com.let188.arkli mkdir -p files/models/siglip2-q4_half`，然后 `adb shell "run-as com.let188.arkli cp /data/local/tmp/q4_half.onnx files/models/siglip2-q4_half/q4_half.onnx"`（Git Bash 下给 adb 的 `/data/...` 路径要设 `MSYS_NO_PATHCONV=1`）。图片放到应用缓存 `cache/arkli/pick/dbg/` 后，用已有的调试广播调用：`adb shell am broadcast -a com.let188.arkli.debug.CMD --es cmd rpc --es method native.ai.classify --es params '{"path":"cache/pick/dbg/a.jpg"}'`，结果在 logcat 的 `DBGMSG` 行。release 包没有这些调试钩子。
- **本地翻译真机验证（debug）**：模型 6 个文件放到 `files/models/nllb600m-un6-ccm-int4/`（`adb push` 到 `/data/local/tmp/nllb/` 再 `run-as com.let188.arkli cp`，Git Bash 设 `MSYS_NO_PATHCONV=1`），`native.model.verify` 变 `installed`，再用调试广播：`adb shell "am broadcast -a com.let188.arkli.debug.CMD --es cmd rpc --es id t1 --es method native.ai.translate --es params '{\"text\":\"Hello world.\",\"src\":\"en\",\"tgt\":\"fr\"}'\"`（**整条命令要作为一个字符串交给 adb shell**，params 里有空格时否则会被设备端 shell 拆开，广播变成 `dat=src:en` 而没有任何回应），结果在 logcat 的 `DBGMSG` 行（`\"id\":\"t1\"`），模型加载耗时在 `ArkliTranslate` tag。
- **本地翻译模型授权（CC-BY-NC-4.0，待在下载界面落地）**：NLLB 权重许可为署名-非商业 4.0，必须在 AI 中心下载本模型的界面显示下列授权说明（内容取自模型包 `NOTICE.txt`）：①仅限非商业使用，不得用于生产部署（原模型卡声明其面向研究用途，本模型包沿用同样限制）；②来源：Meta FAIR NLLB 团队的 NLLB-200-distilled-600M（<https://huggingface.co/facebook/nllb-200-distilled-600M>，论文 <https://arxiv.org/abs/2207.04672>），许可 CC BY-NC 4.0；③修改说明：词表裁剪到 61795 项并重映射 id（按 CCMatrix 词频保留，另含合并中间项与单字）、导出 ONNX（encoder 与带 KV cache 的 merged decoder）、int4 量化（MatMulNBits 对称 RTN，块大小 32）、权重存为外部数据文件、新增 `model.json`，未做任何再训练或微调，修改后权重的输出可能与原模型不同；④免责：与 Meta / NLLB 团队无隶属、背书或赞助关系，按“现状”提供，译文可能出错或有偏见。许可证全文 `LICENSE-CC-BY-NC-4.0.txt`（19,347 字节）与 `NOTICE.txt` 不进设备（models.json 的 files 只列设备必需的 6 个文件），界面里按上面内容展示并链到原模型页。同时：这是**用户已知的商用风险**，App 若走商业发布需换模型或另获授权。
- 预留位置（未实现，代码里没有 ML Kit 类）：`MlKitGenAiProvider`（谷歌 ML Kit GenAI / AICore，依赖白名单机型，要提 minSdk）、其他本地 ONNX 任务（OCR、对联）、在线 OpenAI。接入时只需新增 `AiProvider` 实现并注册，桥方法与页面不改。

## 模型下载管理方法

前端封装在 `web/src/native/model.ts`（`modelList` / `modelStatus` / `modelEnsure` / `modelCancel` / `modelRemove` / `modelVerify`）与 `web/src/stores/models.ts` 的 `useModelsStore`（唯一状态源）。代码在 `com.let188.arkli.model`，设计、安全与验证见 [模型下载管理](model-download.md)。全部只接受主 frame（`PERMISSION_DENIED`）。**页面只传模型 `id`，不能传 URL**；下载地址只来自随包清单 `assets/ai/models.json`；返回值不含任何磁盘路径。下载在原生自己的协程里跑，不随页面会话关闭而取消，页面重载后 `status` 接着看；因为会话级的事件推送在页面关掉后会丢，所以页面启动时用 `native.model.list` 取一次快照，之后靠 `model.changed` 事件实时更新（`ensure` 仍立即返回）。

通用的 `data`（下面称**模型状态**）：`{ id, displayName, version, state, totalBytes, downloadedBytes, diskBytes, phase?, speedBps?, error? }`

- `state`：`absent` 未安装（可能留有 `.part` 可续传，`downloadedBytes` 即其长度）/ `downloading` 下载或校验中 / `installed` 已安装且校验通过 / `unverified` 文件齐全但没有有效校验标记（如手动放进去的）/ `corrupt` 有文件长度不对。页面遇到不认识的值按“不可用”处理。
- `downloadedBytes`：已落地字节（完整文件算全长，否则取 `.part` 长度）；`diskBytes`：磁盘占用（含 `.part`），用来展示“占用空间”。
- `phase`、`speedBps` 只在 `downloading` 时有：`phase` 为 `download` 或 `verify`，`speedBps` 为本次任务的平均速度（字节/秒）。
- `error` 是**最近一次下载失败**的原因 `{ code, message }`，开始新下载或删除后清除；取消不算失败。`code` 取 `NO_SPACE`（剩余空间不足 1.2 倍）/ `NETWORK`（网络错误或所有源失败）/ `HASH_MISMATCH`（sha256 不一致）/ `SIZE_MISMATCH`（服务器长度与清单不符）/ `SOURCE_REJECTED`（地址或重定向被白名单拒绝）/ `INTERNAL`。

| 方法 | params | 成功时的 data | 错误 |
|---|---|---|---|
| `native.model.list` | `{}` | `{ models: [模型状态] }`，与清单同序 | 仅主 frame 限制 |
| `native.model.status` | `{ id }` | 模型状态 | `BAD_PARAMS`（`id` 缺失、不是字符串或不在清单里） |
| `native.model.ensure` | `{ id }` | 模型状态 + `started`（本次是否真的启动了任务）+ `meteredHint`（当前是否计费网络，页面自行决定要不要提醒，原生不拦截）。幂等：`installed` 或已在下载直接返回；`unverified` 只做校验；其余启动下载，有 `.part` 就续传。**立即返回**，失败原因之后从 `status` 的 `error` 读 | `BAD_PARAMS` |
| `native.model.cancel` | `{ id }` | 模型状态（幂等）。保留 `.part`，下次 `ensure` 续传 | `BAD_PARAMS` |
| `native.model.remove` | `{ id }` | 模型状态（`absent`、占用 0）。先取消下载，再释放已加载的推理会话（识物是 `clip_unload`，排在重任务闸门后），最后删清单列出的文件、`.part` 与校验标记，不递归 | `BAD_PARAMS`；`INTERNAL`（有文件删不掉） |
| 事件 `model.changed` | 原生推送 | 与 `native.model.status` 同形的模型状态；下载进度约 300 毫秒一条，开始、完成、失败、取消、删除、校验即时推送。管理器进程单例、桥每会话一个，后建的会话接管推送 | — |
| `native.model.verify` | `{ id }` | 模型状态。重算 sha256（真机 STG-AL00 上 54MB 整次调用约 1.5 秒，含 0.5 秒的轮询粒度），通过则写校验标记变 `installed`；**不通过则删除该文件**并记 `HASH_MISMATCH`；文件不齐全则不动 | `BAD_PARAMS`；`NOT_READY`（正在下载） |

下载器行为（细节与取舍见 [模型下载管理](model-download.md)）：只用 `HttpURLConnection`（经 `HttpTransport`）；每一跳（含 302）都要求 https、主机精确命中 `NetPolicy.DOWNLOAD_HOSTS`（`github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`，与页面出站白名单和 CSP 分开）；最多 5 跳；`Range` 断点续传，服务器忽略 Range 就从头来；多个下载源按序回退；每源连续 3 次无进展才换源，退避 1/2/4/8 秒；下载前要求可用空间 ≥ 待下载字节 × 1.2；完成后 sha256 校验再原子改名；同一模型同一时刻只有一个任务。清单里的 URL 目前是占位，托管 release 尚未发布。

## 文件夹清理方法

前端封装在 `web/src/native/dir.ts`，代码在 `com.let188.arkli.dircleaner`。全部只接受主 frame，参数错误 `BAD_PARAMS`。**只用 SAF 授权（`ACTION_OPEN_DOCUMENT_TREE`），不申请任何存储权限**，只用 `DocumentsContract` / `ContentResolver`，不引入 `androidx.documentfile`。

页面拿到的 `token` 是随机不透明串（`dir:<hex>`），真实目录 URI 只留在原生侧（`SharedPreferences` 持久化 token 到 URI 与显示名）。令牌不存在，或系统已撤销该目录的持久授权，调用返回 `BAD_PARAMS`（message 提示重新选择）。

| 方法 | params | 成功时的 data |
|---|---|---|
| `native.dir.pick` | `{}` | `{ token, name }`；用户取消为 `{ token: null, name: null }`。经 `ActivityHost.pickDirectory()` 拉起系统文件夹选择器（与媒体选择器一样单槽位，已有选择器在显示抛 `NOT_READY`），随后 `takePersistableUriPermission(READ\|WRITE)`；同一目录重复选择复用原令牌 |
| `native.dir.list` | `{}` | `{ items: [{ token, name }] }`。顺手清掉系统已撤销授权的记录 |
| `native.dir.forget` | `{ token }` | `{ forgotten: boolean }`。释放持久授权并删记录，不动目录里的文件 |
| `native.dir.scan` | `{ token, mode: "large"\|"empty"\|"apk"\|"all", minBytes?: number = 52428800, maxItems?: number = 2000（1~5000）, maxDepth?: number = 12（1~20） }` | `{ items: [{ id, name, relPath, bytes, lastModifiedMs, isDir }], scanned, truncated }` |
| `native.dir.delete` | `{ token, ids: string[]（1~500，去重） }` | `{ deleted, freedBytes, failed: [{ id, message }] }` |

**`native.dir.scan` 细节**

- 用 `buildChildDocumentsUriUsingTree` + `query`（`DOCUMENT_ID / DISPLAY_NAME / MIME_TYPE / SIZE / LAST_MODIFIED`）做**非递归的迭代遍历（显式栈）**，节点总数上限 50000，超过即停并 `truncated:true`。可取消（协程取消即停），每遍历 500 个节点推一次事件 `dir.progress`，data 为 `{ scanned }`。
- `large`：`size >= minBytes` 的文件，按大小降序；大小未知的文件不算。`empty`：0 字节文件，以及**不含任何文件的空文件夹**（自底向上判定：子项全是空文件夹也算空；读不了、被层级或节点上限截断而没列出子项的文件夹一律不算空）。`apk`：mime 为 `application/vnd.android.package-archive` 或扩展名 `.apk` / `.apks` / `.xapk`，按大小降序。`all`：不筛选，文件与文件夹都列，按路径排序。
- 命中数超过 `maxItems` 时截断并 `truncated:true`；有文件夹因超过 `maxDepth` 或读取失败没下探，同样 `truncated:true`。所选文件夹本身读不了返回 `INTERNAL`（子文件夹读不了只记为未探索）。
- `id` 是本次扫描内的不透明句柄（`it:<hex>`），原生侧登记它对应的文档；每个令牌只保留最近一次扫描结果，会话关闭时清空。

**`native.dir.delete` 细节**

- **删除不可恢复**：走 `DocumentsContract.deleteDocument`，不经回收站。前端必须在调用前做二次确认并写明「删除后无法恢复」。
- 每个 id 必须属于该令牌**最近一次扫描**的结果，否则记入 `failed`（message「不在最近一次扫描结果里」），防止页面伪造。逐个处理，单个失败不影响其余，可取消（取消后已删的无法恢复）；成功的 id 从登记里移除。层级深的先删，免得先删父文件夹让子项失败。
- `freedBytes` 只累计成功删除的文件大小（文件夹按 0 计）。

**未在真机验证的点**：各厂商文件管理（如华为）对 SAF 目录授权的支持与「禁止授权根目录 / Download」的限制；大目录（数万节点）的遍历耗时；SAF 删除后媒体库（相册、音乐）是否即时刷新，取决于 provider。

## 噪音测量方法

前端封装在 `web/src/native/noise.ts`，代码在 `com.let188.arkli.noise`。全部只接受主 frame。

**数值是未校准的近似值**：`AudioRecord`（`MIC` 源，16kHz 单声道 16bit）按窗口算 RMS，`rmsDbfs = 20·log10(rms/32768)`（静音取下限 -120），`db = rmsDbfs + 90` 夹到 0~140，`peakDb` 同法取窗口峰值。不同机型麦克风灵敏度、自动增益差别很大，读数只能做相对比较与粗略参考，不是声级计。页面须显著注明这一点，并提供校准偏移。

| 方法 | params | 成功时的 data | 错误 |
|---|---|---|---|
| `native.noise.start` | `{ intervalMs?: number = 100（50~1000） }` | `{ started: true, sampleRate }`。之后每个间隔推事件 `noise.sample`，data 为 `{ db, peakDb, rmsDbfs }` | `BAD_PARAMS`；没有 `RECORD_AUDIO` 时先经 `ActivityHost.requestPermission` 申请，被拒 `PERMISSION_DENIED`（message 含 `reason:denied`）；同一会话已有一路在测、麦克风被占用或初始化失败 `NOT_READY` |
| `native.noise.stop` | `{}` | `{ stopped: true }`，等 `AudioRecord` 释放后才返回（最多等 3 秒）；没在测也返回 | 无 |

采集在 `Dispatchers.IO` 的会话任务里跑；**stop、协程取消、会话关闭（页面重载 / 渲染进程崩溃）都会停止并释放 `AudioRecord`**。清单新增 `RECORD_AUDIO`，并声明 `android.hardware.microphone` 为非必需。

**未在真机验证的点**：各机型对 16kHz 的支持与实际采样率；部分系统在后台或通话中给静音数据；自动增益（AGC）与降噪对读数的影响；与他应用同时占用麦克风时的行为。

## 语音转文字方法

前端封装在 `web/src/native/speech.ts`，输入框组件 `web/src/shared/VoiceInput.vue`，代码在 `com.let188.arkli.speech`。全部只接受主 frame。

本地流式识别：sherpa-onnx `OnlineRecognizer`（zipformer2 transducer，中英文，标点在 token 里，80 维 fbank，16kHz）。模型在 `filesDir/models/asr-zipformer-zh-en-int8/`（`encoder.int8.onnx`、`decoder.onnx`、`joiner.int8.onnx`、`tokens.txt`），**目前由手动放置，暂未接 `native.model.*` 下载清单**；文件缺失或小于预期大小一律视为未就绪。**音频只在内存里流转，不落盘、不上传。**

| 方法 | params | 成功时的 data | 错误 |
|---|---|---|---|
| `native.speech.status` | `{}` | `{ available, engine: 'local-zipformer', modelReady, reason? }`；`available` = 模型文件齐全且 sherpa 库能加载；不加载模型，很快 | 无 |
| `native.speech.start` | `{ lang?: 'zh-en' }` | `{ started: true, sampleRate: 16000, taskId }`，麦克风真正开始录音后才返回（首次要加载约 170MB 模型，约 4~5 秒）。之后推事件 `speech.partial { text }`（当前这句的中间结果，会反复修正）与 `speech.final { text }`（一句话定稿：检测到停顿 endpoint，或停止时的最后一句） | `BAD_PARAMS`；没有 `RECORD_AUDIO` 时经 `ActivityHost.requestPermission` 申请，被拒 `PERMISSION_DENIED`；模型缺失 / 加载失败 / 已在听写 / 麦克风被占用或初始化失败 `NOT_READY`（message 说明原因） |
| `native.speech.stop` | `{}` | `{ text }`：整段定稿文本。冲刷剩余音频（补 0.66 秒静音）后才返回，最多等 8 秒；没在听写则返回上次的文本 | 无 |

- 同一会话同一时刻只允许一路；重复 `start` 返回 `NOT_READY`。
- 采集在 `Dispatchers.IO`：每 100ms 读一块喂识别流。**stop、`native.task.cancel { id: taskId }`、会话关闭（页面重载 / 销毁 / 崩溃）都会停止并释放 `AudioRecord` 与识别流**（取消与会话关闭不冲刷、不再推事件）。
- 识别器懒加载、进程内复用，空闲 60 秒自动释放；加载排在 `AiHeavyGate` 之后（与识物不同时加载），会话期间不占闸门。
- 中间结果要追加到「听写前已有文本」之后，不能覆盖；文本合并规则见 `TranscriptMerger`（原生）与 `voice-input.ts`（前端）：交界两侧都是 ASCII 字母数字时补空格，其余直连。

使用示例（`VoiceInput` 与 `van-field` 的 v-model、placeholder、type、maxlength 等属性一致；语音不可用时不显示麦克风）：

```vue
<script setup lang="ts">
import { ref } from 'vue'
import VoiceInput from '@/shared/VoiceInput.vue'
const text = ref('')
</script>
<template>
  <voice-input v-model="text" type="textarea" rows="3" placeholder="点右侧麦克风说话" maxlength="500" />
</template>
```

也可以直接用封装：

```ts
import { getSpeechStatus, startSpeech, stopSpeech, onSpeechPartial, onSpeechFinal } from '@/native/speech'
if ((await getSpeechStatus()).available) {
  const offP = onSpeechPartial((t) => (live.value = t))
  const offF = onSpeechFinal((t) => lines.push(t))
  await startSpeech()
  // ……用户说完
  const { text } = await stopSpeech()
  offP(); offF()
}
```

**未在真机验证的点**：麦克风口述的实际识别质量（debug 命令 `asrwav` 已用 4 条 test wav 走同一解码路径验证，RTF 约 0.25）；嘈杂环境、蓝牙耳机作为输入源；与通话、其他录音应用同时占麦克风时的行为；`native.model.*` 下载接入后的就绪判定。

## 二维码识别方法

前端封装在 `web/src/native/qrcode.ts`，代码在 `com.let188.arkli.qrcode`。全部只接受主 frame。解码用 zxing-cpp，formats 留空识别全部码种；一帧里有多个码时全部返回。

| 方法 | params | 成功时的 data | 错误 |
|---|---|---|---|
| `native.qrcode.scan` | `{}` | `{ cancelled: boolean, results: [{ text, format, bytes }] }`。拉起全屏取景页，识别到码即返回；`format` 为 zxing-cpp 枚举名（`QR_CODE`、`EAN_13` 等），`bytes` 为原始字节 base64。用户返回键取消时 `cancelled` 为 true | 相机权限被拒 `PERMISSION_DENIED`；已有扫码页在显示 `NOT_READY` |
| `native.qrcode.decodeImage` | `{ path: string }`（缓存路径，如选图得到的 `cache/pick/...`） | `{ results: [{ text, format, bytes }] }`，没识别到为空数组 | `BAD_PARAMS`（路径不在缓存内、文件不存在、无法解码） |

实时取景把 `tryHarder/tryRotate/tryInvert` 关掉保帧率；相册识图全部打开，大图先降采样到约 4096 边长。扫码页自己申请相机权限，清单新增 `CAMERA`，相机与自动对焦声明为非必需硬件。

**未在真机验证的点**：低端机帧率与发热、反色码、小码、强反光、扫码页返回键与 WebView 路由的配合、HEIC 等选图结果的识别。

## 通用相机方法

前端封装在 `web/src/native/camera.ts`，代码在 `com.let188.arkli.camera`。全部只接受主 frame。拍照用 CameraX `ImageCapture`，录像用 `VideoCapture`（依赖 `camera-video`，版本沿用 `camerax`）。

| 方法 | params | 成功时的 data | 错误 |
|---|---|---|---|
| `native.camera.capture` | `{ modes?: ('photo'\|'video'\|'album')[], facing?: 'back'\|'front', maxDurationSec?: number, lensSwitch?: boolean }`。`modes` 至少一项、不重复，默认 `['photo']`，多于一个拍照/录像时界面可切换；含 `album` 时显示相册入口；`facing` 默认 `back`；`maxDurationSec` 默认 60、上限 300，到点自动停止；`lensSwitch` 默认 true | 拍到：`{ kind: 'image'\|'video', path, name, mime, size, width, height, durationMs? }`；用户取消：`{ cancelled: true }`；点相册：`{ album: true }`（网页再调 `native.file.pick`） | `modes` 为空、含未知值或重复、其他参数类型不对 `BAD_PARAMS`；相机权限被拒 `PERMISSION_DENIED`；无相机或初始化失败 `INTERNAL`；已有相机页在显示 `NOT_READY` |
| `native.camera.clear` | `{}` | `{ cleared: true, count }`，`count` 是删除的文件数 | - |

- **隐私硬约束**：产物只写 `cacheDir/arkli/pick/cam/cam_<随机>.jpg|.mp4`，页面路径 `cache/pick/cam/...`，绝不写入 MediaStore 或任何持久目录。每次 `capture` 开始前先清空该目录；`clear` 清空该目录；App 启动清理也清空它。
- 照片的 `width` / `height` 已按 EXIF 方向摆正（JPEG 里保留 EXIF 方向标记，后续解码同样会摆正）；视频宽高已按旋转角调整，`durationMs` 为时长。
- 录像需要 `RECORD_AUDIO`：相机页打开时申请，被拒则静音录制，不报错。
- 垃圾分类页只传 `modes: ['photo','album']`；离开页面、选到新图后调用 `native.camera.clear`。

**未在真机验证的点**：各机型前后摄切换、录像到点自动停止、前置摄像头 EXIF 镜像、录音权限拒绝后的静音录制。

## 获取壁纸方法

前端封装在 `web/src/native/wallpaper.ts`，代码在 `com.let188.arkli.wallpaper`。只接受主 frame，**不申请新权限**（清单里 API ≤ 32 的 `READ_EXTERNAL_STORAGE` 够用即可）。

| 方法 | params | 成功时的 data |
|---|---|---|
| `native.wallpaper.get` | `{}` | 读到：`{ available: true, path, width, height, kind: "current"\|"default" }`；没读到：`{ available: false, reason: "restricted"\|"unsupported"\|"error", message }` |

- **受 Android 版本限制**：API 33 及以上，系统通常只把默认壁纸交给没有特殊权限的应用，甚至直接抛 `SecurityException`。尽力读取：先试 `WallpaperManager.getWallpaperFile(FLAG_SYSTEM)`（有文件即为当前壁纸，`kind:"current"`），读不到再用 `getDrawable()`（API 33+ 这条路径按 `kind:"default"` 处理）。
- **任何异常都转成 `available:false`，不抛错**：`SecurityException` 为 `restricted`，`UnsupportedOperationException` 与 `isWallpaperSupported=false` 为 `unsupported`，其余 `error`；只有协程取消照常抛出。
- 成功后压成 PNG 写入缓存 `out/wallpaper/wallpaper-<毫秒时间戳>.png`（每次先清掉旧文件），页面用 `/files/<path>` 显示。像素超过 2400 万：走文件时按 2 的幂 `inSampleSize` 缩小解码，走 Drawable 时按比例缩小重绘，`width` / `height` 是缩小后的尺寸。

**未在真机验证的点**：各 Android 版本与厂商 ROM（动态壁纸、主题壁纸、双层壁纸）的读取结果；`getWallpaperFile` 在 API 33+ 的实际行为。

## 视频与音频方法

前端封装在 `web/src/native/media.ts`，代码在 `com.let188.arkli.media`。全部只接受主 frame，参数错误 `BAD_PARAMS`。**只用 Android 平台自带的 `MediaExtractor` / `MediaMuxer` / `MediaCodec` / `MediaMetadataRetriever`，不引入任何第三方依赖**；原计划的 Media3 Transformer 尚未获批，批准后可整体替换内部实现，协议不变。

所有 `handle` 都是 `native.file.pick`（`mime: "video/*"`）返回的视频句柄（`uri:<id>`）。`FileModule.install` 现在返回本会话的句柄表，`MediaModule.install(bridge, env, handles)` 与它共用同一张表；句柄无效返回 `BAD_PARAMS`。产物写在缓存 `out/` 下，返回页面缓存相对路径（`cache/out/...`），可交给 `native.file.save`（音频进 `Music/Arkli`，视频进 `Movies/Arkli`）或 `native.share`。

| 方法 | params | 成功时的 data |
|---|---|---|
| `native.media.info` | `{ handle }` | `{ durationMs, width, height, rotation, bitrate, sizeBytes, hasAudio, videoMime, audioMime, fps }`；宽高已按旋转摆正，读不到的字段为 `null`，不抛错 |
| `native.media.extractAudio` | `{ handle, startMs?, endMs? }` | `{ path, name, mime: "audio/mp4", bytes, durationMs }` |
| `native.media.frames` | `{ handle, startMs? = 0, durationMs? = 3000（1~15000）, fps? = 8（1~15）, maxEdge? = 320（32~480） }` | `{ frames: [{ path, timeMs }], width, height }` |
| `native.media.compress` | `{ handle, preset: "high"\|"medium"\|"low" }` | `{ path, name, bytes, srcBytes, ratio, durationMs, message? }` |

**进度与取消**：`extractAudio` / `frames` / `compress` 是长任务。进度事件 `media.progress`，data 为 `{ done, total }`（音频与压缩是已处理毫秒 / 总毫秒，取帧是已取帧数 / 总帧数），至多每 200ms 一次，结束时再补一次。页面用 `AbortSignal` 取消（协程取消即停），原生停下后删除半成品文件与目录。

**`native.media.extractAudio`**：只支持 **AAC（`audio/mp4a-latm`）直通**，把已编码样本原样写进 `.m4a`（`MUXER_OUTPUT_MPEG_4`），不重编码。其他编码（amr、opus、mp3 等）与无音轨都返回 `BAD_PARAMS`，message 如「该视频的音轨编码暂不支持直接提取」。`startMs/endMs` 裁剪：`seekTo` 到起点前的同步样本，再按样本时间过滤，输出时间戳减去起点；终点超过时长自动收到时长；`endMs <= startMs` 或起点不在视频内为 `BAD_PARAMS`；窗口内没有音频样本为 `BAD_PARAMS`。文件名取源名主体（经文件名清洗）加 `.m4a`。

**`native.media.frames`**：`getScaledFrameAtTime`（API 27+，更低先 `getFrameAtTime` 再缩放），`OPTION_CLOSEST`，按 `1000/fps` 毫秒取样，只缩小不放大、保持比例，JPEG 质量 90，写到 `out/frames-<随机>/f000.jpg …`。**总帧数上限 150**（超出时间窗内的部分被截掉）；帧总像素超过 `150 × 480 × 480` 为 `BAD_PARAMS`；起点超出视频时长为 `BAD_PARAMS`。页面用 `fetch('/files/' + path)` 取回帧，再喂给 JS 的 GIF 编码器。

**`native.media.compress`**：纯平台 API 转码，**不缩放分辨率**，只降码率。`MediaExtractor` 取视频轨与音轨；`MediaCodec` 解码器的输出 Surface 直接是 H.264 编码器（`createInputSurface()`）的输入 Surface，解码器 `releaseOutputBuffer(index, 样本时间戳 × 1000)`；目标码率 = 源视频码率 × 系数（high 0.7 / medium 0.5 / low 0.3），不低于 300kbps，且不超过源码率；`I_FRAME_INTERVAL = 2`，帧率取源（读不到或不合理取 30），`COLOR_FormatSurface`，支持时用 VBR。旋转不转像素，用 `MediaMuxer.setOrientationHint` 写入，并把解码器格式里的旋转清零避免转两次。**音轨直通**（AAC / AMR 样本直接写入封装器，不重编码），与视频样本按时间戳穿插；其他音轨编码返回 `BAD_PARAMS`（不悄悄丢声音）。输出 `.mp4`（名为源名主体 + `_compressed`）。封装器在编码器报告输出格式后才 `start`。`ratio = bytes / srcBytes`，`ratio >= 1` 表示没压小，此时结果带 `message`（「视频已经压得很小了…」），文件仍保留，由页面决定是否保存。

**错误**：可解释的失败（编码器不支持该分辨率、没有视频轨、音轨编码不支持、句柄无效）为 `BAD_PARAMS`；设备编解码器或写文件出错为 `INTERNAL`，message 是中文提示（如「设备的视频编码器无法按当前参数压缩这个视频」「存储空间不足」）；转码 20 秒没有任何进展按卡死处理并中止。所有 `MediaCodec / MediaMuxer / MediaExtractor` 在 `finally` 里 stop / release，失败或取消时删除半成品。

**已知局限（以后可由 Media3 Transformer 替换）**：音频只直通 AAC，不能转码；压缩不缩放分辨率、不转 HEVC、不处理 HDR 色调映射；可变帧率按名义帧率重编码；取帧用 `MediaMetadataRetriever`，每帧一次 seek，较慢；压缩速度取决于设备编码器，约与视频时长相当。

**未在真机验证的点**：各机型 `MediaCodec` 解码器 Surface 直连编码器 Surface 是否可用；渲染时间戳（样本时间戳 × 1000）能否被编码器当作 pts；旋转视频（含 180°）输出方向；HEVC / HDR / 10-bit 源；可变帧率与时间戳不从 0 开始的视频；AAC 之外的音轨；`getScaledFrameAtTime` 的速度与旋转后的尺寸；编码器对码率与分辨率（奇数宽高）的支持；华为等厂商编码器的行为。**视频压缩是最需要真机验证的一项。**

## 页面侧用法示例

```ts
import { call } from '@/native/bridge'

// 调用 Rust 核心库做 OCR，参数为缓存目录里的图片相对路径
const { text } = await call('rust.ocr.recognize', { path: 'cache/in-001.png' })
```

## 原生侧注册示例

```kotlin
// 注册一个处理器，方法名与页面调用一致
bridge.register("native.clipboard.write", ClipboardWriteHandler())
```
