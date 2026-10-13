---
title: 开源库选型清单
status: draft
updated: 2026-10-13
summary: 按工具类别调研的成熟开源库，含许可证、体积、维护状态与推荐，供各工具落地方案借鉴
---
## TL;DR

- **有现成轻量好选择**：二维码（zxing-cpp / nayuki）、文本类（marked、pinyin-pro、opencc-js、jsdiff、noble-hashes）、农历（tyme4ts）、压缩（Rust zip + sevenz-rust2）、图片基础处理（Rust `image` 系）、PDF 合并拆分（lopdf）、视频剪辑（Media3 Transformer）。
- **没有轻量好选择**：HEIC/AVIF 编码、通用视频转码（ffmpeg-kit 已退役，替代均为个人 fork 或要自编）、科学表达式（mathjs 太重，建议自写或 fend-core）、OCR 的现成 Android 封装（RapidOcrAndroidOnnx 疑似停更，得自己用 ORT 接 PP-OCR 模型）。
- **许可证坑**：MuPDF、gifski、evalexpr 是 AGPL；libheif 是 LGPL-3.0（libheif-js 同）；piper1-gpl 是 GPL-3.0；junrar 用 UnRAR 许可（非 OSI）；ffmpeg 默认 LGPL，开 `--enable-gpl` 就变 GPL；MediaTek NeuroPilot 要与厂商签约才能拿运行库。
- **AI 基座**：以 sherpa-onnx 为基座成立，语音类（ASR/TTS/VAD/说话人/降噪/KWS/标点）开箱即用；它**不覆盖视觉任务**，但官方 AAR 里自带一份可共享的 `libonnxruntime.so`（ORT 1.28.2，arm64 22MB 未压缩），视觉模型（OCR 等）可复用这一份，不必再打包第二份 ORT。
- **NPU**：现阶段不做。NNAPI 已被官方标为弃用，NPU 路线要求量化 + 静态 shape + 按 SoC 编译模型，与"任何 ONNX 模型都能换"的承诺冲突；且 Google Play 禁止下载 .so。先把 CPU（XNNPACK）路径做好，后续按需只试高通。

> 标注约定：无标记 = 已查证（链接见文末来源）；「（推测）」= 凭经验或间接证据；「未知」= 没查到，不编。日期以 2026-10-13 为"现在"，距今超过 2 年无发布/提交标「疑似停更」。体积里"未压缩"指 .so 原文件大小，"deflate"指 AAR 内压缩后大小。

## 各类别首选速查表

| 类别 | 首选 | 备选 | 层 | 许可证 | 体积（增量） |
|---|---|---|---|---|---|
| 二维码识别 | zxing-cpp（Maven `io.github.zxing-cpp:android` 3.1.1） | ZXing core 3.5.4 / Rust rxing | Kotlin（相机）+ native | Apache-2.0 | 未知 |
| 二维码生成 | nayuki QR-Code-generator（单文件） | Rust fast_qr | Web | MIT | 未知（单文件很小，推测） |
| OCR | PP-OCR ONNX 模型 + 共享 ORT + Rust 前后处理 | Tesseract 5.5.3 | Rust | Apache-2.0 | 模型未知（按需下载）；ORT 复用 0 额外 |
| 图片处理 | Rust `image` 0.25 + fast_image_resize + oxipng | 浏览器 Canvas + pica | Rust / Web | MIT/Apache-2.0 | 未知 |
| HEIC/AVIF | 系统 ImageDecoder（解码，推测 API 28/31+） | libheif（LGPL） | Kotlin | 平台 / LGPL-3.0 | 平台 0；libheif 未知 |
| GIF | Rust `gif` 0.14.2 | 平台 AnimatedImageDrawable（推测） | Rust | MIT/Apache-2.0 | 未知 |
| PDF 渲染 | 平台 PdfRenderer（推测） | pdfium-binaries | Kotlin | 平台 / BSD+MIT | 平台 0；pdfium 未知 |
| PDF 合并拆分 | lopdf 0.45.0 | pdfium-render | Rust | MIT | 未知 |
| 视频剪辑转码 | Media3 Transformer 1.11.1 | 自编精简 LGPL FFmpeg | Kotlin | Apache-2.0 / LGPL | Media3 未知 |
| 音频提取 | 平台 MediaExtractor + MediaMuxer（推测） | Media3 Transformer | Kotlin | 平台 | 0 |
| 编码/哈希/加密 | WebCrypto（内置，推测）+ @noble/hashes 2.4.0 | Rust RustCrypto sha2 | Web | MIT | noble 675KB unpacked |
| Diff | jsdiff 9.0.0 | Rust similar 3.2.0 | Web | BSD-3-Clause | 601KB unpacked |
| JSON/XML/YAML | 内置 JSON/DOMParser + yaml 2.9.1 | js-yaml（未查） | Web | ISC | 670KB unpacked |
| Markdown | marked 18.1.1 | markdown-it 15.0.2 | Web | MIT | 506KB unpacked |
| 简繁转换 | opencc-js 1.4.2 | Rust ferrous-opencc 0.4.0 | Web | MIT AND Apache-2.0 | 5.9MB unpacked（含全部词典，可按需子包，推测） |
| 拼音 | pinyin-pro 3.29.5 | Rust pinyin 0.11.0 | Web | MIT | 928KB unpacked |
| 分词 | jieba-rs 0.11.0 | 浏览器 Intl.Segmenter（推测） | Rust | MIT | 词典未知 |
| 单位/进制/日期 | 自写（表驱动）+ 平台 java.time / Intl | fend-core 1.5.8 | Web | — / MIT | ~0 |
| 表达式解析 | fend-core 1.5.8 | 自写 Pratt 解析（约 200 行，推测） | Rust / Web | MIT | 未知 |
| 农历节气 | tyme4ts 1.5.3 | lunar-javascript 1.7.7 | Web | MIT | 735KB / 500KB unpacked |
| 亲戚关系 | relationship.js 1.2.9 | 自写规则表 | Web | MIT | 336KB unpacked |
| 身份证/手机号 | 自写（校验位 + 正则） | libphonenumber-js | Web | — / MIT | ~0 |
| zip/7z | Rust zip 9.0.2 + sevenz-rust2 0.24.0 | Java commons-compress 1.28.0 | Rust | MIT / Apache-2.0 | 未知 |
| rar（仅解压） | junrar 8.1.2 | Rust unrar（绑 C 源码） | Kotlin | UnRAR 许可（非 OSI） | 未知 |
| 传感器/设备信息 | 平台 SensorManager 等（推测） | — | Kotlin | 平台 | 0 |
| 网络工具 | 平台 InetAddress/Socket + 自写 | Rust hickory-resolver / surge-ping | Kotlin / Rust | — / MIT·Apache | 未知 |
| TTS | 系统 TextToSpeech（推测） | sherpa-onnx TTS | Kotlin | 平台 / Apache-2.0 | 0 / 见 AI 一节 |
| ASR/VAD/说话人等 | sherpa-onnx 1.13.8 | — | Kotlin / Rust | Apache-2.0 | arm64 约 9.5MB deflate（见下） |
| 取色 | colorthief 3.5.0 | 自写 median-cut（Rust） | Web | MIT | 1.6MB unpacked |

