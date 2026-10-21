# Arkli 文档索引

找文档先读这里。别名：Arkli = 项目名；壳 = app/ 原生层；核心库 = core/ Rust 层；小工具层 = web/ SPA。

## 续做（接手先看）
- [当前状态与待办](status.md) — 做到哪了、验证到什么程度、下一步、技术债、本机环境与命令。接手入口。active。
- [工具落地跟踪表](design/rollout-tracker.md) — 116 项逐项状态、批次与阻塞原因，盲做模式下的接力清单。active。
- [真机验证清单](design/device-test-checklist.md) — 盲做阶段攒下的全部待验证项，按风险排序，可照着逐条测。active。

## 原则
- [项目原则](principles.md) — 体积、分层、工具归属的优先级。active。

## 决策
- [0001 技术栈与分层](decisions/0001-tech-stack.md) — Compose 壳 + Rust 核心 + WebView Vue SPA。active。
- [0002 AI 推理基座](decisions/0002-ai-inference-base.md) — 原决定“统一用 sherpa-onnx + 共享 ORT”已被 MNN 取代（2026-10-16，M9 删除 ORT 与 sherpa-onnx）；保留为决策历史。superseded。
- [0003 Web 优先、固定竖屏、图片与音视频走原生](decisions/0003-web-first-and-native-media.md) — 能放 web 的不放原生；固定竖屏；图片压缩统一原生、不用 Rust 与 FFmpeg。覆盖早期设计说法。active。
- [0004 AI 提供者抽象与本机 AI 增强项](decisions/0004-ai-provider-abstraction.md) — AiProvider 抽象、系统应用交接、ML Kit GenAI 只预留；可用才显示。active。
- [0005 AI 四层约束](decisions/0005-ai-four-layers.md) — 本地小模型 / 本地大模型 / 本机 AI / 远端 API；本地模型按需下载；用户自选；本机 AI 不支持就隐藏。active。

## 设计
- [总体架构](design/architecture.md) — 分层职责、工具归属规则、目录、体积策略、构建流水线。active。
- [Bridge 协议](design/bridge-protocol.md) — 小工具页与原生/Rust 之间的消息格式、错误码、大数据传输。active。
- [浮窗](design/float-window.md) — 微信小程序式 App 内浮窗：单浮窗、ToolView 保活状态机、圆球、暂停/忙碌接口与工具适配清单。draft。

