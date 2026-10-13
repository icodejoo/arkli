---
title: 工具落地总览与待决策
status: draft
updated: 2026-10-13
summary: 六份工具设计的汇总：优先级统计、体积估计、全部新增依赖、设计间的冲突与统一结论、待用户拍板清单
---
## TL;DR
- 对标清单 116 项已全部有方案：P0 29、P1 37、P2 25、建议不做 25。
- 不含 AI 的新增体积估计约 4~6MB（推测），AI 运行时压缩后约 8MB，加空壳 1.16MB，整体约 13~15MB 量级，和「一个木函」约 21MB 的口径比有余量。
- 新增代码依赖约 22 项，其中 5 项只在构建期用、不进 APK；绝大多数工具是纯 Web，零 Rust、零新库。
- 六份设计互相有 6 处冲突，已给出统一结论（见下）。两个全局决定已定（2026-10-13）：bridge 通道升级为 `WebMessageListener`，加 INTERNET 权限。

## 一、统计

| 分组 | 文档 | 项数 | P0 | P1 | P2 | 不做 | 增量体积（估计） |
|---|---|---|---|---|---|---|---|
| 图片 | [image](tools/image.md) | 21 | 5 | 7 | 7 | 2 | 1.5~2.5MB |
| 音视频 + AI 与识别 | [media-ai](tools/media-ai.md) | 10 | 3 | 3 | 2 | 2 | 2~3MB，不含 AI 运行时 |
| 文本与词典 + 计算与换算 | [text-calc](tools/text-calc.md) | 22 | 7 | 8 | 5 | 2 | 0.25~0.3MB |
| 开发者、编码与网络 | [dev-net](tools/dev-net.md) | 17 | 4 | 8 | 4 | 1 | 约 50KB |
| 设备与系统 + 文件与清理 | [device-files](tools/device-files.md) | 21 | 4 | 4 | 4 | 9 | 0 |
| 生活、效率与趣味 | [life-fun](tools/life-fun.md) | 25 | 6 | 7 | 3 | 9 | 约 0.1MB |
| **合计** | | **116** | **29** | **37** | **25** | **25** | |

各份文档里的体积多数是子代理的推测，已实测的有：zxing-cpp 的 so（1.75MB 未压缩）、pinyin-pro（142KB）、@noble/hashes 的 md5+sha（5.2KB）、bowser（7.9KB）、成语和字典数据包。立项后以真机包体积为准。

## 二、新增依赖汇总（待用户逐项确认）

| 依赖 | 版本 | 许可证 | 层 | 用途 | 来自 |
|---|---|---|---|---|---|
| zxing-cpp | 3.1.1 | Apache-2.0 | 原生 | 二维码识别 | image |
| CameraX | 待定 | Apache-2.0 | 原生 | 扫码取景 | image |
| nayuki QR-Code-generator | 单文件 | MIT | Web | 二维码生成 | image |
| cropperjs | 待定 | MIT | Web | 裁剪框 | image |
| gif | 0.14.2 | MIT/Apache-2.0 | Rust | GIF 编解码 | image / media-ai |
| color_quant | 待定 | MIT | Rust | 量化（GIF 已带入） | image / media-ai |
| png | 待定 | MIT/Apache-2.0 | Rust | PNG 读写 | image |
| Media3 Transformer + inspector-frame | 1.11.1 | Apache-2.0 | 原生 | 视频压缩、抽帧 | media-ai |
| sherpa-onnx（取 so + Kotlin API） | 1.13.8 | Apache-2.0 | 原生 | AI 基座、语音类 | media-ai / 0002 |
| ort（Rust） | 2.0.0-rc.14 | MIT/Apache-2.0 | Rust | 视觉模型推理，需验证与 sherpa 自带 ORT 对得上 | media-ai |
| sherpa-onnx（Rust crate） | 1.13.8 | Apache-2.0 | Rust | 仅离线 TTS，P2 | media-ai |
| imageproc | 待定 | MIT | Rust | 图像后处理（是否会带入 `image` 待核，见 media-ai 未决问题 10） | media-ai |
| pinyin-pro | 3.29.5 | MIT | Web | 拼音 | text-calc |
| relationship.js | 1.2.9 | MIT | Web | 亲戚关系 | text-calc |
| @noble/hashes | 2.4.0 | MIT | Web | MD5 等哈希 | dev-net |
| bowser | 2.14.1 | MIT | Web | UA 解析 | dev-net |
| idb 或自写（约 80 行） | 8.0.4 | ISC | Web | IndexedDB 封装 | life-fun |
| vitest | 5.0.4 | MIT | Web 开发期 | 单测，与 vite 8 兼容性装时核对 | text-calc |
| linux-command | 1.22.0 | MIT | 构建期 | 手册数据 | dev-net |
| marked | 18.1.1 | MIT | 构建期 | 手册渲染 | dev-net |
| chinese-poetry 数据 | — | MIT | 构建期 | 藏头诗，等体积基线再定 | life-fun |
| opencc-js | 1.4.2 | MIT | 构建期 | 诗句繁转简 | life-fun |

