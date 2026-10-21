# 小体积本地流式语音识别模型调研（sherpa-mnn / MNN）

> 调研日期：2026-10-21。目标：把现用 X-ASR 480ms（MNN w8 共 168MB，encoder 155MB）压到几十 MB，仍走 sherpa-mnn `OnlineRecognizer`（transducer，1.10.46）。
> 没核实的地方一律标「未核实」；本次没下载任何模型，也没改项目代码，所有体积来自官方清单与模型页，**w8 体积是按“w8 ≈ fp32 的 1/4”的粗估**（fp32 每权重 4 字节、w8 约 1 字节；对照 X-ASR：fp32 ONNX 包 584MB → w8 .mnn 共 168MB，量级吻合，但没逐个转过）。

## 1. 结论摘要

- **首选：`sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16`**（zipformer1 transducer，中英，无标点）。fp32 三件套约 112MB，估 w8 约 **28MB**（÷4 粗估）；sherpa-mnn 自带 README 的流式示例就是同系 zipformer1（2023-02-20 大号版），转换路径有一手证据。代价：无标点、识别精度明显低于 X-ASR、训练数据是“内部数据”，许可证未核实。
- **备选：`sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23`**（zipformer1 transducer，纯中文，WenetSpeech，Apache-2.0）。fp32 三件套约 53MB，估 w8 约 **13MB**；缺点是纯中文，英文基本不能用。
- 官方清单里**没有**“几十 MB 且中英且带标点”的流式模型；带标点的只有 X-ASR 系列（int8 ONNX 134MB 起，与现用同款）。想保留标点只能走“X-ASR + 4bit 量化”或另配标点模型（后者改动大，不推荐）。
- 官方流式 int8 里最小的两个中文 CTC/transducer（`small-ctc-zh-int8` 21MB、`multi-zh-hans-int8` 62MB）都只有中文，且 int8 ONNX 不能直接转 MNN（见第 4 节）。

## 2. 官方流式模型清单与体积

体积来自 GitHub release `asr-models` 的资产 API（`.tar.bz2` 压缩包大小，含 fp32 与 int8 文件时是两者之和）。文档页本身不给体积，只有各模型节里的 `ls -lh`。

来源：
- 清单：<https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/index.html>、<https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html>
- 体积：<https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/asr-models>（<https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models>）

### 2.1 中文或中英、体积不超过 150MB 的流式候选（精选）

| 模型 | 结构 | 语言 | 标点 | 官方包体积 | 单独 int8 / fp32 ONNX 体积 | 许可证 |
|---|---|---|---|---|---|---|
| `streaming-zipformer-zh-14M-2023-02-23` | zipformer1 transducer | 中 | 无（文档示例无） | 74.0MB；`-mobile` 54.3MB | int8：enc 21M + dec 1.8M + joi 1.7M；fp32：39M + 7.2M + 6.8M | Apache-2.0（HF 模型页标注） |
| `streaming-zipformer-small-bilingual-zh-en-2023-02-16` | zipformer1 transducer | 中英 | 无（文档示例无） | 458.2MB（含多套 chunk 目录）；rk 版 49.7MB（NPU 专用，不可用） | int8：enc 41M + dec 3.4M + joi 3.1M；fp32：85M + 14M + 13M | 未核实（HF 页 401，文档只说“内部数据集训练”） |
| `streaming-zipformer-small-ctc-zh-int8-2025-04-01`（fp32 版 `-zh-2025-04-01` 87.2MB） | zipformer2 **CTC** | 中 | 无 | int8 包 21.3MB | HF：`model.int8.onnx` 26.3MB，仓库共 27MB | 未核实（页面未显示） |
| `streaming-zipformer-multi-zh-hans-2023-12-13`（int8 62.0MB / fp16 122.8MB / fp32 253.0MB） | zipformer2 transducer | 中（14k 小时） | 无 | 见左 | HF fp32 enc 261MB + dec 5.17MB + joi 4.1MB | 未核实（页面未显示） |
| `streaming-zipformer-ctc-multi-zh-hans-int8-2023-12-13` | zipformer2 CTC | 中 | 无 | 57.0MB | 未核实 | 未核实 |
| `streaming-zipformer-zh-int8-2025-06-30`（fp16 282.2MB / fp32 594.1MB） | zipformer2 transducer | 中 | 无 | 132.6MB | 未核实 | 未核实 |
| X-ASR `*-zh-en-punct-int8-2026-06-05`（160/480/960/1920ms 同体积；现用 480ms） | zipformer2 transducer | **中英** | **有（在 token 里）** | 133.9MB；fp32 584.1MB | 现网 int8 ONNX 133.9MB | Apache-2.0（项目已核实） |
| `streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-2025-02-10` | zipformer transducer | 8 语（含中英） | 未核实 | 259.0MB | 未核实 | 未核实 |

