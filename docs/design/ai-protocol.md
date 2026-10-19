---
title: 统一 AI 协议
status: active
updated: 2026-10-19
summary: 原生 AI 入口怎么选提供者（AiRouter）、统一入口 native.ai.invoke 的分派、能力声明与实现端口的不变量、提供者报价（offers：任务+入口+约束）与层、按约束校验输入、生命周期从提供者派生、文本生成的预设与按次采样（AiConstraints.Generate，第 6 步）、前端 AI 目录与 aiInvoke、OCR 作为第一个按新协议接入的任务与“新增一个 AI 任务的 checklist”，对联作为第二个按 checklist 接入的专用端口任务（`couplet`），AI 中心的“参数调整”（`AiTunable` / `native.ai.params.*` / 用户设置补参与优先级，2026-10-19 步 1~3，真机未验），以及后续分步计划
---

## TL;DR

- **统一的是路由、入口、模型目录、选择、生命周期；输入输出不统一**，每类任务保持自己的强类型端口（翻译、识图、文本 run……），不做万能字典。
- 原生所有 AI 入口都经 `AiRouter` 选提供者：找不到 / 不支持 / 走错入口 → `BAD_PARAMS`；选中但不可用 → `NOT_READY`（message 带 reason）。
- **统一入口 `native.ai.invoke`**（第 3 步）：`{ task, input, provider?, entry?, options? }`，按任务分派到强类型端口。端口一律由 `AiRouter.portOf` / `AiPort.canonicalFor` / `AiPort.byEntry` 推导，**没有第二张分派表**；旧方法 `run / translate / classify` 是它钉死端口的别名，与它共用 `AiInvoker`，行为与错误不变。
- **输入按选中提供者的约束校验**：翻译语言不再写死全局 `LANGS`，而是选出提供者后按它报价里的 `AiConstraints.Translate` 查。
- **能力声明 = 实现的端口**：实现了专用端口就必须声明对应任务；声明的任务要么有专用端口，要么由 `run()` 真正承接；每个报价经 invoke 都落到同一提供者的报价入口。`AiProviderContractTest` 对注册的每个提供者逐条检查。
- `native.ai.providers` 每个提供者有 `layer`（L1~L4）、`offers: [{ task, entry, constraints? }]` 与（第 4 步追加）`session`：**入口由实现推导**（`AiRouter.entryOf`），约束只在原生写一份，`session` 由是否实现 `AiSessionControl` 推导。
- **生命周期从提供者派生**（第 4 步）：预热、卸载、删模型前释放、进程级回收都只看 `AiModule.providers` 里谁实现了 `AiSessionControl`；新接一个模型只登记一处。
- **OCR 是第一个按新协议接入的任务**（M8，2026-10-16）：`AiTask.OCR` + `AiPort.Ocr`（`OcrEngine`）+ `AiCall.Ocr` + `LocalOcrProvider`（`local-ocr`，L1，PP-OCRv5 MNN fp16），契约测试与 invoke 分派自动覆盖。以后新增任务照本文“新增一个 AI 任务的 checklist”做。
- **文本生成的预设与采样按次传入**（第 6 步）：invoke 的 `options` 可带 `{ preset?, system?, temperature?, topK? }`，原生 `AiCall.Run` 多出强类型字段 `preset` / `system` / `sampling`；范围与权限挂在报价约束 `AiConstraints.Generate` 上（`check(call)` 校验，分派流程不变）；`TextGenerator` 是可选端口，没实现它的提供者收到这些字段报 `BAD_PARAMS`。见下文“文本生成的预设与采样”。
- **对联是第二个按 checklist 接入的任务**（阶段 2a，2026-10-16）：`AiTask.COUPLET`（文本生成类，但参数与结果强类型，所以走**专用端口** `AiPort.Couplet` + `CoupletEngine`，`isText=false`，不进 run）+ `AiCall.Couplet` + `LocalCoupletProvider`（`local-couplet`，L1，GPT-2 MNN 6 位），报价约束是新子类 `AiConstraints.Couplet`（字数与温度、topK 范围）。契约测试与 invoke 分派自动覆盖；见下文“对联接入记录”。
- 前端：`aiInvoke(task, input, opts)` 按 `AiTaskMap` 强类型；`aiTranslate` / `aiClassifyImage` / `aiRun` 签名不变、内部转调 invoke 并钉住原入口；`aiOcr` 同理（M8 起签名为 `aiOcr(path, signal?)`）；`aiCouplet(text, options?, signal?)` 钉 `native.ai.couplet`。AI 目录（`buildCatalog` / `useAiCatalog`）选择值存提供者 id；预热只跟随 `session` 为真的提供者。

## 概念

| 名词 | 含义 | 代码 |
|---|---|---|
| 任务 | 页面要做的事，如 `translate`、`summarize`、`classifyImage` | `AiTask` |
| 提供者 | 能做某些任务的实现：本地模型、系统交接、将来的在线服务 | `AiProvider` |
| 端口 | 提供者承接任务用的强类型接口，一个端口对应一个桥方法 | `AiPort` |
| 路由 | 按（任务，端口，可选 provider id）选出提供者并查可用性 | `AiRouter` |

端口现有六个：

| 端口 | 桥方法 | 绑定任务 | 接口 |
|---|---|---|---|
| `Run` | `native.ai.run`（= invoke 钉 run） | 通用，承接的任务由路由推导 | `AiProvider.run` |
| `Translate` | `native.ai.translate` | `translate` | `TextTranslator` |
| `Classify` | `native.ai.classify` | `classifyImage` | `ImageClassifier` |
| `Ocr` | `native.ai.ocr`（M8 新增） | `ocr` | `OcrEngine` |
| `Couplet` | `native.ai.couplet`（阶段 2a 新增） | `couplet` | `CoupletEngine` |
| `Session` | `native.ai.warmup` / `unload` | 不绑任务 | `AiSessionControl` |

`Translate`、`Classify`、`Ocr`、`Couplet` 是**专用端口**（`AiPort.DEDICATED`）。以后接带参数的文本生成等强类型任务，就新增一个专用端口和对应接口，在 `DEDICATED` 里登记，再给 `AiCall` 加一个子类（编译器会逼着 `AiInvokePolicy.toCall` 与 `AiInvoker.dispatch` 的 `when` 补全），完整步骤见下文 checklist。

## 统一入口 `native.ai.invoke`（第 3 步）

代码：`AiInvoke.kt`（`AiCall`、`AiInvokePolicy`、`AiInvoker`、`AiPlan`）。请求/响应/错误码见 [桥协议](bridge-protocol.md)。

**分派 = 定端口 + 按端口解析输入**，两步都不另写表：

1. 定端口（`AiInvokePolicy.portFor`）：
   - 传了 `entry` → `AiPort.byEntry(entry)`（只能是 `TASK_PORTS` = 专用端口 + run；`native.ai.warmup` 等不收）；等于直接调那个旧入口，错误与旧入口一致；
   - 只传了 `provider`，且它声明了该任务 → `AiRouter.portOf(provider, task)`，也就是 `offers` 里报给前端的 `entry`（`entryOf` 就是 `portOf(...).entry`，全项目只此一处）；
   - 都没传，或 provider 不认识 / 没声明该任务 → `AiPort.canonicalFor(task)`（有专用端口走专用端口，否则 run），再由路由报“未知的 provider”“不支持”，文案与旧入口相同。
2. 按端口解析输入（`AiInvokePolicy.toCall`，对 sealed `AiPort` 的穷举 `when`）：把 `input` 与 `options` 拼成旧入口的扁平参数（重复键、`input` 里写 `provider` 都报 `BAD_PARAMS`），**直接复用旧入口的 parse**——translate 用 `AiTranslatePolicy.parse`、classify 用 `AiClassifyPolicy.parse`、ocr 用 `AiOcrPolicy.parse`、couplet 用 `AiCoupletPolicy.parse`、run 用 `AiPolicy.checkRunText(input.text)`。专用端口绑定的任务与 `task` 不符（如钉 `native.ai.translate` 却传 `summarize`）报 `BAD_PARAMS`。