## 1. 本地小模型推理（AI 基座：sherpa-onnx）

### 1.1 sherpa-onnx 查证结果

| 项 | 结果 |
|---|---|
| 仓库 | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)，Apache-2.0，15,248 star，最近推送 2026-10-12 |
| 当前版本 | v1.13.8，发布于 2026-09-10；crates.io 同版 1.13.8（2026-09-11，Apache-2.0） |
| 任务范围（README） | 语音识别（流式/非流式）、语音合成、说话人识别/确认/分离（diarization）、语种识别、音频标签、VAD（silero 等）、降噪/语音增强（gtcrn、DPDFNet）、关键词唤醒、加标点、音源分离（spleeter/UVR） |
| 视觉任务 | **不覆盖**：README 功能清单无 OCR、分类、抠图、超分；GitHub issue 搜索也未见相关官方支持 |
| API | C、C++、Java、Kotlin、Swift、Rust、Dart、JS、Python、Go、C# 等；Android 有 Java/Kotlin JNI；官方 Rust 绑定 `sherpa-onnx` + `sherpa-onnx-sys`，crate 有 `static`/`shared` 两个 feature（仓库 `sherpa-onnx/rust/`） |
| minSdk | 官方 Android 示例工程 `minSdk 21`，满足 Arkli 的 24；AAR 清单文件内的值未读到 |
| 自带 ORT | 1.28.2（`cmake/onnxruntime-android-aarch64.cmake`，来自 csukuangfj/onnxruntime-libs 的自建包）；官方 ORT 当前为 1.31.0（2026-10-09） |
| 页大小 | 抽查 arm64 的 libonnxruntime.so、libsherpa-onnx-jni.so、c-api.so，PT_LOAD 对齐均为 0x4000（16KB），符合 Android 15+ 16KB 页要求 |

**arm64-v8a 体积（已下载 v1.13.8 AAR 逐文件量过）**

| 方案 | 文件 | 未压缩 | AAR 内 deflate |
|---|---|---|---|
| 默认 AAR（`sherpa-onnx-1.13.8.aar`，四个 ABI 合计 50.1MB） | libonnxruntime.so | 22.25MB | 7.96MB |
| | libsherpa-onnx-jni.so | 4.77MB | 1.97MB |
| | libsherpa-onnx-c-api.so | 4.47MB | 1.89MB |
| | libsherpa-onnx-cxx-api.so | 0.44MB | 0.14MB |
| 静态链 ORT AAR（合计 38.7MB） | 仅 libsherpa-onnx-jni.so | 24.17MB | 8.99MB |

- 只走 Kotlin JNI 时，运行需要 libonnxruntime.so + libsherpa-onnx-jni.so，约 27.0MB 未压缩 / 9.9MB deflate（c-api、cxx-api 是否可省属推测，没实测）。
- 静态链版本只有一个 so，体积略小，但 ORT 符号不对外，**不能被视觉模型复用**（推测）；要复用就选默认 AAR。
- 模型不在包里，按需下载；官方 Android 发布物只有 AAR/tar.bz2，Maven Central 上没找到 `com.k2fsa` 坐标（仓库的 jitpack.yml 指向 GitHub release，分发方式以此为准）。

### 1.2 视觉类任务怎么办

1. **复用 sherpa 自带的 ORT**：libonnxruntime.so 是标准 ORT 共享库，导出完整 C API，Rust 侧用 `ort` crate（2.0.0-rc.14，2026-10-12 更新，MIT OR Apache-2.0，仍是 RC）的动态加载方式或自己绑 C API 去加载它，即可只带一份 ORT（可行性为推测：`ort` 的动态加载模式与 1.28.2 的 API 版本兼容性没验证）。
2. **算子覆盖要实测**：该 so 22MB 比官方 AAR 的 34.2MB（未压缩）小，是自建包，是否裁过算子未知。OCR 模型（DB 检测 + CRNN 识别）需要的算子，必须在上线前拿真模型跑一遍。
3. **是否仍属"基座 sherpa-onnx"**：我的判断是"运行时同源，API 不同源"。语音走 sherpa 的 API；视觉走同一份 ORT 但前后处理（DB 后处理、CTC 解码）在 Rust 里自己写，或者借鉴 RapidOCR 的实现。如果用户要求"所有 AI 都必须经过 sherpa API"，则视觉类做不到，得改口径。
4. **ORT 精简构建**：官方文档支持 `--minimal_build`、`--include_ops_by_config`（按算子裁剪）、`--enable_reduced_operator_type_support`、`--disable_ml_ops`、`--disable_exceptions`，Android 有 `build_custom_android_package.py` 出自定义 AAR；但文档**没给任何体积数字**，能压到多少未知。minimal build 只支持 ORT 格式模型，会与"任意 ONNX 模型可换"相冲突（推测：需在下载/安装时转 ORT 格式）。
5. 官方 `onnxruntime-android` 1.31.0（Maven Central，2026-10-09）AAR 55.1MB，arm64 libonnxruntime.so 34.2MB 未压缩 / 12.9MB deflate，JNI 桥 0.12MB。

### 1.3 为什么不选其他（一句话）

| 库 | 许可证 / 最近 | 不选的理由 |
|---|---|---|
| NCNN | BSD-3（LICENSE 文本；GitHub 标 NOASSERTION），20260526 | 模型要转 ncnn 格式，与"ONNX 可换"冲突 |
| MNN | Apache-2.0，3.6.1（2026-07-23） | 同上，且与 sherpa 基座重复一份运行时 |
| llama.cpp | MIT，v0.6.0（2026-10-05） | 面向大语言模型，GGUF 体积以百 MB 计，不符合轻便（体积为推测） |
| tract-onnx | MIT/Apache，0.23.8（2026-09-21） | 纯 Rust 免 C++，可作"不想要 ORT"的退路；算子覆盖和速度未验证 |

### 1.4 NPU / 硬件加速

**Android 现状（已查证）**
- NNAPI：官方 NDK 页明确写 "NNAPI is deprecated"，并建议性能敏感场景迁移到 TF Lite GPU 运行时；弃用起始版本抓取摘要写 Android 15，未二次核实。ORT 的 NNAPI EP 文档页**没有**弃用提示，要求 Android 8.1+（推荐 9+）。
- 官方现行路径：LiteRT 的 NPU 加速（CompiledModel API）。支持 Google Tensor、高通 QNN、联发科 NeuroPilot、Intel OpenVINO、三星 Exynos AI LiteCore；要求 API 31+，仅 arm64-v8a；Tensor 只支持 AOT，其余支持 AOT 和端上 JIT；NPU 运行库经 Play Feature Delivery 分发，2.3.0 起也有 Maven 包；JIT 可配缓存目录，文档称初始化从数秒降到数百毫秒；可配 CPU/GPU 回退，AOT 支持部分子图回退。**这条路要用 .tflite 模型，不是 ONNX。**
- 厂商碎片化：高通 QNN/HTP、联发科 NeuroPilot、三星 LiteCore、Google Tensor 各一套 SDK；各家市占比例没找到可靠来源，写**未知**。

