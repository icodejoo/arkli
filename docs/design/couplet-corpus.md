---
title: 对联语料库与对联页
status: active
updated: 2026-10-16
summary: 73.6 万副对联语料的数据包格式、原生随机访问、前端“不重复随机”算法，以及对联页三模式（随机 / 对下联 / 大模型）
---
## TL;DR
- 语料来自 `scripts/couplet`（推导的分类与推荐横批，质量局限见该目录 README）。打成数据包 `couplet-corpus.zip`（deflate -9，33,070,763 B，解压后 64,961,472 B），按需下载，不随 APK。
- 下载与解压走原生 `ModelManager`（清单 `kind: "pack"`，见 [模型下载管理](model-download.md)）；读取走 `native.corpus.couplet.*`，**不在 JS 里解压或读全量**。
- “随机且不重复”在前端：固定步长置换，游标只存（种子、已抽个数）。

## 包格式（`scripts/couplet/build_pack.py`，小端）
| 文件 | 内容 |
|---|---|
| `lines.txt` | 每行 `上联\t下联\t横批\n`，UTF-8，52,188,167 B |
| `offsets.u32` | N+1 个 u32，第 i 行字节区间 `[off[i], off[i+1])` |
| `flags.u32` | N 个 u32：低 16 位分类位图（顺序同 `CATS`），16~19 位首选分类下标 |
| `pools.u32` | 各抽取池的对联序号（升序）顺序拼接 |
| `meta.json` | `{ v, count, cats[16], pools[{ name, count, offset }] }` |

池 0 =「全部」（**不含挽联**，698,574 副）；池 1~16 = 含对应分类标签的全部对联（挽联池 37,640 副，强弱判定都算）。包版本 `v=1`；改 `CATS` 顺序要升版本。

## 原生
- `CoupletCorpus`（`com.let188.arkli.corpus`）用 `RandomAccessFile` 按偏移读一行，打开时核对 meta 与各文件长度，不自洽即判包损坏。
- `native.corpus.couplet.info` `{}` → `{ ready, count?, pools?[{pool,name,count}] }`；`native.corpus.couplet.get` `{ pool, index }` → `{ id, up, down, banner, cats[], primary }`；未装 `NOT_READY`，越界 `BAD_PARAMS`。只接受主 frame。
- 状态 `installed` 才允许读；删除语料前由释放钩子关文件。

## 不重复随机（`web/src/tools/couplet/cursor.ts`）
对池大小 n，种子 s 决定步长 `stride`（取在 0.382n~0.618n 附近并上调到与 n 互质）与起点 `start`，第 k 次抽 `(start + k·stride) mod n`。n 步恰好走遍每个下标一次。游标 `{seed,k,n,v,last}` 存 localStorage（键 `arkli.couplet.cursor.<池名>`）；池大小或语料条数变了、或抽满，换种子开新一轮（并避免上一轮最后一个紧接着出现）。每个池各自游标。游标只在原生成功取到之后才前进。

## 对联页三模式（`web/src/tools/couplet/`）
- **随机**：选池（挽联单列在最后，默认“全部”不含），“抽一副”。显示分类与本轮剩余；提示横批与分类是推导值。
- **对下联**：`aiCouplet`（local-couplet，上联 ≤14 字，只允许汉字与常用标点）。
- **大模型**：`aiInvoke('prompt')` 走 local-qwen。选项：要不要横批、横批 2~7 字、16 类类型、自由要求。`generate.ts` 拼提示词、解析 `上联/下联/横批` 三行、校验（汉字数相等、断句位置一致、上下联不同、横批字数符合），不合格带原因重试一次，仍失败给提示。界面提示 0.8B 会写出不工整的句子。
- 结果可手改，画红底金字竖排图并导出 PNG（`logic.ts` 的 `layoutCouplet/drawCouplet`）。底部用 `BottomActions`。
- 模型选择器放底部操作栏（默认插槽）：工具声明了 `couplet` 与 `prompt` 两类任务，页面按提供者 id（`local-couplet`、`local-qwen`）读就绪状态，不依赖“当前选择”；语料库不是提供者，页面读 `stores/models.ts` 的 `couplet-corpus` 状态，未就绪只提示先下载，下载在 AI 中心。

## 验证
- 真机 STG-AL00（debug 包）：adb 把 zip 放进 `files/models/couplet-corpus/`，`native.model.ensure` 后约 2 秒解压完成，状态 `installed`，zip 被删，5 个文件 sha256 通过；`info/get`、越界、缺参、`remove` 后 `NOT_READY`、重推再装均符合预期；页面随机抽取正常、画布渲染正常。
- 未验证：真实 release 下载（`couplet-corpus-v1` 待上传）、对下联与大模型模式在真机上的实际效果与耗时、Qwen 生成质量与重试率。
