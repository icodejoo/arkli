---
title: 公共基础设施草案
status: draft
updated: 2026-10-13
summary: 六份工具设计共同依赖的底层能力：bridge 协议 v2、统一方法表、安全策略、权限、模型与数据包管理、长任务、缓存、实施顺序
---
## TL;DR
- 六份工具设计都卡在同几件事：页面传不了二进制、处理器只能同步返回、没有取消和订阅约定、联网口子没定。本文一次性补上。
- 方向：bridge 协议升到 v2（向后兼容 v1），通道建议换成 `WebMessageListener`（可限来源、能传 ArrayBuffer）；联网以原生为主，页面出站只放行少数支持 CORS 的白名单接口（汇率）。
- 前提：[工具总览](tools-overview.md) 的两个阻塞决定已由用户确认（2026-10-13）：通道升级为 `WebMessageListener`，加 INTERNET。标了"待 spike 验证"的点要先在真机上验证再动工。
- 现有协议见 [Bridge 协议](bridge-protocol.md)，确认后在那里更新，本文不重复 v1 内容。

## 一、协议 v2 的变化

| 变化 | 内容 | 原因 |
|---|---|---|
| 异步处理器 | `BridgeHandler.handle` 改为挂起函数，带调用上下文（会话号、请求 id、取消信号）；耗时方法也可以先回 `{ taskId }`，再用事件推进度和结果 | 权限申请、选文件、扫描、视频处理都要等用户或 IO |
| 通用取消 | 任何带请求 id 的调用可用 `native.task.cancel { id }` 取消；新增错误码 `CANCELLED`、`NETWORK` | 网络、视频、AI 推理都要能取消 |
| 长任务不设超时 | 标记为长任务的方法不套 30 秒超时，靠事件和 `native.task.status` 恢复 | 视频压缩等动辄几分钟 |
| 事件带订阅号 | 订阅类方法返回 `{ sub }`，事件 data 带 `sub`；原生按"页面会话号"自动清理，WebView 重载或崩溃后会话号递增，旧订阅作废 | 传感器、下载进度会反复订阅 |
| 生命周期事件 | `app.pause` / `app.resume` 推给页面 | `visibilitychange` 在 WebView 里不一定可靠（推测） |
| 二进制通道 | 见下 | Canvas 产出的图片、画板导出要写进缓存 |
| 不透明句柄 | `native.file.pick` 对大文件（视频）返回 `uri:<随机 id>`，原生侧映射到 content URI，页面拿不到真实路径，只能交给原生方法使用 | 几百 MB 到 GB 级视频不该整份拷进缓存 |
| 页面可读 URL | 用 WebViewAssetLoader 的 PathHandler 暴露只读路径：缓存产物 `/files/cache/**`（支持 Range，视频预览要用）、数据包 `/files/packs/**` | 页面直接用 `<img>`、`<video>`、`fetch` 读 |

### 二进制上传（页面 → 原生）
**spike 实测结论（真机 STG-AL00，华为 WebView Chromium 114，详见 [spike 报告](../research/spike-webmessage-arraybuffer.md)）：`WebMessageListener` 作 JSON 通道可行，但这台机器不支持 ArrayBuffer 消息（`WEB_MESSAGE_ARRAY_BUFFER` 为 false），不能把 ArrayBuffer 当协议前提。**

按文件大小分三档：

| 档位 | 方式 | 实测吞吐 | 说明 |
|---|---|---|---|
| 小到中（几十 MB 内） | 分块发"字符串帧"：每块约 1MB，每个字符对应一个字节（latin1），帧头带 `handle` 与 `seq` | 约 21 MB/s | 64KB 到 50MB 五个尺寸 sha256 全部一致、无乱序 |
| 同上，支持 ArrayBuffer 的设备 | 原生探测到 `WEB_MESSAGE_ARRAY_BUFFER` 为 true 时改发 ArrayBuffer 帧 | 未实测（本机不支持） | 只作可选加速，用前必须探测 |
| 兜底 | JSON 里放 base64 分块，每块约 192KB，流水线发送 | 约 14 MB/s（串行等回包仅 4~7 MB/s） | 慢但最通用 |
| 大（几十 MB 以上） | 回环 HTTP：App 内只绑 `127.0.0.1` 的小服务，页面 `fetch(POST, body=Blob)` | 约 88~91 MB/s，渲染进程内存基本不涨 | 需要 INTERNET（已确认加）、network security config 只放行 `127.0.0.1` 的明文、一次性随机 token；或改用 `pick` 返回的不透明句柄让原生直接读 |