**execution provider 支持情况**

| 运行时 | EP / provider | 说明 |
|---|---|---|
| sherpa-onnx（`provider.h`） | cpu、cuda、coreml、xnnpack、nnapi、trt、directml、spacemit、openvino | Android 上有 xnnpack、nnapi 的代码路径（`session.cc`）；枚举里没有 qnn |
| sherpa-onnx QNN | 单独文档页，高通 HTP 后端 | 只列了离线 ASR 模型（Zipformer CTC、Paraformer、SenseVoice 等），**int8、按 SM8850 编译**；要求 SM8350 及更新；用 `model.bin` 或 `libmodel.so` 加载，需 QNN 库和 `ADSP_LIBRARY_PATH`；静态 shape 文档未明说（模型名带 "5-seconds"，推测为固定 5 秒窗口） |
| 官方 ORT QNN EP | backend_type/backend_path（cpu/gpu/htp）、htp_performance_mode、enable_htp_fp16_precision | **预编译包只有 Windows**，Android 需自己带 QNN SDK 源码构建；HTP 只跑量化模型；**不支持动态 shape**，须固定；不支持 Loop/If；文档只在 SM8350/SC8280/骁龙 X、QNN 2.22 上测过 |
| 官方 AAR / sherpa 的 libonnxruntime.so | 两个 so 里都能 grep 到 NNAPI、XNNPACK、QNN 的 EP 名字符串 | 只是字符串，不等于 EP 已编入且能用（推测），没实测 |

**对"模型只要兼容 ONNX 即可"承诺的影响（明确写出）**：走 NPU（QNN HTP）后，模型必须量化、固定 shape，并且按目标 SoC 单独编译；sherpa 的 QNN 模型包就是按 SM8850 单独出的 int8 版本。即 NPU 路径下，**"任意 ONNX 可换"不成立，只对官方/自己编译过的模型成立**。CPU（含 XNNPACK）路径不受此限。

**失败回退**
- ORT QNN EP：不支持的算子默认回退 CPU EP；`session.disable_cpu_ep_fallback=1` 可禁止回退，此时模型不能整图上 HTP 就创建会话失败；HTP 子系统重启要重建 session。
- NNAPI：文档称不支持的算子可能落到 nnapi-reference（NNAPI 自带的 CPU 实现），其效率常低于 ORT 自己的优化内核——即"部分回退反而更慢"有官方依据。
- 行业做法（设备白/黑名单、首跑基准选后端并缓存）：属常见工程做法（推测），没有查到统一规范；LiteRT 的 JIT 编译缓存是文档里能查到的相近机制。

**动态加载与再分发**
- ORT 有 plugin EP 库机制：`RegisterExecutionProviderLibrary`，EP 做成导出 `CreateEpFactories`/`ReleaseEpFactory` 的共享库，核心 ORT 不打进插件包。但文档页没写引入版本，示例是 Windows `.dll`，**Android 是否可用未知**；Android 上 NNAPI/XNNPACK 当前形态是编进 libonnxruntime.so。
- 高通 QNN 运行库：检索到的部署资料提到 `libQnnHtp.so`、`libQnnHtpPrepare.so`、`libQnnSystem.so` 以及 DSP 侧 Skel 库（Stub/Skel 按 HTP 版本区分）；各自体积**未知**。再分发条款：下载 SDK 须先登录高通账号接受 AI Engine 许可协议，SDK 内带 `LICENSE.pdf`、`QNN_NOTICE.txt`，**能否随第三方 App 再分发、哪些文件可分发：未查到，须读 SDK 内的协议或问高通**。
- 联发科 NeuroPilot：Android 版文档与 SDK 对直接客户（有 MOL 账号）开放，部分资源 NDA；ORT 的联发科加速 EP 需联系 MediaTek 代表获取。**再分发需商务协议（基本可判断，原文条款未查到）**。
- 华为 HiAI：只查到 2018 年发布稿，2026 年的第三方接入与再分发条款**未知**。
- Google Play 政策（原文）："an app may not download executable code (such as dex, JAR, .so files) from a source other than Google Play"；例外是在虚拟机/解释器里运行的代码（如 WebView 里的 JavaScript）。页面未提模型文件。**所以"按芯片从自家服务器下发不同 so"在 Google Play 上不可行**；模型数据（非可执行）按需下载，政策页没明说，属推测可行。
- Play 侧合规渠道：Play Feature Delivery / Asset Delivery 的设备定位（beta）可按 SoC（API 31+）、机型、RAM 分组，需 AGP 8.10.0-alpha01 以上。这是"按芯片动态打包"唯一有官方依据的路。
- 国内商店：没有查到华为/小米等对 .so 动态下发的现行条款原文；只查到小米 2022 年的热更新专项整治（针对违规用途，非一律禁止），风险判断为推测。
- 加载位置：Android 10 起，targetSdk ≥ 29 的应用不能对私有目录里的文件 `execve()`，官方建议"只加载 APK 内嵌的二进制代码"；Android 14 起 targetSdk ≥ 34 的动态加载文件必须只读，否则抛异常（官方页针对 DEX/JAR/APK，.so 是否同样适用页面未明说）。`System.load` 从 filesDir 加载 so 在官方页里没有被明确禁止也没被背书，属灰区（推测可用但违反官方指引和 Play 政策）。

**系统自带 AI 能力（只做可行性）**：ML Kit GenAI（基于 AICore / Gemini Nano）对第三方开放，覆盖 Prompt、摘要、校对、改写、图片描述、语音识别；设备列表官方页未给；是否依赖 GMS 页面未明说，国行机型可用性**未知**（国行无 GMS，推测不可用）。不适合作为 Arkli 的通用后端。

**判断（推测 + 已查证混合）**
1. 值不值得做：对轻便工具箱，现在**不值得**。收益只在高通旗舰且模型有预编译版本时才明显；代价是量化+静态 shape+按 SoC 编译的模型矩阵，外加 QNN 库体积与再分发许可不明。
2. 时机：先上 CPU + XNNPACK，把 sherpa 语音和 OCR 做稳；等有明确耗时痛点（长音频 ASR 发热、OCR 卡顿）再评估。
3. 先支持哪家：高通。原因：sherpa 已有 QNN 文档与预编译模型，ORT QNN EP 有文档；联发科需商务协议，华为条款未知，三星/Tensor 走 LiteRT 与 ONNX 路线不通。
4. 若真要做，打包方式只能走 Play 的设备定位分发或把 QNN 库直接打进 APK（体积未知），不要运行时下载 so。

