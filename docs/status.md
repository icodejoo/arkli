---
title: 当前状态与待办
status: active
updated: 2026-10-13
summary: 接手入口：做到哪、已拍板什么、验证到什么程度、下一步按顺序做什么、技术债、本机环境与工作约定
---
## TL;DR
- **协议 v2、文件三件套、联网最小切片、原生图片压缩**已落地并在真机验证；`arkli-ai`（OCR 管线）只做了宿主侧，没进 APK。
- **2026-10-13 盲做冲刺（无真机）**：工具注册表由 25 增到 **90 个**（见 [落地跟踪表](design/rollout-tracker.md)）。新增原生能力：系统能力（剪贴板、分享、设置、Intent、震动、屏幕、设备信息、权限）、提醒与闹钟、系统 TTS、桌面快捷方式、应用管理、`native.net.*`（http/resolve/tcp/whois/speed，含 SSRF 防护）、原生全屏图片预览与自带多选图片页、返回键先关浮层。**这些全部只过了编译与单测，没上真机**，见跟踪表末尾的"待真机验证"清单。
- **底部 tab 导航（2026-10-14）**：首页 / AI / 收藏 / 设置四个根 tab（`van-tabbar` route+replace），tab 之间淡入淡出，进 `/tool/:id` 仍推入、返回回到来的 tab，工具页无底栏；四页 keep-alive 并按路由名还原滚动；`ToolMeta.tags`（`'ai'`）驱动 AI 页，收藏存 localStorage（`stores/favorites.ts`），工具页导航栏右侧星标切换。首页原右上角设置入口已移除（设置现为 tab）。真机 safe-area 与底栏高度待在手机上看。
- **长按图标添加到桌面（2026-10-14）**：首页任意工具长按 500ms → 底部菜单“添加到桌面” → `native.shortcut.pinTool`（`label/icon/route`，路由只认 `/tool/<id>`）。图标用工具 emoji 画在浅灰圆角底上，点桌面图标直达 `#/tool/<id>`（`MainActivity` 改 `singleTop`，冷启动走 `startRoute`，热启动走 `onNewIntent`）。STG-AL00 真机验证：长按弹菜单且不误进页面、系统确认框图标与名称正确、冷/热启动均直达、单实例。已知：从快捷方式冷启动进工具页后按返回直接回桌面（不经首页）。另修闹钟：补声明 `SCHEDULE_EXACT_ALARM`，被拒时降级非精确闹钟。
- **二维码扫码原型（2026-10-14）**：`native.qrcode.scan`（Compose 全屏取景 + CameraX `ImageAnalysis` Y 平面 + zxing-cpp，闪光灯，相机权限）、`native.qrcode.decodeImage`（相册图，选项全开）、web 工具页 `qrcode-scan`；CameraX 1.5.3、zxing-cpp 3.1.1 已获批准。**只过编译与单测，未上真机**。zxing-cpp 3.1.1 由 Kotlin 2.3 编译、会把 kotlin-stdlib 拉到 2.3.20，所以 Kotlin 插件从 2.1.21 升到 2.3.20（`kotlinOptions` 改 `compilerOptions`）。release APK 2,501,582 → 4,917,628 字节（+2.4MB，其中 so 1.75MB 以未压缩存入，dex +0.7MB），口径见 [落地跟踪表](design/rollout-tracker.md)。
- 仍缺：视频压缩/提取音频/转 GIF 的 Media3 替换（平台 API 版已有）；OCR/超分/识别/抠图/融合/上色（页面已做，本地模型方法只有 `native.ai.status` 桩，模型未接入；另有 AI 提供者抽象 `native.ai.providers` / `native.ai.run` 与系统应用交接，见 [0004](decisions/0004-ai-provider-abstraction.md)，真机验证待做）；查字的部首笔画、藏头诗等（缺合规数据）。
- 当前 release APK **1,737,792 字节**（空壳基线 1,220,629）。测试：Kotlin 156、web 38 文件 413 例、`arkli-ai` 49 个单测加 9 个 doctest，全绿。
- **下一步**：系统能力（权限、分享、剪贴板、震动等）→ 联网余下部分 → 视频音频（Media3，要先确认依赖）→ AI 运行时真机复验。见"待办"。
- 仓库 https://github.com/icodejoo/arkli（公开，main，HTTPS 推送）。
- **P0 工具还差 3 项**：视频压缩、视频提取音频、OCR（番茄时钟、二维码扫码原型已做）。

