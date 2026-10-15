---
title: 0005 AI 四层约束：本地小模型、本地大模型、本机 AI、远端 API
status: active
updated: 2026-10-14
summary: 所有 AI 能力分四层供用户自由选择；本地模型一律按需下载不随包；本机 AI 不支持就隐藏；页面只认统一接口
---
## TL;DR

- AI 能力统一分**四层**：L1 本地小模型、L2 本地大模型、L3 本机 AI、L4 远端 API。
- **本地模型（L1、L2）一律按需下载，不随包发布**（已有统一的原生下载管理 `native.model.*`，见 [模型下载管理](../design/model-download.md)）。
- **用户自由选择**用哪一层；**本机 AI 不支持就隐藏**（不置灰）。
- 页面只认统一的 `AiProvider` 接口（见 [0004](0004-ai-provider-abstraction.md)），不认厂商和具体模型。
- 在线先只做 OpenAI；本地 LLM 的推理路线与运行时选型见 [端侧 LLM 对比](../research/on-device-llm-comparison.md)，**未定论**。

## 决定（用户拍板，2026-10-14）

用户明确的约束：四层；本地模型都需要下载、不随包发布；用户可以自由选择使用哪种 AI；本机 AI 不支持的就隐藏。

| 层 | 内容 | 例子 |
|---|---|---|
| L1 本地小模型 | 专用任务的 ONNX 小模型，体积几 MB 到百 MB 级 | OCR、识物（SigLIP2）、对联 GPT-2、TTS |
| L2 本地大模型 | 通用生成式 LLM，数百 MB 到 GB 级 | Qwen3.5-0.8B、Qwen3-0.6B |
| L3 本机 AI | 系统提供的能力，运行时探测；交接型（把内容交给系统应用，拿不回结果）也归这层并标注 | 系统应用交接；ML Kit GenAI（后续，仅预留） |
| L4 远端 API | 在线大模型，**先只支持 OpenAI**；联网走原生通道，密钥放原生侧加密存储 | OpenAI |

## 默认规则（主会话补的细则，用户未提异议；有异议就改）

1. **L1 与 L2 的分界**：以“通用生成式 LLM”和“文件约 300MB”为界，不以参数量为界。
2. **本地模型一律按需下载**：manifest + sha256 校验，支持断点续传，用户可删除，显示占用空间。ORT 运行时本身随不随包，沿用 [0002](0002-ai-inference-base.md) 的默认（先随包带，等体积基线实测）。
3. **用户自选**：每个 AI 工具页面里，可选“本地小模型 / 本地大模型 / 本机 AI / 远端 API”中**当前可用**的层，选择按工具记住；设置里有全局默认。默认优先级：本地优先、远端靠后（离线与隐私优先）。
4. **各层不可用时的表现**：本机 AI 不支持——**隐藏**；本地模型未下载——显示“下载”按钮与体积；远端未配置——显示“去配置”。
5. **隐私提示**：远端与交接型会把内容发给第三方，首次使用时提示，默认不自动启用。
6. **工具只声明需要的能力（`AiTask`）**，不绑定具体层；页面通过 `native.ai.providers` 拿到各提供者的可用性。

## 与既有决策的关系

- [0002](0002-ai-inference-base.md)：视觉与语音推理基座仍是 sherpa-onnx 与共享 ORT，属于 L1 的运行时；本决策不改它。**本地 LLM（L2）如果要换 llama.cpp 或 MNN，需要改 0002，目前未改**，等 fp16 机型复测后再定（见下）。
- [0004](0004-ai-provider-abstraction.md)：`AiProvider` 抽象与交接型提供者是本决策的骨架，目前只有交接型一个实现；L1、L2、L4 的提供者将来按同一接口接入。

## 对已有工作的映射

| 能力 | 层 | 状态 |
|---|---|---|
| 垃圾分类识别（SigLIP2 `q4_half` + 英文词表向量） | L1 | 选型与真机验证完成（q4f16 在低端机 SIGILL，改用 q4_half，fp16 留到高端机再测），见 [垃圾分类调研](../research/garbage-classify-clip.md)；**App 接入第 1 步已做（2026-10-14）**：ORT 随包、`native.ai.classify` 与 `local-clip` 提供者真机跑通；**模型下载管理（第 2 步）已做（2026-10-14）**：`native.model.*` 通用下载管理，见 [模型下载管理](../design/model-download.md)（托管 release 与真实 302 链路待发布后验证）；**Web 页（第 3 步）已做（2026-10-14）**：`waste-classify` 工具页，下载引导、top-3 点选采纳、易混提示、真机跑通；状态为 **App 接入完成（待发布模型）** |
| 对联生成（GPT-2 int4） | L1 | 模型已导出并发布，见 [对联 GPT-2](../research/couplet-gpt2-onnx.md)；App 接入未做 |
| 通用文本生成（Qwen 系） | L2 | 真机可行，速度偏慢，见 [端侧 LLM 对比](../research/on-device-llm-comparison.md) |
| 系统应用交接 | L3 | 已落地（`IntentHandoffProvider`） |
| 在线 OpenAI | L4 | 未做；需要先出方案：密钥存储、`native.net` 增加 POST 与流式、供应商抽象 |

## 待办与未决

- L4 的方案：密钥放 Android Keystore 加密；`native.net.*` 现在只支持 GET/HEAD，需要新增 POST 与流式输出；供应商抽象要为以后加别家留位。属架构级，开工前单独出方案并让用户确认。
- 底部 tab 的 AI 页里“模型配置”占位入口，后续放四层的管理：下载、删除、配置 OpenAI、全局默认。其中本地模型的下载、删除与占用空间已有原生接口 `native.model.*`（`native.model.list` 给全部模型的状态与占用），对联 GPT-2、Qwen 接入时只需往清单 `assets/ai/models.json` 加条目并注册释放钩子（`ModelManager.addReleaseHook`）。
- 本地 LLM 的运行时：Rust ort 不新增依赖但慢；llama.cpp/MNN 快 3–4 倍但要改 0002。**全部任务完成后，找一台有点积与 fp16 的手机复测再决定。**