## 2. 二维码 / 条码

| 库 | 坐标 | 生态 | 许可证 | 最近 | 体积 | 契合 | 层 | 纯 JS |
|---|---|---|---|---|---|---|---|---|
| zxing-cpp | `io.github.zxing-cpp:android:3.1.1`；[仓库](https://github.com/zxing-cpp/zxing-cpp) | Maven（含 native） | Apache-2.0 | v3.1.1，2026-07-29 | 未知 | 高：C++ 快、识别率好 | Kotlin | 否 |
| ZXing core | `com.google.zxing:core:3.5.4` | Maven | Apache-2.0 | 2025-11-11 | 未知 | 中：纯 Java，较慢（推测） | Kotlin | 否 |
| @zxing/library | npm 0.23.0 | npm | Apache-2.0 | 2026-04-29 | 11.6MB unpacked | 低：太大 | Web | 是 |
| jsQR | npm 1.4.0 | npm | Apache-2.0 | npm 2021-04-24（疑似停更；仓库 2026-05 有推送） | 273KB unpacked | 中 | Web | 是 |
| nimiq/qr-scanner | [仓库](https://github.com/nimiq/qr-scanner) | npm | MIT | 2024-03-30（疑似停更） | 未知 | 低 | Web | 是 |
| rxing | crates.io 0.9.3 | crates.io | Apache-2.0 | 2026-09-16 | 未知 | 中：zxing 的 Rust 移植，编解码都有 | Rust | 否 |
| rqrr | crates.io 0.11.0 | crates.io | (MIT OR Apache-2.0) AND ISC | 2026-09-02 | 未知 | 高：只解 QR，小 | Rust | 否 |
| nayuki QR-Code-generator | [仓库](https://github.com/nayuki/QR-Code-generator) | 单文件多语言 | MIT（README 注明） | 推送 2026-08-31，最近 release 2022-04（发布少但仍维护） | 未知，单文件很小（推测） | 高 | Web | 是 |
| qrcode（npm） | npm 1.5.4 | npm | MIT | 2024-08-05（疑似停更） | 132KB unpacked | 中 | Web | 是 |
| fast_qr | crates.io 0.14.0 | crates.io | MIT | 2026-09-01 | 未知 | 高 | Rust | 否 |
| qrcode（Rust） | crates.io 0.14.1 | crates.io | MIT OR Apache-2.0 | 2024-07-05（疑似停更） | 未知 | 中 | Rust | 否 |
| ML Kit 条码 | `com.google.mlkit:barcode-scanning` | Google Maven | 专有，免费使用 | 版本未查 | 未知 | 低：依赖 GMS 或自带模型，国行不稳（推测） | Kotlin | 否 |

**推荐**：扫码首选 zxing-cpp（相机帧在 Kotlin 层，CameraX 喂数据），备选 ZXing core。生成首选 nayuki（Web 端，免依赖），备选 fast_qr。相册图片识别可走 Rust rqrr/rxing。自己写？识别不可行，生成可行但没必要。

## 3. OCR（本地模型）

| 库 | 坐标 | 生态 | 许可证 | 最近 | 体积 | 契合 | 层 |
|---|---|---|---|---|---|---|---|
| PaddleOCR（PP-OCR 模型） | [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | 模型 | Apache-2.0 | v3.7.0，2026-06-11 | 模型文件大小未知 | 高：中文好、轻量 mobile 模型 | 模型 |
| RapidOCR | [RapidAI/RapidOCR](https://github.com/RapidAI/RapidOCR)，PyPI | Python + ONNX 模型 | Apache-2.0 | v3.10.0，2026-10-08 | 未知（模型托管 ModelScope，页面未给大小） | 高：提供现成 ONNX 版 PP-OCRv4/v5 mobile 的检测/识别/方向分类模型，可借鉴前后处理 | 参考实现 |
| RapidOcrAndroidOnnx | [仓库](https://github.com/RapidAI/RapidOcrAndroidOnnx) | 源码/AAR | Apache-2.0 | release 1.3.0（2023-02），推送 2025-04，疑似停更 | 未知 | 中：思路可抄，新版转 Compose 仓库 | Kotlin |
| Tesseract | tesseract-ocr/tesseract | C++ | Apache-2.0 | 5.5.3，2026-07-24 | 未知 | 中：中文效果不如 PP-OCR（推测） | native |
| ML Kit 文字识别（中文） | `com.google.mlkit:text-recognition-chinese` | Google Maven | 专有 | 版本未查 | 未知 | 低：国行无 GMS（推测） | Kotlin |
| ort（Rust 绑定） | crates.io 2.0.0-rc.14 | crates.io | MIT OR Apache-2.0 | 2026-10-12 | 动态加载时 0 | 中：仍是 RC | Rust |
| tract-onnx | crates.io 0.23.8 | crates.io | MIT OR Apache-2.0 | 2026-09-21 | 未知 | 中 | Rust |

**推荐**：首选「PP-OCR ONNX（RapidOCR 的模型包）+ 共享 ORT + Rust 前后处理」，模型按需下载。备选 Tesseract。没有现成"轻量 + 活跃 + Android"的封装库，得自己写后处理（约几百行，借鉴 RapidOCR）。

## 4. 图片处理

| 库 | 坐标 | 生态 | 许可证 | 最近 | 体积 | 契合 | 层 | 纯 JS |
|---|---|---|---|---|---|---|---|---|
| image | crates.io 0.25.10 | crates.io | MIT OR Apache-2.0 | 2026-03-10 | 未知 | 高：解码编码多格式一站式 | Rust | 否 |
| fast_image_resize | 6.1.0 | crates.io | MIT OR Apache-2.0 | 2026-07-21 | 未知 | 高：缩放 SIMD | Rust | 否 |
| imageproc | 0.27.0 | crates.io | MIT | 2026-06-02 | 未知 | 中：滤镜/形态学 | Rust | 否 |
| oxipng | 10.2.1 | crates.io | MIT | 2026-09-02 | 未知 | 高：PNG 无损压缩 | Rust | 否 |
| jpeg-encoder | 0.7.1 | crates.io | (MIT OR Apache-2.0) AND IJG | 2026-07-27 | 未知 | 高：纯 Rust JPEG 编码 | Rust | 否 |
| ravif | 0.13.0 | crates.io | BSD-3-Clause | 2026-01-19 | 未知 | 中：AVIF 编码，纯 Rust | Rust | 否 |
| webp（Rust） | 0.3.1 | crates.io | MIT OR Apache-2.0 | 2025-08-29 | 未知 | 中：绑 libwebp C 库 | Rust | 否 |
| libwebp | [webmproject/libwebp](https://github.com/webmproject/libwebp) | C | BSD-3-Clause | 推送 2026-10-12 | 未知 | 中 | native | 否 |
| libavif | AOMediaCodec/libavif | C | BSD-2 | v1.4.2，2026-05-26 | 未知 | 中 | native | 否 |
| libheif | strukturag/libheif | C++ | **LGPL-3.0**（库本体；示例与封装为 MIT） | v1.23.6，2026-10-05 | 未知 | 低：LGPL 要动态链接并可替换 | native | 否 |
| libheif-rs | 3.0.0 | crates.io | MIT（封装；底层仍是 LGPL） | 2026-08-18 | 未知 | 低 | Rust | 否 |
| pica | npm 10.0.3 | npm | MIT | 2026-08-15 | 1.2MB unpacked | 中：浏览器端高质量缩放 | Web | 是 |
| cropperjs | npm 2.3.0 | npm | MIT | 2026-10-07 | 543KB unpacked | 高：裁剪 UI | Web | 是 |
| @jsquash/webp / avif | npm 1.5.0 / 2.1.1 | npm（wasm） | Apache-2.0 | 2025-05（均未满 2 年） | 893KB / 8.2MB unpacked | 中 / 低 | Web | 是（wasm） |
| libheif-js | npm 1.23.5 | npm（wasm） | **LGPL-3.0** | 2026-10-04 | 8.8MB unpacked | 低 | Web | 是 |
| heic2any | npm 0.0.4 | npm | MIT | 2023-03-29，疑似停更 | 2.7MB unpacked | 低 | Web | 是 |
| Coil | `io.coil-kt.coil3:coil:3.6.3` | Maven | Apache-2.0 | 2026-09-18 | 未知 | 中：Compose 图片加载，非处理 | Kotlin | 否 |
| Android-Image-Cropper | CanHub，4.7.0 | Maven | Apache-2.0 | 2025-11-28 | 未知 | 中：原生裁剪备选 | Kotlin | 否 |
| uCrop | Yalantis，2.2.11 | Maven | GitHub 未识别 | 2025-08-07 | 未知 | 低：许可证需确认 | Kotlin | 否 |

- 取色：colorthief 3.5.0（MIT，2026-08-02，1.6MB unpacked）；自写 median-cut 在 Rust 里几十行即可。
- 滤镜 / 水印 / 拼接：没有值得引入的专库，Canvas（Web）或 Rust `image` + `imageproc` 自写可行。
- HEIC/AVIF：Android 平台 ImageDecoder 解码 HEIC（API 28+）、AVIF（API 31+）属于推测，未抓官方文档；minSdk 24 的机型有缺口。**编码 HEIC 没有轻量选择**，AVIF 编码用 ravif。

**推荐**：处理核心用 Rust `image` 系，裁剪 UI 用 cropperjs，缩放预览可用 pica。HEIC 解码首选平台 ImageDecoder，备选 libheif（LGPL，须动态库）。

## 5. GIF / 动图

| 库 | 坐标 | 许可证 | 最近 | 体积 | 契合 | 层 |
|---|---|---|---|---|---|---|
| gif（Rust） | crates.io 0.14.2 | MIT OR Apache-2.0 | 2026-04-09 | 未知 | 高：分帧解码与编码 | Rust |
| gifski | ImageOptim/gifski 1.34.0 | **AGPL-3.0**（可联系作者买别的授权） | release 2025-07-13，推送 2026-06-17 | 未知 | 低：许可证 | Rust |
| gifenc | npm 1.0.3 | MIT | 2021-03-07，疑似停更 | 168KB unpacked | 低 | Web |
| Coil / 平台 | 平台 AnimatedImageDrawable（API 28+，推测） | — | — | 0 | 中：只管播放 | Kotlin |

**推荐**：首选 Rust `gif`（分解、合成），备选平台解码。表情包制作的画面合成放 Canvas，导出 GIF 时调 Rust；颜色量化库未查（量化可自写，NeuQuant 类算法有现成实现，推测）。gifski 画质好但 AGPL，闭源商用不要碰。

## 6. PDF

| 库 | 坐标 | 生态 | 许可证 | 最近 | 体积 | 契合 | 层 |
|---|---|---|---|---|---|---|---|
| 平台 PdfRenderer | android.graphics.pdf（推测） | 平台 | 平台 | — | 0 | 高：渲染成位图 | Kotlin |
| pdfium-binaries | [bblanchon](https://github.com/bblanchon/pdfium-binaries) chromium/8100 | 预编译 native | MIT（打包脚本） | 2026-10-12 | 未知 | 中：兼容性最好但 so 大（推测） | native |
| pdfium-render | crates.io 0.9.4 | crates.io | MIT OR Apache-2.0 | 2026-09-06 | 未知 | 中 | Rust |
| lopdf | crates.io 0.45.0 | crates.io | MIT | v0.45.0，2026-09-08 | 未知 | 高：合并、拆分、页面操作 | Rust |
| pdf.js | pdfjs-dist 6.4.299 | npm | Apache-2.0 | 2026-10-03 | 34.1MB unpacked | 低：太大 | Web |
| @cantoo/pdf-lib | npm 2.11.1 | npm | MIT | 2026-09-15 | 25.7MB unpacked | 低 | Web |
| pdf-lib（原版） | Hopding/pdf-lib 1.17.1 | npm | MIT | release 2021-11，推送 2024-07，疑似停更 | — | 低 | Web |
| PdfBox-Android | TomRoush 2.0.27.0 | Maven | Apache-2.0 | release 2023-01，推送 2024-03，疑似停更 | 未知 | 低 | Kotlin |
| MuPDF | ArtifexSoftware/mupdf | C | **AGPL-3.0** | 推送 2026-10-12 | 未知 | 低：许可证 | native |

**推荐**：渲染/转图片首选 PdfRenderer，备选 pdfium。合并拆分首选 lopdf，备选 pdfium-render。MuPDF 因 AGPL 排除。加密/复杂表单没找到轻量方案。

## 7. 音频 / 视频

**ffmpeg-kit 现状（已查）**：[arthenica/ffmpeg-kit](https://github.com/arthenica/ffmpeg-kit) 仓库已归档（archived=true），许可证 LGPL-3.0，GitHub 上最新 release 是 2023-09-18；Maven Central 的 `com.arthenica` 坐标已取不到元数据，与"官方退役、旧二进制被移除"的说法一致。

| 库 | 坐标 | 许可证 | 最近 | 体积 | 契合 | 层 |
|---|---|---|---|---|---|---|
| Media3 Transformer | `androidx.media3:media3-transformer`（androidx/media 1.11.1） | Apache-2.0 | 2026-09-11 | 未知 | 高：调用 MediaCodec，剪辑/转码/抽音轨，不带 FFmpeg | Kotlin |
| 平台 MediaExtractor/MediaMuxer | 平台（推测） | 平台 | — | 0 | 高：无损抽音频、简单裁剪 | Kotlin |
| ffmpeg-kit-16kb（个人 fork） | `com.moizhassan.ffmpeg:ffmpeg-kit-16kb:6.1.1` | 上游为 LGPL-3.0（推测） | 2025-12-16 | 未知 | 低：个人维护，供应链风险 | Kotlin + native |
| ffmpeg-kit-lts-16kb（个人 fork） | `io.github.jamaismagic.ffmpeg:ffmpeg-kit-lts-16kb:6.1.7` | 同上 | 2026-02-11 | 未知 | 低 | 同上 |
| dev.ffmpegkit-maintained | Maven `dev.ffmpegkit-maintained:ffmpeg` | LGPL-3.0 + 付费分级（来源存疑） | 版本 8.1.x 声称 | 未知 | 低：付费功能与维护者不透明 | 同上 |
| FFmpeg 自编 | [FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg) | 默认 LGPL-2.1+，`--enable-gpl` 即 GPL | 活跃 | 未知，按所选编解码器 | 中：自己精简构建，维护成本高 | native |
| BtbN/FFmpeg-Builds | MIT（构建脚本） | MIT | 2026-10-12 | 面向桌面，不适用 Android | 低 | — |
| ffmpeg.wasm | @ffmpeg/ffmpeg 0.12.15 | MIT（core 许可证随所选构建） | 2025-01-07；core 仓库已归档 | 未知 | 低：wasm 体量大（推测） | Web |
| symphonia | 0.6.1 | MPL-2.0 | 2026-08-13 | 未知 | 中：纯 Rust 解码，不负责编码 | Rust |
| hound | 3.5.1 | Apache-2.0 | 2023-09-25，疑似停更 | 未知 | 中：WAV 简单，可自写 | Rust |

**推荐**：视频剪辑/转码首选 Media3 Transformer，备选自编精简 LGPL FFmpeg（体积和维护成本未知）。**没有轻量的通用"全格式转码"方案**。音频提取走平台 API 最小。MP3/Opus 编码需要 lame/opus C 库，没找到纯 Rust 活跃方案。

## 8. 文本工具

| 库 | 坐标 | 生态 | 许可证 | 最近 | 体积 | 契合 | 层 | 纯 JS |
|---|---|---|---|---|---|---|---|---|
| 内置 | WebCrypto、atob/btoa、TextEncoder、JSON、DOMParser、RegExp（推测，WebView 常识） | 浏览器 | — | — | 0 | 高 | Web | 是 |
| @noble/hashes | npm 2.4.0 | npm | MIT | 2026-08-27 | 675KB unpacked | 高：MD5 等 WebCrypto 没有的补上 | Web | 是 |
| @noble/ciphers | 2.4.0 | npm | MIT | 2026-08-27 | 未查 | 高 | Web | 是 |
| crypto-js | brix/crypto-js | npm | MIT（GitHub 标 NOASSERTION） | 推送 2024-08-09，疑似停更 | 未知 | 低 | Web | 是 |
| RustCrypto sha2 / aes-gcm | 0.11.1 / 0.11.1 | crates.io | MIT OR Apache-2.0 | 2026-10-12 / 2026-08-21 | 未知 | 高 | Rust | 否 |
| jsdiff | npm `diff` 9.0.0 | npm | BSD-3-Clause | 2026-04-13 | 601KB unpacked | 高 | Web | 是 |
| similar | crates.io 3.2.0 | crates.io | Apache-2.0 | 2026-08-17 | 未知 | 高 | Rust | 否 |
| yaml | npm 2.9.1 | npm | ISC | 2026-09-11 | 670KB unpacked | 高 | Web | 是 |
| marked | npm 18.1.1 | npm | MIT | 2026-10-12 | 506KB unpacked | 高 | Web | 是 |
| markdown-it | npm 15.0.2 | npm | MIT | 2026-09-11 | 1.9MB unpacked，6 个依赖 | 中 | Web | 是 |
| pulldown-cmark | crates.io 0.13.4 | crates.io | MIT | 2026-05-20 | 未知 | 中 | Rust | 否 |
| OpenCC | [BYVoid/OpenCC](https://github.com/BYVoid/OpenCC) ver.1.4.2 | C++ | Apache-2.0 | 2026-08-22 | 未知 | 中 | native | 否 |
| opencc-js | npm 1.4.2 | npm | MIT AND Apache-2.0 | 2026-08-22 | 5.9MB unpacked（全词典） | 中：按子包导入可减（推测） | Web | 是 |
| ferrous-opencc / opencc-rust | 0.4.0 / 2.0.2 | crates.io | Apache-2.0 | 2026-04-18 / 2026-10-10 | 未知 | 中：前者是否纯 Rust 未核 | Rust | 否 |
| pinyin-pro | npm 3.29.5 | npm | MIT | 2026-10-10 | 928KB unpacked，0 依赖 | 高 | Web | 是 |
| pinyin（Rust） | 0.11.0 | crates.io | MIT | 2026-01-01 | 未知 | 高 | Rust | 否 |
| jieba-rs | crates.io 0.11.0 | crates.io | MIT | 2026-09-16 | 内置词典大小未知 | 中 | Rust | 否 |
| Intl.Segmenter | 浏览器内置（推测） | 浏览器 | — | — | 0 | 高 | Web | 是 |

**推荐**：Markdown 首选 marked（渲染 HTML 需另配消毒，没查具体库），备选 markdown-it。简繁首选 opencc-js，备选 Rust ferrous-opencc。分词首选 jieba-rs，备选 Intl.Segmenter（零体积，精度未验证）。正则、JSON/XML 格式化直接用内置，不引库。

## 9. 计算与换算

| 库 | 坐标 | 许可证 | 最近 | 体积 | 契合 | 层 |
|---|---|---|---|---|---|---|
| fend-core | crates.io 1.5.8 | MIT | 2026-01-24 | 未知 | 中：表达式 + 单位换算一体，没验证体积 | Rust |
| mathjs | npm 15.2.0 | Apache-2.0 | 2026-04-07 | 9.2MB unpacked，9 个依赖 | 低：太重 | Web |
| evalexpr | crates.io 13.1.0 | **AGPL-3.0-only** | 2025-11-26 | 未知 | 低：许可证 | Rust |
| meval | 0.2.0 | Unlicense/MIT | 2018-09-30，疑似停更 | 未知 | 低 | Rust |
| Kotlin kotlinx-datetime | 0.8.0 | Apache-2.0 | 2026-05-07 | 未知 | 中：日期，但平台 java.time 已够（minSdk 24 要 desugar，推测） | Kotlin |

**推荐**：单位、进制、日期差值是表驱动的小逻辑，**自写完全可行**。表达式首选 fend-core（Rust，经 bridge 调用），备选自写 Pratt 解析（约 200 行，推测）。汇率只列接口思路：App 请求第三方汇率接口，缓存最近值并标注时间，离线时用缓存或手输，不内置汇率库。

## 10. 中文特色

| 库 | 坐标 | 许可证 | 最近 | 体积 | 契合 | 层 | 纯 JS |
|---|---|---|---|---|---|---|---|
| tyme4ts | npm 1.5.3（6tail） | MIT | 2026-10-03 | 735KB unpacked | 高 | Web | 是 |
| lunar-javascript | npm 1.7.7 | MIT | 2025-11-05 | 500KB unpacked | 高：稳定 | Web | 是 |
| tyme4kt / tyme4rs | 1.5.0 / 1.5.0 | MIT | 2026-06-16 / 2026-06-15 | 未知 | 中：原生层需要时用 | Kotlin / Rust | 否 |
| relationship.js | npm 1.2.9（[mumuy/relationship](https://github.com/mumuy/relationship)） | MIT | npm 2026-04-29 | 336KB unpacked | 高：亲戚称谓计算 | Web | 是 |
| libphonenumber-js | npm 1.13.15 | MIT | 2026-10-08 | 9.9MB unpacked | 低：只做国内号码时过重 | Web | 是 |
| libphonenumber | google/libphonenumber v9.0.41 | Apache-2.0 | 2026-10-08 | 未知 | 低 | Kotlin | 否 |

**推荐**：农历节气首选 tyme4ts（同作者 lunar 系列，tyme 系推测为后继），备选 lunar-javascript。亲戚关系首选 relationship.js，备选自写规则表。身份证校验位（GB 11643 的加权 MOD 11-2）、手机号 11 位基础正则是几十行逻辑，**自写即可**；行政区划码数据表需自备，没查来源；号段会变，别靠号段判运营商。

## 11. 压缩解压

| 库 | 坐标 | 许可证 | 最近 | 体积 | 契合 | 层 |
|---|---|---|---|---|---|---|
| zip（Rust） | crates.io 9.0.2 | MIT | 2026-10-11 | 未知 | 高 | Rust |
| sevenz-rust2 | 0.24.0 | Apache-2.0 | 2026-10-11 | 未知 | 高：7z 读写 | Rust |
| commons-compress | `org.apache.commons:commons-compress:1.28.0` | Apache-2.0 | 2025-07-29 | 未知 | 中 | Kotlin |
| zip4j | `net.lingala.zip4j:zip4j:2.11.6` | Apache-2.0 | 2026-02-11 | 未知 | 中：AES 加密 zip | Kotlin |
| xz-java | 1.12 | 0BSD | 2026-03-01 | 未知 | 中 | Kotlin |
| junrar | `com.github.junrar:junrar:8.1.2` | **UnRAR 自由软件许可（非 OSI，能解不能造 RAR 压缩）**；GitHub 标 NOASSERTION | 2026-10-09 | 未知 | 中：仅解压 | Kotlin |
| unrar（Rust） | 0.5.8 | MIT OR Apache-2.0（封装；底层 UnRAR C 源码许可沿用，推测） | 2025-02-19 | 未知 | 低 | Rust |
| fflate | npm 0.8.3 | MIT | 2026-05-16 | 778KB unpacked | 中：Web 端小文件 | Web |

**推荐**：zip + 7z 首选 Rust（zip + sevenz-rust2），备选 commons-compress。rar 只解压，junrar，需法务确认 UnRAR 许可；**不提供 rar 压缩**（没有合法的开源实现）。

## 12. 传感器、设备、网络、语音

- **传感器与设备信息**：指南针、水平仪、光线、气压用平台 SensorManager；分贝用 AudioRecord 自己算 RMS 再换 dB（校准有偏差，推测）；设备信息读 Build/系统 API。开源参考 Omni（指南针/水平仪/尺子/手电，Kotlin，GPL-3.0）。**无需第三方库，自写可行**。
- **网络工具**：

| 库 | 许可证 | 最近 | 契合 |
|---|---|---|---|
| 平台 InetAddress / Socket + 自写 | 平台 | — | 高：DNS、端口探测、测速（HTTP 计时，服务端需自备） |
| hickory-resolver 0.26.3 | MIT OR Apache-2.0 | 2026-09-10 | 中：自定义 DNS 服务器查询 |
| surge-ping 0.9.1 | MIT | 2026-09-16 | 中：ICMP ping，Android 上权限是否可用没验证 |
| trippy 0.13.0 | Apache-2.0 | release 2025-05，推送 2026-10-12 | 低：traceroute 的 TUI，仅参考 |

  ping 的稳妥做法：调系统 `ping` 可执行文件（位于 /system，不受"私有目录 execve"限制，推测）。首选平台 API 自写，备选 Rust hickory。
- **TTS / 语音**：首选系统 TextToSpeech（0 体积，国行机型引擎情况未知）；备选 sherpa-onnx TTS（Rust 示例脚本里有 Kokoro、Matcha、VITS、Kitten、Pocket、Supertonic、ZipVoice 等模型，模型体积未知，按需下载）。语音识别、VAD、降噪直接用 sherpa-onnx。**Piper 要警惕**：原仓库 rhasspy/piper（MIT）已归档（2025-08），继任仓库 OHF-Voice/piper1-gpl 是 GPL-3.0，不要直接集成；用 sherpa-onnx 加载 VITS/Piper 类模型即可绕开。

## 13. 开源安卓工具箱 App 参考

| 项目 | 技术栈 | 功能范围 | 许可证 | 活跃度 | 借鉴点 |
|---|---|---|---|---|---|
| [OneBox / 万宝盒](https://github.com/wangzhishou/OneBox) | Kotlin（含 JS/HTML） | 90+ 工具、图片/文档工具、AI 智能体调用工具 | Apache-2.0 | 推送 2026-10-12，713 star | 工具注册 + 智能体调度；已在国内多家商店上架 |
| [ToolixHub](https://github.com/Zykrave/ToolixHub) | Kotlin + Compose + M3，minSdk 24 | 计算/换算、文本、日期等，带搜索/收藏/历史 | Apache-2.0 | v1.2.0，推送 2026-09-13，5 star | minSdk 与 Arkli 相同，离线优先，分类结构 |
| [xiaowen-toolbox](https://github.com/jingqiwen/xiaowen-toolbox) | Kotlin（含 JS/Java），Compose，minSdk 26 | 78 个工具：随机、计算、文本、影音图像、函数绘图等 | **自定义非商业许可，禁止商用** | v0.13.1，推送 2026-09-11，1 star | "工具注册表 + 单工具页面"的组织方式；代码不要复制 |
| [Omni](https://github.com/FoedusProgramme/Omni) | Kotlin，M3 | 指南针、水平仪、尺子、手电 | GPL-3.0 | 推送 2025-10-04 | 传感器类工具实现 |
| [Unitto](https://github.com/sadellie/unitto) | Kotlin/Java | 单位换算 | GPL-3.0 | 2026-10-08，730 star | 换算 UI 与单位表 |
| [BinaryEye](https://github.com/markusfisch/BinaryEye) | Kotlin | 条码扫描与生成 | MIT | release 1.75.5（2026-10-08），2,418 star | 扫码与生成的实际产品形态，可直接参考 |
| [phyphox](https://github.com/phyphox/phyphox-android) | C/Java | 传感器实验 | GPL-3.0 | v1.2.1，2026-09-04 | 传感器数据采集与展示 |
| [Fossify Calculator / Gallery](https://github.com/FossifyOrg/Gallery) | Kotlin | 计算器、相册 | GPL-3.0 | 2026-10 活跃 | 小工具的成熟交互 |

- 结论：GitHub 上**没找到**活跃、成体系、对标"木函"的大型开源安卓工具箱（搜索 toolbox/工具箱 等关键词，结果多为 0 到几个 star 的个人项目）。有价值的是单功能的成熟项目，以及 OneBox 这类中型聚合项目。
- 许可证提醒：GPL-3.0 项目只能看思路，不能抄代码进闭源产品；xiaowen-toolbox 明确禁商用；只有 MIT / Apache-2.0 的（BinaryEye、OneBox、ToolixHub）代码可在保留声明的前提下参考复用。
- 没做：木函本身没有开源仓库（没查到），未对标其功能细节，见 `woobx-feature-list.md`。

## 风险与未知

**许可证风险**
- AGPL：MuPDF、gifski（可买别的授权）、evalexpr。闭源商用不可用。
- LGPL：libheif / libheif-js（LGPL-3.0）、FFmpeg 默认（LGPL-2.1+，开 gpl 选项即 GPL）、ffmpeg-kit 系 fork（LGPL-3.0）。需动态链接、可替换、附声明；Android 上 so 放 jniLibs 动态加载可满足，细节要法务确认。
- GPL：piper1-gpl（GPL-3.0）；所有 GPL 的开源 App 只能借鉴。
- MPL-2.0：uniffi（crates.io 0.32.2）、symphonia（0.6.1），文件级 copyleft，改了它们的源文件才需公开。
- 非 OSI：junrar 的 UnRAR 许可。
- 厂商运行库：高通 QNN、联发科 NeuroPilot、华为 HiAI 的再分发条款均未查到明文，联发科基本需商务协议。
- GitHub 未识别许可证：uCrop（`none`）、nayuki（README 声明 MIT）等，上线前读 LICENSE。

**停更 / 低活跃（距今 >2 年或 release 久未更新）**
- qrcode（npm 2024-08）、jsQR（npm 2021-04）、nimiq/qr-scanner（2024-03）、qrcode（Rust 2024-07）、gifenc（2021）、heic2any（2023）、crypto-js（2024-08）、pdf-lib 原版（release 2021-11）、PdfBox-Android（release 2023-01）、meval（2018）、hound（2023）、RapidOcrAndroidOnnx（release 2023-02）、ffmpeg-kit（已退役归档）。
- 个人维护的 ffmpeg-kit fork（moizhassan、jamaismagic、dev.ffmpegkit-maintained）供应链风险高。

**体积未知（需实测后补）**
- 绝大多数 Rust crate 的 arm64 增量、zxing-cpp / Media3 / pdfium / commons-compress 的 AAR 增量、PP-OCR 模型大小、jieba 词典、QNN 运行库、ORT 精简构建后的 so。写入方案前，应在 core 里加一个体积基线脚本，一个库一个库测。
- npm 的"unpacked"是包体不是打包后 bundle，实际要经 Vite tree-shaking 后再量。

**其他不确定项**
- sherpa-onnx 在 Android 上由 Rust crate 构建/链接的实际路径未验证；ORT 1.28.2 自建包的算子覆盖未验证；`ort` crate 复用 sherpa 的 libonnxruntime.so 的版本兼容未验证。
- 平台 API 相关结论（PdfRenderer、ImageDecoder 的 HEIC/AVIF 版本线、MediaExtractor、Intl.Segmenter）标了「推测」的均未抓官方文档，落地前核对。
- 国内应用商店对 so 动态下发的现行条款、各 SoC 厂商市占比例：未查到。

## 来源

- sherpa-onnx：[仓库](https://github.com/k2-fsa/sherpa-onnx)、[v1.13.8 release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8)、[crates.io](https://crates.io/crates/sherpa-onnx)、[provider.h](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/provider.h)、[ORT 版本 cmake](https://github.com/k2-fsa/sherpa-onnx/blob/master/cmake/onnxruntime-android-aarch64.cmake)、[QNN 文档](https://k2-fsa.github.io/sherpa/onnx/qnn/index.html)
- ONNX Runtime：[Maven 元数据](https://repo1.maven.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/maven-metadata.xml)、[自定义构建](https://onnxruntime.ai/docs/build/custom.html)、[QNN EP](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html)、[NNAPI EP](https://onnxruntime.ai/docs/execution-providers/NNAPI-ExecutionProvider.html)、[Plugin EP](https://onnxruntime.ai/docs/execution-providers/plugin-ep-libraries/usage.html)
- Android / Google：[NNAPI 弃用说明](https://developer.android.com/ndk/guides/neuralnetworks)、[LiteRT NPU](https://developers.google.com/edge/litert/next/npu)、[Gemini Nano / ML Kit GenAI](https://developer.android.com/ai/gemini-nano)、[Play 设备与网络滥用政策](https://support.google.com/googleplay/android-developer/answer/9888379)、[设备定位](https://developer.android.com/google/play/device-targeting)、[Android 14 行为变更](https://developer.android.com/about/versions/14/behavior-changes-14)、[Android 10 行为变更](https://developer.android.com/about/versions/10/behavior-changes-10)
- 厂商：[高通 AI Engine Direct SDK](https://www.qualcomm.com/developer/software/qualcomm-ai-engine-direct-sdk)、[联发科 NeuroPilot](https://neuropilot.mediatek.com/)、[华为 HiAI 2.0（2018）](https://www.huawei.com/en/news/2018/11/huawei-hiai-2-ultimate-ai-app-experience)
- 数据来源：各仓库的许可证、star、推送与 release 时间来自 GitHub API（2026-10-13 查询）；npm 版本、体积来自 registry.npmjs.org；crate 版本来自 crates.io API；Maven 版本来自 repo1.maven.org 的 maven-metadata.xml；AAR 体积来自实际下载 sherpa-onnx v1.13.8 AAR 与 onnxruntime-android 1.31.0 AAR 后解包测量。
- ffmpeg-kit 现状：[arthenica/ffmpeg-kit](https://github.com/arthenica/ffmpeg-kit)、[dev.ffmpegkit-maintained](https://central.sonatype.com/artifact/dev.ffmpegkit-maintained/ffmpeg)、[16KB fork](https://github.com/moizhassankh/ffmpeg-kit-android-16KB)
- RapidOCR 模型清单：[RapidOCR 文档](https://rapidai.github.io/RapidOCRDocs/main/model_list/)
- 小米热更新专项报道：[gamersky](https://www.gamersky.com/tech/202207/1498791.shtml)
