---
title: L3 本机 AI 提供者调研：ML Kit GenAI 与国产厂商
status: draft
updated: 2026-10-20
summary: 逐条核对 ML Kit GenAI（Gemini Nano / AICore）的 API、机型表、依赖体积、限制，以及华为/荣耀/小米/OPPO/vivo/三星有没有面向第三方的端侧大模型接口；结论：测试机用不了，专用 API 无中文，国产旗舰在官方机型表里但国行可用性未证实；给出探测、映射、取消方案与待拍板项
---
## TL;DR

- **测试机 HUAWEI STG-AL00 用不了。** Google 官方机型表里没有华为任何机型，机上也没有 AICore。想验证 L3，得另找一台表里的机器。
- **「国产厂商对第三方零可用」这个说法不对。** Google 官方机型表（2026-10-16 更新）已列出荣耀（Magic 7/7 Pro/8 Pro/V5）、小米（15/17 等）、OPPO（Find X8/X9、Reno 14/15）、vivo（X200/X300 等）。但表不分地区，国行系统是否带 AICore、能否下到模型，**未证实**。
- **专用 API（摘要/校对/改写/看图）官方语言表里都没有中文**，只有 Prompt API 是通用口子，它的语言支持文档没写，**未证实**。所以就算接，也只该接 `genai-prompt`，用提示词模板做摘要/改写/翻译。
- **华为、荣耀、小米、OPPO 没查到面向第三方 Android App 的端侧大模型接口**；vivo 的 VCAP 官方文档（经搜索摘要转述）提到「大模型 SDK」，但原文取不回，是否对三方开放**未证实**。纯血鸿蒙不跑 Android 应用。
- **体积代价很小，但有两个坑**：库要求 minSdk 26（项目现在是 24）；AICore 对前台/配额有硬限制。取消要靠协程取消 + 真机验证，文档没写取消 API。
- 建议：**默认先不引入**，等拿到一台表内真机、确认中文效果再拍板；要做就只接 `genai-prompt`。

## 1. ML Kit GenAI（Gemini Nano via AICore）

### 1.1 API 与状态

| API | 状态 | 语言（官方原文） | 输入上限 |
|---|---|---|---|
| Summarization 摘要 | Beta | 英、日、韩 | < 4000 tokens；文章类 > 400 字符 |
| Proofreading 校对 | Beta | 英、日、法、德、意、西、韩 | < 256 tokens |
| Rewriting 改写 | Beta | 英、日、法、德、意、西、韩 | < 256 tokens |
| Image description 看图 | Beta | 仅英文 | 一张图，出一句短描述 |
| Prompt 自由提示词（文本/图文） | Beta | 文档未写 | < 4000 tokens，输出别超 4K |
| Speech recognition 语音 | Alpha（高级模式仅 Pixel 10/11） | 未单独说明 | 与本项目无关 |

没有任何一个是 GA，官方明确「无 SLA、无弃用策略，可能有破坏性变更」。

来源（查阅 2026-10-20）：
- 总览与状态：<https://developers.google.com/ml-kit/genai>
- 摘要：<https://developers.google.com/ml-kit/genai/summarization/android>
- 校对：<https://developers.google.com/ml-kit/genai/proofreading/android>
- 改写：<https://developers.google.com/ml-kit/genai/rewriting/android>
- 看图：<https://developers.google.com/ml-kit/genai/image-description/android>
- Prompt：<https://developers.google.com/ml-kit/genai/prompt/android/get-started>

### 1.2 系统要求、机型、GMS

