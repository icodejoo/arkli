---
title: 当前状态与待办
status: active
updated: 2026-10-13
summary: 接手入口：做到哪、已拍板什么、下一步按顺序做什么、技术债、本机环境与工作约定
---
## TL;DR
- 骨架已跑通：Gradle、Vite、Rust 三个工程齐备，"页面 → bridge → Rust"在真机上通了，空壳 release APK 约 1.16MB。
- 116 项对标功能已全部有落地设计（P0 29 / P1 37 / P2 25 / 不做 25），两个关键 spike 已验证（ort 对接 sherpa 的 ORT：GO；WebMessageListener：有条件 GO，本机不支持 ArrayBuffer）。
- **下一步：做协议 v2 核心**（见"待办"第 1 项），然后文件三件套、系统能力、联网与数据包、长任务，最后落地 P0 工具。
- GitHub 仓库 https://github.com/icodejoo/arkli（公开，main）。**本地领先远端 3 个提交，未推送。**

## 接手先读
1. 本文。
2. [工具落地总览与待决策](design/tools-overview.md)：统计、全部新增依赖、设计间冲突与统一结论、默认决策表。
3. [公共基础设施草案](design/platform-infrastructure.md)：bridge v2、统一方法表、安全、权限、数据包、实施顺序。
4. 决策：[0001 技术栈](decisions/0001-tech-stack.md)、[0002 AI 基座](decisions/0002-ai-inference-base.md)。
5. 各分类的逐工具方案在 `design/tools/`，两份 spike 报告在 `research/`。

## 已拍板（用户确认，2026-10-13）

| 事项 | 结论 |
|---|---|
| 名称与包名 | Arkli；`com.let188.arkli`（域名 arkli.let188.com 反写） |
| 三层 | Compose 原生壳 / Rust 核心（UniFFI）/ WebView 里的 Vue 3 SPA |
| 前端 | Vue 3 + Vite + vue-router + Pinia + SCSS，TypeScript（strict），SPA 路由懒加载 |
| ABI / minSdk | 只发 arm64-v8a；minSdk 24 |
| AI 基座 | sherpa-onnx，模型不干涉、只要兼容 ONNX、按需下载；视觉类复用它自带的 ORT；NPU 暂不做 |
| bridge 通道 | 升级为 `WebMessageListener`，取代 `@JavascriptInterface`（骨架里暂时还是后者） |
| INTERNET | 加；出站采用折中方案：联网以原生为主，页面只对 CSP 白名单里支持 CORS 的接口（汇率）直接请求 |
| 仓库 | 公开，`icodejoo/arkli` |
| 其余 | tools-overview.md 里"B. 不反对就按默认执行"整张表，用户未反对，按默认走 |

## 已完成与证据
- **空壳 release APK**：1,220,629 字节；classes.dex 1.2MB、libarkli_ffi.so 337KB、libjnidispatch.so 176KB。真机 STG-AL00（Android 12，高通 SM6225）上渲染正常，`native.ping`、`rust.core.version` 都成功，R8 后 JNA 与 UniFFI 正常，返回键行为正确。这是未带 sherpa/ORT 的数字，AI 运行时压缩后再加约 10MB。
- **版本**：Gradle 8.11.1、AGP 8.10.1、Kotlin 2.1.21、Compose BOM 2025.05.01、compileSdk/targetSdk 35、androidx.webkit 1.13.0、JNA 5.17.0、uniffi 0.32.2、cargo-ndk 4.1.2、vue 3.5.43、vue-router 5.4.0、pinia 4.0.3、vite 8.3.4、TypeScript 5.9.3（没用 7.x，vue-tsc 兼容性未知）。组合稳定但不是最新，升级前要重跑真机验证。
- **Spike B（ort）**：GO。`ort` 钉死 `=2.0.0-rc.14` + `load-dynamic`，直接加载 sherpa 自带 ORT 1.28.2；PP-OCR 端到端跑通，4 线程整图约 2.2 秒、峰值 RSS 约 205MB；该 ORT 只含 NNAPI 与 CPU，没有 XNNPACK。只在 adb shell 的独立可执行文件里验证过，**没在 APK 进程里验证**。
- **Spike A（通道）**：有条件 GO。本机 WebView（华为 Chromium 114）不支持 ArrayBuffer 消息，页面一发就让 App 进程崩溃，必须以原生探测为准。实测：字符串帧上传约 21MB/s，base64 兜底约 14MB/s，回环 HTTP 约 88~91MB/s；整块发会让内存放大 6~10 倍，分块才恒定。
- **文档**：功能清单（116 项）、开源库选型、六份分类设计、总览、基础设施草案、两份 spike 报告，索引在 [docs/README.md](README.md)。