流程：`native.file.openWrite { name, size?, sha256? }` 拿 `{ handle }` → 分块发 `native.file.write { handle, seq, offset, data, encoding }`（字符串帧，每块 1MB，每个请求有确认）→ `native.file.closeWrite { handle }` 得 `{ path, url, size, sha256 }`。契约见 [Bridge 协议](bridge-protocol.md)「文件方法」。

**必须遵守的约束**
- **探测以原生为准**：新增 `native.hello`，返回 `binary` 能力字段（是否支持 ArrayBuffer）。页面只能按它选择帧类型。
- **页面不探测就发 ArrayBuffer 会让整个 App 进程崩溃**（异常抛在 androidx 适配层，try/catch 接不住）。再加一层保险：用 `addDocumentStartJavaScript` 在页面侧挡掉非字符串消息，已验证有效。
- 国内机型大概率有一批停在老 WebView 上，要用 `binary` 字段做埋点，看兜底路径的实际占比。
- **分块是硬要求**：整块发送时，同一份 50MB 在渲染进程多占约 469MB、App 进程多占约 395MB（6~10 倍，随文件线性增长）；1MB 分块则内存近似恒定。引用传递在本机无法验证，跨进程至少要复制进 IPC 缓冲（推测），不指望它。
- 几十 MB 以上别硬走消息通道，走回环 HTTP 或不透明句柄。
- `shouldInterceptRequest` 看不到 POST body，也没有 Content-Length，不能靠拦截器收上传。

## 二、统一方法表

命名沿用 `域.模块.动作`。各份设计里的重复或近似命名已合并。

| 方法 | 谁用 | 说明 |
|---|---|---|
| `native.file.pick` | 图片、音视频、文本、编解码、备份 | 多选、mime 过滤；图片走 Photo Picker，无需权限；HEIC 在 API 28+ 自动转 JPEG；视频返回不透明句柄 |
| `native.file.pickDir` | 文件夹清理 | SAF 目录树，持久化授权，返回不透明 token |
| `native.file.save` | 图片、音视频、记账、画板 | API 29+ 走 MediaStore 无需权限；24~28 要存储写权限（`maxSdkVersion=28`）；默认目录 `Pictures/Arkli`、`Movies/Arkli` |
| `native.file.openWrite` / `closeWrite` | 画板、图片 Canvas 产物 | 见上 |
| `native.share` | 多数工具 | 分享文本或缓存文件（FileProvider） |
| `native.clipboard.read` / `write` | 多数工具 | `write` 支持 `sensitive: true`（API 33+ 设置敏感标记） |
| `native.permission.check` / `request` | 噪音测量、扫码、通知 | 含"永久拒绝后跳设置"分支 |
| `native.settings.open` | 权限引导 | |
| `native.screen.keepAwake` / `orientation` / `immersive` / `brightness` | 时间屏幕、手持弹幕、记分牌 | |
| `native.intent.openUrl` / `processText` / `view` | 扫码结果、翻译转交、快递 | 打开前由用户确认 |
| `native.camera.capture` | 证件照、识物 | 系统相机 Intent，结果写缓存，不申请 CAMERA |
| `native.haptic.vibrate` | 抽签、骰子、反应力 | |
| `native.alarm.*` / `native.notify.*` | 番茄钟、通知自己 | 闹钟加通知；点击通知通过 deep link 路由到指定工具 |
| `native.shortcut.pin` | 网页转应用 | |
| `native.sensor.subscribe` / `unsubscribe` | 尺子、指南针、水平仪等 | 原生 SensorHub 只保留每个传感器的最新值，按设定频率（上限 60Hz）发一条消息；页面退出或切后台自动注销 |
| `native.net.http` / `resolve` / `whois` | 网址探查、IP 查询、Whois、端口与 DNS | 可访问任意域名；统一超时、2MB 读取上限、手动跟随跳转、并发上限。汇率不走它，页面直接请求白名单接口 |
| `native.pack.ensure` / `list` / `delete` | AI 模型、词典与数据包 | 见第四节；事件 `pack.progress` |
| `native.task.status` / `cancel` | 视频、AI、下载 | 事件 `task.progress` / `task.done` / `task.error`，进度节流不超过 10Hz |
| `rust.*` | 计算类 | 同步短任务直接返回；长任务走 task |