### 2.2 其他结构（不推荐，原因一句话）

| 模型 | 为什么不选 |
|---|---|
| `streaming-paraformer-bilingual-zh-en` / `trilingual-zh-cantonese-en`（各约 1047MB） | 体积是现用的 6 倍以上；结构是 paraformer（encoder + decoder 两图），不在本次 transducer 目标内 |
| `lstm-zh-2023-02-20`（417MB）、`streaming-conformer-zh-2023-05-23`（528.8MB） | 体积大、精度老旧 |
| `nemo-streaming-fast-conformer-*`、`nemotron-*`、`parakeet-unified-*` | 只有英文，且 int8 也要 100MB 以上 |
| `kroko`（en/fr/es/de）、`small-ru-vosk`、`bn-vosk`、`t-one-russian`、`ctc-fa-*` | 没有中文 |
| `*-rk35xx-*` | RKNN NPU 专用包，手机用不了 |

## 3. sherpa-mnn 对在线结构的支持

固定提交所在仓库 `alibaba/MNN` 的 `apps/frameworks/sherpa-mnn/sherpa-mnn/csrc` 下，在线模型头文件有（GitHub contents API 实查）：

`online-zipformer-transducer-model.h`（zipformer1）、`online-zipformer2-transducer-model.h`、`online-zipformer2-ctc-model.h`、`online-conformer-transducer-model.h`、`online-lstm-transducer-model.h`、`online-ebranchformer-transducer-model.h`、`online-paraformer-model.h`、`online-wenet-ctc-model.h`、`online-nemo-ctc-model.h`、`online-transducer-nemo-model.h`、`online-cnn-bilstm-model.h`、`online-ctc-model.h`。

- zipformer1 / zipformer2 transducer 与 zipformer2 CTC 都在；`OnlineRecognizer` 按 ONNX 元数据（`model_type`）选结构。X-ASR 现用 `modelType = "zipformer2"`，若换 zipformer1 模型要把 Kotlin 里的 `modelType` 改成 `zipformer`（未核实该字段在 1.10.46 Kotlin API 里的确切取值，换模型时对照 `OnlineModelConfig` 看）。
- sherpa-mnn README（<https://github.com/alibaba/MNN/tree/master/apps/frameworks/sherpa-mnn>）：说明是 sherpa-onnx 把 onnxruntime 换成 MNN；转换用 `MNNConvert --weightQuantBits=8 --weightQuantBlock=64`，**明确建议用 fp32 ONNX 转，不要转 int8 ONNX**；流式示例就是 `sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20`（zipformer1），产物 `encode.mnn/decode.mnn/joiner.mnn`。
- **没有找到**现成可下的小号流式 MNN 模型：README 无预转换模型清单或 ModelScope/HF 链接；GitHub 仓库搜索也没有第三方 sherpa-mnn 模型仓库。HF 与 ModelScope 上是否有人发布过，本机 curl 访问 HF 失败（返回 000），**未核实**。
- 版本差异：sherpa-mnn 基于 sherpa-onnx 1.10.46，晚于它发布的模型若用了新元数据或新算子，可能读不了。小号候选都是 2023 年的 icefall 导出，早于 1.10.46，对它们有利；2025 年的 `small-ctc-zh`、2025-06-30 系列、X-ASR 是否都被 1.10.46 接受：X-ASR 已实测可用，其余**未核实**。