## 接手先读
1. 本文。
2. 决策：[0001 技术栈](decisions/0001-tech-stack.md)、[0002 AI 基座](decisions/0002-ai-inference-base.md)、[0003 Web 优先、固定竖屏、图片与音视频走原生](decisions/0003-web-first-and-native-media.md)（**覆盖了设计里的早期说法，先读**）。
3. [Bridge 协议](design/bridge-protocol.md)（v2，含文件方法与 `native.image.compress`）、[公共基础设施](design/platform-infrastructure.md)（联网白名单、CSP、缓存策略）。
4. [工具落地总览与待决策](design/tools-overview.md)（末尾"落地后的变更"列了已落地依赖）；各分类逐工具方案在 `design/tools/`。

## 已拍板（用户确认）

| 事项 | 结论 |
|---|---|
| 名称与包名 | Arkli；`com.let188.arkli` |
| 三层 | Compose 原生壳 / Rust 核心（UniFFI）/ WebView 里的 Vue 3 SPA |
| 前端 | Vue 3 + Vite + vue-router（hash 路由）+ Pinia + SCSS，TypeScript strict，**Vant 4 按需引入**，路由懒加载 |
| ABI / minSdk | 只发 arm64-v8a；minSdk 24；构建目标 `chrome80`（不得放宽） |
| **固定竖屏** | `MainActivity` 锁 portrait；横屏需求全部作废 |
| **Web 优先** | 页面 JS 与浏览器 API 能做好的只在 web 做 |
| **图片压缩** | 统一原生做，`native.image.compress`；PNG 自写缩色编码器；**不用 Rust**；压缩与转换合并；拼接 App 内走原生 `native.image.stitch`（浏览器保留 Canvas 兜底），九宫格仍在 web Canvas |
| **不引 FFmpeg** | 视频音频走 Media3 Transformer 与平台 API（Media3 是新增依赖，**落地前单独确认**） |
| bridge 通道 | `WebMessageListener`（已落地，取代 `@JavascriptInterface`） |
| INTERNET | 已加；出站只放行 `api.wikimedia.org`（精确主机名），页面直连、CSP `connect-src` 同步；其余一律拦截 |
| AI 基座 | sherpa-onnx；视觉类复用其 ORT；`ort` 钉死 `=2.0.0-rc.14` + `load-dynamic`；NPU 暂不做 |
| 已批准的新依赖 | CameraX 1.5.3（`camera-core/camera2/lifecycle/view`，2026-10-14 已批准）、`io.github.zxing-cpp:android` 3.1.1（2026-10-14 已批准）、`vant`、`unplugin-vue-components`、`@vant/auto-import-resolver`、`vitest`、`tyme4ts` 1.5.3、`@noble/hashes` 2.4.0、`pinyin-pro` 3.29.5、`kotlinx-coroutines`、JUnit、`org.json`（测试）、`ort`；二维码生成用 nayuki 单文件（MIT，`web/src/vendor/`） |
| 其余 | tools-overview.md "B. 不反对就按默认执行"整张表，按默认走 |

## 已完成与证据

