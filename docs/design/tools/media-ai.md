---
title: 音视频与 AI 类工具落地设计
status: draft
updated: 2026-10-13
summary: 「音视频」「AI 与识别」分类全部工具的落地方案：层归属、所用库与模型、bridge 方法、体积与优先级
---
## TL;DR
- 覆盖功能清单里两类共 10 项（音视频 4、AI 与识别 6），定级为 P0 3 项、P1 3 项、P2 2 项、建议不做 2 项（AI 人脸融合、黑白图像上色）。
- 体积：非 AI 部分 APK 只增约 2~3MB（主要是 Media3 Transformer，R8 后，推测）；AI 部分的大头是共享的 libonnxruntime.so（22.25MB 未压缩 / 约 8MB deflate，已查证），OCR 一上就得带。模型都按需下载，P0+P1 合计约 26MB（OCR 约 21MB + 超分约 4.7MB），全部做完上限约 80MB。
- 关键决定一：音视频不碰 FFmpeg，统一走 Media3 Transformer 调系统硬件编解码器，界面放 Web，活儿交给原生前台服务干，进度走事件推回页面。
- 关键决定二：所有视觉 AI 共用一个 Rust「AI 运行时」：动态加载 sherpa 自带的那份 ORT，会话缓存复用，模型由原生按 manifest 下载。语音只有「文字转语音」一项，先用系统 TTS（0 体积），sherpa 离线音色放到 P2。

## 总览表

| # | 工具 | 层 | 首选方案 | APK 增量 / 模型 | 优先级 |
|---|---|---|---|---|---|
| 1 | 视频压缩 | Web 界面 + 原生执行 | Media3 Transformer 硬件转码 | Media3 约 1.5~3MB（推测，与 2、3 共用）/ 无 | P0 |
| 2 | 视频提取音频 | Web 界面 + 原生执行 | Transformer 去视频轨，能直通就不重编码 | 0（共用 Media3）/ 无 | P0 |
| 3 | 视频转 GIF | Web 界面 + 原生抽帧 + Rust 编码 | Media3 FrameExtractor + Rust `gif` | 约 0.1~0.3MB（推测）/ 无 | P1 |
| 4 | 文字转语音 | Web 界面 + 原生 | 系统 TextToSpeech；离线音色包另议 | 0 / 可选 14~31MB | P1（离线包 P2） |
| 5 | OCR 文字识别 | Web 界面 + Rust | PP-OCRv5 mobile + 共享 ORT + Rust 前后处理 | ORT 22.25MB 未压缩（全体 AI 共用）/ 约 21MB | P0 |
| 6 | AI 图像识别 | Web 界面 + Rust | ImageNet 1000 类轻量分类模型 + 中文标签表 | 0 / 5~21MB | P2 |
| 7 | AI 人脸融合 | — | 不做 | — | 建议不做 |
| 8 | 黑白图像上色 | — | 暂不做，留模型接口 | — | 建议不做 |
| 9 | 图像分辨率提升 | Web 界面 + Rust | Real-ESRGAN general x4v3（SRVGGNetCompact）分块推理 | 0 / 约 4.7MB | P1 |
| 10 | 对象计数 | Web 界面 + Rust | 传统 CV 数连通域 + 手动修正；检测模型可选 | 0 / 可选约 4MB | P2 |

## 共用部件

### A. Web 端「选文件 → 处理 → 进度 → 保存」流程组件
- 一个通用组件（暂名 `ToolFileFlow`）加一个 Pinia store 管状态：`idle → picked → running → done | error | canceled`。
- 统一处理：调 `native.file.pick` 选文件（带 mime 过滤）、展示参数表单、发起任务、订阅 `task.progress` 显示进度条和预计剩余时间、完成后预览、调 `native.file.save` / `native.share` 保存或分享、离开页面时提示「任务会在后台继续」或取消。
- 10 个工具里有 7 个直接套这个组件，每个工具只写参数表单和结果展示。