## 4. 转 MNN 难度与预估 w8 体积

体积估法：w8 .mnn 总和 ≈ fp32 三件套总和 ÷ 4（w8 每权重 1 字节）；不含 tokens/bpe.model。

| 候选 | 转换难度 | 预估 w8 体积 | 说明 |
|---|---|---|---|
| zipformer-small-bilingual-2023-02-16 | 低~中 | 约 28MB（85+14+13=112MB fp32 ÷ 4，**粗估**） | 结构与 sherpa-mnn 官方示例同系（zipformer1）。风险：zipformer1 导出的状态张量多（每层 cached_key/val/conv 等），MNN 转换与 `cached_*` 形状推断是否一次通过**未核实** |
| zipformer-zh-14M-2023-02-23 | 低~中 | 约 13MB（53MB fp32 → ≈ 13MB，粗估） | 同上，更小；同系结构 |
| small-ctc-zh-2025-04-01 | 中 | 约 22MB（fp32 包 87MB → ≈ 22MB，粗估） | 需 fp32 ONNX（官方有 `-zh-2025-04-01` 非 int8 包）；zipformer2 CTC 路径在 sherpa-mnn 有头文件，但**没有 CTC 实测**，且不是 transducer |
| multi-zh-hans-2023-12-13 | 低 | 约 63MB（249+4.9+3.9 → 粗估） | 与 X-ASR 同为 zipformer2，转换流程可直接复用；只有中文，体积仍偏大 |
| X-ASR + 4bit（`recipes.json` 已有 `w4b32hqq` 变体） | 低（已有配方） | 约 80~90MB（155MB 的一半多，**粗估**，没转过） | 保留中英与标点；4bit 对精度的影响**未核实**，需跑 `eval_asr.py` |

转换流程（沿用 M7）：`scripts/mnn/recipes.json` 的 `asr` 配方 + `convert_all.py asr`（`asr:` 前缀指向 fp32 目录，三图 + `tokens.txt`）；新增候选时另加一个 `asr-small` 配方，文件名仍用 encoder/decoder/joiner。M7 踩过的坑对新候选同样适用：
- 必须从 fp32 ONNX 转，不要用 int8 ONNX；
- 重转会改 sha，转一次就登记；
- 带 bpe 的模型要核对 `tokens.txt` 与 `bpe.model` 是否都要（本项目现在只带 `tokens.txt`，BPE 模型在 sherpa 里只用于热词，非必需，**未核实**）；
- 桌面验收口径是“sherpa-mnn 自带前处理”那一行，不是 numpy eval（fbank `high_freq=-400`、尾部静音补法不同）；
- Apache-2.0 要随分发带许可证文本，M7 当时漏了，新包记得带 NOTICE/LICENSE。

## 5. 推荐

### 推荐 1（体积优先、仍中英）：zipformer-small-bilingual-zh-en-2023-02-16

- 理由：整包 w8 估 28MB，约现用的 1/6；中英混合；zipformer1 与 sherpa-mnn 官方示例同系，OnlineRecognizer 路径有一手依据；2023 年导出，不会撞 1.10.46 的版本差异。
- 风险：
  1. **无标点**，产品上要么接受，要么另做标点（会再加体积与链路）；
  2. 精度明显弱于 X-ASR（官方没给 WER，**未核实**），中英混说和专有名词可能更差；
  3. **许可证未核实**，训练集是“内部数据”，上线前要查 HF 页与 icefall 说明，查不清就不能分发；
  4. zipformer1 的 MNN 转换是否一次通过未实测；
  5. 目标机 STG-AL00 无 dotprod/fp16，int8 动态量化内核速度仍是 M7 以来的风险点（模型小，应比现用更宽松）。