### 原生与协议
- **协议 v2**：挂起式 handler、会话与取消、`native.hello` 能力探测、`app.pause/resume`、渲染进程崩溃后重建。真机验证崩溃重建（会话 1→2、挂起请求被取消、旧事件不串）。
- **文件三件套**：`native.file.pick/save/openWrite/write/closeWrite` 与 `/files/` 路径响应（Range、防穿越、`nosniff` 加 CSP sandbox、可执行类 mime 降级）。真机验证 24MB 分块写入 sha256 一致、Range 206、MediaStore 保存、选图（系统文档选择器）。
- **联网切片**：`NetPolicy` 白名单（含子域伪装、`@` 技巧、端口、punycode 等绕过用例单测）、appassets 的 HTML 响应加 CSP 头、首帧深色脚本外置 `web/public/theme-init.js`。真机验证维基 200、`example.com` 与明文被拦。
- **原生图片压缩**：JPEG、WebP（Android 12 用 `WEBP_LOSSY`）、PNG 无损与缩色；质量、最长边、目标体积（二分）、保留 EXIF、批量、`image.progress` 事件、取消并清理半成品。真机：12MP JPEG q80 约 0.6s；12MP 无损 PNG 11.7s、产物 19.9MB（比原图大）。
- **原生图片拼接与覆盖原图（2026-10-14）**：`native.image.stitch`（Kotlin 布局与 web `stitchLayout` 对拍，PNG 按行编码，逐张解码即回收，画布上限 4000 万像素）、`native.file.pick` 的 `keepSource`/`sourceHandle`、`native.file.overwrite`、`native.file.discard`、`native.cache.stats`/`native.cache.clear`、启动与 `onDestroy` 清拼图遗留。真机 STG-AL00（Android 12）验证：3 张 4000×3000 拼 3600 万像素 JPEG/PNG 成功、取消无残留、discard 越界整体拒绝、clear 跳过活跃写句柄、启动清理只删 `stitch_*`。**覆盖原图结论：选图器 URI 只读（`Media is read-only`），必须走 MediaStore `createWriteRequest`（系统确认框），已端到端验证；API 33+ 真 Photo Picker URI、API 29 及以下、自带多选页 URI 没验证**，详见 [Bridge 协议](design/bridge-protocol.md)「native.file.overwrite」。新增错误码 `FORMAT_MISMATCH`，前端 `BridgeErrorCode` 已补。
- **拼接 PNG 编码提速（2026-10-14）**：真机 2 张 1200 万像素原图纵拼 3072×8192，编码 136s → 4.1s（总 ~137s → ~4.8s），成品 19.4MB → 20.5MB，与旧输出逐像素一致，WebView 可显示；改为流式写出（`.part` 随编码增长），`image.progress` 新增 `phase`/`percent`（节流）；`native.image.compress` 的 PNG 仍用 `PngTuning.BEST`，未变。详见 [Bridge 协议](design/bridge-protocol.md)。
- **图片拼接前端改接原生（2026-10-14）**：App 内选图带 `keepSource`，拼接走 `native.image.stitch`，结果列表只显示缩略图（新增 `shared/NativeResultList.vue`，不动 `ImageResultList`），点击走 `native.image.preview`；结果下方可“压缩”（复用 `native.image.compress`，格式与成品一致）；拼接与压缩结果各有“保存并覆盖原图”（覆盖 images[0]，二次确认，格式不一致前端禁用）；重拼、改图、页面卸载都会 `native.file.discard` 旧产物。`native/cache.ts` 封装缓存统计与清理，**拼接默认 JPEG、PNG 慢提示（阈值 2000 万像素）、百分比进度**已接入（`image-stitch/logic.ts`：`pngSlowHint`、`stitchPercent`），真机 2 张 4000×3000 随机噪点图纵拼 PNG（4000×6000）验证了默认选中 JPEG、切 PNG 出现提示、按钮 0%→100% 逐步递增、缩略图正常；顺带发现 vant 按钮 `loading` 时会隐藏文字，进度文案改用 `loading-text` 才显示。JPEG 单条 percent 事件只在单测里验证，真机没单独测。**设置页**：首页标题右侧“设置”入口 → `/settings`（`views/SettingsView.vue`，逻辑在 `views/settingsCache.ts`），目前只有“缓存”卡片（占用 + 确认后清理 + toast + 刷新，无宿主显示“仅 App 内可用”）。真机（STG-AL00）验证了 拼接、缩略图、压缩、原生预览调用、覆盖流程到确认框与错误提示（假句柄，得到“原图句柄已失效”）、卸载清理；**没验证**真实选图器与系统授权框的完整覆盖。已验证“出结果后改格式单选”修正（覆盖仍按成品格式禁用、压缩仍是 PNG 无损）与设置页缓存统计和清理（造了 300KB 文件，清后 0 B）。
- **评审修复**：取消先于协程体补发 `CANCELLED`、权限与选图槽位启动失败必释放、`closeWrite` 严格校验、图片拷贝上限 128MB、wakelock 竞态、指南针卸载后不再监听、DB 候选按得分计数；`bridge.ts` 超时后通知原生取消。
- **调试入口**（仅 debug 源集，release 不含）：`adb shell am broadcast -a com.let188.arkli.debug.CMD --es cmd <命令>`。命令：`crash` `hello` `ping` `state` `sleep` `ticker` `cancel` `filepick` `filesave` `writetest` `writeopen` `rangetest` `videotest` `listcache` `securitytest` `nettest` `imgprep` `imgrun` `exifdump` `imglist` `nav` `rpc`（`--es method --es params [--es id]`，任意调一个 bridge 方法，结果看 `DBGMSG`）`previewtest`（生成 1080×20000 长图并打开原生预览，日志含底图/局部解码耗时）。日志过滤 `adb logcat | grep -E "ArkliDebug|DBGMSG|DBGNET"`。

