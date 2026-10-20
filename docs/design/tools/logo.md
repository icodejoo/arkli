---
title: logo 设计工具
status: draft
updated: 2026-10-20
summary: 模板排版式 logo 工具：自研渲染 + Lucide 图标子集，本地 Qwen 只挑参数，没模型走关键词规则；含参数结构、体积、许可、限制与待真机验证项
---
## TL;DR
- 形态：输入品牌名（必填）、标语、一句话描述 → 点「生成方案」出 6 个方案 → 点一个进入微调（版式、配色、图标、字体、字号、字距、反色）→ 存 PNG / 分享。
- 不加任何新模型。logo 由 `web/src/tools/logo/` 里的渲染代码按「模板 + 图标 + 字体 + 配色」画出来；本地 Qwen3.5-0.8B 只负责把需求挑成参数。页面文案叫「智能排版」，不叫 AI 画图。
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
| `plan.ts` | AI 参数生成：提示词、解析、校验、重试、关键词兜底 |
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

页面里模型就绪与否都能用；没就绪时只显示「无可用模型」提示条，并说明已用关键词规则。

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