得到强类型的 `AiCall`（`Run` / `Translate` / `Classify` / `Ocr` / `Couplet`），交给 `AiInvoker.dispatch`，流程固定：

```
select（AiRouter.select，不查可用性，BAD_PARAMS）
  → offerOf(provider, task).constraints?.check(call)（BAD_PARAMS）
  → requireAvailable（NOT_READY）
  → 调强类型端口（翻译 / 识图 / 文字识别在 IO 线程；重活在各服务里排 AiHeavyGate）
  → 按端口序列化（AiPolicy.resultJson / AiTranslatePolicy.resultJson / AiClassifyPolicy.resultJson / AiOcrPolicy.resultJson）
```

**旧入口是薄封装**：`AiRunHandler` = `parseRun`（provider 必填，保持旧约定）→ `dispatch(AiCall.Run)`；`AiTranslateHandler` = `AiTranslatePolicy.parse` → `dispatch(AiCall.Translate)`；`AiClassifyHandler`、`AiOcrHandler`（`native.ai.ocr`，M8）同理。校验、路由、约束、可用性检查只有 `AiInvoker` 一份。

**为什么约束校验夹在 select 与 requireAvailable 之间**：改造前语言在 parse 阶段就查，所以“语言不对 + 模型没装”报 `BAD_PARAMS`；现在语言要等选出提供者才知道查哪份清单，放在查可用性之前，错误码顺序与改造前一致。

`AiInvoker.plan(params)` 只定去向（提供者 + 端口）不执行，与 `dispatch` 走同一套解析与选择，契约测试与调试用。

取消与超时：invoke 只是一个普通桥方法，取消沿用 `native.task.cancel`（取消处理协程）；前端不设超时（`timeoutMs: 0`）。

## 路由规则

- `AiRouter.runTasks(p)` = `p.capabilities()` − 它实现了专用端口的任务。提供者**不另报**“run 支持哪些任务”，避免两处声明对不上。
  - 例：`local-qwen` 声明 summarize/proofread/rewrite/prompt/translate，实现了 `TextTranslator`，所以 run 只承接前四个（正好是 `AiQwenPolicy.SUPPORTED_TASKS`），translate 只走 `native.ai.translate`。
  - 例：`intent-handoff` 声明了 translate 但没有语言对接口，translate 归 run（交接），不参与 `native.ai.translate` 的选择。
- `resolve(providers, task, port, providerId?)` = `select` + `requireAvailable`：指定 id 时只看它；缺省按注册顺序取第一个候选，**不跳过不可用的**，避免某个模型没下载就悄悄换模型。**缺省选择（不点名 provider）只在本地 L1/L2 里挑**（`AiRouter.DEFAULT_LAYERS`）；交接（L3）与远端（L4）会把文本交给第三方，必须显式点名才会走，缺省时没有本地候选就报 `BAD_PARAMS`（提示显式指定）。分派器把两步拆开，中间插入约束校验。
- `resolveById` / `find` / `all`：预热（查可用性）与卸载（不查，模型删了也要能卸）用，不看任务。
- 提供者的 `run()` 收到不归它的任务时抛 `AiRouter.notRunnable(id, task)`，message 指明该走的方法。

## 报价（offers）与层

`native.ai.providers` 的每个提供者在旧字段之外追加（只追加，旧页面忽略即可）：

- `layer`：`AiProvider.layer`（`AiLayer`），按 0005：`local-clip`、`local-nllb` 为 L1，`local-qwen` 为 L2，`intent-handoff` 为 L3。契约测试把这张表钉住。
- `offers`：`AiProvider.offers()`，默认由 `capabilities()` 逐项推导、不带约束；要带约束的提供者重写它（`local-nllb`、`local-qwen` 的 translate 带 `AiTranslatePolicy.OFFER_CONSTRAINTS`，两者语言相同，**共用同一个常量**）。序列化时每项是 `{ task, entry, constraints? }`：
  - `entry` 不由提供者填，而是 `AiRouter.entryOf(p, task)`——实现了该任务的专用端口就是专用方法（`native.ai.translate` / `native.ai.classify`），否则 `native.ai.run`。所以 `intent-handoff` 的 translate 报 `native.ai.run`，`local-qwen` 的 translate 报 `native.ai.translate`，前端不用再靠 `modelId` 猜。
  - `constraints` 有翻译与文本生成两种。翻译：`{ languages: string[], sourceAuto: boolean, maxChars: number, allowNumBeams: boolean }`（`AiConstraints.Translate`）；`maxChars` 是该提供者能译的原文字数上限（NLLB 2000 即入口上限，Qwen 300），超限 `BAD_PARAMS`，message 提示改用本地翻译模型；`allowNumBeams` 为 false（Qwen）时传了 `numBeams` 报 `BAD_PARAMS`。
- `session`（第 4 步追加）：是否实现了 `AiSessionControl`（能 `native.ai.warmup/unload`），由实现推导，前端据此决定要不要预热。

### 约束同时用于校验输入

`AiConstraints` 除了 `toJson()`（下发给前端），还有 `check(call)`：分派时按**选中提供者**报价里的约束校验输入。`AiConstraints.Translate.check` 调 `AiTranslatePolicy.checkLanguages(req, languages, sourceAuto)`——`src` 必须在清单里或（`sourceAuto` 为真时）是 `auto`，`tgt` 必须在清单里。`AiTranslatePolicy.parse` 只做结构校验（字符串、非空、`tgt` 不能是 `auto`、`src≠tgt`、`numBeams` 范围）。

`Translate.check` 之后还查原文字数（`> maxChars` 报 `BAD_PARAMS`：“该模型最多翻译 N 字，请改用本地翻译模型”）与 `numBeams`（`allowNumBeams` 为假时不许传）。前端页面可直接读 `maxChars` 提前限制输入，不读也行（原生 message 是中文，页面会原样显示）。

所以前端看到的语言清单和原生实际收的是同一份数据；以后某个翻译提供者语言不同，只改它的 `offers()`，路由与入口都不用动（`AiInvokeTest` 用一个报了德语、不许 auto 的替身验证过）。`AiTranslatePolicy.LANGS` 降级为“应用认识的语言码”，契约测试要求各提供者报的语言都在其中（`AiQwenPolicy.langName` 与 NLLB 的语言映射只认这些）。

## 文本生成的预设与采样（第 6 步）

代码：`AiGenerate.kt`（`AiPreset`、`AiGenOptions`、`AiSamplingParams`、`TextGenerator`、`AiGeneratePolicy`）、`AiProvider.kt` 的 `AiConstraints.Generate`、`AiQwenPolicy`（`Sampling`、默认采样、`OFFER_GENERATE`）。