### B. 原生「长任务执行器」（前台服务）
- 一个 `ToolTaskService`，串行跑一条队列（同时只跑一个重任务，免得手机烫手），视频压缩、提取音频、转 GIF、超分都进这里。
- 前台服务类型：API 35+ 用 `mediaProcessing`（每 24 小时累计 6 小时上限，已查证）；API 34 用 `dataSync`；更低版本不需要声明类型。任务期间持 partial wake lock，结束即释放。
- 进度：Media3 用 `Transformer.getProgress()` 每 300ms 轮询一次；Rust 任务通过 UniFFI 回调接口上报。统一转成 `task.progress` 事件 `{ taskId, percent, stage }`，结束发 `task.done { taskId, outPath, ... }` / `task.error`。通知栏同步显示进度和「取消」按钮。
- 页面被关掉或 WebView 重建后，页面重新进来用 `native.task.status` 取回结果，产物留在缓存目录，有限期清理。
- 这部分的 bridge 方法属公共基础设施，见文末。

### C. 模型管理（原生）
- 一份随 APK 发的 `models.json` manifest，每个模型一项：`id`、`version`、`files[]`（名字、sha256、大小）、`urls[]`（多镜像）、`license`、`task`（ocr/sr/cls/det/tts）、`config`（输入尺寸、均值方差、标签文件名等前后处理参数）。
- 页面在用到模型前调 `native.model.ensure { id }`：没装就弹「需下载 xx MB，建议 Wi-Fi」，确认后下载（断点续传、sha256 校验、解压到 `filesDir/models/<id>/<version>/`），进度走 `model.progress` 事件。
- Rust 不自己找文件：原生把模型目录绝对路径和 config 传给 Rust。没装就返回 `NOT_READY`。
- 「换模型不改代码」靠 config：同一类任务（如超分）只要输入输出约定一致，换一份 ONNX 加改 config 就行。

### D. Rust「AI 运行时」（core 里新开 `arkli-ai` crate）
- **ORT 只有一份**：用 `ort` crate 的动态加载方式加载 sherpa-onnx 1.13.8 带的 `libonnxruntime.so`（ORT 1.28.2）。`ort` 2.0.0-rc.14 与 1.28.2 的 C API 版本能不能对上还没验证，这是第一个要做的技术验证（推测可行）。
- **会话复用**：进程内一个 `Environment` 单例，会话按模型 id 放进 LRU，最多同时留 2 个；空闲 60 秒或原生收到 `onTrimMemory` 时释放。
- **provider 探测**：不写死链。运行时初始化时调一次 `GetAvailableProviders`，列出什么用什么，CPU 必须永远可用。spike B 实测 sherpa 自带的 ORT 1.28.2 只含 NNAPI 与 CPU，没有 XNNPACK（显式注册会报错）；NNAPI 能注册但无加速、多占内存，默认不开。所以现阶段实际就是 CPU，靠 ORT 自带的 MLAS。NPU 先不做，只留枚举位。线程数默认 4，低电量或后台任务降到 2。想要 XNNPACK 只能自编 ORT，与「ORT 只带一份」冲突，不做。
- **公共前后处理**：Rust 侧不引 `image` 系（`image`、`fast_image_resize` 等），以图片类设计为准，只用 `png` 读 PNG。EXIF 方向和 JPEG/WebP/HEIC 解码交给原生（平台 `BitmapFactory` / `ImageDecoder` + `ExifInterface`，按需 `inSampleSize` 降采样），原生把摆正后的图以 PNG 写缓存再交给 `rust.ai.*`（见未决问题 9）。缩放（双线性 / Lanczos）、NCHW 归一化、分块推理与拼接（超分用，OCR 大图也可用）都自己写，各几十行；取消令牌和进度回调同理。
- **输入上限**：所有 AI 接口先把图片长边压到各自上限（OCR 4096、超分 1024、分类 512 内部再缩），防止 OOM。

### E. 音视频公共探测
- `native.media.probe { path }` → `{ durationMs, width, height, rotation, fps, videoMime, audioMime, bitrate, sizeBytes, hasAudio }`，用平台 `MediaMetadataRetriever`（0 体积）。视频三件套共用，用来给参数默认值和估算产物大小。

## 逐工具方案

### 1. 视频压缩（P0，难度 M）
- **层**：Web 界面 + 原生执行（要前台服务，按归属规则第 1 条归原生；表单很简单，所以界面仍放 Web）。
- **引擎**：Media3 Transformer 1.11.1，底层是系统 MediaCodec 硬件编解码，不带 FFmpeg。
- **流程**：选视频 → probe → 选档位 → 进任务服务转码 → 产物写缓存 → 预览 → 保存到 `Movies/Arkli`。
  - 档位：「清晰 1080p/约 4Mbps」「标准 720p/约 2Mbps」「小体积 540p/约 1Mbps」，另有「目标大小」：码率 = 目标字节×8 / 时长 − 音频 96kbps，算出来太低就提示画质会很差。
  - 实现要点：`Presentation` 改分辨率（保持比例、只降不升）；`DefaultEncoderFactory` 加 `VideoEncoderSettings` 设码率；可选去掉音轨；编码默认 H.264（兼容最好），设备有 HEVC 编码器时给「更小（HEVC）」选项；HDR 源做 HDR→SDR 色调映射。