- **库的 minSdk 是 26**（各页原文 "requires Android API level 26 or higher"）。项目 minSdk 现为 24，见 `app/build.gradle.kts`。
- **运行时最低系统版本：官方文档没写**。antigravity 说要 Android 14+，没有一手来源，**未证实**；错误码 `NEEDS_SYSTEM_UPDATE`（"Android version is too low"）说明确实存在系统版本门槛，具体数值不详。
- **不支持解锁 bootloader 的设备**（Prompt 与各专用页原文）。
- **依赖 AICore 应用**：错误码 `AICORE_INCOMPATIBLE` = "AICore is not installed or its version is too low"。总览页写明 API 「built on top of AICore, an Android system service」。
- **GMS 是否必需：官方没有明说**。模型下载走 Private Compute Services 伴生 APK（AICore 自己无直接联网），它是 Google 组件，推断国行无 GMS 的机器大概率不行，但**未证实**。
- **官方机型表**（2026-10-16 更新，逐品牌）：
  - 功能型 API（摘要/校对/改写/看图）：Google Pixel 9~11；荣耀 400 Pro、Magic 7/7 Pro/8 Pro/V5；iQOO 13/15；联想平板 2 款；摩托罗拉 3 款；一加 13/13s/15/15R；OPPO Find N5、Find X8/X9 系列、Reno 14/15 Pro 系；POCO 5 款；realme GT 7 Pro/7T；三星 S25/S26 系列、Z Fold7/Fold8/Flip8、TriFold；夏普 AQUOS R11；索尼 Xperia 1 VIII；vivo X200/X200 Pro/X200 FE/X200T/X300/X300 Pro/X Fold3 Pro/X Fold5/T4 Ultra；小米 14T Pro、15、15T、15T Pro、15 Ultra、17、17 Ultra、Pad Mini。
  - Prompt API 按 Gemini Nano 版本分三组：nano-v2（荣耀 Magic 7/7 Pro/V5、小米 15 系、一加 13、三星 Z Fold7 等）、nano-v3（Pixel 9/10、三星 S26、荣耀 Magic 8 Pro、OPPO Find X8/X9、vivo X200/X300 等）、nano-v4（Pixel 11、三星 Z Fold8/Flip8）。**注意 Prompt API 的表比功能型 API 的表短**：三星 S25 系列、荣耀 400 Pro、vivo X Fold3 Pro / X Fold5 在功能型表里有、Prompt 三组里没有（2026-10-20 对照原页）。
  - **华为：整张表里没有。**
  - 表不分国行/海外版，**国行机型能不能真用，未证实**。
- 官方原话：不同版本 Gemini Nano 对同一提示词输出可能不同，要用 `getBaseModelName()` 查版本并评测提示词质量。

来源：<https://developers.google.com/ml-kit/genai>（Device support 段，页面标注 Last updated 2026-10-16 UTC）、<https://developers.google.com/android/reference/com/google/mlkit/genai/common/GenAiException.ErrorCode>

### 1.3 依赖坐标、版本、体积

版本取自 Google Maven 的 `maven-metadata.xml`（2026-10-20 实测）：

| 坐标 | 最新版本 | AAR 原始大小 | `gzip -9` 后 |
|---|---|---|---|
| `com.google.mlkit:genai-prompt` | 1.0.0-beta4（2026-07-21） | 1,104,796 B | 1,099,542 B |
| `com.google.mlkit:genai-common`（被上面传递依赖） | 1.0.0-beta4 | 63,641 B | 60,469 B |
| `com.google.mlkit:genai-summarization` | 1.0.0-beta1（2025-05-14） | 581,958 B | 577,908 B |
| `com.google.mlkit:genai-rewriting` | 1.0.0-beta1 | 577,928 B | 573,909 B |
| `genai-proofreading`、`genai-image-description` | 1.0.0-beta1 | 未下载 | 未测 |