- **预设** `AiPreset`：`summarize` / `proofread` / `rewrite` / `prompt`，各自决定指令模板、system 与默认采样。不传按 task；传了就覆盖模板（task 只管路由）。**只有 `prompt` 预设允许页面额外传 `system`**，其它预设传了 `BAD_PARAMS`（小模型的 system 是为任务写死的，让页面改会破坏“只输出结果”的约束）。
- **默认采样**：翻译、摘要、校对、改写贪心；`prompt` 温度 0.7、topK 20（`AiQwenPolicy.PROMPT_SAMPLING`，已逐字核对 Qwen3.5-0.8B 官方模型卡（2026-10-19）：非思考模式官方推荐 temperature 1.0 / top_p 1.0 / top_k 20 / presence_penalty 2.0 / repetition_penalty 1.0，项目现值是 top_p 0.95、重复惩罚 1.1（沿用模型 config.json）、prompt 温度 0.7，**与官方不同，是自己的折中**；要不要改回官方值得真机比质量，暂不动）。页面传的 `temperature` / `topK` 覆盖默认；`temperature = 0` 即贪心；贪心预设上只传 `topK` 仍是贪心。
- **约束** `AiConstraints.Generate(presets, temperature 0~1.5, topK 1~100, allowSystem)`：序列化为 `{ presets, temperature: {min,max}, topK: {min,max}, allowSystem }`；本地 Qwen 的四个文本任务报价都带它（`AiQwenPolicy.OFFER_GENERATE`）。
- **非 run 端口拒绝生成选项**：翻译、识图、文字识别这些专用端口收到 `preset` / `system` / `temperature` / `topK` 等生成类选项一律 `BAD_PARAMS`（不静默忽略）；识图的 `topK` 是它自己的参数，不在此列。Qwen 翻译的 max new tokens 随原文走：`clamp(字数 × 2, 64, 512)`（`AiQwenPolicy.translateMaxTokens`），与 300 字上限配套。
- **线程与取消**：run 端口在 IO 调度器上执行；Qwen 生成与翻译（NLLB、Qwen）都能真取消：服务里 `runCancellable`（`CancellableCall.kt`）在 IO 线程跑阻塞调用，协程被取消时 watcher 立刻调 `backend.cancel()`，原生层在下一个检查点中止并抛 `CancellationException`，桥回 `CANCELLED`，`AiHeavyGate` 随之释放。Qwen 在下一个 token 处停，预填充（整段提示一次前向）不可打断；NLLB 在下一个解码步前停，最多等一次 decoder 调用。识图（CLIP）只有一次前向、没有循环，不接取消。
- **非生成式提供者拒绝**：`AiInvoker.route` 在选中提供者后，若 `AiCall.Run` 带了任何生成选项而它的报价约束不是 `Generate`，报 `BAD_PARAMS`（例如 `intent-handoff`）；契约不变量 7：实现 `TextGenerator` ⇔ run 承接的任务都带 `Generate`。旧入口 `native.ai.run` 不带这些字段，行为不变。
- **JNI 与“`set_config` 不能按次切换”（读码结论，原方案的假设不成立）**：MNN 的采样器只在 `Llm::load()` 里建一次，`load()` 之后 `set_config` 只改配置不重建采样器，所以**不能**“每次生成前 `set_config`”；顺带发现旧 JNI 在 `load()` 之后设的全局贪心从未生效，翻译等其实一直在用模型 config 的混合采样（temperature 1.0）。做法：采样配置改在 `load()` 之前设；`nativeGenerate(handle, system, prompt, maxNewTokens, temperature, topK)` 每次比较采样配置，变了就在 JNI 里销毁并重建会话（句柄是 `Session` 指针，对 Kotlin 透明）；不带采样的路径（`nativeCreate`）默认贪心。**代价**：在贪心任务与提示词问答之间切换会多一次模型加载（此前真机实测加载约 3.4 s，未测重建本身），同一类任务连续调用不重建。要消除重建，只能自己在 JNI 里接管逐 token 循环与采样（要碰 `forward` / KV 元数据，风险大，本次没做）。
- **行为变化**：翻译 / 校对 / 摘要 / 改写现在是真贪心（以前其实带温度 1.0 的采样），输出更稳定；提示词问答默认温度从 1.0 降到 0.7。

## 参数调整（AI 中心，2026-10-19 步 1~6，真机未验）

AI 中心详情弹窗里让用户调推理参数（温度、回答长度、束宽这类）。方案与取舍见 [调研](../research/model-tunable-params.md)；这里只记协议与约束。代码：`AiParams.kt`、`AiParamStore.kt`、`AiParamDefaults.kt`，前端 `stores/aiParams.ts`、`shared/ModelParamsPanel.vue`。

**第 5/6 步（MNN 性能模式 / Qwen 采样）**：伪提供者 `mnn` 再加一项 session 级 select：`power` 性能模式（只留均衡 0 / 性能 1，值即 MNN `PowerMode`；省电档与计算精度实测后已下线，见下）。两条生效路径：非 Qwen 的 Rust 模型由 5 个 Android 后端在 `*Load` 前调 `mnnSetRuntimeOptions(power)`（进程级静态量，`MnnConfig::runtime()` 读取，不改 5 个 `*_load` 的签名；C ABI 升到 2，`arkli_mnn_config` 多一个 `power`）；Qwen 不改 JNI，由 `QwenConfigWrapper` 把 `power`（仅性能档时写 `"high"`，均衡不写键）写进缓存里的包装 config（模型自带的 `precision=low` 原样保留）。Qwen 另有 session 级 `topP`（0.5~1.0，默认 0.95）与 `penalty` 重复惩罚（1.0~1.3，默认 1.1），默认值取自模型 `config.json`，同样写进包装 config：采样器在 `load()` 里按配置建一次、JNI 的 `set_config` 只合并 `sampler_type/mixed_samplers/temperature/topK`、不覆盖它们，所以不必改 JNI；只对混合采样（自由问答）有效，贪心任务不受影响，改完下次使用时重新加载。会话指纹含 mnn 组与 Qwen 自身全部 SESSION 项，改任意一项都会触发重载（有单测）。**为何去掉省电与精度**：真机实测（STG-AL00，4 大 4 小核，无 fp16，MNN_ARM82=OFF）：性能(High)对均衡(Normal)，Qwen 校对热态约 4.8 s 对 4.8 s、NLLB 约 0.93 s 对 0.94 s，无收益；省电(Low) Qwen 约 10.2 s、NLLB 约 2.1 s，且切回均衡后不恢复（约 9.0 s / 2.1 s），原因是 MNN 线程池全局、重载不重建，Low 把线程绑到小核（Cpus_allowed_list 0-3），Normal 不绑核所以沿用旧绑定，切到 High 会主动绑大核才能恢复；精度高对普通无差别（本构建无 fp16 内核）。用户据此拍板：性能模式只留“均衡 / 性能”，计算精度整项不开放（C ABI 的 `precision` 字段是 ABI 1 就有的，保留，全项目恒传 0；`power` 的 C/Rust 侧仍允许 2，只是 Kotlin 参数规格不再提供）。性能档不承诺更快，文案写成“固定用大核，在大小核调度不好的手机上可能更快，代价是更耗电”。以后换有 fp16 内核的机型，或修好 MNN 线程池绑核（重载后重建/解绑）后可再评估精度与省电档。

**数据流**

1. 提供者实现可选端口 `AiTunable.paramSpecs()`（与 `TextGenerator` 同类），返回 `AiParamSpec` 列表；`native.ai.providers` 的条目带可选 `params`（没有就省略，旧页面忽略）。
2. 页面用 `native.ai.params.get/set/reset` 读写，返回 `{ provider, specs, values }`，`values` 是当前生效值。存储是 SharedPreferences `ai_params`，键 `<provider>.<key>`，**只存与默认不同的值**（默认以后改了老用户自动跟随，“恢复默认”就是删键）。
3. 调用时，`AiInvoker.dispatch` 在 `constraints.check` 之前调 `AiParamDefaults.fill`，把用户**改过的**值补进调用里没带的字段，补完照常过约束校验。没改过的什么都不补，行为与改前完全一致。

**优先级**：页面显式传的值 > 用户设置 > 内置默认。所以自带温度的页面（如对联页的 `QWEN_TEMPERATURE`）不受用户设置影响，弹窗文案要写明“页面自带设置的功能以页面为准”。识物靠 `AiClassifyRequest.explicitTopK` 区分“页面显式传了 topK”和“解析出来的默认值”。

**spec 字段**：`key`（稳定键）、`label`、`desc`、`kind`（`slider` / `stepper` / `switch` / `select`）、`default`、`min`、`max`、`step`、`options`（select 的档位文字）、`optionValues`（可选，select 各档真实值，与 `options` 等长）、`advanced`（折进“高级”）、`scope`（`call` / `session`）、`applyTo`（只作用于哪些任务，空 = 全部）。数值统一用 number：switch 是 0/1，**select 有 `optionValues` 时存真实值，`options` 只管显示**（如 NLLB `numBeams` 直接存 1/2/4）；没有 `optionValues` 的 select 才按选项下标存。

**CALL / SESSION**