## 三、安全
- **通道来源**：`WebMessageListener` 的 `allowedOriginRules` 只放 `https://appassets.androidplatform.net`，bridge 不会注入到其他来源的 frame。
- **页面出站只开白名单（2026-10-13 用户选定折中方案 B）**：一旦加 INTERNET，必须在 `shouldInterceptRequest` 里拦掉所有"非 appassets 域且不在白名单"的请求，CSP 为 `default-src 'self'; connect-src 'self' <白名单域名>; img-src 'self' blob: data:`。
  - **走原生**（`native.net.*`、`native.pack.*`）：ping、DNS、端口、Whois、任意网址请求（网址探查、网页源码、短链还原）、模型与数据包下载。浏览器做不了或会被跨域拦住。
  - **页面直接请求**：只放行少数**明确支持 CORS** 的 JSON 接口，目前只有汇率（Frankfurter 为主、ExchangeRate-API 为备）；落地前要逐个实测 CORS 头，不支持的退回原生。
  - 白名单写死在 CSP 和拦截规则里，改域名要发版。
  - JS 解释器所在的 Worker 单独加 `connect-src 'none'`，禁止出站。
- **JS 解释器工具**：必须跑在 Web Worker 里，不能放 iframe。spike 实测：新通道的 `ArkliNative` 只注入主页面和 `srcdoc` iframe（`srcdoc` 继承父来源，所以也拿得到），`data:`、sandbox、跨源 frame 和 Worker 里都没有；旧的 `@JavascriptInterface` 方案会注入所有 frame（Worker 除外），跨源 frame 的调用确实到了原生。
- **回环服务的安全**：只绑 `127.0.0.1`，每次上传一次性随机 token；network security config 只放行 `127.0.0.1` 明文，不全局放开；CSP 的 `connect-src` 要加上回环地址与端口。
- **`SpikeActivity`**：spike 代码里的清单声明是 `exported=true`，正式代码里不得保留。
- **路径**：原生方法收到的路径一律归一化，限制在缓存目录内；SAF 和大文件只用不透明句柄。
- **明文 HTTP**：默认不放开；API 24 机型补根证书的 network security config 要单独评估。
- **隐私政策**：联网工具（IPinfo、RDAP/WHOIS、汇率接口）要写明各自收到什么数据；加 INTERNET 后商店详情页会显示"完全的网络访问权限"。

## 四、模型与数据包（`native.pack.*`）
一套机制管 AI 模型和词典数据包，是 [0002 决策](../decisions/0002-ai-inference-base.md) 里"按需下载、可替换"的落地。
- **manifest**：JSON，带 Ed25519 签名，公钥内置在 App 里；每项含 `id`、`version`、`kind`（model / data）、`size`、`sha256`、`urls[]`（多镜像）、`minAppVersion`、`license`。托管位置未定。
- **下载**：`HttpURLConnection` 加 Range 断点续传，多镜像互为备份，先检查剩余空间，下完校验 sha256，原子落盘到 `filesDir/packs/<id>/<version>/`。
- **使用**：模型由 Rust 的 AI 运行时加载；数据包经 PathHandler 暴露给页面读取。
- **事件**：`pack.progress`（百分比、速度）、完成与失败走 task 事件。
- **加速包（NPU）**：本期不做，manifest 里的 `kind` 预留 `accel` 以便以后扩展。