- 体积数字来源：直接下载 Google Maven 上的 `.aar`，用 `gzip -9` 复测。AAR 本身就是 zip，所以压缩几乎没收益。**这是 AAR 体积，不是对 APK 的实际增量**；R8 裁剪后的增量没有构建实测，**未测**。
- `genai-prompt` 的 POM 传递依赖：`genai-schema 1.0.0-alpha1`、`play-services-basement 18.9.0`、`play-services-tasks 18.2.0`、`com.google.mlkit:common 18.11.0`、`firebase-encoders`、`transport-*`（Firebase Data Transport）、`kotlinx-coroutines-core 1.7.3`、`kotlinx-coroutines-guava`、`kotlinx-coroutines-reactive`、`kotlin-stdlib 2.3.21`。Kotlin/协程项目里大概率已有，需要核对版本冲突（stdlib 2.3.21 vs 项目现用版本，**未核对**）。
- 模型权重不随 APK，由 AICore 系统服务管理。

来源：<https://dl.google.com/android/maven2/com/google/mlkit/genai-prompt/maven-metadata.xml>、同目录 `genai-prompt-1.0.0-beta4.pom`、`.aar`（均 2026-10-20 下载）

### 1.4 模型下载与首次体验

- 官方说法：每个 App 共用设备上同一份 Gemini Nano，已有就不用再等下载（总览页原文）。AICore 管分发和更新（<https://developer.android.com/ai/gemini-nano>）。
- 状态探测：`checkStatus()`（专用 API 叫 `checkFeatureStatus()`），返回 `FeatureStatus`：`UNAVAILABLE` / `DOWNLOADABLE` / `DOWNLOADING` / `AVAILABLE`。
- **`UNAVAILABLE` 的官方注释**：「设备不支持，**或设备还没拉到最新配置**」。刚开机、刚重置、AICore 刚被清数据时会暂时不可用，"通常几分钟到几小时"，重启可加快。所以**不能把 UNAVAILABLE 永久缓存**。
- 主动下载：`download()` 返回 `DownloadStatus` 流（DownloadStarted / DownloadProgress / DownloadCompleted / DownloadFailed）；不主动调的话，首次推理也会触发下载（摘要/校对页原文）。Prompt 页示例是让开发者在 `DOWNLOADABLE` 时自己调。
- 可调 `warmup()` 预热，把模型载入内存。

### 1.5 流式、取消、限制

- **流式**：有。Kotlin 是 `generateContentStream(...)` 返回可 `collect` 的 Flow；专用 API 是 `runInference(request) { newText -> }` 回调。
- **取消**：**文档没有写取消 API**。`GenAiException.ErrorCode.CANCELLED`（7，"The request is cancelled."）存在，说明底层支持取消。Kotlin 下取消 collect 的协程会不会真正打断 AICore 推理，**未证实，须真机测**。antigravity 说「会向 Binder 发打断信号」是推断，没有来源。
- **前台限制（硬性）**：「推理只在 App 是顶层前台应用时允许；即便用前台服务也会返回 `BACKGROUND_USE_BLOCKED`（30）」。
- **配额**：AICore 按 App 配额，短时间请求太多返回 `BUSY`（9），建议指数退避；长周期（如每天）超额返回 `PER_APP_BATTERY_USE_QUOTA_EXCEEDED`（27）。具体配额数值没有公开。
- 其他错误码：`NOT_ENOUGH_DISK_SPACE`(501)、`REQUEST_TOO_LARGE`(12)、`REQUEST_TOO_SMALL`(-100)、`RESPONSE_GENERATION_ERROR`(15，流式里可能中途断)。
- Prompt API 可调参数：`temperature`、`topK`、`seed`、`candidateCount`、`maxOutputTokens`；另有 system instructions（Beta）、结构化输出（Alpha）、thinking mode（Beta）、prefix caching（Experimental）。
- 中文：专用 API 官方语言表无中文（见 1.1）；Prompt API 文档没写语言范围，**未证实**，须在表内真机上用中文提示词实测。

来源：<https://developers.google.com/ml-kit/genai>（Quota / Background usage 段）、<https://developers.google.com/ml-kit/genai/prompt/android/get-started>、<https://developers.google.com/ml-kit/genai/prompt/android/select-model>、ErrorCode 参考页（同 1.2）

