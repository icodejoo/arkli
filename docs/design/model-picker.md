# 模型选择器

状态：active（2026-10-15 第 2 步改为由 AI 目录生成；Web 端单测已过，真机未验证）

AI 工具页底部操作栏最左边的「cpu-ai 图标 + Ai」按钮，点开底部弹层选模型。依据 [0005 AI 四层约束](../decisions/0005-ai-four-layers.md)，可选项由 [统一 AI 协议](ai-protocol.md) 的 AI 目录算出。

## 范围

- 只做选择器与状态展示，不改各工具的推理引擎；当前选择通过 `useAiCatalog(toolId)` 暴露，工具按需读取。
- 不新增原生方法：可选项来自 `native.ai.providers`（含第 2 步追加的 `layer` / `offers`），下载复用 `native.model.ensure`（经 `stores/models.ts`）。

## 职责边界

- AI 中心：模型的下载、取消、删除、校验与进度的唯一管理处。
- 模型选择器：只负责选中，以及对未下载项触发下载（`store.download`）。
- 业务工具页：只读 `useAiCatalog(toolId).current`（状态来自模型 store）、只使用和展示；未就绪时给一句提示，不写任何下载/删除/校验逻辑。

## 参数调整只在 AI 中心

模型的推理参数（温度、回答长度、束宽等，见 [统一 AI 协议](ai-protocol.md)「参数调整」）只在 AI 中心详情弹窗 `ModelSourcesSheet` 底部的“参数调整区”出现：已安装、且提供者 `modelId` 匹配、`native.ai.providers` 带了 `params` 才显示。**业务工具页与模型选择器都不得读写参数**，不得引用 `native.ai.params.*`、`aiParamsGet/Set/Reset`、`stores/aiParams`；`web/src/shared/aiParamsScan.test.ts` 会扫描 `web/src/tools/` 拦截。工具要自带参数就自己显式传，显式传的值优先于用户设置。

## AI 中心里的下载地址

AI 中心即 `/ai`（`AiView.vue`）。其「本地模型」区每个模型除「点击下载」外有「下载地址」入口，点开 `ModelSourcesSheet` 面板：文件名、大小、sha256、全部镜像地址（可点开、可复制）、release 页面链接、手动放置说明（放到 `files/<dir>/`，再点「校验」）。数据来自 `native.model.sources`（一次性读取，不轮询），状态仍只读 `stores/models.ts`。选择器与业务工具页不出现这些入口。详见 [模型下载管理](model-download.md)。

## 状态源

- 下载状态：`web/src/stores/models.ts` 的 `useModelsStore` 是唯一来源（启动调一次 `init()`，之后靠 `model.changed` 推送，**不轮询**）。
- 有哪些选项、各属哪层、带什么约束：`native.ai.providers`，全应用共用一次探测（`useSharedAiProviders`，`ensure()` 去重；打开选择器时 `refresh()`）。
- 二者在纯函数 `buildCatalog`（`web/src/shared/aiCatalog.ts`）里合并，组合式函数是 `web/src/native/useAiCatalog.ts`。
- `native.ai.status`（恒为 false 的桩）不参与，新代码不得依赖它（清理在第 5 步）。

## 交互

- 挂载点：各工具页自己的底部操作栏最左边（`<bottom-actions ai>` 的 `#ai` 插槽放 `<model-picker :tool-id="TOOL_ID" variant="bar" />`；用原生 `van-action-bar` 的页面直接放在最左）。`ToolView` 标题栏不再自动渲染选择器，新增带 `ai` 标签的工具要自己在操作栏里放。
- 触发器一律用组件默认的 AI 图标按钮，调用方不传插槽（除非明确指定要自定义）。点开 `van-action-sheet` 底部面板，标题「选择模型」，底部的取消位改名「查看Ai中心」（带右箭头，文字与箭头为 danger 红），用 `cancel` 插槽接管点击（`.stop` 防冒泡）跳转 AI 中心，右上角关闭图标仍走默认 `@cancel` 只关面板。每行：标题「层名-模型名」+ 备注 + 状态图标。
- 组件只收 `tool-id`：`<model-picker :tool-id="TOOL_ID" />`，不再传 `models`。