### 推荐 2（极小、仅中文）：zipformer-zh-14M-2023-02-23

- 理由：估 w8 约 13MB；Apache-2.0 明确；WenetSpeech 训练，中文听写够用。
- 风险：纯中文，英文词会被硬转成近音汉字；无标点；精度比 small 版更低（未核实）。适合作为“极小体积档”或给纯中文场景，不适合当唯一语音模型。

### 不建议
- 为了保标点而换 CTC 或 paraformer：体积和结构都不划算。
- 想要“几十 MB + 标点 + 中英”：官方清单里没有，只能 X-ASR 走 4bit（约 80~90MB，仍不到“几十”）或另配标点模型。

## 6. 下一步（需用户拍板，本次未做）

1. 先问用户：能接受**无标点**吗？不能 → 只剩 X-ASR + w4；能 → 走推荐 1。
2. 下载 small-bilingual 官方 fp32 包（约 458MB 压缩包，含多套 chunk 目录；用 `aria2c -x16 -s16`）；先在 HF 页核实许可证。
3. 加 `asr-small` 配方，转 w8，跑 `eval_asr.py` 与桌面 `sherpa-mnn.exe`（`modelType` 用 zipformer），拿 4 条测试音频对照 X-ASR 的识别质量，再决定是否上真机。

## 7. 转换与评测（2026-10-21，small-bilingual 实测）

> 范围：只做了桌面转换与 `eval_asr.py` 口径评测（numpy fbank + 流式贪心，4 线程）。**没有**跑 sherpa-mnn 桌面可执行，**没有**上真机，**没有**验证 `.mnn` 里是否保留了 `model_type=zipformer` 等元数据（sherpa-mnn 靠它选结构，见 M7）。本节与第 4 节“约 28MB”的粗估冲突，以本节为准。

### 7.1 许可证：未核实

- 本机访问 huggingface.co 与 hf-mirror.com 一律失败（HTTP 000），ModelScope 同样不通，HF 模型页读不到。
- 能确认的只有：k2-fsa 文档（`zipformer-transducer-models.rst`）写明该模型转自 `csukuangfj/k2fsa-zipformer-bilingual-zh-en-t`，“由社区贡献，使用数万小时内部数据训练”；训练配方是 icefall 的 `pruned_transducer_stateless7_streaming`（zipformer1）。GitHub issue #3116 里有人问过权重，没提许可证。
- 官方 release 包（`.tar.bz2`）里**没有 LICENSE/README**；sherpa-onnx 仓库的 Apache-2.0 只管代码，不等于模型权重的许可。
- 结论：**许可证未核实，上线分发前必须先查到 HF 页的 license 字段（或问 csukuangfj/k2-fsa），查不到就不能随 App 分发**。

### 7.2 下载

