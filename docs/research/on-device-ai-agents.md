---
title: 本机 AI 与系统智能体接入调研
status: draft
updated: 2026-10-14
summary: 第三方 App 能否调用手机自带的端侧大模型或系统智能体：ML Kit GenAI、AppFunctions、Chrome 内置 AI、国内厂商、PROCESS_TEXT/SEND 的结论、真机核实表与推荐接入顺序
---
## TL;DR
- **能直接调用并拿回结果的只有谷歌 ML Kit GenAI（AICore）**，但依赖白名单机型，且要提高 minSdk。测试机 HUAWEI STG-AL00 没有 `com.google.android.aicore`，用不了。
- **AppFunctions** 方向相反（本 App 暴露能力给系统智能体调用），且处于实验阶段，不能让我们调别人。
- **Chrome 内置 AI**（Gemini Nano 的 Prompt API 等）在 Android 上不可用。
- **国内厂商**没查到面向第三方的公开端侧 LLM 接口。
- **PROCESS_TEXT / ACTION_SEND** 只能把文本单向交出去，拿不回结果。
- 决定（[0004](../decisions/0004-ai-provider-abstraction.md)）：先落零依赖的 AiProvider 抽象与系统应用交接，ML Kit GenAI 只预留位置，本机 AI 是“可用才显示”的增强项。

## 1. 各路线结论

| 路线 | 能否调用并取回结果 | 主要限制 | 结论 |
|---|---|---|---|
| ML Kit GenAI（基于 AICore / Gemini Nano） | 能（摘要、校对、改写、看图说话、Prompt） | 依赖设备装有 AICore 且在支持名单内；minSdk 要比现在（24）高，具体数值以官方文档为准；要新增依赖；首次可能要下载模型 | 预留位置，不接。华为机型不在内 |
| AppFunctions（Jetpack） | 否，方向相反 | 是本 App 把功能暴露给系统智能体，让它来调我们；仍在实验阶段 | 不做 |
| Chrome 内置 AI | 否 | 桌面 Chrome 的能力，Android 版 Chrome 与 WebView 不提供 | 不做 |
| 国内厂商端侧 LLM（华为小艺、小米小爱、OPPO、vivo 等） | 没查到 | 没找到面向第三方 App 的公开 SDK 或系统接口 | 不做 |
| `ACTION_PROCESS_TEXT` | 否，只能交出去 | 取决于装了哪些响应应用；不能附带“请摘要”之类指令 | 采用（IntentHandoffProvider） |
| `ACTION_SEND` / 分享面板 | 否，只能交出去 | 同上，且更像“分享”；已有 `native.share` | 不单独做 |

## 2. 真机核实表（HUAWEI STG-AL00，Android 12 / EMUI 14.2）

| 项 | 结果 | 方式 |
|---|---|---|
| 有 GMS | 有 | 用户调研时确认 |
| `com.google.android.aicore` | **没有** | 同上 |
| `ACTION_PROCESS_TEXT` 响应者 | 只有华为翻译与浏览器 | 同上 |
| 第三方在通用层调用系统智能体并取回结果 | **做不到** | 同上，未发现可用接口 |
| 本机能否跑 ML Kit GenAI | 否（没有 AICore） | 推断，未装库实测 |

## 3. 无法确认的点
- ML Kit GenAI 的**支持机型清单与最低 minSdk**：没有拿到官方原文逐字核对，落地前以官方文档为准。
- **国内厂商是否有未公开或需要商务合作的接口**：只能说没查到公开的，不能说没有。
- 其他品牌机型上 `ACTION_PROCESS_TEXT` 响应者有哪些（是否有 AI 助手类）：只有一台测试机的数据。
- 交接给华为翻译后，用户体验是否顺畅（只读模式、能否复制结果）：待真机试。

## 4. 推荐接入顺序
1. **AiProvider 抽象 + 能力探测 + 系统应用交接**（本次已做，零依赖）。
2. 页面侧接入：入口按 `can(task)` 显示，没有响应者就隐藏或提示去装翻译应用。
3. 本地 ONNX 提供者：接 [0002](../decisions/0002-ai-inference-base.md) 的基座，先做 OCR 等已有模型，文本生成类模型体积大，暂缓。
4. 在线 OpenAI 兼容提供者：需要用户配置 Key、联网白名单与隐私提示，另议。
5. ML Kit GenAI：只在主要用户设备大多支持时再考虑，需要提 minSdk 并加依赖。

## 5. 需要用户拍板的点与默认值

| 点 | 默认值 |
|---|---|
| 本机 AI 入口放哪里 | 沿用页面侧的 AI tab；不可用时整个入口隐藏 |
| 没有响应者时的提示 | 提示“系统里没有可接收文本的应用”，不引导安装具体应用 |
| 是否做在线 OpenAI 提供者 | 暂不做 |
| 是否为 ML Kit GenAI 提 minSdk、加依赖 | 暂不做 |
| 交接时是否额外复制文本到剪贴板兜底 | 不做，页面自己决定 |

## 6. 真机验证步骤（待做）
1. 装 debug 包，页面里调 `native.ai.providers`：期望 `intent-handoff` 的 `available` 为 true，`tasks` 含 `translate` 等五项文本任务，`capabilities` 与之相同。
2. 调 `native.ai.run { provider: "intent-handoff", task: "translate", input: "hello" }`：期望弹出华为翻译（或选择器），返回 `{ handoff: true, handled: true }`。
3. 在系统设置里禁用华为翻译与浏览器的相关入口（或换一台没有响应者的设备），再调 `providers`：期望 `available:false, reason:"no_handler"`；`run` 返回 `NOT_READY`。
4. 校验：`provider` 写错、`task` 写成 `describeImage`、`input` 为空或超 5 万字符，期望 `BAD_PARAMS`。
5. API 30+ 设备上确认清单 `<queries>` 生效：去掉它再试，探测会变成 `no_handler`（用来证明确实需要）。