- **为什么不用 FFmpeg**：ffmpeg-kit 已归档退役，个人 fork 有供应链风险；自编精简 LGPL FFmpeg 要动态链接、维护构建脚本，体积按编解码器另算。硬件编码又快又省电，代价是格式受设备限制：只输出 MP4，输入只支持设备能硬解的（常见 MP4/MKV/WebM/3GP/TS 没问题，RMVB/WMV 不支持，直接报「不支持这种视频」）。
- **耗时与耗电（推测，待实测）**：中端机 1080p→720p 大约接近或快于实时，1 分钟视频几十秒；10 分钟视频耗电个位数百分比，机身会热。
- **Bridge**：`native.media.probe`；`native.media.compress { path, preset | { height, videoBitrate, codec: "avc"|"hevc", removeAudio }, taskId }` → 完成时 `{ outPath, sizeBytes, durationMs }`；进度 `task.progress`；取消 `native.task.cancel`。
- **权限**：通知（API 33+，拒绝也能跑，只是通知不显示）、前台服务相关声明；全程离线。
- **风险/测试**：机型编码器差异大（码率不达标、某些分辨率编码器拒绝），准备 3~5 款不同 SoC 真机；测竖屏旋转、HDR、可变帧率、4K 输入、转码中途杀进程。

### 2. 视频提取音频（P0，难度 S）
- **层**：Web 界面 + 原生执行。
- **方案**：Transformer 设置 `removeVideo`。源音频是 AAC 时直接直通封装成 `.m4a`，不重编码，几秒完成；源是其他编码（Opus、AC3 等）时转成 AAC 128kbps。源是 MP3 时直接把 MP3 帧写成 `.mp3`（MediaExtractor 读样本顺序写出即可，零重编码）。
- **不提供 MP3 编码输出**：要 LAME（LGPL），不值。需要 WAV 的话，后续可用 Rust 写 44 字节头的 PCM WAV，不引库。
- **Bridge**：`native.media.extractAudio { path, startMs?, endMs?, taskId }` → `{ outPath, mime, sizeBytes, durationMs }`。
- **体积**：0（共用 Media3）。如果 Media3 最终不引入，退回平台 MediaExtractor + MediaMuxer，同样 0 体积，只是非 AAC 源做不了。
- **默认保存**：`Music/Arkli`（木函是 `Download/woodbox/MxAudio`，没必要照抄）。离线、无额外权限。
- **测试**：无音轨视频要友好报错；多音轨默认取第一条；测时长精度。

### 3. 视频转 GIF（P1，难度 M）
- **层**：Web 选区间和参数 → 原生抽帧 → Rust 编码。
- **抽帧**：`media3-inspector-frame` 1.11.1 的 `FrameExtractor`（AAR 仅 28KB，依赖与 Transformer 重合，已查证），按 `1000/fps` 毫秒步进取 Bitmap，缩到目标宽度后拿 RGBA 字节直接经 UniFFI 交给 Rust（进程内传，不落盘、不过 bridge）。逐帧取太慢的话，备选平台 `MediaMetadataRetriever.getFrameAtTime(OPTION_CLOSEST)`。
- **编码**：Rust `gif` 0.14.2，默认 feature 带 `color_quant`（NeuQuant 量化，已查证），每帧独立调色板；第二步再做「相邻帧不变像素置透明」优化体积。`gifski`（AGPL）、`imagequant`（GPL/商业授权，推测）都不能用。
- **限制**：时长 ≤15 秒、宽 ≤480、fps 5~15（木函说法是「帧率随时长调整」，照做：时长越长默认帧率越低）。页面根据参数预估大小，480×270、10fps、10 秒大约 3~8MB（推测）。
- **Bridge**：`native.media.toGif { path, startMs, endMs, fps, width, taskId }` → `{ outPath, sizeBytes, frames }`。Rust 侧暴露 UniFFI 接口 `GifWriter.new(path, w, h, fps) / add_frame(rgba) / finish()`，只给原生用，不开放给页面。图片类的「GIF 合成/分解」可共用这一层封装。
- **体积**：Rust `gif` + `color_quant` 约 0.1~0.3MB（推测）。离线、无额外权限。
- **测试**：量化后颜色带状、长视频内存（逐帧处理，不能一次全载入）、旋转视频方向。

