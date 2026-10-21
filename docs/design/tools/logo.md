---
title: logo 设计工具
status: draft
updated: 2026-10-21
summary: logo 工具：模板排版（Lucide 图标子集，本地 Qwen 只挑参数、没模型走关键词规则）+ 本地 SDXS 生成 AI 符号（行业词表 4 个物体词、逐张生成可取消、质量闸门排序与模板补位）；含参数结构、体积、许可、限制与待真机验证项
---
## TL;DR
- 形态：输入品牌名（必填）、标语、一句话描述 → 点「生成方案」出 6 个方案 → 点一个进入微调（版式、配色、图标、字体、字号、字距、反色）→ 存 PNG / 分享。
- 模板部分不加任何新模型：logo 由 `web/src/tools/logo/` 里的渲染代码按「模板 + 图标 + 字体 + 配色」画出来；本地 Qwen3.5-0.8B 只负责把需求挑成参数，页面文案叫「智能排版」。
- **AI 图形（C 批，2026-10-21）**：装了本地 SDXS（`local-logo-sdxs`）时，点「生成」会按 4 个物体词依次生成 AI 符号（一张出一张，可取消），放进 App 自己画的容器；页面标明「本地 AI 生成、仅供参考、注意商标风险」。没装模型页面照旧是纯模板模式，只多一条未就绪提示。详见下面「AI 图形（SDXS）」一节。
- 素材：Lucide 图标子集 180 个（gzip -9 约 17.0KB），10 个模板，14 套配色，6 种字体（全部是系统字体栈）。
- 兜底：模型没下载 / 未就绪 / 两次输出都不合格 → 关键词规则，恒出 6 个方案；取消即停。
- 整个工具源码（含图标数据）gzip -9：`iconData.ts` 17413B、`scene.ts` 6017B、`plan.ts` 6191B、`render.ts` 3007B，另有 `palettes.ts`、`fonts.ts`、`logic.ts`、`index.vue`，合计约 40KB 级，按需 chunk 加载。

## 目录
`web/src/tools/logo/`

| 文件 | 作用 |
| --- | --- |
| `types.ts` | 参数 `LogoParams`、场景 `Scene` 与图元类型 |
| `assets/iconData.ts` | 图标数据（名称 → 分组 + 中文关键词 + path），脚本抽取，勿手改 |
| `assets/LICENSE-lucide.txt` | Lucide 的 LICENSE 原文（ISC，含其中 Feather 部分的 MIT 声明） |
| `palettes.ts` / `fonts.ts` | 配色表、字体栈、文字宽度估算 |
| `scene.ts` | `TEMPLATES` 与 `buildScene`：参数 → 场景（布局，纯函数） |
| `render.ts` | 场景 → SVG 字符串（预览）/ Canvas 2D（导出 PNG） |
| `plan.ts` | AI 参数生成：提示词、解析、校验、重试、关键词兜底；另导出 `matchIndustryGroups`（只读，给概念词表兜底用） |
| `concepts.ts` | AI 符号的概念映射：行业词表（`INDUSTRIES`）、匹配、Qwen 推荐与校验、通用词、提示词模板 |
| `symbol.ts` | AI 符号纯逻辑：解析原生 SVG path、闸门排序与补位、逐张生成（取消、并发拒绝重试）、候选 → 参数 |
| `symbolScene.ts` | AI 符号版式 `SYMBOL_LAYOUTS` 与 `buildSymbolScene`（圆环 / 实心圆 / 圆角方块 / 横排） |
| `logic.ts` | 页面纯逻辑：默认参数、图标搜索、夹紧、文件名 |
| `index.vue` | 页面 |

## 参数结构（`LogoParams`）
| 字段 | 说明 |
| --- | --- |
| `template` | 模板 id（见下表） |
| `palette` | 配色 id；`primaryOverride`（可选 `#rrggbb`）覆盖主色 |
| `icon` | 图标名（`ICON_DATA` 的 key），空串为不要图标 |
| `name` / `slogan` | 品牌名、标语（可空） |
| `font` | 字体 id |
| `fontScale` | 品牌名字号倍率，0.6~1.4 |
| `spacing` | 字距，单位 em，-0.05~0.3 |
| `invert` | 反色：背景与主色对调，文字取可读的一边 |
| `symbol` | 可选，AI 符号 `{ layout, vb: 512, paths: [{ d, tx, ty }] }`；有值时按 `symbol.layout` 走 `buildSymbolScene`，`template` 与 `icon` 不起作用 |