- [工具落地总览与待决策](design/tools-overview.md) — 116 项汇总、全部新增依赖、设计间冲突与待拍板清单。draft。
- [公共基础设施草案](design/platform-infrastructure.md) — bridge v2、统一方法表、安全、权限、模型与数据包、实施顺序。draft。
- [对联语料库与对联页](design/couplet-corpus.md) — 73.6 万副语料的数据包格式、原生随机访问、前端不重复随机算法、对联页三模式。active。
- [本地模型下载管理](design/model-download.md) — native.model.* 的清单格式、退役模型回收（retired）、下载器安全设计、状态机、外部目录导入、真机验证与后续优化。active。
- [统一 AI 协议](design/ai-protocol.md) — AiRouter 选提供者、统一入口 native.ai.invoke 的分派（旧方法为别名）、能力=端口不变量、报价 offers（任务+入口+约束）与按约束校验输入、生命周期从提供者派生、文本生成预设与按次采样（第 6 步）、前端 AI 目录与 aiInvoke、后续步骤。OCR 作为第一个按新协议接入的任务（M8）与“新增一个 AI 任务的 checklist”，logo 符号接入记录（`logoSymbol`：互斥拒绝并发、让位、驻留方式判据、卸载先取消、取消延迟），以及 AI 中心“参数调整”（`AiTunable`、`native.ai.params.*`、补参优先级、契约不变量 8~11）。active。
- [端侧联网调研（Qwen3.5-0.8B）](design/agent-research.md) — 固定流水线而非自由 ReAct：拆问题→维基搜索→带出处回答；预算、搜索源、未验证项。draft。
- [随机点名 3D 滚筒](design/roll-call-3d.md) — three.js 多环滚筒：只抽 1 人、结果先定动画只表演、选中弹出加粒子、无 WebGL 直接出文字。draft。
- [模型选择器](design/model-picker.md) — AI 工具的模型选择：工具声明 tasks、目录自动算可选项、四种状态、选择存提供者 id 与旧值迁移；参数调整只在 AI 中心、工具页禁碰。文字识别页只读目录、缺模型提示条。active。
- [图片类工具](design/tools/image.md) — 21 项。draft。
- [抠图（人像 / 通用）](design/tools/matting.md) — MODNet 与 U2Net-p 两个本地 MNN 模型，外加实验模型 PP-MattingV2 / BiRefNet-lite；选型与真机数据、`native.ai.matting` 协议、取消限制、模型 release 已发布（单包 zip）。active。
- [logo 设计](design/tools/logo.md) — logo 工具：模板排版（自研渲染 + Lucide 图标子集，本地 Qwen 只挑参数，没模型走关键词规则）+ 本地 SDXS 生成 AI 符号（行业词表 4 个物体词、逐张生成可取消、质量闸门排序与模板补位、未就绪行为）；参数结构、体积、许可、限制与待真机验证项。draft。
- [音视频与 AI 类工具](design/tools/media-ai.md) — 10 项。draft。
- [文本与计算类工具](design/tools/text-calc.md) — 22 项。draft。
- [开发者、编码与网络类工具](design/tools/dev-net.md) — 17 项。draft。
- [设备系统与文件类工具](design/tools/device-files.md) — 21 项。draft。
- [生活、效率与趣味类工具](design/tools/life-fun.md) — 25 项。draft。