### 4. 文字转语音（P1；离线音色包 P2；难度 S / M）
- **层**：Web 界面 + 原生。
- **首选**：系统 `TextToSpeech`。朗读用 `speak`，导出用 `synthesizeToFile` 写 WAV。文本超过 `getMaxSpeechInputLength()` 时按句号/换行切段，WAV 拼接在原生做（只是改头部长度，十几行）。0 体积。
- **木函的「5 种常用语音」**：系统引擎有几个音色就列几个，保证不了 5 个。设备没有中文引擎时（部分国内 ROM 或纯净系统，推测），引导用户装引擎，或下载离线音色包。WebView 的 `speechSynthesis` 不稳定，不用。
- **离线音色包（P2）**：走 sherpa-onnx 离线 TTS。候选（release 资产大小已查证）：`vits-icefall-zh-aishell3` 31MB，多说话人，挑 5 个说话人刚好对上「5 种语音」；`vits-piper-zh_CN-*-int8` 每个音色 14MB。模型和数据集的商用许可证都没核实，上线前必须核实。代价：除共享 ORT 外要多带 `libsherpa-onnx-c-api.so` 4.47MB 未压缩（经 Rust `sherpa-onnx` crate 调用，不带 JNI so）。
- **Bridge**：`native.tts.voices` → `{ voices: [{ id, name, locale, needsNetwork }] }`；`native.tts.speak { text, voiceId, rate, pitch }`；`native.tts.stop`；`native.tts.synthesize { text, voiceId, rate, pitch, taskId }` → `{ outPath, durationMs }`；事件 `tts.done`。离线包：`rust.ai.tts { text, model, speakerId, speed, taskId }` → `{ outPath, durationMs }`。试听用页面 `<audio>` 播放缓存路径。
- **网络**：系统引擎个别音色需联网（`needsNetwork` 标出来），其余离线。
- **测试**：多 ROM 的引擎可用性（小米/华为/OPPO/vivo 至少各一台）、长文本切段边界、导出格式是否真为 WAV。

### 5. OCR 文字识别（P0，难度 L，第一个 AI 工具，顺带把运行时打通）
- **层**：Web 界面 + Rust（计算中等，属归属规则第 4 条）。
- **模型**：RapidOCR 托管的 PP-OCRv5 mobile ONNX，Apache-2.0。检测约 4.7MB（Paddle 格式数字，已查证）、识别约 16MB（第三方转出的 ONNX 15.8MiB，已查证）、文本行方向分类不到 1MB（推测），外加约 1.8 万字的字典文件。合计约 21MB，按需下载。
- **流程**：取图（相册走 `native.file.pick`；拍照走 `native.camera.capture`，调系统相机 Intent，不引 CameraX）→ `rust.ai.ocr` → 检测（DB，长边缩到 960 并对齐 32）→ 二值化、找轮廓、最小外接矩形（`imageproc`）→ 外扩 → 透视裁行 → 可选方向分类 → 识别（CTC 贪心解码）→ 按阅读顺序排行 → 返回。
- **为什么部分自写**：没有活跃又轻的 Android 封装（RapidOcrAndroidOnnx 疑似停更）。后处理照 RapidOCR 写，几百行；DB 的 unclip 作用在矩形上，等价于把宽高各加 2d（d = 面积×1.5/周长），所以不需要 clipper 库。
- **Bridge**：`rust.ai.ocr { path, model?: "ocr-zh-mobile", cls?: boolean }` → `{ text, lines: [{ text, score, box: [x1,y1,…,x4,y4] }], width, height, costMs }`。页面在原图上画框，可点选单行复制；复制走 `native.clipboard.write`。
- **耗时/内存（推测）**：中端机一张 1080p 截图 0.5~2 秒，峰值内存 150~300MB。
- **权限/网络**：首次下载模型要联网，之后全离线；拍照受相机权限约束（App 声明了 CAMERA 时，Intent 拍照也要先授权）。
- **关于「图片文字化」**：清单原话含糊。如果指 OCR，就是本工具；如果指「字符画」，应归图片类，Web Canvas 实现，0 体积，不在本文范围。需要用户确认。
- **可复用**：图片类的「图片提取表格」可以复用检测和识别结果，再加表格结构推断，不另引模型。
- **风险/测试**：sherpa 那份 ORT 的算子覆盖（自建包，有没有裁剪过不清楚）必须拿真模型跑一遍；`ort` crate 动态加载的版本兼容；测竖排文字、低光拍照、超长截图（分块检测）。