- `call`：每次调用补进去，改完下次调用就生效，不重建会话。本期全是它。
- `session`：加载模型时定死，改了要重建会话。机制已备好：6 个 `XxxService` 都有 `settingsKey: () -> String` 并进重载指纹，`AiParams.sessionFingerprint` 算 SESSION 级值的指纹。**步 4 已接**：5 个 Runtime 创建 Service 时传 `settingsKey = { AiMnnParams.fingerprint(提供者 id, 自身 specs, store) }`，指纹含 `mnn` 组的 SESSION 值（`mnn.numThread=…`）与该提供者自己的 SESSION spec。改设置不会打断正在跑的推理，下次拿到闸门后才重载。参数 store 全进程只有一个（`AiParamStores.get(context)`），`AiModule` 与各 Runtime 共用。

**已声明的参数**

| 提供者 | key | 形态 | 说明 |
|---|---|---|---|
| `local-qwen` | `temperature` | slider 0~1.5 | 只作用于 prompt 预设（其它预设保持贪心） |
| `local-qwen` | `topK` | stepper，高级 | 只作用于 prompt 预设 |
| `local-qwen` | `maxTokens` | select 短 128 / 中 256 / 长 512 | 回答长度，作用于全部文本预设，**不影响翻译**（翻译随原文走）；`AiCall.Run.maxTokens` 只由用户设置补入，页面不传 |
| `local-nllb` | `numBeams` | select 快速 / 均衡 / 精细 | 值 1/2/4 即束宽，页面没传 `numBeams` 才补 |
| `local-couplet` | `temperature` / `topK` | slider 0~1.5 / stepper（高级） | 页面没传才补 |
| `local-clip` | `topK` | stepper 1~10（高级） | 页面没显式传才补 |
| `local-clip` | `clipStrictness` | select 松 / 标准 / 严（默认 1） | 识别严格度，scope `call`。对应阈值 0.65/0.8/0.9（对称收放，非调参所得）；只影响“拿不准”提示的松紧，不改变排序 |
| `local-ocr` | `ocrSensitivity` | select 宽松 / 标准 / 严格（默认 1） | 检测灵敏度，scope `call`。标准档按模型自带 box_thresh（v5 0.5 / v6 0.45），宽松 0.35、严格 0.6；档位越严越可能漏淡字，越宽松越可能多出杂框。`det_post.thresh`/`unclip_ratio` 默认依模型版本而不同、风险大，本期不开放 |
| `local-ocr` | `ocrDropScore` | slider 0~0.8（步进 0.05，默认 0.5） | 过滤低置信文字，scope `call`。与 Rust DEFAULT_DROP_SCORE 一致，低于该分数的文字行直接丢弃 |
| `local-ocr` | `ocrMaxSide` | select 640 / 960 / 1280（高级，默认 960） | 检测图最长边上限，scope `call`。送入检测网络前等比缩放到该最长边以内 |


**`mnn` 伪提供者（步 4）**：所有本地 MNN 模型共用的基础参数，只出现在 `params.get/set/reset`（`AiParams.resolveTunable` 直接认 `provider: "mnn"`，返回 `AiMnnParams.SPECS`），**不进** `native.ai.providers`、不参与路由。现有一项 `numThread`（stepper 1~6，默认 4，scope `session`，默认值是原先各 `AndroidXxx.kt` 写死的 4 的唯一来源）。Clip/Couplet/Matting/Ocr/Translate 的 Backend 加载时读 `AiMnnParams.threads(store)`；语音识别（sherpa）有自己的线程数，不受影响。Web 入口：AI 中心顶部“MNN 基础参数”卡片 → `MnnParamsSheet.vue`（内嵌 `ModelParamsPanel provider-id="mnn"`）。

**Qwen 线程（不改 JNI）**：`MnnQwenBackend.load` 读模型目录的 `config.json`，经纯函数 `QwenConfigWrapper.wrap` 覆盖顶层 `thread_num` 并加 `base_dir`（模型目录绝对路径，必须以 `/` 结尾，MNN 是字符串直拼），写到 `cacheDir/qwen_runtime_config.json`（固定名覆盖写），把它传给 `nativeCreate`。依据 MNN `llmconfig.hpp`：`base_dir` 取自 config，随后 `config_.merge(llm_config.json)`；ujson `merge` 是源（llm_config.json）覆盖已有键、对象递归，但设备上 `llm_config.json` 不含 `thread_num` / `base_dir`，所以覆盖值有效。不动 `mllm` 里的 `thread_num`。

**校验**：`params.set` 逐项按 spec 校验（范围、步进对齐、select 值在 `optionValues` 里，无 `optionValues` 时为合法下标），**整批原子**，任一非法整批拒绝，报 `BAD_PARAMS`（不夹取，与“不静默忽略”一致）。未知提供者、没实现 `AiTunable` 的提供者、空 `values`、未知 key 同样 `BAD_PARAMS`。值与默认相同就删键不存。三个方法只接受主 frame。

**页面边界**：参数区只在 AI 中心详情弹窗，工具页不得读写，见 [模型选择器](model-picker.md)。

**新提供者要加可调参数**：实现 `AiTunable`，并过契约不变量 8~11（见下）。范围常量引用该提供者 Policy 里已有的那一份（`AiConstraints` 也引用它），别再写第二份。

## 不变量（能力 = 端口）

`AiProviderContractTest` 用替身服务调 `AiModule.providers(...)`（与正式注册同一个函数），对每个提供者检查：

1. 实现了专用端口 ⇒ 声明了对应任务；
2. 声明的任务要么有专用端口，要么在 `runTasks` 里；`runTasks` 里的任务必须是文本任务，且 `run()` 不以 `BAD_PARAMS` 拒绝；
3. 有专用端口的任务，`run()` 一律以 `BAD_PARAMS` 拒绝；
4. `offers()` 的任务集合 == `capabilities()`、不重复；翻译约束只能挂在 translate 上；经 `native.ai.translate` 承接的 translate 必须带非空语言清单，且每种语言都在 `AiTranslatePolicy.LANGS` 里（应用认识的语言码；报了引擎不认识的语言就是说谎）；
5. （第 3 步）每个报价按 `{ task, provider }` 经 `native.ai.invoke` 定路由（`AiInvoker.plan`），落到**同一个提供者**、**报价里写的那个入口**；钉住同一入口结果不变；
6. （第 4 步）会话类提供者的 `sessionModelId` 与它报给前端的 `modelId` 一致；
7. （第 6 步）实现 `TextGenerator` ⇔ run 承接的任务报价都带 `AiConstraints.Generate`，且 `Generate` 只挂在 run 承接的任务上。
8. （参数调整）可调参数的提供者实现 `AiTunable` 且 `paramSpecs()` 非空；`key` 在提供者内唯一；`default ∈ [min,max]`、`step > 0`；select 的 `options` 非空；有 `optionValues` 时与 `options` 等长、默认在其中、`min/max` 取其最小/最大，否则默认是合法下标；`applyTo` 里的任务必须是该提供者报价里的任务；
9. 每个 spec 能 `set → get` 往返、`reset` 回默认；越界 `set` 抛 `BAD_PARAMS` 且不改已有值，整批原子；
10. spec 范围 ⊆ 对应 `AiConstraints` 范围，防止两份漂移；
11. `scope = session` 的 spec 改值后，会话指纹必须变化；`call` 级改值指纹不变。

另有八个故意“说谎”的替身（第 6 步加了“报了生成约束却没实现 `TextGenerator`”“实现了 `TextGenerator` 却没带约束”）（含“报价少一项”“走语言对接口却不报语言”“实现了 `OcrEngine` 却没声明 `ocr`”），确认检查器本身能抓到问题。新增提供者只要加进 `AiModule.providers`，就自动受检。

`local-ocr` 没有为契约测试改任何检查逻辑：逻辑不变，只同步了测试里的四处提供者列表（见 checklist）。