## 待办（按顺序）

### 1. 协议 v2 核心
- `BridgeHandler` 改挂起函数，带上下文（会话号、请求 id、取消信号）；长任务可先回 `{ taskId }` 再推事件。
- 会话与订阅（事件带 `sub`，WebView 重载或崩溃后会话号递增）、通用取消 `native.task.cancel`、错误码增加 `CANCELLED`、`NETWORK`、生命周期事件 `app.pause/resume`。
- 通道换成 `WebMessageListener`（必须在页面加载前注册；`allowedOriginRules` 只放 `https://appassets.androidplatform.net`），加 `addDocumentStartJavaScript` 守卫挡非字符串消息。
- 新增 `native.hello` 返回能力字段（含 `binary`：是否支持 ArrayBuffer），页面按它选帧类型。
- `web/src/native/bridge.ts` 同步升级；更新 [bridge-protocol.md](design/bridge-protocol.md) 到 v2。
- 补 `app/` 欠的单测（分发、未知方法、异常转换）；验证渲染进程崩溃后重建。
- 参考实现：spike 代码 `app/src/main/kotlin/com/let188/arkli/spike/`（SpikeAsyncBridge.kt 等）。

### 2. 文件三件套
`native.file.pick`（Photo Picker、HEIC 转 JPEG、视频返回不透明句柄）、`native.file.save`（MediaStore，24~28 要存储写权限且 `maxSdkVersion=28`）、`native.file.openWrite/closeWrite`（字符串帧分块，1MB 一块；base64 兜底）、PathHandler 暴露缓存与数据包（视频要支持 Range）、缓存清理策略。大文件的回环 HTTP 上传后置，真出现几十 MB 级页面产出物再做。

### 3. 系统能力
`native.permission.*`、`native.share`、`native.clipboard.*`（`sensitive: true`）、`native.screen.*`、`native.haptic.vibrate`、`native.settings.open`、`native.intent.*`、`native.camera.capture`。

### 4. 联网与数据包
Manifest 加 INTERNET；`shouldInterceptRequest` 拦非白名单域 + CSP；`native.net.*`（http/resolve/whois，超时、2MB 上限、手动跳转、取消）；`native.pack.*`（带 Ed25519 签名的 manifest、Range 断点续传、sha256 校验、原子落盘，托管位置未定）；汇率接口逐个实测 CORS；network security config 只放行 `127.0.0.1`（给回环用）。

### 5. 长任务
`native.task.*`、前台服务（API 35+ 声明 `mediaProcessing`）、通知封装、闹钟（番茄钟）。

### 6. AI 运行时
把 `ort`（`=2.0.0-rc.14`，`load-dynamic`）集成进 `core/`（新 crate，arkli-core 保持零依赖）；PP-OCR 管线；**在 APK 进程里复验**裸名 dlopen 与 ORT 共享；每次升级 sherpa 加一条 OCR 端到端回归；provider 链改为启动时 `GetAvailableProviders` 探测，默认 4 线程。

### 7. P0 工具（共 29 项）
- 图片：二维码、图片压缩、格式转换、图片拼接、九宫格切图
- 音视频与 AI：视频压缩、视频提取音频、OCR 文字识别
- 文本与计算：中文转拼音、单位换算、金额转大写、进制转换、时间计算器、日期计算器、亲戚关系计算器
- 开发者与网络：Base64、MD5、密码生成器、颜色转换
- 设备与文件：尺子、指南针、设备信息、时间屏幕
- 生活趣味：番茄时钟、自定义抽签、做个决定、抛硬币、掷骰子、手持弹幕