### 6. AI 图像识别（P2，难度 M）
- **能否本地化**：能，但只到「千类物体分类」这个程度，达不到服务端「识万物」的水平。
- **模型类别**：ImageNet-1k 轻量分类网络，如 MobileNetV3-Large（约 5.4M 参数，fp32 约 21MB，int8 约 5.5MB，推测）或 EfficientNet-Lite0 量级。输入 224×224，输出 top-5。中文标签表 1000 行，要自己整理进模型包。
- **Bridge**：`rust.ai.classify { path, topK?: 5 }` → `{ items: [{ label, labelZh, score }], costMs }`。
- **耗时**：几十到一百多毫秒（推测）。首次下载模型要联网。
- **为什么 P2**：ImageNet 类别偏门（上百种狗），给普通用户看观感一般；想认花草、植物得换专门模型，体积和数据许可都另算。也可以和对象计数合并成一个「识物」工具，共用一个检测模型（见未决问题）。
- **风险**：预训练权重的商用许可（ImageNet 数据衍生）各家口径不一，要逐个核实。

### 7. AI 人脸融合（建议不做）
- 本地化不现实：主流换脸方案的融合模型约 500MB 量级，且常用权重是非商用许可（推测，以 InsightFace 系为代表）；CPU 上跑也慢。
- 合规成本高：人脸属于敏感个人信息，要单独同意；「深度合成」类服务有显著标识、安全评估等监管要求（推测，未逐条查原文）。
- 结论：不属于本 App 本体。真要做只能自建服务并单独过合规，不建议。

### 8. 黑白图像上色（建议不做，暂缓）
- 能否本地化：技术上能。开源上色模型（ECCV16 系、DeOldify、DDColor 等）普遍在 100MB 以上（推测），中端机 CPU 跑一张 512px 要数秒到数十秒，效果也不稳定（偏色、发灰）。
- 和「轻便」原则冲突，木函也把它放在付费档。先不做，等出现几十 MB 以内、效果还行、许可证干净的 ONNX 模型再说。到时套用超分的流程即可：模型只预测 Lab 色度通道，低分辨率推理后放大，再和原图亮度合成，输出保持原分辨率。

### 9. 图像分辨率提升（P1，难度 M）
- **能否本地化**：能，而且很划算。
- **模型**：Real-ESRGAN `realesr-general-x4v3`（SRVGGNetCompact，约 1.2M 参数，fp32 约 4.7MB，BSD-3-Clause，已查证；有 int8 版约 1.25MB，在 CPU 上的画质与速度未验证）。
- **流程**：输入长边上限 1024（超过就提示先缩）→ 切 192px 小块、每边重叠 16px → 逐块推理 x4 → 羽化拼接 → 要 2 倍时，把 4 倍结果用共用部件 D 里自写的 Lanczos 缩回去 → 写 PNG/JPEG 到缓存。走共用部件 B 的任务服务，可取消，按块数报进度。
- **Bridge**：`rust.ai.upscale { path, scale: 2|4, format?: "png"|"jpg", taskId }` → `{ outPath, width, height, costMs }`。
- **耗时（推测，粗算）**：每个输入像素约 2.4 MFLOP，512×512 输入约 0.6 TFLOP，中端机 CPU 大约 10~30 秒；1024×1024 要 1~2 分钟。所以默认建议 ≤768。
- **风险/测试**：拼接缝、JPEG 噪点被放大（可以加一个 wdn 降噪版模型作为第二选择，先不做）、大图内存（输出 4096² RGBA 约 64MB）。

