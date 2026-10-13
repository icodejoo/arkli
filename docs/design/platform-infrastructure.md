---
title: 公共基础设施草案
status: draft
updated: 2026-10-13
summary: 六份工具设计共同依赖的底层能力：bridge 协议 v2、统一方法表、安全策略、权限、模型与数据包管理、长任务、缓存、实施顺序
---
## TL;DR
- 六份工具设计都卡在同几件事：页面传不了二进制、处理器只能同步返回、没有取消和订阅约定、联网口子没定。本文一次性补上。
- 方向：bridge 协议升到 v2（向后兼容 v1），通道建议换成 `WebMessageListener`（可限来源、能传 ArrayBuffer）；联网统一收口到原生，页面不能直连外网。
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
推荐方案（**待 spike 验证**）：通道换成 `WebMessageListener`，页面直接 `postMessage(ArrayBuffer)`。
1. 页面调用 `native.file.openWrite { name, mime, size }`，拿到 `{ handle }`。
2. 页面分块发二进制帧，每块约 1MB，帧头 8 字节：`handle(4) + seq(4)`，原生按序追加到缓存文件。
3. 页面调用 `native.file.closeWrite { handle }`，得到 `{ path, size }`。

兜底：WebView 不支持 ArrayBuffer 消息的设备，退化成 JSON 里的 base64 分块（每块约 192KB），慢但能用。测试机 STG-AL00 是 Android 12，WebView 版本要实测。

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
| `native.net.http` / `resolve` / `whois` | 汇率、网址探查、IP 查询 | 调用方声明域名策略：固定白名单或任意；统一超时、2MB 读取上限、手动跟随跳转、并发上限 |
| `native.pack.ensure` / `list` / `delete` | AI 模型、词典与数据包 | 见第四节；事件 `pack.progress` |
| `native.task.status` / `cancel` | 视频、AI、下载 | 事件 `task.progress` / `task.done` / `task.error`，进度节流不超过 10Hz |
| `rust.*` | 计算类 | 同步短任务直接返回；长任务走 task |

## 三、安全
- **通道来源**：`WebMessageListener` 的 `allowedOriginRules` 只放 `https://appassets.androidplatform.net`，bridge 不会注入到其他来源的 frame。
- **页面不能直连外网**：一旦加 INTERNET，必须在 `shouldInterceptRequest` 里拦掉所有非 appassets 域的请求，并设 CSP `default-src 'self'; connect-src 'self'; img-src 'self' blob: data:`。联网只能走 `native.net.*` 和 `native.pack.*`。
- **JS 解释器工具**：必须跑在 Web Worker 里，不能放 iframe。
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
- 目录 `cacheDir/arkli/<tool>/<session>/`，退出工具时清理本次产物。
- 启动时清理超过 24 小时的残留；总量上限（默认 500MB）超限从最旧的删。
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
   - WebMessageListener 加 ArrayBuffer 在真机上能否用，以及上传吞吐。
   - Rust `ort` 与 sherpa 自带 ORT 1.28.2 的版本兼容，及其算子能否跑 OCR 模型。
1. 协议 v2 核心：异步处理器、会话与订阅、取消、新错误码；web 侧 `bridge.ts` 同步升级；补上 `app/` 欠的单测。
2. 文件相关：`pick`、`save`、`openWrite/closeWrite`、PathHandler。
3. 系统能力：权限、分享、剪贴板、屏幕、触感、设置。
4. 联网与数据：`native.net`、`native.pack`、CSP 与请求拦截。
5. 长任务：task、前台服务、通知。
6. 然后按优先级落地 P0 工具。

## 九、还没定的
- 模型与数据包的托管位置。
- 国内商店对按需下载 so 的规则（没查到原文），影响 AI 运行时能否做成可选包。