渲染分两步：`buildScene(params)` 先算出场景（画布尺寸 + 按顺序的矩形/圆/路径/图标/文字图元，坐标已定），再由 SVG 与 Canvas 两个后端各画一遍。预览与导出共用同一份场景，所以排版一致。

## 模板（10 个）
| id | 名称 | 画布 |
| --- | --- | --- |
| `badge-circle` | 圆形徽章 | 600x600 |
| `square-round` | 方形圆角 | 600x600 |
| `shield` | 盾形徽章（主色实心盾，反白图文） | 600x600 |
| `h-lockup` | 水平横排（左图标右文字） | 900x420 |
| `stack` | 上图下字 | 600x600 |
| `monogram` | 首字印记（首字大号方块 + 名字） | 600x600 |
| `pill` | 圆角胶囊 | 900x420 |
| `wordmark` | 纯文字字标（忽略图标，下加短横线） | 900x420 |
| `tagline-stack` | 带标语双行（上下细线） | 900x420 |
| `ring-seal` | 双圈印章 | 600x600 |

自动缩字号：品牌名按 `estimateTextWidth` 估算宽度，超出可用宽度就等比缩小，最低到基准的 0.3 倍；标语同理。无图标时整体重新垂直居中，标语为空不留空位。

## 配色（14 套）
浅色底 5：`tech-blue`、`minimal-light`、`fresh-mint`、`coral-sand`、`rose-crimson`；深色底 5：`obsidian-gold`、`cyber-neon`、`deep-purple`、`navy-slate`、`emerald-gold`；中间色 4：`warm-coffee`、`nordic-gray`、`forest-green`、`sunset-orange`。每套都有风格标签（warm / cool / dark / light / vivid / calm / natural / elegant），单测里实算过：文字与底色对比度 ≥ 4.5，主色与底色 ≥ 3。

## 字体
只用系统字体栈，不打包字体文件：`sans-bold`、`sans`（黑体类）、`serif`、`serif-bold`（宋体类）、`mono`（等宽）、`rounded`（Android 没有真圆体，回退无衬线，名字叫「柔和圆体」只是粗体无衬线）。回退顺序写在 `fonts.ts` 顶部：中文优先 Noto Sans/Serif CJK SC（Android 自带），其次 Source Han、PingFang、微软雅黑，最后 `sans-serif` / `serif` / `monospace`。