## 五、长任务与前台服务
- 视频压缩、转 GIF 这类用前台服务，API 35+ 声明 `mediaProcessing` 类型，状态通过 `native.task.status` 查询。
- 提醒类（番茄钟、通知自己）不用前台服务，改用闹钟加通知；Android 14 起新装应用默认拿不到精确闹钟权限，没有时退回非精确闹钟，Doze 下可能晚几分钟（已查证）。
- 进程被杀后，任务状态持久化，页面重开时用 `native.task.status` 恢复展示。

## 六、缓存
- 根目录 `cacheDir/arkli/`，页面路径 `cache/...`。已落地的子目录：`pick/`（选图结果）、`out/<handle>/`（分块写入的成品）、`tmp/`（未关闭写句柄的 `.part` 临时文件）。
- 清理策略（常量在 `FileConst`，策略在 `CachePolicy`，纯函数可单测）：
  - 保留期 24 小时（`CACHE_MAX_AGE_MS`），超过就删。
  - 总量上限 500MB（`CACHE_MAX_TOTAL_BYTES`），超限从最旧的删；最近 10 分钟写入的不动（`CACHE_KEEP_RECENT_MS`），免得删掉页面刚拿到的产物。
  - 临时文件：属于活跃写句柄的不动；空闲清理时存活超过 1 小时（`PART_ORPHAN_AGE_MS`）算孤儿；启动清理时所有非活跃临时文件都是孤儿（进程重启后没有会话）。
  - 触发时机：`MainActivity.onCreate`（启动）与 `onStop`（空闲，两次间隔不少于 10 分钟），在单独线程执行，同时清空闲超时的写句柄。没有对应的 bridge 方法，页面不用管。
- 页面主动清理本次工具产物（`cacheDir/arkli/<tool>/<session>/` 那种按工具分目录）还没做，需要时再加。
- GIF 帧、中间 PNG 用完即删。

## 七、权限汇总（Manifest）
| 权限 | 用途 | 说明 |
|---|---|---|
| `INTERNET` | `native.net`、`native.pack` | 已确认加 |
| `POST_NOTIFICATIONS` | 提醒、视频任务通知 | API 33+ 运行时申请 |
| `SCHEDULE_EXACT_ALARM` | 番茄钟精准提醒 | 可选，用户在系统设置授予 |
| `VIBRATE` | 触感反馈 | 普通权限 |
| `CAMERA` | 扫码取景 | 运行时申请；拍照走 Intent，不需要 |
| `RECORD_AUDIO` | 噪音测量 | P1，运行时申请，需要隐私政策 |
| `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_MEDIA_PROCESSING` | 视频任务 | |
| `WRITE_EXTERNAL_STORAGE` | 保存到公共目录 | 仅 `maxSdkVersion=28` |
| `<queries>` | 应用管理 | P2，只查有桌面图标的应用 |

明确**不用**：`MANAGE_EXTERNAL_STORAGE`、`QUERY_ALL_PACKAGES`、`READ_MEDIA_*`、悬浮窗、无障碍。

## 八、实施顺序
0. **两个 spike**（先做，结果决定后面怎么写）：
   - ~~WebMessageListener 加 ArrayBuffer 在真机上能否用，以及上传吞吐。~~ 已验证：有条件 GO，本机不支持 ArrayBuffer，见第一节与 [spike 报告](../research/spike-webmessage-arraybuffer.md)。在支持 ArrayBuffer 的设备上的吞吐与拷贝份数仍待补测。
   - ~~Rust `ort` 与 sherpa 自带 ORT 1.28.2 的版本兼容，及其算子能否跑 OCR 模型。~~ 已验证 GO，见 [spike 报告](research/spike-ort-sherpa.md)。
1. 协议 v2 核心：异步处理器、会话与订阅、取消、新错误码；web 侧 `bridge.ts` 同步升级；补上 `app/` 欠的单测。
2. 文件相关：`pick`、`save`、`openWrite/closeWrite`、PathHandler。
3. 系统能力：权限、分享、剪贴板、屏幕、触感、设置。
4. 联网与数据：`native.net`、`native.pack`、CSP 与请求拦截。
5. 长任务：task、前台服务、通知。
6. 然后按优先级落地 P0 工具。

## 九、还没定的
- 模型与数据包的托管位置。
- 国内商店对按需下载 so 的规则（没查到原文），影响 AI 运行时能否做成可选包。