## 四种状态

| 展示 | 条件 | 样式 | 点击 |
|---|---|---|---|
| 普通 | 已下载，未选中 | 默认色 | 选中并关闭弹层 |
| 着色 | 当前选中 | 主色 + 对勾 | 选中并关闭 |
| 禁用样式 | 未下载 | 置灰（class，非 Vant `disabled`，否则吞点击） | 下载该项的**清单模型 id**（提供者项不是拿提供者 id 去下），随即弹顶部提示 |
| loading | 正在下载 | 转圈 | 只弹同一提示，不重复下载 |

原生状态映射：`installed` -> 普通/着色；`downloading` -> loading；`absent`、`unverified`、`corrupt` -> 置灰（点击重新 `ensure`）；清单里查不到 -> 「未接入」。store 还没拿到某个模型时，提供者项暂用 `native.ai.providers` 自带的 `downloaded` / `downloading` / `sizeBytes`。

顶部提示：`van-notify`，文案「正在下载，可以去AI中心查看」，点击 `router.push('/ai')`。

## 适用性与层规则（AI 目录）

工具只声明“我需要哪些任务”，**不再逐个列模型和层**。目录按下面的规则自动算：

| 来源 | 出现条件 | 呈现 |
|---|---|---|
| 依赖本地模型的提供者（L1/L2） | 它的 `offers` 含工具需要的任务，且入口对得上 | 按下载状态；标题取工具过渡声明里同 `modelId` 的文案，没有就用提供者 `displayName`；备注按报价生成（翻译写「N 种语言互译」，其余写任务名） |
| 不依赖本地模型的提供者（L3 本机 AI） | 同上，且当前可用 | **不可用就隐藏**（0005）；可用为普通项，备注「… · 可用」 |
| 过渡 L1 清单模型 | 工具在 `models` 里声明、且原生还没有同 `modelId` 的提供者（超分、对象计数、人脸融合、上色等） | 按清单状态；清单里没有则「未接入」，点击 toast「还没接入」 |
| L4 远端占位（OpenAI） | 工具需要 `prompt` / `summarize` / `proofread` / `rewrite` / `translate` 之一，且没有真 L4 | 置灰「未接入」，不可选 |

按层 L1~L4 排序，同层保持原生注册顺序。**旧版给每个 AI 工具都补的 L2 Qwen 占位已删除**：垃圾分类、OCR 等页不再出现 Qwen。OCR 与图片转表格（M8 起）只有 `local-ocr` 一项（L1），没有过渡项、Qwen、交接与 L4 占位。

## 契约

```ts
ToolMeta.tasks?: ToolAiTask[]        // ToolAiTask = AiTask | { task: AiTask; entry: AiEntry }
ToolMeta.models?: ToolModelOption[]  // 过渡：{ modelId, title, desc }，L1 清单模型
```

- `tasks`：只写任务名表示任何入口都行；写对象可限定入口。翻译页调 `native.ai.translate`（要语言对），所以声明 `{ task: 'translate', entry: AI_METHODS.translate }`，交接类（经 `native.ai.run`）就不会混进来。
- `models`：过渡字段。原生已有提供者的（识物）按 `modelId` 并进提供者项、沿用这里的文案；原生还没有提供者的按清单状态单独出项（不伪造提供者），各工具接入原生提供者时并入、再删掉过渡声明（OCR 已于 M8 完成，改为只声明 `tasks`）。
- 约束（翻译的 `languages` / `sourceAuto`）只来自原生报价，`registry.ts` 不再写语言清单；`shared/languages.ts` 的 `supportedOf` / `allowsAuto` 吃的就是 `constraints`。
- 已移除 `ToolMeta.pickerInPage`：选择器统一放页面操作栏，不再有标题栏自动挂载这条路。

当前各工具的声明（`aiCatalog.test.ts` 有快照断言，改了要同步这里）：