`AiInvokeTest` 另外用记录型替身端到端跑 `dispatch`，确认每个报价真的到达报价入口对应的端口方法；并把 invoke 与旧入口在“未知提供者 / 不支持 / 走错入口 / 未就绪 / 未知任务 / 要图片输入”上的错误码与文案逐条对齐。

## 生命周期派生（第 4 步）

以前每接一个模型要改三处：`AiModule.install` 的删模型钩子、`AiRecycle` 手列的三个服务、提供者列表。现在只登记一处——`AiModule.providers(...)`，其余全派生：

| 生命周期 | 派生方式 | 代码 |
|---|---|---|
| 预热 `native.ai.warmup` | `AiRouter.resolveById(all, AiPort.Session, id)` | `AiWarmupHandler` |
| 卸载 `native.ai.unload` | `AiLifecyclePolicy.selectSessions`（缺省 = 全部实现 `AiSessionControl` 的） | `AiUnloadHandler` |
| 删模型前释放 | `AiLifecyclePolicy.releaseHooks(all)`：按 `AiSessionControl.sessionModelId` 分组，`install` 逐个 `addReleaseHook(modelId) { unloadAll(sessions) }` | `AiModule.install` |
| 退出 / 内存告急回收 | `install` 调 `AiRecycle.attach(all)`，只留会话控制；`releaseAll` 卸它们（与 unload 缺省同一个选择） | `AiRecycle` |
| 前端预热跟随 | 目录项 `session`（原生 `session`；旧原生缺字段时按“有 modelId”兜底），`sessionProviderOf(item)` 为空就不预热 | `aiCatalog.ts`、翻译页 |

`AiSessionDerivationTest` 加了一个只实现 `AiSessionControl` 的替身：只把它放进提供者列表，不改别处，它就被 `AiRecycle` 回收、进删模型钩子、被 `native.ai.warmup/unload` 路由到、`providers` 里 `session: true`。

注意：`AiRecycle` 现在依赖 `AiModule.install` 先调过 `attach`（每次 WebView 会话装模块都会重新登记，以最后一次为准）；还没装过就什么都不做——与原来“服务还没建就不卸”的效果相同，因为原来 `install` 也会建出三个服务。各 Runtime 的 `peek()` 因此不再需要，已删除。

注意：`intent-handoff` 声明了 translate 但没有语言对接口，它的 translate 报价经 `native.ai.run`、不带语言清单，这是合法的（“translate 必须有语言”只约束走 `native.ai.translate` 的）。

## 前端

- **AI 目录**（第 2 步）：`web/src/shared/aiCatalog.ts` 的 `buildCatalog` 是纯函数，`web/src/native/useAiCatalog.ts` 是组合式函数。输入是工具在 `registry.ts` 声明的 `tasks`（`AiTask` 或 `{ task, entry }`）与过渡 `models`、`native.ai.providers`（全应用共用一次探测，`useSharedAiProviders().ensure()` 去重）、模型 store 的下载状态（只读）。输出每项 `{ key, providerId?, modelId?, layer, title, desc, status, constraints?, entries, selectable }`。适用性、层、文案、隐藏规则见 [模型选择器](model-picker.md)。
- **选择值是提供者 id**：`useAiCatalog(toolId).current.providerId` 直接传给桥方法；原生还没有提供者的 L1 清单模型（超分等）存 `model:<id>`，不伪造提供者（OCR 已有 `local-ocr`，存提供者 id）。旧值（清单模型 id）一次性迁移，见 model-picker.md。
- 翻译页：`useAiCatalog('translate')`。工具声明 `{ task: 'translate', entry: 'native.ai.translate' }`，目录里只有 NLLB、Qwen（加 L4 占位），交接不会混进来；语言清单取 `current.constraints`（原生报价），`registry.ts` 不再写语言。还没探测到就先等一次 `refresh`；当前项没有提供者就提示“当前模型暂不能翻译”，不回落到别的模型。探测前不显示“无可用模型”提示。旧的 `findTranslateProvider` 已删除。极短输入改走 Qwen 时，页面用 `warmup.occupy('local-qwen')` 登记额外占用，离页（停用/卸载）时与当前所选提供者一起 `aiUnload`，避免 NLLB 与 Qwen 同时驻留；`translate` 的异步等待之后写结果前统一用 `isLatestRun(my, seq)` 守卫，取消或换模型后旧结果不会覆盖新状态；`BAD_PARAMS` 带中文 message（如超过 Qwen 的 300 字上限）时页面原样显示。
- 就绪：`current.status === 'ready'`，status 来自模型 store（store 还没拿到时用提供者自带的 `downloaded`），不读 provider 的 `available`。
- 预热：`useModelWarmup(sessionProviderOf(current), modelReady)` → `createProviderWarmup`。只跟随 `session` 为真的提供者（没有会话的交接、占位不会去调 warmup 换一个 `BAD_PARAMS`）。页面活跃且已安装时预热当前提供者；换提供者时先取消并卸载旧的，**等卸载请求结束再预热新的**，避免 NLLB 与 Qwen 同时驻留；停用/卸载时释放当前的；页面停用期间的状态变化不触发预热。
- **`aiInvoke`**（第 3 步，`web/src/native/ai.ts`）：`aiInvoke<T extends keyof AiTaskMap>(task, input, { provider?, entry?, options?, signal? })`。`AiTaskMap` 按任务给强类型：文本四类 `{ text }` + `options: { preset?, system?, temperature?, topK? }`（第 6 步，`AiGenerateOptions`）→ `AiRunResult`；`translate` `{ text, src, tgt }` + `options.numBeams` → `TranslateResult`；`classifyImage` `{ path }` + `options.topK` → `ImageClassifyResult`；`ocr` `{ path }` → `OcrResult`；`couplet` `{ text }` + `options: { temperature?, topK?, seed? }` → `CoupletResult { text, elapsedMs, modelId }`（`describeImage` 没有端口，暂不收录）。只发有值的字段，空 `options` 省略。旧封装签名不变，内部转调并**钉住原入口**：`aiTranslate` 钉 `native.ai.translate`（点名交接时照旧 `BAD_PARAMS`，不会悄悄交接出去）、`aiClassifyImage` 钉 `native.ai.classify`、`aiOcr` 钉 `native.ai.ocr`、`aiRun` 钉 `native.ai.run`（它的 task 可以是交接的 translate，超出 `AiTaskMap`，走内部 `invokeRaw`）。
- `aiInvoke` 的类型以任务的缺省端口为准：只点名交接类提供者做 translate、又不钉入口时，原生按它的报价走 run，返回的是 `AiRunResult` 形状，类型上看不出来；需要确定形状就钉 `entry`。

## 新增一个 AI 任务的 checklist（OCR 是第一个按它接入的）

统一协议的收益：**路由、入口分派、报价序列化、生命周期（预热/卸载/删模型前释放/回收）、契约测试、前端目录与选择器都不用改或自动覆盖**，只需要补这个任务自己的输入输出与服务。OCR（M8）实测要动的地方如下，漏了会怎样也一并标出（“编译”= 编译器逼着补；“契约”= `AiProviderContractTest` 会红；“靠人”= 没有机器拦，务必核对）。

**原生（Kotlin，`com.let188.arkli.ai`）**

