# 端侧联网调研（Qwen3.5-0.8B）

状态：draft（2026-10-17；原型逻辑与 20 个 Web 单测已过，**真机一次都没跑过**，见第 6 节）

让本地 Qwen3.5-0.8B 能联网查资料、拆解问题、带出处作答。代码：`web/src/shared/agent/research.ts`。

## 1. 结论

**别做自由发挥的 ReAct 智能体，做「代码掌控流程、模型只在两个节点出场」的固定流水线。** 0.8B 的 4bit 小模型照格式输出工具调用的稳定性差，一步错就整条链崩；而且这台机器上每多一轮就多一次完整预填，慢得受不了（第 2 节）。

```
问题 ──▶ ①拆问题（模型，贪心，只输出关键词，每行一个）
          └ 解析失败 → 退回原问题当唯一关键词（代码兜底）
      ──▶ ②并行搜索（代码，每个关键词一次维基 API）
          └ 单个失败当没结果；全空 → 直接回「没搜到」，不再调模型
      ──▶ ③挑资料（代码：按关键词重合度选句、按预算截断、编号）
      ──▶ ④回答（模型，贪心，只许依据资料并标 [n]）
```

「任务拆解」只放在第 ① 步，而且被约束成最简单的格式（逐行关键词），代码清洗序号与符号。下一步想让模型做更复杂的规划，得先在真机上测它的遵从度，再决定放不放权。

## 2. 为什么是这个形状（约束来自现有栈）

| 事实 | 出处 | 对设计的影响 |
|---|---|---|
| 解码约 17 tok/s，预填约 35 tok/s（STG-AL00，4 线程） | [Qwen 模型文档](../research/qwen35-mnn-model.md) 第 3 节 | 资料每多 1000 token 首字就慢约 28 秒；资料总量封顶 1200 字（约 850 token，预填约 25 秒） |
| `generate(system, prompt, maxNewTokens, sampling)` 单轮无状态，没有跨调用的 KV 复用 | `QwenService`、[统一 AI 协议](ai-protocol.md) | 多轮循环每轮都要重新预填全部历史，所以轮数越少越好：固定 2 次模型调用 |
| 单次最多生成 256 token | `AiQwenPolicy.MAX_NEW_TOKENS` | 回答要短；拆问题只要几行关键词，足够 |
| `prompt` 预设允许自定义 `system`（≤2000 字）与温度 | `AiGenerate.kt` | 协议约束写进 system，不动原生 |
| 可真取消（下一个 token 处停），预填不可打断 | ai-protocol 第 7 条 | 流程各步传同一个 `AbortSignal`，取消即抛 |
| 联网只有 `native.net.http`：GET/HEAD、≤2MB、10 秒超时、带 SSRF 防护，无 Cookie | [Bridge 协议](bridge-protocol.md) | 搜索与抓取都走它；页面端不用 `fetch` |
| 没有搜索 API 密钥，且规矩是不把密钥写进代码 | 全局约定 | 默认搜索源选免 Key 的 |

## 3. 搜索源

搜索不限站点：模型自己决定搜什么关键词（第 ① 步），搜索源是任意话题的通用网页搜索，不是只查百科。

先在这台电脑上用 curl 逐个试过（带手机 UA），结论如下：

| 源 | 结果 | 结论 |
|---|---|---|
| **Brave 网页搜索**（`search.brave.com/search?q=…`，HTML 页，免 Key） | 200，结果与查询相关（中英文都试了），页面里每条自然结果带 `data-type="web"`，标题在 `search-snippet-title`，摘要在 `generic-snippet` | **主源**。类名里的哈希会变，解析只认这几个语义属性；真实页面精简后放在 `fixtures/brave-search.html` 做回归 |
| 维基百科 API | 200，JSON，免解析 | **兜底**：Brave 报错或解析为空时用；只覆盖百科类 |
| Bing（`www.bing.com`） | 200，但**结果与查询无关**（搜 quantum computing 给出 vesicle），对脚本请求疑似降级 | 不能用 |
| DuckDuckGo lite / html | 三种地址都连不上（超时） | 这台电脑上不可用，手机上没试 |
| Google | 200，要求开 JS（`enablejs`） | 不能用 |
| 公共 SearXNG（searx.be） | 返回「验证浏览器」页 | 不能用 |
| 百度 | 200，页面 2.7MB | 没做解析（体积大，且是国内站，用户在菲律宾） |
| `cn.bing.com` | 连不上 | 不能用 |