| 工具 | tasks | 过渡 models |
|---|---|---|
| `waste-sort` | `classifyImage` | `siglip2-mnn-w8`（并入 `local-clip`；2026-10-15 起由 `siglip2-q4_half` 换成 MNN 版） |
| `translate` | `translate@native.ai.translate` | — |
| `ocr`、`table-extract` | `ocr@native.ai.ocr`（M8；图片转表格用同一个文字识别任务，并带 `ai` 标签以出现选择器） | — |
| `couplet` | `couplet@native.ai.couplet`、`prompt@native.ai.run` | 对联页：对下联用 local-couplet，大模型用 local-qwen；页面按提供者 id 读就绪状态，选择值不起作用；语料库（数据包）不在选择器里 |
| `speech-to-text` | —（走 `native.speech.*`，不走 `native.ai.*`，页面内不放选择器） | `asr-zipformer-zh-en-mnn-w8` |
| `ai-writer` | `prompt@native.ai.run`（起名、标题、润色、扩写、缩写；选择器放在页面里） | — |
| `image-upscale`、`object-count`、`face-fusion`、`colorize` | — | 各自的占位 id（清单里没有，显示「未接入」） |

没有工具声明 `summarize` / `prompt` 等文本任务（`summarize` 工具是纯前端抽取式摘要，不走 AI），所以 Qwen 目前只在翻译页出现；声明了文本任务的工具会自动出现 Qwen（L2）、可用的交接（L3）与 L4 占位，有单测覆盖。

## 选择值与持久化

`useAiCatalog(toolId)`（`web/src/native/useAiCatalog.ts`）返回 `{ items, ready, choice, current, set, refresh }`：

- `choice`：解析后的选择值。**存的是提供者 id**（如 `local-nllb`、`local-qwen`、`intent-handoff`）；过渡项存 `model:<清单 id>`（如 `model:image-upscale`）；L4 占位不可选。
- 失效回落（`resolveChoice`）：存值仍可选就用；旧清单 id 或 `model:` 前缀能按 `modelId` 对上提供者项也算；否则按“本地优先”取第一个 ready 的 L1 → 第一个 L1 → 第一个 ready 的 L2 → 第一个 L2；**不会自动回落到 L3/L4**（交接与远端会把内容交给第三方，0005 要求默认不启用）；都没有为 `null`。探测前 `choice` 就是存值，页面用 `ready` 判断，别在探测前提示“没有模型”。
- `current`：当前目录项，页面读 `providerId`（传给桥方法）、`status`（`'ready'` 才可用）、`constraints`。
- 持久化：localStorage 键 `arkli.modelChoice.<toolId>`（`CHOICE_KEY_PREFIX`），仅偏好，读写都 try/catch；同一工具共享同一个 ref，选择器改了工具页立即可见。底层是 `useModelChoice`（只管存取与迁移，不校验有效性）。

### 为什么推翻“L1/L2 存模型 id”

旧契约里 `modelId` 在 L1/L2 是清单模型 id、在 L3 是提供者 id，页面要自己维护“模型 id → 提供者 id”的映射，翻译页靠 `findTranslateProvider` 按 `modelId` 反查；同时 `PLACEHOLDERS` 给每个 AI 工具都补了 Qwen 且 `isSelectable` 认为它可选，于是垃圾分类、OCR 页能选中 Qwen 然后被静默忽略（和之前“翻译页选 Qwen 却走 NLLB”是同一类事故）。改为存提供者 id 后，选择值就是桥方法要的 `provider`，不再需要反查；而一个提供者用哪个模型由原生 `modelInfo` 说明，前端只读。

### 一次性迁移

`useModelChoice` 首次读到旧值时用 `migrateChoice` 换成新值并写回（迁移幂等）：

| 旧值 | 新值 |
|---|---|
| `siglip2-q4_half` | `local-clip` |
| `siglip2-mnn-w8` | `local-clip` |
| `nllb600m-un6-ccm-int4` | `local-nllb` |
| `nllb600m-un6-mnn-w6` | `local-nllb` |
| `qwen35-0.8b-mnn-q4` | `local-qwen` |
| `ocr`（早期的清单占位 id，没有对应真实模型）、`ppocrv5-mnn-fp16` | `local-ocr` |
| `l2-none`（早期 L2 占位） | 丢弃（不写回，回落默认） |
| 工具 `models` 里声明过的清单 id（`image-upscale` 等） | `model:<id>` |
| 其余（已是新值、L3 提供者 id、认不出的） | 原样，交给目录回落 |