### Rust
- `core/crates/arkli-ai`：PP-OCR 管线的纯逻辑（预处理、DB 后处理、CTC、取消与进度）、provider 探测、推理后端 trait；`ort` 仅在 `ort-backend` 特性后。`arkli-core` 仍零依赖。**未接入 UniFFI，未进 APK，APK 进程内的 ORT 加载与 OCR 端到端耗时没复验。**

### Web（25 个工具，id 见 `web/src/tools/registry.ts`）
- 文本与计算：金额转大写、进制转换、单位换算、时间计算器、日期计算器、亲戚关系计算器、阳历/阴历互转、中文转拼音。
- 开发者：Base64、哈希计算（MD5/SHA）、密码生成器、颜色转换、二维码生成。
- 图片：图片压缩（含转换）、图片拼接、九宫格切图。
- 设备：尺子、指南针、时间屏幕、手持弹幕、设备信息（只含 web 能取到的部分）。
- 趣味：抛硬币（3D 翻转带阴影与景深）、掷骰子、自定义抽签、做个决定。
- **阳历/阴历**：1–9999 年；1582 年前按儒略历推算；宜忌平铺，点击弹出 140 项通俗释义（10 条权威来源不足，标"待核对"）；"历史上的今天"取维基百科 On This Day（CC BY-SA，已标注来源）。
- **尺子**：竖直贴屏幕长边（可靠左或右），0.5px 游标线，实时读数预览，彩虹七色轮换加彩虹盘取色，标记不限数量、可隐藏；“间距对比”弹窗里用 SVG 按位置排出所有标记，点选任意两条看间距。

### 文档
决策 0001–0003、六份分类设计、总览、基础设施、两份 spike、开源库选型；索引在 [README.md](README.md)。

## 待办（按顺序）

### 1. 系统能力
`native.permission.*`（落地后把 `native.file.save` 在 API 24~28 的临时权限申请改走它）、`native.share`、`native.clipboard.*`（`sensitive: true`）、`native.screen.*`、`native.haptic.vibrate`、`native.settings.open`、`native.intent.*`、`native.camera.capture`。抛硬币与掷骰子的音效和震动、设备信息里的电池、存储、品牌型号也依赖它（建议 `native.device.info/status/display`，有了 `xdpi` 尺子可免校准）。

### 2. 联网余下部分
`native.net.*`（http、resolve、whois，超时、2MB 上限、手动跳转、取消）、`native.pack.*`（带 Ed25519 签名的 manifest、Range 断点续传、sha256、原子落盘，托管位置未定）、汇率接口逐个实测 CORS 后加入白名单、`network_security_config` 放行回环 `127.0.0.1`。

### 3. 长任务与视频音频
`native.task.*`、前台服务（API 35+ 声明 `mediaProcessing`）、通知封装、闹钟（番茄钟）。视频压缩、提取音频走 Media3 Transformer 与平台 `MediaExtractor/Muxer`，**先问用户确认 Media3 依赖**。

### 4. AI 运行时真机复验
`arkli-ai` 经 UniFFI 接入（`CancelToken` 做 Object、进度做 callback interface）；**在 APK 进程里复验**裸名 dlopen 与 sherpa 共用 ORT；通道顺序 BGR/RGB、cls 模型输入尺寸（v5 未核实）、默认参数在 1080×2400 截图上的检出率、耗时与内存；每次升级 sherpa 加一条 OCR 端到端回归；NNAPI 默认关。模型文件来源（约 21.5MB，ModelScope RapidAI）与托管位置待定。PNG 解码 `png` crate 未批准，输入暂由原生解码成像素。

### 5. 其余 P0
OCR 工具页（依赖 4）。二维码扫码原型已做，待真机验证。