## 2. 国产厂商与三星

调研口径：有没有「第三方 Android App 传入文本、调系统预置的端侧大模型、直接拿回文本」的公开接口。

| 厂商 | 结论 | 依据与说明 | 状态 |
|---|---|---|---|
| 华为（HarmonyOS 4 / EMUI 兼容 Android） | 没查到 | HiAI 官方页能力清单是人脸、图像、OCR、分词/意图/关键词、语音、视频总结等传统能力，**无文本生成/摘要大模型**。华为 ML Kit 官方页同样只有识别、翻译、语言检测、文本嵌入、实体抽取，无生成式。盘古对三方是云端 ModelArts API，不是端侧。 | 官方页未列出（不等于绝对没有） |
| 华为（纯血鸿蒙 NEXT） | 不跑 Android 应用 | 财新 2024-01 报道 NEXT 去掉 AOSP、只运行鸿蒙原生应用。仅媒体来源，未取到华为官方原文。 | 媒体报道 |
| 荣耀（MagicOS） | 官方机型表里有（走 Google AICore）；自家接口没查到 | 2024-01 荣耀发布 70 亿参数端侧 MagicLM，并提出「百模生态计划」，称要让第三方应用更方便调用魔法大模型（搜索摘要转述荣耀官方稿，**未逐字核对**）。荣耀开发者站首页取回为空，没找到对应 SDK/申请流程。 | 自家 SDK 未证实 |
| 小米（HyperOS） | 官方机型表里有（走 Google AICore）；自家接口没查到 | 搜索未发现面向三方的端侧大模型 SDK；小米开发者站未取回有效内容。 | 自家 SDK 未证实 |
| OPPO（ColorOS） | 官方机型表里有（走 Google AICore）；自家接口没查到 | AndesGPT 是 2023 年发布的资料，只见「将来对开发者开放智能体平台」的表述，无端侧 SDK 文档。 | 自家 SDK 未证实 |
| vivo（OriginOS） | **有线索，需人工核实** | 搜索摘要转述 vivo 开放平台文档 doc/204：VCAP 已支持端侧大模型，「通过 VCAP 大模型 SDK 可集成文本总结、文本创作、全局文件命名、卡证识别」。该页是 JS 渲染，我取回的只有标题，**拿不到原文**，不知是否预置模型、是否需要申请/白名单、机型范围。 | 未证实 |
| 三星（Galaxy AI） | 没有独立三方 SDK；走 Google AICore | 官方机型表含 S25/S26/Z Fold7/Fold8 等。 | 一手（机型表） |

**和 antigravity 的差异**：它说「五家全部零可用」「VCAP 只是自带模型的加速库」。前者被官方机型表反驳（荣耀、小米、OPPO、vivo 机型都在 AICore 的表里，只是走的是谷歌接口而不是自家 SDK）；后者无法证实也无法证伪，不采信。

来源：
- 华为 HiAI：<https://developer.huawei.com/consumer/cn/hiai/>
- 华为 ML Kit：<https://developer.huawei.com/consumer/cn/hms/huawei-mlkit/>
- 财新（NEXT 与 Android）：<https://www.caixinglobal.com/2024-01-19/huaweis-latest-operating-system-completely-breaks-with-android-102158167.html>
- 荣耀 MagicOS 8.0 发布稿：<https://www.honor.com/global/news/magicos-launch-2024/>
- vivo 开放平台文档 204：<https://dev.vivo.com.cn/wap/documentCenter/doc/204>（取回失败，仅有搜索摘要）
- 机型表：<https://developers.google.com/ml-kit/genai>

## 3. 对 Arkli 的建议

### 3.1 值不值得接