1. `AiTask` 加枚举：wire 名（前端 `AiTask` 联合类型同名）与 `isText`（图片输入类为 false，`run` 端口因此自动不收）。
2. `AiModule.METHOD_XXX` 常量，`AiPort.Xxx` 专用端口（`AiPort<XxxEngine>(METHOD_XXX, AiTask.XXX)`，`bind` 判断提供者是否实现 `XxxEngine`），并加进 `AiPort.DEDICATED`。`TASK_PORTS`、`byEntry`、`canonicalFor`、`portOf`、`entryOf`、offers 的 `entry`、契约不变量 1~3 全由它派生。
3. 输入输出：`AiXxxPolicy.parse(JSONObject)` → 强类型请求、`resultJson`（纯函数；路径、provider 字段复用 `AiPolicy.pagePath` / `providerId`）。输入形状、结果形状在这里定死，前端 `AiTaskMap` 照它写。
4. `AiCall.Xxx` 子类，并补 `AiInvokePolicy.toCall` 与 `AiInvoker.dispatch` 里的 `when` 分支（编译：这两处是对 sealed 类的穷举 `when`）。
5. 服务 + 提供者：`XxxService`（排 `AiHeavyGate`、首次使用才加载、文件指纹变化重载、协程取消打断引擎）与 `LocalXxxProvider`（`layer`、`offers()`、`capabilities()`、`modelInfo()`、`sessionModelId`、实现 `XxxEngine` 与 `AiSessionControl`；`run()` 一律 `throw AiRouter.notRunnable`）。参照 `OcrService.kt` / `ClipService.kt`。
6. 登记两处：`AiModule.providers(...)` 加参数与列表项（编译：所有调用方要改，测试夹具也是）；`AiModule.install` 取 `XxxRuntime.get(...)` 并 `bridge.register(METHOD_XXX, AiXxxHandler(invoker))`（旧入口 = invoke 钉死端口的别名，`handle` 里只做 `requireMainFrame` + parse + `dispatch`）。**不用动**：`AiRecycle`、`AiLifecyclePolicy`、预热/卸载处理器、删模型钩子。
7. 若有新本地模型：`assets/ai/models.json` 加条目（`dir`、各文件 bytes/sha256/role/urls、许可证），`XxxService.REQUIRED_FILES` 与它逐一对应（`OcrServiceTest` 会对照清单文本查）。
8. 测试：`AiFixtures.registered` 加该服务的替身（靠人）；`AiProviderContractTest` 里要手工同步四处——注册 id 列表、层 map、`sampleInput`、会话提供者列表（靠人：漏了列表断言会红，但不会告诉你该加哪一行）；`AiSessionDerivationTest` 的两个提供者列表（靠人）；新增 `XxxServiceTest`（缺文件 NOT_READY、懒加载一次、指纹变化重载、取消）、`AiXxxPolicyTest`、`AiInvokeTest` 里“invoke 与旧入口错误一致”与结果形状。契约测试本身**不用改逻辑**：实现了端口没声明任务、声明了没实现、run 也收、offers 与声明不一致、invoke 落不到报价入口，都会自动抓到；可以在 `AiProviderContractTest` 里加一个“说谎者”替身确认检查器对新端口生效（OCR 加了 `HiddenOcr`）。

**Rust（需要新引擎时）**

9. `arkli-ai` 里的管线/引擎（只依赖 `Session` / `GraphSession` trait，mock 单测），`arkli-ffi/src/<xxx>.rs` 导出 `xxx_load(runtime_lib, model_dir, threads)` / `xxx_<动作>` / `xxx_unload`（风格同 `clip.rs`、`translate.rs`：进程内单例 + Mutex、强类型 `uniffi::Record` 结果、`uniffi::Error` 分 NotLoaded / InvalidInput / Cancelled / Backend），需要取消就再导出 `xxx_cancel`。然后 `core/scripts/build-android.ps1` 重新生成绑定（生成物不手改）。

**前端（`web/src`）**

10. `native/ai.ts`：`AiTask`、`AiEntry` 联合类型加成员；`AiTaskMap` 加 `{ input, options, output }`；写 `aiXxx()` 封装 = `aiInvoke(task, input, { entry: AI_METHODS.xxx, signal })` + 把 `NOT_READY` / `UNKNOWN_METHOD` 统一成 `AiNotReadyError`（`AI_METHODS` 里已有同名常量的更省事，没有就加）。
11. `shared/aiCatalog.ts`：`TASK_LABELS` 加中文短名（编译：它是 `Record<AiTask, string>`）；若旧版存过这个工具的清单占位 id，往 `LEGACY_CHOICE_MIGRATION` 加一行映射到新提供者 id。
12. `tools/registry.ts`：工具声明 `tasks: [{ task: 'xxx', entry: AI_METHODS.xxx }]` 并带 `tags: [TAG_AI]`（选择器与 AI 页都靠它）；去掉过渡 `models`。
13. 工具页：`useAiCatalog(toolId)`，就绪 = `current.status === 'ready'`，探测完仍无就绪模型时显示 `<model-missing-notice />`；**只读状态，不得出现 ensure / cancel / remove / verify、下载进度**（见 CLAUDE.md 与 [模型选择器](model-picker.md)）。
14. 测试（靠人）：`aiCatalog.test.ts` 的 `nativeProviders()` 夹具加该提供者的报价、“各 AI 工具声明的任务”快照加该工具、`ai.test.ts` 加封装用例（钉入口、无宿主、错误码统一）；有迁移表项就在迁移表断言里加。

15. 可调参数（可选）：提供者实现 `AiTunable`，常量引用 Policy 里的范围，并过契约不变量 8~11；`AiParamDefaults.fill` 里加该任务的补参分支。前端只在 AI 中心弹窗里出现，工具页不碰。

**文档**：[桥协议](bridge-protocol.md) 加 `native.ai.xxx` 行与提供者行、更新 `providers` / `invoke` 说明里的任务与入口清单；本文端口表；[模型选择器](model-picker.md) 里涉及该工具的表格。

OCR 实际改动量（作为参照）：原生新增 `OcrService.kt`、`AndroidOcr.kt`、`AiOcrPolicy.kt` 与 `AiTask` / `AiPort` / `AiCall` / `AiModule` / `AiHandlers` 各数行；前端 `ai.ts` / `aiCatalog.ts` / `registry.ts` 各数行加两个页面改读目录。**没碰** `AiRouter` 的路由逻辑、`AiInvoker.route`、`AiLifecyclePolicy`、`AiRecycle`、`AiPolicy.providersJson/offersJson`、`ModelPicker.vue`、`useAiCatalog.ts`、`buildCatalog`。

**接入时发现的缺口**（如实记录）：契约测试里有四处手写的提供者列表（id / 层 / 会话 / sample 输入）要人工同步，新增提供者时漏一处不会指出漏的是哪一行；前端 `nativeProviders()` 夹具同理。可以以后让这些断言从 `AiModule.providers` 派生，本次没做。

## 对联接入记录（第二个按 checklist 接入的任务，阶段 2a）

只做推理引擎与协议接入，**不含前端页面**（`web/src/tools/couplet/` 下一阶段重做）。按上面 checklist 逐项，实际动了这些地方：

| checklist | 对联的做法 |
|---|---|
| 1 `AiTask` | `COUPLET("couplet", isText = false)`：文本生成类，但**不走 run**（强类型参数 + 专用端口），所以 `isText=false`，交接类提供者的 `capabilities`（取 `isText`）因此不会声明它 |
| 2 端口 | `AiModule.METHOD_COUPLET = "native.ai.couplet"`；`AiPort.Couplet`（`bind` = 是否实现 `CoupletEngine`）并进 `DEDICATED` |
| 3 输入输出 | `AiCoupletPolicy.parse`（形状、`text` 1~14 字、`temperature` 0~2、`topK` 1~200 整数、`seed` 非负安全整数）、`checkConstraints`、`resultJson`（`{ text, elapsedMs, modelId }`）。**上联字符合法性由 Rust 校验**（见下） |
| 4 `AiCall` | `AiCall.Couplet(req)`；补 `toCall`、`dispatch` 两处 `when`。另有一处：`rejectGenOptions` 原来对非 run 端口一律拒绝 `temperature` / `topK`，对联认这两个（自己的范围），所以按端口区分，对联只拒 `preset` / `system` |
| 5 服务与提供者 | `CoupletService`（`AiHeavyGate`、懒加载、指纹重载、协程取消调 `couplet_cancel`）、`LocalCoupletProvider`（`local-couplet`，L1，实现 `CoupletEngine` + `AiSessionControl`）、`AndroidCouplet.kt`（UniFFI 桥） |
| 6 登记 | `AiModule.providers(..., couplet, models)`（追加在 `local-qwen` 之后）与 `install` 里的 `CoupletRuntime.get`、`AiCoupletHandler` 注册；回收、预热、卸载、删模型前释放自动覆盖 |
| 7 模型清单 | `models.json` 的 `couplet-gpt2-mnn-w6`（7 个文件，`CoupletService.REQUIRED_FILES` 与它逐一对应，`CoupletServiceTest` 对照） |
| 8 测试 | 契约测试同步四处列表并加 `HiddenCouplet` 说谎者；`AiSessionDerivationTest` 两处；新增 `CoupletServiceTest`、`AiCoupletPolicyTest`；`AiInvokeTest` 加对联与旧入口一致、结果形状、NOT_READY |
| 9 Rust | `arkli-ai::couplet`（引擎 + 纯逻辑）、`arkli-ffi::couplet`（`couplet_load/generate/cancel/unload`），`build-android.ps1` 重新生成绑定 |
| 10~12 前端 | `AiTask`、`AiEntry`、`AiTaskMap.couplet`、`aiCouplet`、`AI_METHODS.couplet`、`TASK_LABELS.couplet`；**不动** `registry.ts` 与 `tools/couplet/`（下一阶段） |