### 5b. AI 四层与模型（决策见 [0005](decisions/0005-ai-four-layers.md)）
- **全部任务完成后，找一台有点积（`asimddp`）和 fp16（`fphp`）的手机复测** Rust ort、llama.cpp、MNN，再决定是否改 0002（见 [端侧 LLM 对比](research/on-device-llm-comparison.md)）。
- 对联 GPT-2 int4 在 Android 真机上跑通并实测速度、对联工具页接入（下载、解码、上联 ≤14 字、拦截英文数字括号、等长约束）；垃圾分类 SigLIP2 q4f16 真机验证、识物工具页接入；L4 在线 OpenAI 先出方案（密钥存储、`native.net` 加 POST 与流式）；AI 页“模型配置”占位入口接管理功能。
- 设备上 `/data/local/tmp/qwenspike/`（约 641MB）是探测残留，用户尚未说清理。

### 6. 工具与前端小项
- 手持弹幕、时间屏幕固定竖屏后体验受限，**是否页面内旋转 90° 模拟横屏待用户定**。
- 图片压缩：大图选 PNG 时给"又慢又大"的提示（待定）；PNG 缩色是否按真实照片再调参。
- 彩虹盘只选色相，没有亮度调节；预设黄色在白底上对比度偏低。
- `formatError` 对 `{code:'', message}` 或无 `code` 的对象会输出 `[object Object]`（已知小 bug，未修）；`markUsed` 不校验 id。
- Vant 图标字体的 `at.alicdn.com` 回退被 CSP 拒绝，console 有一条无害噪音；字体内嵌约 34KB（gzip）。
- 各工具里有重复的局部样式，可抽共用组件。

## 待用户拍板 / 未知
- **开源协议**还没选（仓库无 LICENSE）：GPL 类依赖（如 libimagequant）会牵连整个 App，选协议要早于引入这类依赖。
- 模型与数据包托管位置；拼豆色号表数据来源；国内商店对按需下载 so 的规则（没查到原文）。
- AI 运行时（ORT + sherpa JNI，arm64 约 27MB 未压缩）是否随包：默认随包，等体积基线复议。
- 高通、华为运行库再分发许可（NPU 暂搁置）。
- **对联 GPT-2 的 release（`couplet-gpt2-v1`，公开仓库）许可证无法确认可再分发**：用户决定不向作者确认、风险自负；作者若不允许要删除 release（见 [对联 GPT-2](research/couplet-gpt2-onnx.md)）。
- 端侧 LLM 的 tokenizer：引入 `tokenizers` crate（新依赖）还是自写 BPE 解析，未定。
- `ArkliPage` 里 `bridge` 字段先于 `binarySupported` 初始化，`native.hello` 的 `features.binary` 可能一直是 false（只会永远走 base64 兜底，不出错但慢）：修不修待定。
- 宜忌释义 123 条非"待核对"条目是通俗改写，没有逐条对权威黄历核过，正式上线前建议找懂行的人过一遍。

## 技术债与风险
- **发版前必须处理 spike 代码**：`app/src/main/kotlin/com/let188/arkli/spike/`、`assets/spike/`、`res/xml/spike_network_security_config.xml`（未被引用的遗留文件），以及清单里 `exported=true` 的 `.spike.SpikeActivity`。移除或挪进 `debug` 源集。
- `/files/` 的 Range 响应依赖 Chromium 114 对拦截流"再 skip 一次"的行为（用流头垫虚拟前缀兼容），换内核可能表现不同，已写进协议文档，**别的机型要复测**。
- **没在真机验证的**：HEIC 转 JPEG、API 24~28 的存储权限分支、API 24~27 的图片解码回退、手指拖动尺子游标的手感、`touch-action: none` 对页面滚动的影响、Chrome 80 内核上的 3D 抛硬币与 `createImageBitmap` 选项、深色首帧、指南针与时间屏幕常亮在华为 WebView 上的表现、文件哈希里 `<input type=file>` 在 WebView 里的选择器。
- 古代农历（尤其 1900 年前）是库的推算值，可能与历史上实际颁行的历差一天或一个月，界面已写"仅供参考"。
- R8 的 keep 规则偏宽（JNA 与 uniffi 整包）；`ort` 仍是 RC 版，升级前重跑 OCR 回归。
- release 用 debug keystore 签名，仅限本机验证，上架前换正式签名（密钥不进仓库）。
- 提交 `a48553c`（feat(tools) 新增 18 个工具）的标题误写成"17 个"，未改写历史。
- 推送前按约定要跑的 diff-simplify 这批没跑。