局限：Brave 的 HTML 页是**抓取而非官方接口**，页面改版会让解析拿到空（此时自动退维基）；高频请求可能被限流或要验证。要稳就改用 Brave 官方 Search API（要用户填 Key，存储与隐私另议），搜索源只是 `ResearchDeps.search` 一个函数，换源只改这一处。

## 4. 原型清单

`web/src/shared/agent/research.ts`，依赖全部可注入：

- `runResearch(question, deps, onEvent?, signal?, budget?)`：整条流水线，事件 `plan` / `search` / `answer` 供页面显示进度。
- `parseSubQueries`：清理序号、符号、引号，去重，限长度与个数，空则退回原问题。
- `selectPassage`：按关键词重合度选句（中文按字、英文按词），保持原顺序、不超字数。
- `mergeHits`：按网址去重，各子问题轮流各取一条，保证每个子问题都有代表。
- `buildAnswerPrompt`：编号资料 + 问题，每条按预算均分。
- `search.ts`：`webSearch`（Brave → 维基兜底）、`braveSearch`、`parseBraveResults`、`wikiSearch`、`htmlToText`。
- `createNativeDeps`：默认依赖（`local-qwen` 的 `prompt` 预设、温度 0 + `webSearch`）。

单测共 20 个：`research.test.ts` 覆盖解析清洗、选句、去重合并、全流程、无结果不调模型、单搜索失败、取消；`search.test.ts` 覆盖实体解码、用真实页面夹具解析 Brave、维基 URL 与排序、Brave 失败或空时退维基、取消不兜底。

**还没有页面。** 要接成工具页，要遵守项目约定：模型状态只读 `stores/models.ts`；未就绪只提示先下载；操作栏里用默认的 `<model-picker variant="bar">`；取消走 `AbortSignal`。

## 5. 如果以后要做更「智能」的版本

按风险递增，每一步都要先在真机测过再往下：

1. **加一次「资料够不够」判断**（模型回 是/否）：不够就换关键词再搜一轮。多一次预填，成本约 +10 秒。
2. **抓取网页正文**：`native.net.http` 取 HTML（≤2MB），在页面里用 `DOMParser` 抽正文，再走 `selectPassage`。不需要新依赖；要先解决「搜索源只有维基」的问题，否则没有网址可抓。
3. **自由 ReAct 循环**：只有在 0.8B 的格式遵从度实测够好、且原生支持 KV 复用（现在没有）时才值得。引入新依赖或改 JNI 之前要先问。
4. **换大一点的模型**（例如 2B/4B）：规划、工具调用会稳很多，代价是体积、内存、速度；与 [0005 四层约束](../decisions/0005-ai-four-layers.md) 的本地大模型层一并评估。

## 6. 没验证的点（接手先做）

手机断开、模型库 `E:/workspaces/arkli-models` 不在本机，所以下面这些（搜索源的可达性除外）**全是推断，没有数据**：

1. **0.8B 能不能照「逐行关键词」格式输出**：解析有兜底，但若经常输出整句解释，第 ① 步就等于白做，要看成功率。
2. **回答是否真的依据资料、真的标 [n]**：小模型常常忽略 system 里的约束。
3. **真机总耗时**：预估拆问题几秒 + 搜索 1~2 秒 + 预填约 25 秒 + 解码最多 15 秒，约 45 秒，**没实测**；要不要把资料预算再砍，看实测。
4. **`local-qwen` 的 `prompt` 预设对长 system 与较长 prompt 的表现**，以及从贪心换到别的采样会不会触发会话重建（多一次约 3.4 秒加载，见 ai-protocol）。
5. **Brave 与维基在手机网络上的可达性与限流**（电脑上通了，手机没测）；Brave 页面经原生 `net.http` 取回的内容是否和电脑上 curl 一致（UA、压缩、地区可能不同）。
6. **摘要质量**：Brave 摘要通常只有一两句，4 条合计远不到 1200 字预算；是否需要抓正文（第 5 节第 2 条）看实测。

验证步骤：装 debug 包 → `scripts/device-push-models.sh` 推 `qwen35-0.8b-mnn-q4` → 在任意页面的控制台或一个临时调试入口里调 `runResearch('量子计算有什么用', createNativeDeps())`，记录三个阶段耗时与输出，再决定第 5 节往哪走。
