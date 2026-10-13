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
| `native.hello` | 无 | `{ "protocol": 2, "session": 1, "features": { "binary": false } }`。`binary` 为原生探测的 ArrayBuffer 支持情况，页面只能据此选帧类型 |
| `native.task.cancel` | `{ id }` | `{ "cancelled": true }` |
| `rust.core.version` | 无 | `{ "version": "0.1.0" }`，取自 Rust 核心库 |
| `native.file.pick` / `save` / `openWrite` / `write` / `closeWrite` | 见下节"文件方法" | |
| `native.image.compress` | 见"图片方法" | |

## 文件方法

以下方法都只接受主 frame（`CallContext.isMainFrame`），子 frame 调用返回 `PERMISSION_DENIED`。页面里的路径统一为 `cache/...` 相对路径（见"大数据"），原生一律规范化后限制在缓存目录内。

### `native.file.pick`
打开系统选择器。

| 项 | 说明 |
|---|---|
| params | `{ mime?: string = "image/*", multiple?: boolean = false, max?: number = 20 }`。`mime` 取值：`image/*`、`video/*`、`image/*,video/*`、具体媒体类型（如 `image/png`）走 Photo Picker；其他（如 `text/plain`、`*/*`）走系统文档选择器。`max` 上限 50 |
| 返回 | `{ items: Item[], failed: { name, message }[] }` |
| 图片 Item | `{ kind: "image", path, url, name, mime, size, width?, height?, orientation }`。文件原样拷进 `cache/pick/`（保留 EXIF），≤ 128MB，超过进 `failed`。`width/height` 是按 EXIF 方向摆正后的显示尺寸，`orientation` 为 EXIF 方向值 1~8；页面用 `createImageBitmap(..., { imageOrientation: 'from-image' })` 摆正 |
| HEIC/HEIF | API 28+ 用平台 `ImageDecoder` 转成 JPEG（质量 92，输出已摆正且不带 EXIF，`orientation` 恒为 1，`name` 扩展名换成 `.jpg`）；超过 2500 万像素按采样率缩小防 OOM。API 24~27 无法转换，该文件进 `failed` 并提示换格式 |
| 视频 Item | `{ kind: "video", handle: "uri:<随机 id>", name, mime, size, width?, height?, durationMs? }`。不拷贝、不读入内存，真实 content URI 只存在原生侧的会话句柄表里，页面拿不到；句柄随会话失效，只能交给原生方法使用 |
| 其他文件 Item | `{ kind: "file", path, url, name, mime, size }`，≤ 64MB 拷进缓存，更大的进 `failed` |
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

约定与取舍：
- **像素上限**：解码后像素数不得超过 6400 万（与 web 侧 `MAX_CANVAS_PIXELS` 一致），超过时需要设置更小的 `maxEdge`，否则该张 `BAD_PARAMS`。PNG 路径要把像素读成 `IntArray`，上限更低：1600 万像素（约 64MB），超过同样要求设 `maxEdge`。
- **JPEG 与透明**：JPEG 不支持透明，透明区先铺白底。WebP、PNG 保留透明。
- **WebP**：API 30+ 用 `WEBP_LOSSY`，更低版本用旧的 `WEBP`（同样是有损）。
- **HEIC**：API 28+ 由 `ImageDecoder` 解码；24~27 解不了，该张 `INTERNAL`，message 提示需要 Android 9 及以上。
- **EXIF 方向**：解码时按 EXIF 摆正，输出像素即显示方向。
- **PNG 缩色的取舍**：自写量化器，不引 libimagequant（GPL）等库。alpha 当第 4 个通道参与聚类，alpha 为 0 的像素统一归一不占调色板名额，调色板按 alpha 升序放，tRNS 只写前缀。直接在 sRGB 通道上做，不做感知色彩空间转换，视觉质量略逊于 pngquant。**缩色对照片、噪声类图能明显省体积，对平滑渐变反而可能更大**（量化出的色带打乱了滤波与 Deflater 依赖的规律，抖动尤其明显）；页面应在选择缩色时提示，并在结果比原图大时给出提示。
- **成品生命周期**：成品落在缓存根的 `out/`，与其他缓存产物一样受缓存清理策略管理（保留 24 小时，超总量时最近 10 分钟写入的不动）。页面拿到结果后回显与保存都在这个窗口内；窗口外再用需要重新压缩。

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