| 对象 | 建议 |
|---|---|
| 华为 / EMUI / HarmonyOS NEXT | 不接。没有可用接口；测试机永远是 `unsupported_device` |
| 荣耀 / 小米 / OPPO / vivo 自家 SDK | 不接。没查到公开接口；vivo VCAP 单列一条「待人工核实」 |
| Google ML Kit GenAI（只接 `genai-prompt`） | **有条件值得**：表内国产旗舰 + Pixel + 三星能用。前提是国行真机能跑通且中文可用，这两点目前都没验证 |
| 专用四个 API | 不接。无中文，且输入上限小（校对/改写 256 tokens） |

### 3.2 与 `AiProvider` 对上

`MlKitGenAiProvider`：`layer = L3`，同时实现 `AiProvider` 与 `TextGenerator`，只依赖 `genai-prompt`。

| AiTask | 做法 |
|---|---|
| PROMPT | 直接 `generateContent` |
| SUMMARIZE / PROOFREAD / REWRITE / TRANSLATE | 用提示词模板，和 Qwen 的预设一致，走 `AiPreset`；不调专用 API |
| DESCRIBE_IMAGE | Prompt API 支持图文（`ImagePart`），契约已预留；中文输出效果未知，先不声明 |
| COUPLET / OCR / MATTING / CLASSIFY_IMAGE | 不声明 |

- `offers()` 带 `AiConstraints.Generate`：temperature 与 topK 范围按 Prompt API 支持的参数设；`allowSystem` 可开（Prompt API 有 system instructions，Beta）。输入长度上限按 4000 tokens 折成字数，**折算比例需实测**，别拍脑袋。
- **接口对不上的一点**：`AiProvider.availability()` 是同步、要求「快速返回」，而 `checkStatus()` 是挂起调用。做法：启动时和每次打开选择器时异步刷新一份缓存，`availability()` 读缓存；`UNAVAILABLE` 不永久缓存（见 1.4）。

### 3.3 可用性探测（不支持就隐藏）

三步，前一步失败就不往下走：
1. `SDK_INT >= 26`（库要求）。
2. 包管理器能查到 `com.google.android.aicore`（用 `<queries>` 声明，API 30+ 才看得到包）。
3. `checkStatus()`：
   - `UNAVAILABLE` → `UNSUPPORTED_DEVICE`，**选择器里隐藏**（沿用 0005 的「不支持就隐藏」）；
   - `DOWNLOADABLE` / `DOWNLOADING` → `NOT_INSTALLED`；
   - `AVAILABLE` → 可用。

第 2 步是推断出来的快速预判，官方文档没有这么写；真正权威的是第 3 步。

### 3.4 取消

项目约定要求：取消后抛 `CancellationException`（桥上回 `CANCELLED`），下一次调用能正常跑，会话不残留。

- 用 `generateContentStream(...)` + 在 `collect` 里随协程取消；取消后把 `GenAiException(CANCELLED)` 转成 `CancellationException`。
- **取消延迟与能否真打断 AICore，文档没写**，须上真机测；单测要带「取消后再生成」。
- 取消后若发现会话残留，每次调用新建 client 或先 `close()`，**行为未证实**。
- 约定里「只有一次前向的模型要在文档写明」：这条按实测结果写。
- 前台/配额错误映射成能读懂的桥错误：`BACKGROUND_USE_BLOCKED` 提示「请保持应用在前台」，`BUSY` 退避一次后提示稍后再试，`PER_APP_BATTERY_USE_QUOTA_EXCEEDED` 提示今日额度用完。具体用哪个桥错误码要对照 `BridgeErrors`，这里没定。

### 3.5 体积代价与 minSdk

- `genai-prompt` 的 AAR 约 1.1 MB（原始），APK 实际增量没测，粗估在这个量级以内；加传递依赖要核对 Kotlin/协程版本。
- **minSdk 24 → 26 的两个路**（需用户选）：
  - A. 直接提到 26：简单，但放弃 API 24、25 的设备；
  - B. 保持 24，用 manifest 合并的 `tools:overrideLibrary` 让库进来，所有调用前先判 `SDK_INT >= 26`。可行性是推断，**未实测**，且违反库作者的声明，出问题自负。