## 图标：来源、许可、体积
- 来源：[lucide-icons/lucide](https://github.com/lucide-icons/lucide)，`git clone --depth 1` 到仓库外的临时目录，用脚本抽取子集，不走 npm、运行时不联网。
- 许可：ISC（Lucide 自己的部分；其中派生自 Feather 的图标另附 MIT 声明）。LICENSE 全文照放在 `web/src/tools/logo/assets/LICENSE-lucide.txt`。
- 数量：180 个，分 15 组：food、tech、edu、health、retail、travel、nature、pet、finance、sport、art、beauty、home、auto、general；每个带 3~5 个中文关键词。
- 处理：把 `circle/rect/line/polyline/polygon/ellipse` 全部转成 `path`，一个图标合成一条 `d`（24x24 视窗、描边风格），这样 SVG 和 Canvas（`Path2D`）都能直接画。拼接时把每段开头的相对 `m` 改成绝对 `M`，避免串在一起后坐标跑偏。
- 体积：`iconData.ts` 45086B，gzip -9 为 17413B。

## AI 参数生成与兜底（`plan.ts`）
调用方式照 couplet 的大模型模式：`aiInvoke('prompt', …, { provider: 'local-qwen', entry: AI_METHODS.run, signal })`，页面只读 `useAiCatalog` 的就绪状态，不做任何下载、校验之类的管理。

1. 提示词（约 1400 字）：给出模板 id、配色 id+标签、行业分组、字体 id 的枚举，要求只输出 JSON：`{"plans":[{"template","palette","group","keyword","font"}…]}`，6 个。
2. 解析：`parsePlansJson` 容忍代码围栏与前后废话。
3. 严格校验：模板 / 配色 / 分组 / 字体必须是合法枚举，数量 1~6，去重；不合法给出中文原因，带着原因重试一次（共 2 次）。图标由代码按 `group + keyword` 在图标库里解析，模型不直接编图标名。
4. 兜底：两次都不合格 → `planByKeywords`；模型没下载 / 未就绪（`AiNotReadyError`）→ 直接规则；用户取消 → 立刻停，不兜底（`isAiCancelled`）。AI 给的方案不足 6 个时用规则补齐。
5. 关键词规则：行业词表（约 50 个词 → 分组）+ 图标自带关键词 + 风格词表（→ 配色标签），模板与字体轮转；用输入文本的哈希做起点，同样输入结果稳定，恒出 6 个互不相同的方案。

页面里模型就绪与否都能用；没就绪时只显示「无可用模型」提示条，并说明已用关键词规则。装了 SDXS 时多出 AI 图形区，见下一节。

## AI 图形（SDXS，C 批）
流程（`index.vue`，纯逻辑在 `concepts.ts` / `symbol.ts` / `symbolScene.ts`）：
1. **概念词**：品牌名 + 标语 + 描述 → `matchIndustry`（`INDUSTRIES` 63 个行业，每个中文关键词若干 + 4 个英文可剪影物体；最长关键词优先，英文关键词按单词边界且长度 >= 4）→ 没中就退到 plan.ts 行业词表命中的图标分组（取该分组的第一个行业，不另造一份并行词表）→ 仍没中且本地 Qwen 就绪：让 Qwen 只出 4 个英文名词（接受 `{"objects":[…]}` 或裸数组；每个去冠词后 1~3 个字母词、去重、凑够 4 个；最多 2 次，第 2 次带上次的问题；温度 0.3）→ 失败或 Qwen 未就绪：通用词 `a feather / a lantern / a crown / a telescope`（单测锁定）。其中 30 个行业沿用桌面 spike v3 调过的词，其余按「单一、具体、可剪影、不抽象」补写。页面显示这 4 个词和来源说明，用户可直接改（改过就不再自动推荐，可点「恢复自动推荐」）。
2. **生成**：提示词用 spike 最佳模板 P7 `flat pictogram glyph of <概念>, solid black emoji silhouette, bold simple shape, minimalist icon, white background`，经 `aiInvoke('logoSymbol', …, { provider: 'local-logo-sdxs', entry: AI_METHODS.logoSymbol, signal })`，`runSymbolBatch` 依次 4 张，一张出一张，进度「第 2/4 张」，种子每张随机（候选里记着，暂无“再来一张”按钮）。取消：不再发起后续张，已出的保留；原生一步前向不能中途打断，页面点取消后立刻提示「正在取消，等当前这张收尾…」，原生真正停下来最长约一次 UNet。取消后马上重来：原生会回「正在生成，请稍候」，批量逻辑等 1.5 s 重试（最多 12 次）并提示「上一次的生成还在收尾」。
3. **内存让位**：原生加载 SDXS 时会卸掉其它会话；反方向（SDXS 常驻时再用 Qwen）原生不管，所以页面在调 Qwen 推荐概念前先 `aiUnload('local-logo-sdxs')`，离开页面也卸载。有 SDXS 时模板方案用关键词规则（不再调 Qwen 排版），避免 Qwen 与 SDXS 来回换入内存。
4. **渲染**：原生返回 512x512 坐标系的单色 `<path/>` 片段，每条自带 `transform="translate(x,y)"`；`parseSymbolPaths` 取 `d` 与平移（`d` 只放行路径命令与数字，其余整条丢弃，因为预览用 `v-html`）。场景里新增 `symbol` 图元（`paths + vb + x/y/size + color`）：SVG 后端输出「平移缩放组 + 每条 path 带自己的 translate」，Canvas 后端 `translate/scale` 后逐条 `translate` + `Path2D` 填充。版式 4 种（`ai-ring` 圆环徽章 / `ai-solid` 实心圆（符号反白）/ `ai-square` 圆角方块 / `ai-lockup` 横排左图右字），符号占容器内圈直径（方块为边长）的 58%，配色字体取关键词方案，版式按序号轮流；编辑区可换版式、配色、字体，或「改用模板图标」。导出 PNG / 分享沿用原来的 Canvas 路径。
5. **质量闸门的使用**：原生每张带 `gateOk` 与原因码。生成过程中按到达顺序显示；**跑完后过闸的排前面**（稳定排序）。**未过闸的仍显示**，卡片下标「效果可能欠佳（图形太碎）」这类中文原因（折叠会让用户觉得“只出了 2 张”，所以不折叠）。**一张过闸的都没有（含取消、出错没出图）时自动补上模板方案**并提示；否则模板方案折叠，点「查看模板图标方案」才展开。闸门只是排序与过滤，不是可靠分类器（桌面精确率约 59%、召回约 62%）。
6. **模型未就绪**：不显示 AI 图形区，页面行为同改版前（Qwen 就绪走 Qwen 排版，否则关键词规则），顶部显示共用的 `<model-missing-notice />`，只提示不指定入口。`ToolMeta.tasks` 声明 `prompt@native.ai.run` 与 `logoSymbol@native.ai.logoSymbol`（见 [模型选择器](../model-picker.md) 的表格，`aiCatalog.test.ts` 有快照），底部操作栏最左是 `<model-picker variant="bar">`。
7. **文案与免责**：AI 图形区标题「本地 AI 生成，仅供参考」，并有提示条「用于商业前请自行检索商标，避免与已有标识雷同」（`page.test.ts` 守卫）。

**限制**：
- 符号是 SDXS 一步出图后二值化再矢量化的单色剪影，边缘偏“团块感”，抽象服务业（律师、会计、编程）仍弱，桌面实验里 4 张里至少 1 张可用的行业约 20/30，过闸后约 16/30。
- 0.8B Qwen 推荐概念词质量一般（会给出 `a sky`、`a space` 这类偏抽象的词），只是词表认不出行业时的备用；它也常不守 JSON 格式，所以解析放宽了。
- 取消延迟最长约一次 UNet；锁屏、后台时 CPU 被降频，耗时可到前台热态的 2~3 倍。
- 同一时刻只能有一个生成；没有“单张重画 / 再来一张”（种子已记录在候选里，留作后续）。
- 许可：SDXS / DreamShaper 为 CreativeML OpenRAIL-M / OpenRAIL++-M（含使用限制），随包带许可文本，见 [AI 协议](../ai-protocol.md)。

## 已知限制
- 字体依赖系统：不同手机字形会不一样，导出的 PNG 是这台手机当时的样子，不能保证跨设备一致；没有中文圆体、没有手写体、粗细档有限。
- 文字没有转曲：不导出 SVG，只导出 PNG（导出走 Canvas 2D 直接画，不把 SVG 当图片再画，避开 WebView 里系统字体在 SVG 图片中不可靠的问题）。
- 模板感：10 个固定版式，属于「排版出来的 logo」，不是原创设计；图标是通用线条图标，不同品牌可能撞图标。
- 宽度靠估算：自动缩字号用的是估算宽度（CJK 1em、拉丁约 0.58em），个别字体下可能略宽或略窄。
- 0.8B 小模型常常不守格式，所以兜底会比较常用；模型选的方案质量也只是「大致沾边」。
- 图标搜索关键词是人工写的，冷门行业可能搜不到，可手选。

## 待真机验证
- Canvas `letterSpacing` 在目标 WebView 上是否生效（不支持时字距在导出图里会丢，预览 SVG 不受影响）。
- 系统 Noto CJK 的粗体 / 宋体回退在各品牌手机上的实际字形，导出 PNG 与预览是否一致。
- Qwen 在真机上的 JSON 输出合格率与耗时、取消延迟（只有预填充阶段无法打断，同 couplet）。
- 保存到相册 / 分享面板的 PNG 是否正常；导出 1600px 长边在低端机上的内存与耗时。
- 方案网格与编辑区在小屏上的排版，图标网格（6 列）点击区是否够大。
