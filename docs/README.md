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
- [0002 AI 推理基座](decisions/0002-ai-inference-base.md) — 统一用 sherpa-onnx，模型只要兼容 ONNX。active。
- [0003 Web 优先、固定竖屏、图片与音视频走原生](decisions/0003-web-first-and-native-media.md) — 能放 web 的不放原生；固定竖屏；图片压缩统一原生、不用 Rust 与 FFmpeg。覆盖早期设计说法。active。
- [0004 AI 提供者抽象与本机 AI 增强项](decisions/0004-ai-provider-abstraction.md) — AiProvider 抽象、系统应用交接、ML Kit GenAI 只预留；可用才显示。active。
- [0005 AI 四层约束](decisions/0005-ai-four-layers.md) — 本地小模型 / 本地大模型 / 本机 AI / 远端 API；本地模型按需下载；用户自选；本机 AI 不支持就隐藏。active。

## 设计
- [总体架构](design/architecture.md) — 分层职责、工具归属规则、目录、体积策略、构建流水线。active。
- [Bridge 协议](design/bridge-protocol.md) — 小工具页与原生/Rust 之间的消息格式、错误码、大数据传输。active。

- [工具落地总览与待决策](design/tools-overview.md) — 116 项汇总、全部新增依赖、设计间冲突与待拍板清单。draft。
- [公共基础设施草案](design/platform-infrastructure.md) — bridge v2、统一方法表、安全、权限、模型与数据包、实施顺序。draft。
- [本地模型下载管理](design/model-download.md) — native.model.* 的清单格式、下载器安全设计、状态机、真机验证与后续优化。active。
- [模型选择器](design/model-picker.md) — AI 工具标题栏的模型选择：四种状态映射、四层规则、useModelChoice 契约，不改推理引擎。active。
- [图片类工具](design/tools/image.md) — 21 项。draft。
- [音视频与 AI 类工具](design/tools/media-ai.md) — 10 项。draft。
- [文本与计算类工具](design/tools/text-calc.md) — 22 项。draft。
- [开发者、编码与网络类工具](design/tools/dev-net.md) — 17 项。draft。
- [设备系统与文件类工具](design/tools/device-files.md) — 21 项。draft。
- [生活、效率与趣味类工具](design/tools/life-fun.md) — 25 项。draft。

## 调研
- [命名与技术选型调研](research/naming-and-stack.md) — 四种技术路线对比、候选名查重结论。active。
- [开源库选型清单](research/open-source-libs.md) — 按工具类别的成熟开源库、许可证、体积、sherpa-onnx 与 NPU 结论。draft。
- [Spike：WebMessageListener 与 ArrayBuffer 通道](research/spike-webmessage-arraybuffer.md) — 真机有条件 GO：不支持 ArrayBuffer，含吞吐、内存、来源限制。draft。
- [Spike：ort 对接 sherpa 自带 ORT 与 OCR](research/spike-ort-sherpa.md) — 真机验证 GO，含耗时、内存、体积。draft。
- [垃圾分类拍照识别：CLIP 零样本选型与四模型对比](research/garbage-classify-clip.md) — 路线对比、SigLIP2/TinyCLIP/Chinese-CLIP 实测、top-3 策略、中文处理。draft。
- [本机 AI 与系统智能体接入调研](research/on-device-ai-agents.md) — ML Kit GenAI、AppFunctions、Chrome 内置 AI、国内厂商、PROCESS_TEXT 交接的结论与真机核实表。draft。
- [对联 GPT-2 ONNX 导出与评估](research/couplet-gpt2-onnx.md) — fp32/int8/int4 体积、速度、质量，诗词与成语支持度，许可证状态，release 下载地址。draft。
- [端侧 LLM 选型对比：模型与运行时](research/on-device-llm-comparison.md) — Qwen3.5/Qwen3/Qwen2.5 在 ORT、ORT GenAI、llama.cpp、MNN 上的真机速度、体积、内存，对 0002 的影响。draft。
- [「一个木函」功能清单](research/woobx-feature-list.md) — 对标产品 116 项功能，按 11 类列出，含形态与置信度。draft。