- 包：`sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16.tar.bz2`（来自 GitHub release `asr-models`），458,187,351 B，sha256 `2b7c63322b32e5e0f2526043a1103366119ca58dd615cd7105a37c01db9553d7`，aria2 单源约 46MiB/s，十来秒下完。
- 位置：`E:\asr-small-dl\`（仓库外）。包内根目录是 `decode_chunk_len=32`（T=39，约 320ms 一块），另有 `64/`、`96/` 两套更大的块；本次只用根目录那套。
- fp32 ONNX（根目录）：encoder 88,476,270 B（sha `21b82075…efd84`）、decoder 13,877,276 B（`89be509a…e0906`）、joiner 12,833,675 B（`bcbcf0cc…b5775`）；`tokens.txt` 6254 词、56,317 B（`a8e0e4ec…841d3`）。元数据：`model_type=zipformer`、`version=1`、`context_size=2`、`vocab_size=6254`；encoder 有 36 个输入（x + 35 个 cached_* 状态）。

### 7.3 转换：一次通过，没有算子问题

- 脚本：`scripts/mnn/convert_asr_small.py <fp32 目录> <输出目录> [w8|w8b64|w8b32|fp16|fp32]`，走固定提交的 `MNNConvert.exe`（`mnnconv.py`），每个子网络约几秒。官方文件名带 `-epoch-99-avg-1` 后缀，脚本统一改名为 `encoder/decoder/joiner.mnn`。
- **fp32 MNN（memory=0）与 ORT fp32 在 6 条音频上 6/6 逐字一致**，说明 zipformer1 的图（Cumsum/GatherElements/Where/Range 等）和 35 个状态张量转换无误，问题只在量化。
- 体积（三件套合计；gzip -9 是三个文件各自压缩后相加）：

| 变体 | 合计字节 | gzip -9 | 说明 |
|---|---|---|---|
| fp32 | 115,547,660（110.2MiB） | 106,637,425 | 对照 |
| fp16 权重 | 58,323,480（55.6MiB） | 52,566,100 | |
| w8（逐通道） | 47,677,000（45.5MiB） | 43,611,629 | encoder 29.8 + decoder 12.6 + joiner 3.1 MiB |
| w8 block64 | 49,948,760（47.6MiB） | 46,480,708 | sherpa-mnn README 的推荐参数 |
| w8 block32 | 52,800,476（50.4MiB） | 49,164,941 | |

  **实测 w8 约 45~48MiB，不是第 4 节估的 28MB**：decoder 几乎没被量化（13.9MB → 12.6MB，权重主要是 Gather 嵌入表与 Conv，w8 不处理），joiner 也只降到 3.1MB；只有 encoder 接近 ÷3（88 → 30MiB）。decoder 用 fp16 能到 6.7MB，但没做混合精度，**未试**。tokens.txt 另算 56KB。对比现用 X-ASR w8 共 168.8MB，约为其 28%。

### 7.4 识别效果（6 条音频，2 条是 test_wavs 里的 0~3 之外的 4 与 46）

`eval_asr.py` 同口径，ORT fp32 为基准。MNN 的 `memory=0`（加载时把量化权重还原成 float，只带权重量化误差）与 `memory=2`（手机上真正用的口径，保留 int8 权重并对激活做动态 int8）分开看：

| 变体 | memory=0 与 ORT fp32 逐字一致 | memory=2 与 ORT fp32 逐字一致 | 现象 |
|---|---|---|---|
| fp32 | 6/6 | 未测 | |
| fp16 权重 | 6/6 | 未测 | |
| w8（逐通道） | 1/6 | **0/6** | 1、3 号音频几乎被截断（“这是第二”“第一是什”） |
| w8 block64 | 5/6 | **2/6** | memory=0 仅 0.wav 个别字不同（“李八二姐”→“领八二姐”）；memory=2 多处掉字、末尾少“啊” |
| w8 block32 | 2/6 | 0/6 | 不比 block64 好，两种口径下都是 |

小样本（6 条、共约 50 秒），结论只作方向参考。要点：
- **memory=2 的动态 int8 激活量化对这个小 zipformer1 伤害明显**（同一份权重 memory=0 5/6、memory=2 2/6），这与 X-ASR 的 4/4 一致形成反差。逐通道 w8 连权重本身就掉得厉害；block64 才勉强可用。
- 小模型本身的识别质量（ORT fp32 基准）：中英混说能出，但英文全大写、无标点、有明显错字（“礼拜二”→“李八二姐”，“and tomorrow”→“AFTER TOMORROW”，“扫拖下”类错字），4.wav 末尾被截在“教他的”（X-ASR 同样停在这里，应是音频结束）。

与现用 X-ASR 同 6 条音频对照（X-ASR 用本机 int8 ONNX 当基准、已有的 w8 MNN 产物 `memory=2`；注意 X-ASR 的 fp32 包没下载，基准是现网 int8，不是 fp32）：

| 音频 | small（ORT fp32） | X-ASR（int8 ORT） |
|---|---|---|
| 0 | 昨天是 MONDAY TODAY IS李八二姐 AFTER TOMORROW是星期三 | 昨天是 Monday，today is 礼拜二，the day after tomorrow 是星期三 |
| 1 | 这是第一种第二种叫呃与 ALWAYS什么意思啊 | 这是第一种，第二种叫呃与 always always 什么意思啊？ |
| 2 | 这是频繁的啊不认识记下来 FREQUENTLY平凡的 | 就是频繁的啊，不认识记下来，frequently 频繁的 |
| 3 | 第一句是个什么时态加了 ES是一般现在时对后面它时态先生 | 第一句是个什么时态？加了 yes 是一般现代时，对，我们把它时态写上去。 |
| 46 | 你好石头把厨房扫脱下 | 你好石头，把厨房扫脱下 |

X-ASR 明显更准：标点、“李八二姐/礼拜二”、“ES/yes”、“先生/写上去”都是 small 错、X-ASR 对；X-ASR 自己的 w8 MNN 与 int8 ORT 在这 6 条里 3/6 一致，差别只是标点位置与个别词（M7 已有结论）。**small 是用精度换体积，不是等价替代。**

### 7.5 速度与内存（桌面，仅相对参考）

- 编码器 RTF（`eval_asr.py`，4 线程）：small fp32 MNN 0.063；small w8 block64 memory=2 **0.035**；X-ASR w8 memory=2 0.149（同机同口径）。small 约快 4 倍，符合体积比例。
- 同一批 small 的 w8（逐通道）memory=2 首次跑出过 RTF 1.438（RSS 116MB），之后 block64/block32 的 memory=2 是 0.035/0.050，**这个 1.4 的原因没查**（可能是机器当时负载或逐通道量化走了慢内核，未复测），不要拿单次数字下结论。
- RSS：small memory=2 约 118~120MB（峰值 267~273MB 为加载瞬时）；X-ASR w8 约 263MB（峰值 695MB）。目标机 STG-AL00（无 dotprod/fp16）上速度**未测**。

### 7.6 结论与遗留风险

1. **转换可行，但“28MB”不成立**：实测 w8 约 45~48MiB（gzip 后 43.6~46.5MB），约 X-ASR 的 28%，而不是 1/6。
2. **量化不稳**：手机口径（memory=2）下，w8/w8 block64 与 ORT fp32 相比明显掉字（2/6 或 0/6 一致），不能直接按 X-ASR 的验收门槛（逐字一致）通过。可选路径（都**未做**，需用户拍板）：(a) fp16 权重（约 55.6MiB，memory=0 下 6/6，但手机上 memory=0 会把权重还原成 float，常驻内存约 fp32 大小 110MiB，且这台机无 fp16 加速，需真机测）；(b) w8 block64 + memory=0（5/6，同样常驻约 110MiB）；(c) 排查哪些层对动态激活量化敏感，让这些层保持浮点（MNN 有按层排除的机制，没研究）。
3. **精度远不如 X-ASR 且无标点**；英文输出为全大写，需要后处理（转小写等）。
4. **许可证未核实**（见 7.1），是上线的硬前置。
5. **没验证 sherpa-mnn**：`modelType` 要从 `zipformer2` 改成 `zipformer`（zipformer1），`.mnn` 元数据是否被 sherpa-mnn 读到、`decode_chunk_len=32` 的块与端点行为，都没跑；M7 已记录 sherpa 自带前处理（`high_freq=-400`、尾部静音）与 numpy eval 口径有差异，本节 eval 是 numpy 口径。
6. 产物在 `E:\asr-small-dl\out\<变体>\`（仓库外，没有登记 sha、没上传、没改 `models.json`/`recipes.json`/README）；`w8 block64` 三个文件 sha256：encoder `1639aba0…bb51d`、decoder `aaf1bf6d…b707`、joiner `bea8fdbb…7158`。

## 8. multi-zh-hans-2023-12-12 专项（2026-10-21，用户指定）

> 范围同第 7 节：桌面转换 + `eval_asr.py` 口径（numpy fbank、流式贪心、4 线程）。没跑 sherpa-mnn 桌面可执行，没上真机，没验证 `.mnn` 的 sherpa 元数据。

### 8.1 模型事实

- 包：`sherpa-onnx-streaming-zipformer-multi-zh-hans-2023-12-12.tar.bz2`（GitHub release `asr-models`），310,380,628 B，sha256 `865308b3…dc7ba`（与 release digest 一致）。同系还有 `-12-13` 的 fp32 / fp16 / int8 三个拆分包（int8 62.0MB），本节用的是 12-12 全量包（fp32 + int8 都在，`chunk-16-left-128`，epoch-20）。
- 结构 zipformer2 transducer，encoder 有 99 个输入（x + 16 层×6 个 cached + embed_states + processed_lens）。
- 训练数据（icefall `egs/multi_zh-hans`）：THCHS-30、AiShell-1/2/4、ST-CMDS、Primewords、aidatatang_200zh、MagicData、AliMeeting、WenetSpeech（10k 小时）、KeSpeech，合计约 14k 小时。
- 语言：官方文档原话 “It supports only Chinese.”。词表约 2000 个 BPE，带 256 个 `<0x..>` 字节回退。**英文实际不可用**（见 8.4）。
- 标点：无（词表与输出都没有）。
- 许可证：包内 `README.md` 的 front matter 写 `license: apache-2.0`（等同 HF 模型卡）。但官方文档与 icefall 页均未给权重许可说明，训练集（WenetSpeech、KeSpeech 等）各有自己的使用条款，**数据集条款对权重的影响未核实**；上线前建议自己再确认一次。
- 官方 WER：**未找到**。icefall `RESULTS.md` 里 multi_zh-hans 只有 large（约 160M 参数）和 xl 的流式 CER 表，本包 encoder fp32 仅 260MB（约 65M 参数），对不上，不能借用。
- 体积（包内 ONNX）：fp32 encoder 260,643,233 / decoder 5,165,083 / joiner 4,104,464 B；int8 encoder 70,109,350 / decoder 1,308,688 / joiner 1,033,416 B（int8 合计约 72.5MB）。fp32 sha（前 12 位）：encoder `f8b49fe762cb`、decoder `67d37eedeb20`、joiner `da90cccb05a1`；tokens.txt `6722bd1585f4`。
- 下载位置 `E:\asr-multi-zh-dl\`（仓库外），aria2 约 44MiB/s。

### 8.2 转换：一次通过

`scripts/mnn/convert_asr_small.py`（本次改为自动识别文件名后缀）直接转，无任何算子报错。fp32 MNN 与 ORT fp32 逐字一致（6/6）。

| 变体 | 合计字节 | MiB | gzip -9（三文件各自压缩后相加） |
|---|---|---|---|
| w8 逐通道 | 75,568,328 | 72.1 | 69,170,135 |
| w8 block64 | 82,495,816 | 78.7 | 77,732,578 |
| fp16 权重 | 136,438,216 | 130.1 | 124,644,231 |
| fp32 | 270,536,440 | 258.0 | 249,826,854 |

w8 逐文件：encoder 66.8 / decoder 4.3 / joiner 1.0 MiB。**体积是硬伤**：w8 约 72MiB，只比现用 X-ASR w8（168.8MB）小 57%，是 small-bilingual w8（45.5MiB）的 1.6 倍。

### 8.3 与 ORT fp32 的一致性

eval_asr.py 新增了 `<0xXX>` 字节回退合并（`join_tokens`，对不含此类 token 的词表无影响），否则英文会输出成一串 `<0x4D>`。

| 音频集 | 变体 | memory=0 一致 | memory=2 一致 | RTF（m0 / m2） |
|---|---|---|---|---|
| 6 条中英混说（同第 7 节） | fp32 / fp16 | 6/6 / 6/6 | 6/6 / 6/6 | 0.115 / 0.279（fp32），0.096 / 0.098（fp16） |
| 同上 | w8 | 6/6 | 5/6 | 0.096 / **0.061** |
| 同上 | w8 block64 | 5/6 | 5/6 | 0.097 / 0.065 |
| 包自带 6 条中文 | w8 | 5/6 | 5/6 | 0.107 / 0.074 |
| 同上 | w8 block64 | 5/6 | 5/6 | 0.134 / 0.077 |

- 量化明显比 small-bilingual 稳（那边 memory=2 是 0/6~2/6）。差异都是尾部或个别字：w8 m2 在混说 3 号少了“代还是算线”后几字；w8 block64 在 1 号把英文片段“OYS 什么意思”换成“韦外”；纯中文那 5/6 的差异是末尾“就”与“就是”。
- 样本小（12 条），RTF 为桌面单次数字，目标机 STG-AL00 未测。memory=2 的 RSS：w8 约 166~173MB（峰值约 550MB）；X-ASR w8 约 263MB。fp32 memory=2 RTF 0.279 偏高，原因没查。

### 8.4 中英混说与标点（ORT fp32 基准，6 条混说）

| 音频 | multi-zh-hans | X-ASR（int8 ORT，第 7 节） |
|---|---|---|
| 0 | 昨天是MANDT的一零八二只对阿富特曼人是星期三 | 昨天是 Monday，today is 礼拜二，the day after tomorrow 是星期三 |
| 1 | 这是地方第二种叫鳄鱼 OYS 什么 意思 | 这是第一种，第二种叫呃与 always always 什么意思啊？ |
| 2 | 平凡的真是记下来福瑞冻的平凡的 | 就是频繁的啊，不认识记下来，frequently 频繁的 |
| 3 | 第一只是个什么时代加了夜四十一般现代时代还是算线上品 | 第一句是个什么时态？加了 yes 是一般现代时，对，我们把它时态写上去。 |
| 46 | 你好石头把厨房扫脱下 | 你好石头，把厨房扫脱下 |

结论：**英文基本不可用**（Monday→MANDT、frequently→福瑞冻，偶尔蹦出乱码式大写字母）；中文部分连这几条口语也错得多（“时态”→“时代”、“第一种”→“地方”）；无标点。它对中文朗读/会议类数据（见 8.3 末列的纯中文样例，读起来基本通顺）尚可，但对本项目“中英混说 + 标点”的定位不合适。

### 8.5 结论与遗留风险

1. 转换成功（w8 / w8 block64 / fp16 / fp32），量化稳定性好于 small-bilingual，但体积 w8 72.1MiB，gzip 后 69.2MB。
2. 与 X-ASR 差距：缺英文、缺标点、中文口语精度明显较低；体积省约 57%，RTF 约快 2 倍（0.061 对 0.149，不同时间同机）。**只适合“纯中文、不要标点、体积上限放宽到 ~75MB”的场景**。
3. 许可证：包内标 Apache-2.0，但训练数据条款未核实；官方 WER 未找到。
4. 未验证：sherpa-mnn 加载（`modelType=zipformer2` 应与 X-ASR 一致，BPE 字节回退在 sherpa 里是否被正确解码**未核实**）、目标机速度与端点行为。
5. 产物在 `E:\asr-multi-zh-dl\out\<变体>\`，评测输出在 `E:\asr-multi-zh-dl\ev\`（仓库外，未登记 sha、未上传）。w8 三文件 sha 前 12 位：encoder `aa98a44c8625`、decoder `4951f38347cf`、joiner `ac005c577995`。