**约束与校验的分工**：

- **Rust**：上联 1~14 字（按 char 计）、只允许汉字与 `，。、；：！？,.;:!?`、至少一个汉字、拒绝字母数字括号空白；`temperature` 0~2、`topK` 1~200。错误是 `AiError::InvalidConfig`，经 FFI 映射为 `InvalidInput`，Kotlin 翻成 `BAD_PARAMS`。
- **Kotlin**：只管 JSON 形状与范围（同一份范围写进报价 `AiConstraints.Couplet`，前端读它，不再自己写一份）。上联非法字符不在 Kotlin 重复校验，避免两份规则漂移；代价是非法上联要等拿到闸门、加载模型后才报错（Rust 在生成入口校验）。若以后要“秒回”，再把同一规则搬到 Kotlin。
- **等长约束与解码**：见 [对联 GPT-2 评估](../research/couplet-gpt2-onnx.md) 的“MNN 转换与接入”。

**缺口（如实记录）**：契约测试里四处手写提供者列表这次又要人工同步（与 OCR 时发现的缺口相同，没解决）。

## 翻译页：超短输入处理

**现象**：NLLB-200-distilled-600M 对 1~4 字的中文短语译文不准。“你好世界”→"I'm going to have a good time."，“你好”→"You're all right."，“你好！”→"I'm going to be a little late."，“不客气”→"Unhospitality"，“救命”→"Salvation and Salvation"；en→zh 的 Goodbye→“别见你”。带上下文就对，如“你好，世界！”→"Hello, world!"。

**证据**：桌面 fp32 / int8 / fp16 / int4 对照，原版 fp32 也错，即问题在模型本身，调参数、换量化、换更大尺寸都修不好；真机同样复现。本地大模型 Qwen（`local-qwen`）对这些输入翻译正常。

**规则**（前端实现，`web/src/tools/translate/shortInput.ts`、`phrases.ts`，原生不改）：

1. 极短判定 `isUltraShort`：去首尾空白与标点后，中文（源为 `zh-CN`，或 auto 且含汉字）字符数 ≤ `SHORT_ZH_MAX`（4）；其他语言词数 ≤ `SHORT_WORDS_MAX`（2）。原文内部含逗号、顿号、分号、冒号的视为带上下文，不算极短（所以“你好，世界！”仍走 NLLB）。
2. 短语表 `lookupPhrase`：zh-CN→en 12 条、en→zh-CN 9 条，只收人工确认正确的；精确匹配，忽略首尾空白、大小写与末尾 `。！!？?.`。命中不调原生，直接出译文。
3. 路由 `routeShort`：仅当所选是 `local-nllb` 且极短时生效。命中短语表 → 直接出译文；否则 Qwen 已安装且其报价约束覆盖当前语言对 → 本次用 `local-qwen`，结果下方提示“短文本已改用本地大模型翻译，更准”；否则照所选。用户自己选了 Qwen 或其他提供者时不改写。
4. 翻译按钮可用规则不变：所选模型未就绪就不能翻译，即便短语表能命中。

**已知局限**：短语表只覆盖固定条目，改一个字（如“你好啊”）就落到 NLLB 或 Qwen；Qwen 未安装时极短输入仍可能得到错误译文，且页面不额外提示；首次走 Qwen 要加载模型，会比 NLLB 慢。opus-mt-zh-en 等更适合短句的专用模型，并入“ONNX→MNN 迁移评估”一并看。

**引擎层补强：引号包裹法**（Rust，`core/crates/arkli-ai/src/translate/wrap.rs`，在 `Translator::translate` 里生效，前端无感）：

- **做法**：对极短输入加固定前缀并用直引号包住，翻译后只取第一对引号里的内容。前缀译成什么无所谓，不剥前缀译文。zh 源：`这个词是："X"`；en 源：`The word is: "X"`；前缀以“：”结尾，不会被切句。弯引号 “” 实验里不稳，必须直引号；提取时同时认 `"` 与全角 `“”`（en→zh 后处理会把引号变全角）。
- **启用条件（全部满足）**：切句后恰 1 段；X 不含引号、换行和句内句末标点（末尾的 `！`、`？` 允许）；zh ≤ `MAX_ZH_CHARS`（6）字、en ≤ `MAX_EN_WORDS`（3）词；源语言为明确的 zh-CN 或 en（auto 时用该段识别结果，识别不出则不启用）；目标 ≠ 源。fr/es/ru/ar 未验证，不启用。
- **回退条件（回到不加前缀的原路径）**：找不到闭合的一对引号；内容为空；目标非中文但内容仍含汉字；内容有 3 次以上重复 n-gram（如 `Hello, hello, hello`）；内容词数（中文按字）超过 max(6, 4 × 原文字/词数)。引号后还有尾巴先接受。目标为 en 时首字母大写。
- **开关**：模型清单 `generation.short_phrase_wrap`，缺省 true，显式 false 关闭。长句与不满足条件的输入走原路径，行为不变。
- **证据**（桌面 int4，实验脚本与逐条译文在会话 scratchpad，未入库）：zh→en 76 词基线对 43~44，引号法 60~62；en→zh 28 词 15 → 20~21。真模型测试：你好→Hello、谢谢→Thank you、你好！→Hello!、Hello→你好，长句开关前后一致。
- **局限**：只验证 zh/en、只在桌面 int4 上量过，真机未复测；仍有不少词译不对（只是显著改善），极短输入准确率要求高时仍应走短语表或 Qwen；每次多翻一遍前缀，耗时略增（桌面约 0.4~0.5 秒/条）。M6 把引擎抽成 Seq2SeqRunner 时，`wrap.rs` 是纯函数可直接复用，编排（先试包裹、失败回退）要随引擎迁移。

## 抠图接入记录（第三个按 checklist 接入的任务）

任务 `matting`（`isText=false`，专用端口 `AiPort.Matting` / `MattingEngine`，`AiCall.Matting`）。与 OCR 接入不同的决定：
- **两个模型 = 两个提供者**（`local-matting-portrait` / `local-matting-general`），一个 `MattingService` 类按 `MattingMode` 实例化两份。理由：契约里一个提供者只有一个 `sessionModelId` / `modelInfo`，沿用 NLLB、Qwen 各一个提供者的做法，下载状态、预热、卸载、删模型前释放全部自动覆盖。请求带 `mode`，由 `AiMattingPolicy.parse` 补出提供者 id，`provider` 与 `mode` 冲突报 `BAD_PARAMS`；因此契约测试的 `sampleInput` 要按提供者给 `mode`。
- **输出是文件**：服务把 Rust 返回的原图尺寸 alpha 乘进像素，用 `PngEncoder`（FAST 调优）写 `cache/out/`，结果只回路径；Rust 侧负责缩放与 alpha 缩回，不返回合成图。
- **取消**：单次前向不可打断，只在阶段边界检查（见 [抠图](design/tools/matting.md)）。
- **细化强度**：请求带可选 `refine`（`off|light|standard|strong`，缺省 `strong`，非法 `BAD_PARAMS`），由抠图页四档分段控件传入，不进 AI 中心参数面板（用户拍板）。
- 前端：`AI_METHODS.matting`、`AiTask` / `AiEntry` / `AiTaskMap.matting`、`aiMatting`、`TASK_LABELS.matting`、registry 的 `tasks: [{ task: 'matting', entry }]`；`aiCatalog.test.ts` 夹具加两个提供者。
- 同步的测试列表：`AiFixtures`（`NoMatting`）、契约测试（id / 层 / 会话 / sample / `HiddenMatting` 说谎者）、`AiSessionDerivationTest`，新增 `MattingServiceTest`、`AiMattingPolicyTest`，`AiInvokeTest` 加两条。缺口同前：四处手写列表仍要人工同步。