### 10. 对象计数（P2，难度 M）
- **形态不确定**：清单只有名字（单来源）。按常见用途理解为「数钢管、药片、细胞、人头」这类。
- **方案（先不上模型）**：Rust `imageproc` 做传统 CV：灰度 → Otsu 阈值 → 开运算 → 距离变换找局部极大值（分开粘连的圆形物体）→ 连通域计数。页面上叠标记点，用户点击增删修正，可框选 ROI，用一个灵敏度滑块调参。纯背景下的规则物体这套就够用，0 模型。
- **可选模式**：COCO 80 类检测模型数「人/车/瓶子」，用 YOLOX-Nano 或 NanoDet 这类 Apache-2.0 小模型（约 4MB，推测）。**不要用 Ultralytics YOLO 系（AGPL）**。密集同类物体（类无关计数）的模型都偏大，不做。
- **Bridge**：`rust.ai.count { path, mode: "blob"|"detect", roi?, invert?, sensitivity?, classes? }` → `{ count, items: [{ x, y, w, h, score?, label? }] }`。
- **测试**：粘连物体、阴影背景、反光；结果一定要允许人工修正，别让用户觉得「AI 数错了没法改」。

## 新增依赖清单

| 名称 | 版本 | 许可证 | 用途 | 层 |
|---|---|---|---|---|
| androidx.media3:media3-transformer | 1.11.1 | Apache-2.0 | 视频压缩、提取音频。会连带 media3-effect / exoplayer / muxer / common / extractor / container / datasource / decoder，以及 Guava 33.3.1-android（已查证 POM）。这些 AAR 合计约 4.5MB（未经 R8，已查证），R8 后约 1.5~3MB（推测，待基线实测） | app |
| androidx.media3:media3-inspector-frame | 1.11.1 | Apache-2.0 | 视频转 GIF 抽帧（28KB） | app |
| sherpa-onnx（取其 libonnxruntime.so；离线 TTS 时再加 c-api.so） | 1.13.8（内含 ORT 1.28.2） | Apache-2.0 | 所有视觉 AI 的推理运行时；离线 TTS | app jniLibs |
| ort | 2.0.0-rc.14 | MIT OR Apache-2.0 | Rust 动态加载上面那份 ORT（RC 版，有 API 变动风险） | core |
| sherpa-onnx（Rust crate，`shared` feature） | 1.13.8 | Apache-2.0 | 仅离线 TTS（P2） | core |
| gif | 0.14.2 | MIT OR Apache-2.0 | GIF 编码（与图片类共用） | core |
| color_quant | 随 gif 默认 feature | MIT（推测） | NeuQuant 量化 | core |
| imageproc | 0.27.0 | MIT | OCR 后处理（轮廓、最小外接矩形）、对象计数 | core（与图片类共用） |

本类 Rust 侧**不引** `image`、`fast_image_resize`：PNG 读写复用图片类的 `png`，JPEG 解码与 EXIF 由原生做，缩放自写。`imageproc` 在上面保留，但它是否会把 `image` 带进依赖树还没核实（见未决问题 10）。

模型资源（不进 APK，manifest 管理，许可证要逐个核实）：

| 模型 | 大小 | 许可证 | 用于 |
|---|---|---|---|
| PP-OCRv5 mobile det / rec / 文本行方向分类 + 字典 | 约 21MB | Apache-2.0 | OCR |
| realesr-general-x4v3 | 约 4.7MB | BSD-3-Clause | 超分 |
| MobileNetV3-Large 或同级 ImageNet 分类 | 5~21MB（推测） | 待核（权重/数据衍生） | 图像识别 |
| YOLOX-Nano / NanoDet 级 COCO 检测（可选） | 约 4MB（推测） | Apache-2.0（推测） | 对象计数 detect 模式 |
| vits-icefall-zh-aishell3 或 piper zh_CN int8 | 31MB / 每音色 14MB | 未知，必须核实 | 离线 TTS |

查证记录：Media3 体积与依赖来自 dl.google.com 的 AAR/POM；sherpa TTS 模型大小来自 GitHub release `tts-models` 资产列表；PP-OCRv5 大小来自 PaddleX 文档与 oar-ocr 文档；realesr-general-x4v3 来自 HuggingFace LFS 指针与 OpenModelDB；gif features 来自 docs.rs；前台服务类型来自 developer.android.com 的 FGS 类型页。

## 对公共基础设施的需求
本文只引用名字，具体设计统一放到公共基础设施文档里。

