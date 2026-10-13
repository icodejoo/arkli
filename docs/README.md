# Arkli 文档索引

找文档先读这里。别名：Arkli = 项目名；壳 = app/ 原生层；核心库 = core/ Rust 层；小工具层 = web/ SPA。

## 续做（接手先看）
- [当前状态与待办](status.md) — 做到哪了、验证到什么程度、下一步、技术债、本机环境与命令。接手入口。active。

## 原则
- [项目原则](principles.md) — 体积、分层、工具归属的优先级。active。

## 决策
- [0001 技术栈与分层](decisions/0001-tech-stack.md) — Compose 壳 + Rust 核心 + WebView Vue SPA。active。
- [0002 AI 推理基座](decisions/0002-ai-inference-base.md) — 统一用 sherpa-onnx，模型只要兼容 ONNX。active。
- [0003 Web 优先、固定竖屏、图片与音视频走原生](decisions/0003-web-first-and-native-media.md) — 能放 web 的不放原生；固定竖屏；图片压缩统一原生、不用 Rust 与 FFmpeg。覆盖早期设计说法。active。

## 设计
- [总体架构](design/architecture.md) — 分层职责、工具归属规则、目录、体积策略、构建流水线。active。
- [Bridge 协议](design/bridge-protocol.md) — 小工具页与原生/Rust 之间的消息格式、错误码、大数据传输。active。

- [工具落地总览与待决策](design/tools-overview.md) — 116 项汇总、全部新增依赖、设计间冲突与待拍板清单。draft。
- [公共基础设施草案](design/platform-infrastructure.md) — bridge v2、统一方法表、安全、权限、模型与数据包、实施顺序。draft。
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
- [「一个木函」功能清单](research/woobx-feature-list.md) — 对标产品 116 项功能，按 11 类列出，含形态与置信度。draft。