数据与服务（不是代码依赖，要逐个确认来源与许可）：YuNet、MODNet 等视觉模型；TTS 音色与分类模型商用许可未核实；Unihan、chinese-xinhua 词典数据（释义版权不清）；Frankfurter 与 ExchangeRate-API（汇率）；IPinfo Lite；RDAP/WHOIS 公共协议。

## 三、设计间的冲突与统一结论

| # | 冲突 | 统一结论 |
|---|---|---|
| 1 | image 只在 Rust 读写 PNG、不引 `image` 系；media-ai 假设与图片类共用 `image` / `fast_image_resize` | 以 image 为准：Rust 侧不引 `image` 系，视觉模型的缩放与前后处理自己写，媒体帧用 Media3 / Canvas；JPEG 解码与 EXIF 由原生做，Rust 只读 PNG。media-ai 已按此改完（2026-10-13）。另：Canvas 只管中小图，超大图交原生或 Rust（见 image 的「大图分流」） |
| 2 | life-fun 说不需要 INTERNET；dev-net、text-calc、模型与数据包下载都要联网 | 只要有一个按需下载功能就必须加 INTERNET。结论：**加**（用户已确认），同时 WebView 只允许 appassets 域，所有联网只走原生 `native.net.*` / `native.pack.*`，页面无法直接 fetch 外网（见基础设施文档） |
| 3 | 屏幕方法命名不一：`keepAwake` / `keepOn` / `immersive` / `fullscreen` | 统一 `native.screen.keepAwake`、`.orientation`、`.immersive`、`.brightness` |
| 4 | 模型下载（`native.model.*`）与数据包下载（`native.download.*`）各设计一套 | 合并为 `native.pack.*`，模型和词典数据包共用 manifest、断点续传、校验 |
| 5 | 汇率用 `native.http.get`（白名单），dev-net 用 `native.net.http` | 用户选定折中方案：`native.net.*` 管任意域名与 ping/DNS/端口/Whois；汇率这类支持 CORS 的 JSON 接口由页面直接请求，域名写进 CSP 白名单，不再需要 `native.http.get` |
| 6 | 通知：life-fun 用闹钟加通知；media-ai 的视频任务用前台服务通知 | 公共层只做一个通知封装；长任务走前台服务，提醒类走闹钟，互不替代 |
| 7 | media-ai 把 provider 链写成 `xnnpack → cpu` | 实测 sherpa 自带的 ORT 没有 XNNPACK，只有 NNAPI 与 CPU，NNAPI 无收益。改为启动时用 `GetAvailableProviders` 探测，实际就是 CPU，默认 4 线程，低电量或后台降到 2。media-ai 已按此改完（2026-10-13） |

另有几处入口要对齐：打字板与手持弹幕同页两种模式；随机数与"做个决定、抛硬币、掷骰子"共用抽签引擎；文本类的 `native.clipboard.write` 增加 `sensitive: true`（给密码生成器和加解密用）。

## 四、待拍板