### 3.6 推荐与备选

- **推荐（默认）**：本轮不引入。理由：测试机验证不了、国行可用性未证实、中文效果未证实，三个关键点都没证据。
- **备选 1**：先做 spike。借一台表内真机（荣耀 Magic 7/8 Pro、小米 15、vivo X200/X300、OPPO Find X8、Pixel 9 任选），临时加 `genai-prompt` 验证：国行能否 `AVAILABLE`、中文摘要/改写/翻译质量、取消延迟、取消后再调。通过再做正式 Provider。
- **备选 2**：直接实现 `MlKitGenAiProvider`（只 `genai-prompt`）。风险是写完才发现国行不可用。
- **备选 3**：人工核实 vivo VCAP 文档（登录开放平台看原文），若真有三方可用的预置端侧模型，再评估单独做一个 vivo 提供者。机型太窄，优先级低。

### 3.7 待用户拍板

| 点 | 推荐默认 |
|---|---|
| 是否引入 `genai-prompt`（新第三方依赖） | 先不引入，走备选 1 的 spike |
| minSdk 24 → 26，还是 overrideLibrary | 若引入，选 A 提到 26 |
| L3 的模型下载入口：AICore 需要 `download()` 时，放 AI 中心的按钮，选择器只触发 | 同上（符合「下载只归 AI 中心」约定） |
| 是否有表内真机可借来测 | 需要用户确认 |

## 4. 核对记录：antigravity 的结论与实际来源的差异

| antigravity 说法 | 一手来源核对结果 |
|---|---|
| 最低 Android 14 | 官方文档无此数字，未证实 |
| 机型：Pixel 8、S24 | 官方现表从 Pixel 9、S25 起，不含 Pixel 8、S24 |
| 国产「完全放弃」 | 官方表已含荣耀/小米/OPPO/vivo 旗舰 |
| genai-common 1.0.0-beta1 | Maven 实测 beta4（2026-07-13） |
| 专用 API「主要面向英文」 | 实为日韩及欧洲语种，**无中文**；看图仅英文 |
| 取消「向 Binder 发打断」 | 无来源，推断 |
| 前台限制、BUSY | 属实 |
| 体积「150~250KB」 | 与 AAR 实测不符（1.1 MB / 0.58 MB 原始） |
| Kotlin 示例里的 `generateStream`、`TextGenerator.generate(call)` | 真实 API 是 `generateContentStream`；项目 `TextGenerator` 签名是 `generate(task, input, opts)` |

antigravity 可用，本次调研已完成调用；它的来源多是首页级链接，以上差异均由本文逐条回到官方页面纠正。

## 5. 未证实清单

1. 国行荣耀/小米/OPPO/vivo 是否带 AICore 并能下载 Gemini Nano。
2. 运行时最低 Android 版本。
3. 是否强依赖 GMS / Play 服务。
4. Prompt API 的语言支持（中文质量）。
5. 取消能否真打断 AICore 推理、取消后会话是否残留。
6. `genai-prompt` 对 APK 的实际体积增量与传递依赖版本冲突。
7. vivo VCAP「大模型 SDK」是否对三方开放、申请条件、机型。
8. 荣耀「百模生态计划」是否落地为公开 SDK。
9. 纯血鸿蒙不跑 Android 应用：只有媒体来源。
10. `tools:overrideLibrary` 方案在本项目是否可行。

## 与既有文档的关系

补充并部分更新 [本机 AI 与系统智能体接入调研](on-device-ai-agents.md)：那里写「国内厂商没查到」「机型清单未核对」，本文给出了官方机型表原文与国内品牌在表内的事实；其余结论不变。决策仍按 [0005](../decisions/0005-ai-four-layers.md)，本文不改任何决策。