## 调研
- [命名与技术选型调研](research/naming-and-stack.md) — 四种技术路线对比、候选名查重结论。active。
- [开源库选型清单](research/open-source-libs.md) — 按工具类别的成熟开源库、许可证、体积、sherpa-onnx 与 NPU 结论。draft。
- [Spike：WebMessageListener 与 ArrayBuffer 通道](research/spike-webmessage-arraybuffer.md) — 真机有条件 GO：不支持 ArrayBuffer，含吞吐、内存、来源限制。draft。
- [Spike：ort 对接 sherpa 自带 ORT 与 OCR](research/spike-ort-sherpa.md) — 真机验证 GO，含耗时、内存、体积。已标注语音迁 sherpa-mnn。draft。
- [垃圾分类拍照识别：CLIP 零样本选型与四模型对比](research/garbage-classify-clip.md) — 路线对比、SigLIP2/TinyCLIP/Chinese-CLIP 实测、top-3 策略、中文处理；含 2026-10-15 迁到 MNN（`siglip2-mnn-w8`）的说明。draft。
- [本机 AI 与系统智能体接入调研](research/on-device-ai-agents.md) — ML Kit GenAI、AppFunctions、Chrome 内置 AI、国内厂商、PROCESS_TEXT 交接的结论与真机核实表。draft。
- [L3 本机 AI 提供者调研：ML Kit GenAI 与国产厂商](research/l3-native-ai-providers.md) — 对 on-device-ai-agents 的补充核实：官方机型表（含荣耀/小米/OPPO/vivo、不含华为）、专用 API 无中文、依赖与 AAR 体积、前台与配额限制、国产厂商端侧接口现状、AiProvider 映射/探测/取消方案与未证实清单；测试机不可用。draft。
- [对联 GPT-2 ONNX 导出与评估](research/couplet-gpt2-onnx.md) — fp32/int8/int4 体积、速度、质量，诗词与成语支持度，许可证状态，release 下载地址；第 9 节为 MNN 转换与接入（w6 默认、解码约束、真库实测）。draft。
- [端侧 LLM 选型对比：模型与运行时](research/on-device-llm-comparison.md) — Qwen3.5/Qwen3/Qwen2.5 在 ORT、ORT GenAI、llama.cpp、MNN 上的真机速度、体积、内存，对 0002 的影响。draft。
- [ONNX 全量迁移到 MNN：盘点、spike 与施工方案](research/onnx-to-mnn-migration.md) — 识物/翻译/语音/OCR 迁 MNN 的转换量化、桌面实测、目标架构、分步清单与验收门槛；含 M5（识物 SigLIP2）桌面落地与待真机清单，M6a（NLLB 词表审计：缺字是原版就没有、词表 v2、MNN 产物与 149 句评测），以及 M6b（NLLB 的 Rust 引擎：`Seq2SeqRunner` 抽象、MNN 三图按行执行、清单 `format`、桌面真库 149/149 对拍），以及 M6c（NLLB 的 Kotlin/清单/前端切 MNN、默认束宽 1、`nllb-mnn-v1` 待上传清单与 sha、`build-android.ps1` 修复、待真机清单），以及 M7（语音切 sherpa-mnn：`build-sherpa-mnn.sh`、`libsherpa-mnn-jni.so` 的体积与 sha、v2 三个 so 与 `asr-mnn-v1` 待上传清单、语音模型清单条目、桌面 sherpa-mnn 对拍与 `high_freq` 口径差、待真机清单）。，以及 M8（OCR 切 MNN：`ppocrv5-mnn-fp16` 产物字节数与 sha、识别字典取自 rec 的 ONNX 元数据、cls 输入是 80×160、`ocr-mnn-v1` 待上传清单与许可证状态、Rust `load_ocr_pipeline` / FFI `ocr_*` / Kotlin `local-ocr` / 前端落地、桌面真库对拍、待真机清单）。以及 M8 升级（OCR 换 PP-OCRv6 small：`ppocrv6-small-mnn-fp16` 产物与 sha、v6 det 后处理参数、桌面 ORT/MNN 对拍与 v5 对比、`ocr-mnn-v2` 待上传）。以及 M9（2026-10-16：删 ORT 与 sherpa-onnx、四个旧模型目录登记 `retired`、debug APK 体积与 so 清单前后对比）。draft。
- [Qwen3.5-0.8B MNN 文本模型：托管与溯源](research/qwen35-mnn-model.md) — L2 文本模型的 release 下载地址、六个文件的体积与 sha256、与上游的差异、真机速度、运行时要求与使用建议。draft。
- [AI 中心开放模型推理参数：调研与方案](research/model-tunable-params.md) — MNN 基础参数（线程/功耗/精度，后端不开放、memory 钉死 low）与逐模型参数表、开放/高级/不开放归类、`native.ai.params.*` 数据流与分步实施计划；已拍板：显式传参优先、Qwen 采样只作用于 prompt 预设、改参数下次调用重载；步 1~8 均已实现并真机验证（2026-10-19，已提交）。draft。
- [人像抠图模型普查与桌面实测](research/portrait-matting-models.md) — 针对发丝毛边的候选普查（PP-MattingV2、RVM、BiRefNet、RMBG 等的体积/输入/许可/ONNX/MNN 风险）与桌面 ORT 实测、MNN 转换结果；推荐 PP-MattingV2 接现有细化链，RMBG 非商用、RVM 为 GPL。draft。
- [端侧 logo 生成：模型与方案调研](research/logo-generation-on-device.md) — 位图扩散（MNN diffusion 支持 SD1.5/太乙/Sana/SD3.5，测试机 CPU 无 fp16 基本不可用）、小模型写 SVG、模板+图标库+字体排版三条路线的体积/耗时/许可对比；推荐模板排版为主、小 LLM 只出结构化参数，端侧小扩散模型待真机验证。draft。
- [logo 专用小模型（第二轮）](research/logo-small-models.md) — 模板效果差后的续调研：SDXS 一步扩散+vtracer、Qwen LoRA 写 SVG、程序化合成；候选表、许可、spike 顺序。draft。
- [「一个木函」功能清单](research/woobx-feature-list.md) — 对标产品 116 项功能，按 11 类列出，含形态与置信度。draft。
