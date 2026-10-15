# 模型选择器

状态：active（2026-10-15，Web 端已做，真机未验证）

AI 工具标题栏右上角的小按钮，点开底部弹层选模型。依据 [0005 AI 四层约束](../decisions/0005-ai-four-layers.md)。

## 范围

- 只做选择器与状态展示，不改各工具的推理引擎；选中值通过 `useModelChoice` 暴露，工具按需读取。
- 不新增原生方法，下载复用 `native.model.ensure`（`web/src/native/model.ts`）。

## 职责边界

- AI 中心：模型的下载、取消、删除、校验与进度的唯一管理处。
- 模型选择器：只负责选中，以及对未下载项触发下载（`native.model.ensure`）。
- 业务工具页：只读模型状态、只使用和展示；未就绪时给一句提示（去选择器或 AI 中心），不写任何下载/删除/校验逻辑。`waste-classify` 已按此收敛。

## 状态源

`web/src/stores/models.ts` 的 `useModelsStore` 是模型状态的唯一来源：每个模型是一个 `AiModel` 对象（id、名称、用途、状态、进度、字节数、错误…），浅响应式，原生推送 `model.changed` 时整体替换。应用启动调一次 `init()`（取一次 `native.model.list` 快照并订阅事件），之后选择器、工具页、AI 中心都只读 store，**不轮询**。接入方只依赖 `AiModel` 类型。

## 交互

- 挂载点：`ToolView` 标题栏右侧，工具带 `ai` 标签（`TAG_AI`）且声明了 `models` 时自动出现，工具页不用自己写。
- 触发器一律用组件默认的 AI 图标按钮，调用方不传插槽（除非明确指定要自定义）。点开 `van-action-sheet` 底部面板，标题「选择模型」，底部的取消位改名「查看Ai中心」（带右箭头，文字与箭头为 danger 红），用 `cancel` 插槽接管点击（`.stop` 防冒泡）跳转 AI 中心，右上角关闭图标仍走默认 `@cancel` 只关面板。每行：标题「层名-模型名」+ 备注 + 状态图标。
- 状态来自 store 的推送，不自己刷新。

## 四种状态

| 展示 | 条件 | 样式 | 点击 |
|---|---|---|---|
| 普通 | 已下载，未选中 | 默认色 | 选中并关闭弹层 |
| 着色 | 当前选中 | 主色 + 对勾 | 选中并关闭 |
| 禁用样式 | 未下载 | 置灰（class，非 Vant `disabled`，否则吞点击） | 开始下载，随即弹顶部提示 |
| loading | 正在下载 | 转圈 | 只弹同一提示，不重复下载 |

原生状态映射：`installed` -> 普通/着色；`downloading` -> loading；`absent`、`unverified`、`corrupt` -> 置灰（点击重新 `ensure`：unverified 触发校验，corrupt 重新下载）；清单里查不到该模型 -> 「未接入」。

顶部提示：`van-notify`，文案「正在下载，可以去AI中心查看」，点击 `router.push('/ai')`。

## 层规则

| 层 | 来源 | 呈现 |
|---|---|---|
| L1 本地小模型 | 工具在 `registry.ts` 声明；状态来自 `native.model.list` | 按上表；清单没有该 id 则置灰「未接入」，点击 toast「还没接入」 |
| L2 本地大模型 | 选择器统一补占位 | 置灰，「未接入」，点击 toast「还没接入」 |
| L3 本机 AI | 工具声明 + `useAiProviders` 运行时探测 | 提供者不可用则**不显示**；可用则为普通项 |
| L4 远端 API | 统一补占位（OpenAI） | 置灰，「未接入」，点击 toast「还没接入」 |

文案：标题「层名-模型名」，如「本地小模型-识物 SigLIP2」；备注「作用 · 状态」，如「识别垃圾品类 · 已安装 54.7MB」「… · 未下载，点击下载」「… · 正在下载 37%」。纯函数在 `web/src/shared/modelPicker.ts`。

## 契约

`ToolMeta.models?: ToolModelOption[]`，`ToolModelOption = { layer, modelId, title, desc }`。可选字段 `ToolMeta.pickerInPage`：为 true 的工具把选择器放在页面里（如翻译页中间一行），`ToolView` 标题栏就不再重复显示（摄像头工具同理）。L1 的 `modelId` 必须是 `assets/ai/models.json` 的清单 id；L3 的 `modelId` 是 AI 提供者 id。

`useModelChoice(toolId)`（`web/src/native/useModelChoice.ts`）返回 `{ choice, set }`：

- `choice`：当前选中的选项 id（只读 ref）；工具没声明模型为 `null`。
- 默认值：该工具声明的第一个 L1；存的值不再是可选项（L2/L4 占位不可选）时回落默认。
- 持久化：localStorage 键 `arkli.modelChoice.<toolId>`，仅偏好，读写都 try/catch。
- 同一工具共享同一个 ref，选择器改了工具页立即可见。

## 各 AI 工具现状

`waste-classify` 对应清单里的 `siglip2-q4_half`；`translate` 对应 `nllb600m-un6-ccm-int4`（NLLB-200 600M 裁剪 int4，中英法西俄阿互译，CC-BY-NC-4.0，页内选择器，已不再提供「转交翻译应用」这一项）。`ocr`、`image-upscale`、`object-count`、`face-fusion`、`colorize` 的模型尚未进清单，L1 项以占位 id 声明，选择器显示「未接入」。没有工具声明 L3：当前唯一的本机 AI 提供者 `intent-handoff` 只支持文本任务，这些工具都是图片类。