| 名字 | 本文谁在用 | 需要满足的点 |
|---|---|---|
| `native.file.pick` | 全部（7、8 除外） | mime 过滤（video/*、image/*）；大视频不要整份拷进缓存（见异议 1） |
| `native.file.save` | 1、2、3、4、9 | 能指定公共目录（Movies / Music / Pictures 下的 Arkli 子目录）；API 24~28 要处理存储权限 |
| `native.share` | 1、2、3、4、5、9 | 分享缓存文件（FileProvider） |
| `native.clipboard.write` | 5 | — |
| `native.camera.capture` | 5、6、9、10 | 系统相机 Intent 拍照，结果写缓存 |
| `native.permission.request` | 1、2、3、4 | 通知权限（API 33+） |
| `native.model.ensure` / `list` / `delete` + 事件 `model.progress` | 4、5、6、9、10 | 共用部件 C：manifest、多镜像、断点续传、校验、空间检查 |
| `native.task.cancel` / `native.task.status` + 事件 `task.progress` / `task.done` / `task.error` | 1、2、3、4、9 | 共用部件 B 的长任务约定。这类方法 bridge 侧不设超时，靠事件和 status 恢复 |
| 缓存文件的页面可读 URL（PathHandler） | 全部 | 页面能用 `<img>` / `<video>` / `<audio>` 预览缓存里的产物，视频要支持 Range 请求 |
| 缓存清理策略 | 全部 | 任务产物保留期限、总量上限 |

## 对既定约束的异议
1. **「大数据只传缓存目录里的文件路径」对大视频不合适**。几百 MB 到几个 GB 的视频先拷进缓存，耗时、耗空间，空间不够时直接失败。建议补一条：`native.file.pick` 对视频返回不透明句柄（如 `uri:<随机 id>`，原生侧映射到 content URI，页面拿不到真实路径），只能交给 `native.media.*` 这类原生方法用。安全口径不变，页面依然碰不到任意路径。不算推翻协议，算扩展，请主会话在 bridge 协议里定。
2. 其余无。工具归属规则那边，视频类按第 1 条（前台服务）算原生，本文把执行放原生、界面放 Web，和规则不冲突。

## 未决问题（需要用户拍板）
1. **AI 运行时是否随包**（0002 里还挂着）。OCR 是 P0，一上就得带 libonnxruntime.so：22.25MB 未压缩 / 约 8MB deflate。另外 AGP 在 minSdk ≥23 时默认不压缩 so（推测，依 AGP 默认行为，本次未重核），APK 文件会实打实大 22MB，只是商店下载走压缩传输。可选：(a) 随包，最省事；(b) 改 `useLegacyPackaging=true` 压缩 so，APK 小了，但安装后要解压出来占空间；(c) OCR 等 AI 工具降到 P1，先发不带 AI 的版本。默认 (a)，等空壳体积基线出来再定。
2. **视频引擎**：Media3 Transformer（R8 后约 1.5~3MB，推测，稳）还是自写 MediaCodec + Surface 管线（0 依赖，但机型兼容坑多，工作量 L）？默认 Media3。
3. **离线 TTS 包做不做**：做的话 P2，要多带 4.47MB 的 sherpa c-api so 和 14~31MB 模型，还得先把音色的商用许可核清楚。不做的话，本文范围内就用不上 sherpa 的语音 API，只用它那份 ORT。
4. **图像识别、对象计数是保留 P2、砍掉，还是合并成一个「识物」**（共用一个 COCO 检测模型约 4MB，同时出类别和数量）？
5. **确认砍掉**「AI 人脸融合」和「黑白图像上色」。
6. **「图片文字化」**到底是 OCR 的别名还是字符画？
7. **模型托管**：自建 CDN、HuggingFace 还是 ModelScope（国内可达性不同，本次 Bash 直连 ModelScope API 也没通）？manifest 要不要签名防篡改？
8. **视频压缩默认编码**：H.264（兼容最好）还是 HEVC（体积约小三成，推测，部分旧设备和平台播放有问题）？默认 H.264。
9. **AI 工具的输入图格式**：Rust 只读 PNG，那 `rust.ai.*` 收到 JPEG 缓存路径怎么办？可选 (a) 原生在 `native.file.pick` / 拍照后统一转 PNG 写缓存（简单，大图多一次写盘）；(b) 原生解码成 RGBA，经 UniFFI 进程内交给 Rust（不落盘，视频转 GIF 同款，但要多一套接口）。默认 (a)，待与 bridge 公共方案对齐。
10. **`imageproc` 是否违反「不引 `image` 系」**：本文 OCR 后处理和对象计数用 `imageproc` 0.27.0，我印象里它依赖 `image` crate（推测，未核实）。如属实，要么自写轮廓 / 最小外接矩形 / Otsu / 连通域（几百行），要么放宽约束，请拍板。