表在 `LEGACY_CHOICE_MIGRATION`（`web/src/shared/aiCatalog.ts`），有单测。

## 文字识别页的接法（M8，第一个只读目录的新任务页）

`ocr` 与 `table-extract` 页：`useAiCatalog(TOOL_ID)`，`modelReady = current.status === 'ready'`，探测完（`catalog.ready`）仍没有就绪模型时显示共用的 `<model-missing-notice />`（文案 `MSG_NO_MODEL`「无可用模型，去查看」，点击去 AI 中心，只提示、不指定下载入口）；识别按钮在 `modelReady` 为假时禁用。**页面不再读 `native.ai.status` 桩，也不调任何 `native.model.*`**，下载、取消、删除、校验都在 AI 中心。模型选择器放在页面底部操作栏最左（`variant="bar"`），用默认插槽（组件自带的 cpu-ai 图标按钮）。识别撞上 `NOT_READY`（`AiNotReadyError`）时页面只重新探测目录（`catalog.refresh()`），不弹下载相关文案。

## 翻译页的拍照翻译（只改前端，真机未验证）

翻译页底部的「拍照翻译」卡片（`web/src/tools/translate/PhotoTranslate.vue`）：拍照走 `captureCamera`（相机里点相册转相册），相册走 `pickImages({ multiple: true, max: 9 })`（即 `native.file.pick` 自带选择页；无宿主才退回 input 兜底）。

- 流程（`photoRun.ts`）：多图串行，每张先 `aiOcr`，再逐个文字块翻译；块翻译复用 `routeShort`（短语表 / 短文本改走 Qwen）与 `aiTranslate`，相同原文只翻一次。单块失败只标该块，单张失败只标该张，不影响其它张；可取消，取消后剩余标「已取消」；撞上 `NOT_READY` 立即中止剩余并重新探测目录。
- 模型状态：只读 `useAiCatalog('translate')` 与 `useAiCatalog('ocr')` 的 `current.status`，任一未就绪就显示 `MSG_NO_MODEL` 提示条并禁用入口；页面不含 ensure/cancel/remove/verify 与下载进度。
- 展示：(a) 译文叠在图上，OCR 框是 OCR 基准图（`OcrResult.width/height`，原图过大时是降采样后的尺寸）的像素坐标，按「显示宽 / 基准宽」缩放，半透明深底白字，字号随框高与文字量自适应（`photoLogic.ts`）；多图用 `van-swipe` 横滑。(b)「查看文本」弹窗按图分组列出原文与译文，可复制单张、全部、仅译文。
- 纯逻辑与单测：`photoLogic.ts`（框换算、叠层样式、聚合文本、进度状态）、`photoRun.ts`（流程）、对应 `*.test.ts`。
- 限制：一次最多 9 张、每张最多 60 个文字块；叠层只用外接矩形，倾斜文字不旋转；竖排或密集小字的字号可能偏小；翻译按文字块独立进行，没有上下文。

## 多类模型同屏选（sections）

一个页面同时要选多类模型时（翻译页进入图片模式：翻译模型 + 文字识别模型），给 `<model-picker>` 传 `sections` 代替 `tool-id`：

```vue
<model-picker :sections="[{ toolId: 'translate', title: '翻译模型' }, { toolId: 'ocr', title: '文字识别模型' }]" />
```

- 每组是一个 `ModelPickerSection`：各用自己工具的目录与记忆的选择（`ocr` 的选择与文字识别页共用）。
- 多组时选中不关弹层，方便连选；弹出下载提示仍会关。触发器简称取第一组。
- 翻译页只在图片模式才加 OCR 组。底部动作栏见 `shared/BottomActions.vue`：布尔 props `ai` / `album` / `photo` / `main` 控制四项有无（`mainText` / `mainType` / `mainColor` / `iconColor` / `disabled` 调样式与禁用），`#ai` 放模型选择器（用 `variant="bar"`，不传自定义触发器），`ai` / `album` / `photo` / `main` 同名插槽（带作用域）可整项替换，默认插槽放额外项，翻译、垃圾分类与其余工具页共用。