## 已知局限

- 共用探测只在首次使用与打开选择器时刷新：装了/卸了交接类应用后，L3 是否出现要等下次打开选择器；本地模型的下载状态走 store 推送，不受影响。
- **`native.ai.status`（恒为 false 的桩）仍被这些工具读**（经 `tools/_ai/useAiModel.ts`）：超分 `image-upscale`（`upscale`）、证件照抠图 `id-photo`（`matte`）、人脸融合 `face-fusion`（`fuse`）、黑白上色 `colorize`（`colorize`），它们永远“未就绪”。识物（`classify`）与文字识别（`ocr`，M8 起 OCR 页与图片转表格都改读 AI 目录）已不再读它，桩里这两项成了死项。**随这几个工具各自接入新协议（新增任务 + 提供者）时逐个换成 `useAiCatalog`，全部换完再删 `native.ai.status`、`useAiModel`、`getAiStatus`、`AiStatus`**；新代码不得依赖它。
- 过渡 `models` 与原生提供者靠 `modelId` 关联，属于过渡期的约定；现在只剩超分、对象计数、人脸融合、上色还在用，各自接入原生后删掉过渡声明、改为 `tasks`（OCR 已完成）。
- `local-qwen` 翻译不接受 `numBeams`（传了 `BAD_PARAMS`，报价 `allowNumBeams: false`），固定贪心。采样已按次传入（第 6 步），但采样参数变化会重建 MNN 会话（多一次约 3.4 s 的加载）；翻译与提示词问答来回切换时会感觉到。
- 取消只断开页面等待：原生推理调用（Rust / MNN JNI）是阻塞的，要跑完才放开 `AiHeavyGate`（据代码推断，未在真机测量）。
- **新前端 + 旧 APK 不兼容**：旧封装已改调 `native.ai.invoke`，只热更新前端、手机上还是第 3 步之前的 APK 时，翻译会报 `UNKNOWN_METHOD`（识物会被当成“模型未就绪”）。装了新 APK 就好；没有做回退到旧方法的兼容层。
- run 端口（含 `local-qwen` 的摘要等）仍在桥的默认调度器（`Dispatchers.Default`）上执行，没有像翻译 / 识图那样切到 IO 线程，沿用改造前的行为。
- 进程级回收持有的是“最后一次装模块”的会话控制；它们背后的服务是进程单例，所以卸到的是同一份模型，但如果将来某个会话类提供者持有 Activity 级资源，要注意别在这里攥住。

## 后续步骤

按顺序，每步可单独交付：

1. ~~**模型目录 / offers**~~ 与 2. ~~**tasks 声明带入口**~~：**已做（2026-10-15，第 2 步，合并交付）**。原生 `layer` + `offers{task, entry, constraints}`；前端 AI 目录、工具声明 `tasks`、选择存提供者 id 与迁移。见上文与 [模型选择器](model-picker.md)。
3. ~~**`native.ai.invoke`**~~：**已做（2026-10-15）**。统一入口按任务分派到强类型端口，端口由路由推导；旧方法改为它钉死端口的别名；翻译语言按选中提供者的约束校验；前端 `aiInvoke` 与 `AiTaskMap`。见上文“统一入口”。
4. ~~**生命周期派生**~~：**已做（2026-10-15）**。预热/卸载/删模型前释放/进程回收都从实现了 `AiSessionControl` 的提供者派生；`providers` 追加 `session`，前端预热按它跟随。见上文“生命周期派生”。
5. ~~**OCR 接入**~~：**已做（2026-10-16，M8，桌面部分；真机与模型上传待用户）**。新增 `OcrEngine` 专用端口 + `AiCall.Ocr` + `LocalOcrProvider`，Rust `OcrPipeline` 经 `GraphSession` 跑 MNN fp16，OCR 页与图片转表格改读 AI 目录。见上文 checklist 与 [ONNX→MNN 迁移](../research/onnx-to-mnn-migration.md) 的 M8 一节。
6. ~~**按次采样与预设**~~：**已做（2026-10-16，桌面部分；真机待用户）**。invoke 的 `options` 带 `{ preset, system, temperature, topK }`，`AiCall.Run` 带强类型字段，校验挂在 `AiConstraints.Generate`，非生成式提供者报 `BAD_PARAMS`；JNI 按次采样（靠重建会话，原因见上文“文本生成的预设与采样”）；前端 `AiTaskMap` 文本任务 `options` 放开为 `AiGenerateOptions`。没有做 `maxNewTokens`（固定 256）。
7. ~~**真取消**~~：**已做（2026-10-16，对联、OCR 之后补上 Qwen 与翻译；桌面单测通过，真机待验）**。Qwen：`arkli_mnn_jni.cpp` 加全局原子标志 `g_cancel` 与 `nativeCancel()`；`nativeGenerate` 开头复位标志，把输出接到自定义 `streambuf`（`CancelAwareBuf`），MNN 每个 token 都会写流并 flush，那一刻若标志已置位就把引擎状态改成 `USER_CANCEL`，`ArGeneration::generate` 下一圈开头检查到就退出循环，随后 JNI 抛 `java.util.concurrent.CancellationException`。之前文档说“`LlmContext` 不在公开头文件里”不准确：它定义在公开的 `llm/llm.hpp`，`getContext()` 返回 const 指针，`const_cast` 后即可写 `status`；状态只在解码线程自己的写流回调里改，没有跨线程写。两个坑：`response()` 开头遇到 `USER_CANCEL` 会直接返回，所以取消后和每次调用前都要把状态复位成 `RUNNING`；`CancellationException` 本身是 `IllegalStateException` 的子类，`MnnQwenBackend.guard` 要先放行再捕获后者，否则会被误报成 INTERNAL。翻译：`Engine` 持有 `CancelToken`，贪心与束搜索每个解码步前、每个句子片段前检查，`ErrorKind::Cancelled` 经 `TranslateFfiError::Cancelled` 映射成 Kotlin 的 `CancellationException`；FFI 每次 `translate_run` 换新令牌（取消不残留），`translate_cancel()` 置位。Kotlin 侧 `QwenBackend.cancel()` / `TranslateBackend.cancel()` 加 `runCancellable` 接线，取消不算引擎故障，会话保留。入口 `AiInvoker.dispatch` 的 `withContext(Dispatchers.IO)` 不用改：外层协程取消会传给服务里的 watcher。**遗留**：`libarkli-mnn.so` 改过，需要用 `native/mnn/build.sh` 重编、上传 release 并同步 `app/build.gradle.kts` 的 sha256 与 `docs/research/qwen35-mnn-model.md`；Qwen 取消在真机上的效果（取消到停止的延迟、之后能否正常再生成）待验。
8. **参数调整**：步 1~3 已做（2026-10-19，原生框架 + 已有通道参数 + AI 中心面板，**未提交、真机未验**）。步 4~6 已做（2026-10-19，真机未验；步 5 新 so 待上传 release）。步 7 已做；步 8 已做（抠图 `RefineStrength` 放抠图页四档分段控件，不进 AI 中心，真机待验）。见 [调研](../research/model-tunable-params.md) §6 与 [状态](../status.md)。