### A. 阻塞级（已定，2026-10-13 用户确认）
1. **bridge 通道升级为 androidx.webkit 的 `WebMessageListener`**（可限定来源），取代 `@JavascriptInterface`。spike 已验证：JSON 通道可行，来源限制有效；但测试机（华为 WebView Chromium 114）**不支持 ArrayBuffer 消息**，所以二进制走"字符串帧 + base64 兜底 + 大文件回环 HTTP"，ArrayBuffer 只作探测到才启用的加速，详见基础设施文档第一节。
2. **加 INTERNET 权限**。出站策略选定折中方案：联网以原生为主，页面只对少数支持 CORS 的白名单接口（汇率）直接请求，其余域一律在 `shouldInterceptRequest` 和 CSP 里拦掉。

### B. 不反对就按默认执行
| 事项 | 默认 |
|---|---|
| 25 项"建议不做"（见各份文档总览） | 全部同意 |
| AI 运行时是否随包 | 随包，等体积基线出来再复议 |
| 视频引擎 | Media3 Transformer，输出 H.264 |
| 视觉 AI 的 spike | 先验证 `ort` 与 sherpa 自带 ORT 是否兼容，及其算子能否跑 OCR 模型，再排 OCR |
| 字典释义 | 先只做基础查字（拼音、部首、笔画），入口叫「查字」 |
| 文章摘要、翻译 | 摘要不做，翻译只转交已装的翻译 App |
| 汇率 | 页面直接请求（CSP 白名单），落地前实测 CORS；断网可手填 |
| 日期计算 | 不带农历 |
| 文本编辑器 | 先只读打开大文件 |
| 清理类 | 三个合成「文件夹清理」，全程不要存储权限 |
| 传感器 | 统一原生 SensorHub |
| 噪音测量 | P1，首批不带，等隐私政策 |
| 应用管理 | P2，先不做 |
| IndexedDB 封装 | 自写约 80 行，不引 idb |
| 通知自己 | 不加开机自启恢复权限 |
| 网页转应用 | 只做桌面快捷方式 |
| 垃圾分类词典 | 先按上海的指南整理 |
| 藏头诗 | 等体积基线再定 |
| 二维码相机 | CameraX |
| 裁剪框 | cropperjs |
| 证件照 | 约 25MB 抠图模型按需下载 |
| 导出目录 | `Pictures/Arkli`，文件名"工具名_时间戳_序号" |
| IP 查询 | 不做省市级，不引 11MB 离线库 |
| 明文 HTTP | 不放开 |
| Linux 手册 | 精简约 150 条 |
| AES | 先不做，列 P2 |
| 短链生成、网速测试 | 砍掉 |
| 离线 TTS 包 | P2，不排期 |
| 图像识别 + 对象计数 | 合并为「识物」，P2 |
| 模型清单 | 带签名的 manifest，托管位置待定 |
| vitest | 引入，仅开发期 |

### C. 还没有答案的
- 拼豆各品牌色号表的数据来源。
- 模型与数据包托管在哪。
- 国内商店对按需下载 so 的规则（没查到原文），影响 AI 运行时能否做成可选包。
- 高通、华为运行库的再分发许可（NPU 暂不做，先搁置）。

## 落地后的变更（以 0003 为准）
实现过程中有三项决定覆盖了上文的早期结论，详见 [0003](../decisions/0003-web-first-and-native-media.md)：
- **图片压缩与格式转换合并，统一原生做**：上文「Canvas 管中小图、Rust 读写 PNG」「`png`/`gif`/`color_quant`」的方案作废；PNG 自写缩色编码器，不引这几个依赖。拼接、九宫格仍在 web Canvas。
- **不引 FFmpeg**：视频、音频走 Media3 Transformer 与平台 API；Media3 仍是待确认的新增依赖。
- **固定竖屏**：各工具设计里的横屏需求作废。
- **已新增并落地的依赖**：`vant` 4.10.2（及按需引入插件 `unplugin-vue-components`、`@vant/auto-import-resolver`）、`vitest` 5.0.4、`tyme4ts` 1.5.3、`@noble/hashes` 2.4.0、`pinyin-pro` 3.29.5、`ort` `=2.0.0-rc.14`（仅 `arkli-ai` 的可选特性）、Kotlin 协程与 JUnit 等测试依赖；二维码生成用 nayuki 单文件（MIT，放在 `web/src/vendor/`）。