### 8. 落地前要先修的设计
- media-ai 里 `image` / `fast_image_resize` 的假设改掉（以 image 设计为准：Rust 侧不引 `image` 系）。
- media-ai 的 provider 链 `xnnpack → cpu` 改为探测式（见 tools-overview 冲突 7）。
- image 里用 Canvas 做大图编解码：超大图（几千万像素）改交原生或 Rust，避免页面侧大对象。
- 引入 vitest（仅开发期），给 web 补单测：`markUsed`、`findTool`、`formatError`、bridge 的超时与分发。

## 待用户拍板 / 未知
- AI 运行时（ORT + sherpa JNI，arm64 约 27MB 未压缩）是否随包：默认随包，等体积基线复议。
- 开源协议选哪个（仓库目前无 LICENSE，默认保留所有权利）。
- 模型与数据包托管位置；拼豆色号表数据来源；国内商店对按需下载 so 的规则（没查到原文）。
- 高通、华为运行库再分发许可（NPU 暂搁置）。
- ArrayBuffer 在支持该特性的设备上的真实吞吐与拷贝份数没测过。
- 完整新增依赖清单见 tools-overview.md 第二节，落地前逐项确认。

## 技术债与风险
- **发版前必须处理 spike 代码**：`app/src/main/kotlin/com/let188/arkli/spike/`、`assets/spike/`、`res/xml/spike_network_security_config.xml`，以及清单里 `exported=true` 的 `.spike.SpikeActivity`。移除或挪进 `debug` 源集，不得随 release 发布。
- R8 的 keep 规则偏宽（JNA 与 uniffi 整包），classes.dex 1.2MB 里多少是它造成的没拆开看。
- `ort` 仍是 RC 版，钉死版本，升级前要重跑 OCR 回归。
- release 用 debug keystore 签名，仅限本机验证，上架前要换正式签名（密钥不进仓库）。
- WebView 老版本：国内机型有一批可能停在老内核，用 `native.hello` 的 `binary` 字段埋点看兜底路径占比。

## 本机环境与命令
- Windows，Node 24、JDK 21（`E:\sdk\jdk\openjdk-21.0.5+11`）、`ANDROID_HOME=E:\sdk\android`（platforms 35/36、build-tools 36.0.0、NDK 28.2.13676358；`ANDROID_NDK_HOME` 未设置）、Rust（含各 Android target）、cargo-ndk 4.1.2、pnpm。
- 真机：序列号 `7NQBB23606003715`，华为 STG-AL00，Android 12，arm64，高通 SM6225（品牌华为、芯片高通，加速包要按芯片而非品牌匹配）。
- 构建 Rust 并生成绑定：`pwsh E:\workspaces\arkli\core\scripts\build-android.ps1`（必须 PowerShell 7，不是 5.1；生成物 `jniLibs`、`kotlin/uniffi` 不入库；strip 会抹掉 UniFFI 元数据，所以脚本从宿主 debug 库生成绑定）。
- 构建前端并同步进 assets：`cd web; pnpm build:app`（产物不入库）。
- 打包与装机：`.\gradlew.bat assembleRelease`；`adb -s 7NQBB23606003715 install -r app\build\outputs\apk\release\app-release.apk`；`adb -s 7NQBB23606003715 shell am start -n com.let188.arkli/.MainActivity`。
- `gradle wrapper` 在带构建脚本的目录里会卡住，要在空目录生成再拷回。
- git：SSH 到 GitHub（443）连续被中断，`origin` 已改成 HTTPS，推送正常。

## 工作约定（这个项目里用过的做法）
- 调研和设计由子代理产出，主会话复审并核实外部事实（版本、体积、许可证）；子代理只写自己的文件，索引和共享文件由主会话统一更新。
- antigravity（`mcp__antigravity__ask_antigravity`）本次会话里每次都报"模型名无效"，没给出过实质结论；此后调研类直接用 sonnet 子代理。工具设计类用户明确要求 opus high。
- 并发 spike 共用一台真机时，耗时数字要多测几次、标注噪声。
- 提交前自查敏感信息与调试残留；push 前先看 `git status`。

## 用户自己要核实
- ARKLI 商标检索（USPTO / WIPO / 中国商标网，第 9、42、35 类）。
- 注册 arkli.app / arkli.dev，GitHub 组织或账号变体。
- 国内安卓应用市场同名检索。
- 隐私政策：联网工具会向 IPinfo、RDAP/WHOIS 注册局、汇率接口发送什么数据；噪音测量要 `RECORD_AUDIO`。