## 本机环境与命令
- Windows，Node 24、JDK 21（`E:\sdk\jdk\openjdk-21.0.5+11`）、`ANDROID_HOME=E:\sdk\android`（platforms 35/36、build-tools 36.0.0、NDK 28.2.13676358）、Rust（含各 Android target）、cargo-ndk 4.1.2、pnpm。
- 真机：序列号 `7NQBB23606003715`，华为 STG-AL00，Android 12，arm64，高通 SM6225；系统没有 Photo Picker，选图走 androidx 回退的文档选择器。
- 构建 Rust 并生成绑定：`pwsh E:\workspaces\arkli\core\scripts\build-android.ps1`（必须 PowerShell 7；生成物不入库）。
- 前端：`cd web; pnpm dev --host 127.0.0.1` → http://127.0.0.1:5173/assets/web/ ，**hash 路由**，如 `#/tool/ruler`；`pnpm build:app` 构建并同步进 assets（产物不入库）；`pnpm test`、`pnpm exec vue-tsc --noEmit`。
- 真机热更新（仅 debug 包）：先装一次 debug 包，之后 `cd web; pnpm dev:device`（= `adb reverse tcp:5173 tcp:5173` + 固定 5173 端口的 vite），手机上的页面就走电脑的 vite，改前端保存即热更新（HMR）。原理：debug 源集的 `DevServerProxy` 把 `/assets/web/*` 转给 `127.0.0.1:5173`，页面来源仍是 appassets，通道与 CSP 不变；连不上开发服务器自动退回包内 assets，日志 `adb logcat -s ArkliDebug`。release 里没有这套代码（主代码只留一个空的 `DevAssetHook`）。改 Kotlin 仍要重新编译装机。
- 测试：`.\gradlew.bat testDebugUnitTest`（Kotlin）、`cd core; cargo test --workspace`、`cd web; pnpm test`。
- 打包与装机：`.\gradlew.bat assembleRelease` / `assembleDebug`；`adb -s 7NQBB23606003715 install -r <apk>`；拉起应用用 `adb -s 7NQBB23606003715 shell monkey -p com.let188.arkli -c android.intent.category.LAUNCHER 1`（**别用 `am start -n`**：它的 Intent 没有 LAUNCHER 分类，之后点桌面图标会被当成新启动，新开一个实例，看起来像"后台回来就重启"）。
- Windows 上 `curl` 访问 https 会因 schannel 吊销检查失败，加 `--ssl-no-revoke`。
- git 提示 LF/CRLF 转换的 warning 是正常的；`gradle wrapper` 在带构建脚本的目录里会卡住，要在空目录生成再拷回；origin 用 HTTPS。

## 工作约定（这个项目里用过的做法）
- 任务由 sonnet 子代理产出，主会话复审并**自己复跑测试**、核实外部事实（版本、体积、许可证、文献引文）；子代理只写自己的文件，共享文件（`registry.ts`、`toolIcons.ts`、文档索引）由主会话统一改；多个子代理并行时按目录划界，不并行跑会清空产物目录的构建、不并行占真机。
- antigravity（`mcp__antigravity__ask_antigravity`）此前每次都报"模型名无效"，没给出过实质结论，调研与开发直接用 sonnet 子代理。
- 提交前自查调试残留（`console.log`、`debugger`、`TODO`）；按功能分组、指定路径 `git add`，别用 `git add .`；push 前先看 `git status`。
- UI 反馈要按"元素、方向、位置"说清楚；尺子的数字方向、游标线长度改过多次，现版本是最终状态。

## 用户自己要核实
- ARKLI 商标检索（USPTO / WIPO / 中国商标网，第 9、42、35 类）。
- 注册 arkli.app / arkli.dev，GitHub 组织或账号变体；国内安卓应用市场同名检索。
- 隐私政策：联网工具会向 IPinfo、RDAP/WHOIS 注册局、汇率接口、**维基媒体（历史上的今天，会发月日与 IP）**发送什么数据；噪音测量要 `RECORD_AUDIO`。
