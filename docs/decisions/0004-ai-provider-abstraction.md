---
title: 0004 AI 提供者抽象与本机 AI 增强项
status: active
updated: 2026-10-14
summary: 原生侧加一层 AiProvider，页面只看能力不认厂商；先落零依赖的系统应用交接，ML Kit GenAI 只预留位置，本机 AI 定位为可用才显示的增强项
---
## TL;DR
- 原生侧新增 **AiProvider 抽象**：每个提供者声明支持的任务、运行时探测可用性、执行任务。页面只看“有没有某项能力”，不认厂商。
- 第一个也是目前唯一的实现是 **IntentHandoffProvider**：把文本用 `ACTION_PROCESS_TEXT` 交给系统里已有的翻译、AI 助手类应用，**拿不回结果**（返回 `handoff: true`）。零依赖、不改 minSdk。
- **不加** ML Kit GenAI 依赖、不改 minSdk（24）；只在抽象里留 `MlKitGenAiProvider` 的位置，代码里不出现 ML Kit 类。
- **本机 AI 是增强项**：可用才显示入口，不可用就隐藏或降级，不影响任何现有工具。
- 国内厂商 LLM、AppFunctions、Chrome 内置 AI **不做**。

## 决定（用户拍板，2026-10-14）
1. **提供者抽象**：Kotlin 接口 `AiProvider`（`id`、`displayName`、`capabilities()`、`availability()`、`run(task, input)`），将来与本地 ONNX、在线 OpenAI 并列。任务枚举 `AiTask`：`summarize` `proofread` `rewrite` `describeImage` `prompt` `translate`，只列契约。
2. **能力探测**：`availability()` 运行时探测，不可用时带原因（`no_handler` / `unsupported_device` / `not_installed` / `not_configured`）。页面用 `native.ai.providers` 拿到各提供者与可用任务并集，据此显示、隐藏或降级入口。
3. **IntentHandoffProvider**：复用 `native.intent.processText` 的思路，用 `queryIntentActivities` 探测有无 `ACTION_PROCESS_TEXT` 响应者，有才可用；执行就是把原文交出去。支持全部文本类任务，但任务种类**不会传给对方**（系统接口只能带文本，不能带“请摘要”之类指令），用户在接手的应用里自己选操作。
4. **桥方法**：新增 `native.ai.providers` 与 `native.ai.run`，保留 `native.ai.status` 原行为（本地模型就绪状态，仍是桩）。契约见 [Bridge 协议](../design/bridge-protocol.md)「AI 提供者方法」。
5. **边界**：不加 ML Kit GenAI 依赖，不改 minSdk；国内厂商 LLM、AppFunctions、Chrome 内置 AI 不做。

## 背景
本机（HUAWEI STG-AL00，Android 12 / EMUI 14.2）有 GMS 但没有 `com.google.android.aicore`；`ACTION_PROCESS_TEXT` 响应者只有华为翻译与浏览器；第三方应用无法在通用层调用系统智能体并拿回结果。详见 [本机 AI 调研](../research/on-device-ai-agents.md)。结论是：端侧大模型对大多数机型不可用，现阶段能零成本做到的只有“把文本交给别的应用”。

## 与既有决策的关系
- [0002](0002-ai-inference-base.md) 说“不走厂商系统 AI 服务”，指的是**视觉与语音推理的基座**（OCR、抠图、超分等），本决策不动它。本决策管的是**文本类生成任务**（摘要、改写、翻译等），二者并列，不冲突。
- 本地 ONNX 提供者将来接 0002 的基座；在线 OpenAI 提供者需要 Key 与联网白名单，另议。

## 影响与待办
- 代码：`com.let188.arkli.ai` 下 `AiProvider.kt`（接口与枚举）、`AiPolicy.kt`（校验、汇总、序列化与 `ProviderRegistry`，有 JVM 单测）、`IntentHandoffProvider.kt`、`AiHandlers.kt`；前端 `web/src/native/ai.ts` 的 `aiProviders()` / `aiRun()` 与 `useAiProviders`。
- 清单 `<queries>` 增加 `ACTION_PROCESS_TEXT`（`text/plain`），否则 API 30+ 探测不到响应者。
- 页面接入（底部 AI tab 等）由页面侧另行做：先 `useAiProviders().refresh()`，再按 `can(task)` 显示入口。
- 真机验证待做，步骤见调研文档末尾。
- 将来接 ML Kit GenAI 需要：minSdk 提到 26 以上、新增依赖，均需用户另行拍板。
