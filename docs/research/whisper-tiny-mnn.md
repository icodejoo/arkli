---
title: whisper-tiny 的 MNN 版：本地语音识别调研
status: draft
updated: 2026-10-21
summary: MNN 官方没有 whisper 发布物，但 sherpa-mnn 已带 whisper 离线识别代码，社区有现成转换好的 tiny/base MNN 文件；tiny 约 102MB，中文 FLEURS 字错率约 40%、英文也不及现用 zipformer，不建议替换，只建议作“离线文件转写/多语种”的并存候选，先做零原生改动的 POC。
---
# whisper-tiny 的 MNN 版：本地语音识别调研

标注约定：**[一手 Sx]** = 已打开对应仓库源码 / 模型卡 / 论文核对（来源清单见末尾）；**[推断]** = 由一手数据推出，不是原文；**[推算]** = 自己估的数量级；**未核实** = 没拿到证据。
所有 GitHub / HuggingFace 数据取自 2026-10-21 当天。

## 1. 结论先行

1. **MNN 官方没有 whisper 发布物，也没有计划。** alibaba/MNN 里没有 whisper 专用示例或模型库；官方 HF 组织 `taobao-mnn` 下没有 whisper 与独立 ASR 模型，只有 Qwen2-Audio / Omni 等多模态大模型 [一手 S1、S6、S20]。有人在 #4276 请求转换 whisper-distil-large-v3.5 等，维护者回复“暂无计划，欢迎 PR”并关闭 [一手 S6]。
2. **但路是通的**：MNN 仓库里的 sherpa-mnn（sherpa-onnx 的 MNN 改版）**整套搬进了 whisper 离线识别**（模型、贪心解码、前处理、Kotlin `OfflineRecognizer`）[一手 S2~S4、S19]。我们现在装机的 `libsherpa-mnn-jni.so`（2,690,520 B）里已经有 `OfflineRecognizer` 的 JNI 与 whisper 相关字符串，**接 whisper 不需要重编原生库** [一手 S17，本机缓存 so 的 strings 核对]。
3. **现成 MNN 文件有，来源是个人账号**：HF `developerabu/whisper-{tiny,tiny-en,base,small}-mnn`。tiny 的编码器我下载后核对了内嵌元数据，与 sherpa-mnn 读的字段一致（99 种语言，无粤语）[一手 S7]。缺点：作者个人账号、无 README、tiny 仓库无许可证声明、转换方式不公开（只能推断是 w8）。
4. **质量是硬伤**：whisper-tiny 中文 FLEURS 字错率约 **40.5%**、CommonVoice9 约 52.4%（base 为 34.1% / 44.9%，small 为 20.8% / 29.4%）[一手 S12，PDF 文本提取，见 3.3 的口径说明]；英文 LibriSpeech clean/other 词错率 7.54 / 17.15 [一手 S13]。我们现在的 X-ASR zipformer（480ms 流式）同口径是 3.14 / 7.57，且中文在 WenetSpeech 上 7~9% [一手 S14]。**tiny 在中、英两头都比现用方案差，中文差距是数量级的。**
5. **建议：不替换，也不为中文引入。** 唯一说得过去的用途是“多语种/离线文件转写”这类现用模型覆盖不到的场景，但那种场景下 tiny 的多语种质量（多数非英语种词错率 > 50%）也不够，真要做应上 base/small 或 SenseVoice / Qwen3-ASR（第 7 节）。如果用户仍想验证，POC 很便宜（第 9 节）。

## 2. MNN 官方支持现状

| 项 | 事实 | 来源 |
|---|---|---|
| MNN 主仓库的 whisper 专用代码 | 没有。文件树里带 `whisper` 的路径只有 sherpa-mnn 目录下的示例与源码 | [一手 S1] |
| sherpa-mnn | `apps/frameworks/sherpa-mnn`，README 写明“基于 sherpa-onnx 改造，onnxruntime 调用全部替换为 MNN”；首个提交 2025-06-11 整体导入 | [一手 S1、S5] |
| sherpa-mnn 的 whisper | `offline-whisper-model.cc`、`offline-whisper-greedy-search-decoder.cc`、`offline-recognizer-whisper-impl.h`、`OfflineWhisperModelConfig`（Kotlin）、`whisper-c-api.c` 示例都在 | [一手 S1~S4、S19] |
| 是否被 MNN 团队测试过 | 未核实。MnnLlmChat 的 ASR 页只用 transducer 配置，没有 whisper 配置 | [一手 S1，MnnLlmChat `AsrModelConfig.kt`] |
| MNN 自带音频前处理 | `tools/audio` 有 `whisper_fbank`（默认 n_mels=128，给 Qwen-Omni 之类用，80 维需传参）；#4963 刚修了 Whisper 特征的周期 Hann 窗，仍在演进 | [一手 S18] |
| MNN LLM 引擎里的 ASR | 有，但走的是 **Qwen3-ASR（llm.mnn + audio.mnn）**，不是 whisper；PR #4478 已合并，维护者要求补真实音频冒烟 | [一手 S15] |
| 历史坑 | #2745（2024-01）：有人把 HF whisper 直接转 MNN，动态维度变 -1、输出严重偏差，无结论后因过期关闭 | [一手 S6] |
| 社区验证 | #4275（2026-03）：`abuvanth` 把 `sherpa-onnx-whisper-tiny.en` 转成 MNN，称“与 sherpa-mnn 配合正常” | [一手 S6、S7] |

### 社区现成 MNN 文件（均为 HF `developerabu/*`，2026-03~06 上传）

| 仓库 | 文件与大小（字节） | 许可标注 | 备注 |
|---|---|---|---|
| `whisper-tiny-mnn`（多语种） | `tiny-encoder.mnn` 11,452,836；`tiny-decoder.mnn` 89,985,888；`tiny-tokens.txt` 816,730 | **仓库未标许可，无 README** | 合计约 102.3MB；2026-06-15 更新 |
| `whisper-tiny-en-mnn` | `encode.mnn` 12,365,220；`decode.mnn` 90,881,376；`tiny.en-tokens.txt` 835,554 | apache-2.0（标签） | 合计约 104.1MB |
| `whisper-base-mnn` | `encode.mnn` 29,154,436；`decode.mnn` 133,417,824；`base-tokens.txt` 816,730 | apache-2.0（标签） | 合计约 163.4MB |
| `whisper-small-mnn` | `small-encoder.mnn` 107,374,700；`small-decoder.mnn` 263,024,872；`small-tokens.txt` 816,730 | mit（标签） | 合计约 371.2MB |

数据来自 HF API 的文件列表 [一手 S7]。我把 tiny 编码器下载下来做了二进制核对：

- 内嵌元数据有 `n_text_layer`、`n_text_ctx=448`、`n_vocab=51865`、`is_multilingual=1`、`sot_sequence=50258,50259,50359`、`no_timestamps=50363`、`all_language_codes`（**99 个，含 zh、不含 yue**），正是 sherpa-mnn 的 `SHERPA_ONNX_READ_META_DATA` 要读的那批字段 [一手 S2、S7]。
- 文件大小与 k2-fsa 的 sherpa-onnx 导出包的 int8 版几乎一致：tiny 编码器 11.45MB 对 12.94MB，解码器 89.99MB 对 89.86MB；`tiny-tokens.txt` 字节数与 k2 包完全相同（816,730）[一手 S10]。**[推断]** 它是从 k2 的 tiny 导出包转的，且做了 8 位权重量化；解码器 90MB 的大头是没量化的 51865×384 fp32 词嵌入表（79.7MB，[推算]）。
- 没有找到 MNN 团队或任何组织（含 ModelScope 官方）发布的 whisper MNN 模型，ModelScope 未查到（接口不通，**未核实**）。
- 另有个人仓库 `pgf20160610/whisper-mnn`（GitHub，Apache-2.0，2026-06 创建，0 星）：自带 `asrexport.py`（HF whisper → ONNX → MNN，含 KV cache 的 prefill/cache 两个解码器）与 C++ 前处理 [一手 S8]。可当导出脚本参考，成熟度低，不建议直接依赖。

## 3. 模型规格与质量

### 3.1 结构与体积

| 模型 | 参数量 | 结构（tiny） | 说明 |
|---|---|---|---|
| tiny / tiny.en | 39M | d_model 384，编解码各 4 层，词表 51865（多语种），音频上下文 1500，文本上下文 448，80 维 mel | [一手 S11、S13] |
| base / base.en | 74M | — | [一手 S11] |
| small | 244M | — | [一手 S11] |

HF 上 `openai/whisper-tiny` 的 fp32 权重 `model.safetensors` 为 151,061,672 B [一手 S13]。

各档 sherpa-onnx 导出包的文件大小（一手，供转换对照）[一手 S10]：

| 档位 | 编码器 | 解码器 | 合计 |
|---|---|---|---|
| tiny fp32 ONNX | 37,647,080 | 114,505,801 | 约 152.2MB |
| tiny int8 ONNX | 12,937,772 | 89,855,401 | 约 102.8MB |
| base fp32 ONNX | 95,087,154 | 196,548,998 | 约 291.6MB |
| base int8 ONNX | 29,120,534 | 130,672,026 | 约 159.8MB |

**MNN 各精度体积**：w8 的实测只有社区 tiny 的约 102MB（上表，来源与量化方式有推断成分）；fp16 约 76MB（tiny）、fp32 约 152MB **[推算：由 fp32 减半/原值]**，无一手 MNN 数据。词嵌入表在解码器里占大头（fp32 79.7MB、fp16 约 39.8MB、int8 约 19.9MB，[推算]），MNNConvert 是否会量化这一张表**未核实**；若能量化，tiny 解码器可从 90MB 降到约 30MB 量级 [推算]。

对比：现用语音包 `asr-zipformer-zh-en-mnn-w8` 共 168,813,626 B [一手 S17]。**whisper-tiny w8（约 102MB）比现用小约 66MB；base w8（约 163MB）与现用持平。**

### 3.2 多语言与粤语

- 多语种 tiny/base/small 支持 99 种语言，含中文 `zh` [一手 S11、S13]。
- **粤语：tiny 没有粤语标签。** whisper 代码里 `yue` 是排在第 100 位的语言（官方模型里只有 large-v3 起用 100 种语言），tiny 的词表 51865、99 种语言，社区 MNN 的语言列表也核对为 99 个且无 `yue` [一手 S7、S11、S13]。粤语输入会被当 `zh` 处理，输出质量没有一手数据，**可预期很差**，实际需真机/样本测。
- 官方 `.en` 版只做英文，同参数量下英文略好，“tiny.en/base.en 差距明显”见官方说明 [一手 S11]。
- 同类方案对照：SenseVoice-Small 官方明说支持普通话、粤语、英语、日语、韩语（粤语有 `yue` 标签）[一手 S16]；Qwen3-ASR-0.6B 支持 30 种语言与 22 种方言，含粤语 [一手 S15]。

### 3.3 公开 WER/CER

**口径说明**：论文表格来自 PDF 文本提取，列头被打乱，下面的列对应关系是我按 FLEURS/CommonVoice 的语言代码字母序对回去的（FLEURS 里 Chinese 的代码 `cmn` 排在 `ca` 与 `cs` 之间），已与英文列做过合理性检查，但**请对照论文原表复核后再引用**。中文按字符算错误率（论文方法部分写明）[一手 S12]。

| 数据集 | 语言 | tiny | base | small | medium | large-v2 | 来源 |
|---|---|---|---|---|---|---|---|
| FLEURS | 中文（字错率 %） | 40.5 | 34.1 | 20.8 | 12.1 | 14.7 | [一手 S12 Table 13] |
| CommonVoice9 | 中文（%） | 52.4 | 44.9 | 29.4 | 23.2 | 26.8 | [一手 S12 Table 11] |
| FLEURS | 英文（词错率 %） | 12.4 | 8.9 | 6.1 | 4.4 | 4.2 | [一手 S12 Table 13] |
| LibriSpeech clean / other | 英文（词错率 %） | 7.54 / 17.15 | — | — | — | — | [一手 S13 模型卡] |

对比（不同测试集，**不能直接相减，只看量级**）：

| 方案 | 英文 | 中文 | 来源 |
|---|---|---|---|
| 现用 X-ASR zipformer，480ms 流式 | LibriSpeech clean 3.14 / other 7.57，GigaSpeech 9.77 | WenetSpeech net 7.38 / meeting 9.31 | [一手 S14] |
| whisper-tiny | LibriSpeech 7.54 / 17.15 | FLEURS 40.5，CV9 52.4 | 见上 |
| whisper-base | FLEURS 8.9 | FLEURS 34.1，CV9 44.9 | 见上 |
| whisper-small | FLEURS 6.1 | FLEURS 20.8，CV9 29.4 | 见上 |

**诚实评估**：

- **tiny 的中文不可用作主力识别。** 字错率 40% 意味着十个字错四个，口述输入基本没法用；base 仍有三成多；到 small 才勉强进入“能看懂”的区间，但 244M 参数在无 fp16、无点积的测试机上跑 30 秒窗口会非常慢（见 4）。
- 论文自己也点名中文是 whisper 的薄弱语种之一（与中文训练数据占比小、字节级 BPE 对中文不友好有关）[一手 S12]。
- tiny 的英文（LibriSpeech clean 7.54）比我们现用方案差一倍以上；FLEURS 英文 12.4 也远高于 small 的 6.1。
- whisper 输出自带标点与大小写，但中文简繁、标点风格不可控，**未核实**是否需要后处理（如强制简体的提示词做法属二手线索，没核）。

## 4. 端侧性能

**无一手数据，需真机测。** 具体：

- MNN 仓库与 sherpa-mnn 的文档里没有 whisper 的手机 RTF 或内存数据 [一手 S1、S5]；k2-fsa 的 sherpa-onnx 文档给的是 ONNX 路线，非本项目运行时，**未采用**。
- 我们自己的参照：测试机 STG-AL00（无 fp16、无点积）上，现用 zipformer 在 sherpa-mnn 下实时率 0.20、加载 2.5 s [一手 S17]。
- **[推算]**（仅量级，不是数据）：tiny 编码器处理一个 30 秒窗口的计算量约 30 GFLOP（约 7M 参数×1500 帧，加注意力和卷积）；在该机 4 个大核的 fp32 路径上，每窗口编码大概在数秒量级。解码器每步算量很小，但中文字节级 BPE 常 2~3 个 token 一个字，150 字要解码 300+ 步，每步还要对 1500 帧交叉注意力。整窗处理耗时可能达到几秒到十几秒。w8 在无点积机器上不会更快（走反量化），只省体积与内存。
- 内存：编码器交叉 K/V 是 4 层×1500×384 的 fp32 两份，约 18MB；自注意力 KV 缓存 4×448×384 两份约 5.5MB（[推算]，由 `GetInitialSelfKVCache` 的形状算出 [一手 S2]）；模型本体约 102MB（w8，社区文件）。运行时峰值需真机测，加载瞬时峰值可能是模型体积的数倍（现用语音模型桌面加载峰值就比稳态高 4 倍以上 [一手 S17]）。

## 5. 与现有方案对比

现状 [一手 S17]：语音识别走 Kotlin 侧 sherpa-mnn JNI，在线流式 zipformer2 transducer（X-ASR，480ms，中英），`SpeechEngine.kt` 用 `OnlineRecognizer`，前端 `speech-to-text` 以 `lang: 'zh-en'` 起会话，边说边出字。M9 起真机实测通过，RTF 0.20。

| 维度 | 现用 X-ASR zipformer（流式） | whisper-tiny MNN（社区 w8） |
|---|---|---|
| 体积 | 168.8MB | 约 102MB；base 约 163MB |
| 语言 | 中英 | 99 种，但非英语种质量多数不可用；无粤语标签 |
| 中文准确率 | WenetSpeech 7~9% | FLEURS 40.5%（tiny）、34.1%（base） |
| 英文准确率 | LibriSpeech 3.14 / 7.57 | 7.54 / 17.15 |
| 流式 | 原生流式，边说边出，有端点检测 | **非流式**，固定 30 秒窗口 |
| 长音频/实时 | 无需特殊处理 | 须自己切段：VAD 分句、每句单独跑；要“实时预览”只能反复重跑当前窗口（见下） |
| 取消 | 现有取消链路已通（按块喂音频，天然可停） | 解码循环可检查令牌；**编码器单次前向无法中断**（见下） |
| 集成成本 | 已集成 | 原生库已具备（见 2），要补 Kotlin 文件与一条识别通路 |

### 长音频与“实时”

- sherpa-mnn 的 whisper 识别器**只处理前 30 秒**，超过 2950 帧直接截断并打日志“Only waves less than 30 seconds are supported. We process only the first 30 seconds and discard the remaining data”，编码器输入也被限制为最多 3000 帧 [一手 S4]。长音频必须在上层切段。
- 编码器对长度是可变的：k2 的导出脚本把位置编码改成按输入长度切片，`dynamic_axes` 标了变长 [一手 S9]；识别器里实际用的是“有效帧数 + 尾部补零（默认 1000 帧）”，所以短句不必凑满 30 秒，但**仍要补尾部零帧**让模型能吐出结束符 [一手 S4]。即一句话越短越快，但补零有固定开销。
- 现实做法：用 VAD（silero）把麦克风流切成句，每句结束后整句识别；要实时预览只能每隔一两秒对“当前句已累计的音频”重跑一次，代价是每次都重跑编码器，耗电与延迟远高于流式 zipformer。sherpa-mnn 源码里有 VAD 与 whisper 联用的示例（`vad-whisper-c-api.c`）[一手 S1]，但 **JNI/Kotlin 是否带 VAD、模型是否另需**，未核实。
- 结论：whisper 适合“录完再转”（文件、录音），不适合替代口述输入。

### 取消（项目约定：所有模型必须支持取消）

- sherpa-mnn 的 whisper 贪心解码是个 C++ 循环，**没有取消钩子**：`OfflineWhisperGreedySearchDecoder::Decode` 一次跑完，Kotlin 的 `decode` 是阻塞 JNI 调用 [一手 S3、S19]。直接用 `OfflineRecognizer` 做不到“解码步内检查令牌”。
- 要满足约定，需自己写解码循环（放 Rust 或 C++）：编码器一次 `onForward`（**无法中途打断**，只能整段跑完再检查，需在文档里写明延迟上限，约等于一个窗口的编码时间，数秒量级 [推算]）；解码器每步前检查取消令牌，取消后抛 `CancellationException`，并保证下一次调用的会话不残留（KV 缓存是每次新建的，天然无残留）[一手 S3：KV 缓存每次 `GetInitialSelfKVCache` 新建]。
- 这条路的集成成本已有先例：Rust 核心里 NLLB 已有 `Seq2SeqRunner`（编码、逐步解码、MNN 句柄管理）[一手 S17]，whisper 的“一次编码 + 带偏移的逐步解码 + 固定形状 KV”与之同构，可参考但不能直接复用（whisper 解码器输入是 `tokens, self_k, self_v, cross_k, cross_v, offset` 六个张量 [一手 S2]）。

### 前后处理谁写

- **mel 前处理**：sherpa-mnn 用 kaldi-native-fbank 的 whisper 变体在 C++ 里算（`OfflineStream` 的 `WhisperTag`，80 维），归一化在 `NormalizeFeatures` [一手 S4]；若自写解码，则前处理可复用 sherpa-mnn 或 MNN 的 `whisper_fbank`（后者默认 128 维、窗函数仍在调整，需核对与 whisper 官方 80 维一致）[一手 S18]，也可自己用 Rust 写。
- **tokenizer**：`tokens.txt` 是 base64 的字节级 BPE，sherpa-mnn 加载时解码，按 token 拼接字节串 [一手 S4]。自写时注意：一个汉字可能跨多个 token，需先拼字节再按 UTF-8 解，**不能逐 token 单独转字符串**。
- **语言**：元数据带 `all_language_codes`；传 `language=zh` 可固定语种，留空则先跑一步解码器做语种检测 [一手 S3]。
- **注意一个潜在坑**：sherpa-mnn 把最大输出长度写成“每秒最多 6 个 token”（`num_feature_frames/100*6`，再与 `n_text_ctx/2` 取小）[一手 S3]。中文字节级 BPE 的 token 数每秒可能超过 6，**可能截断中文输出**。这是我对中文 token 密度的 **[推断]**，需用真音频验证；自写解码循环可绕开。

## 6. 转换路线与已知坑

两条路：

1. **用社区现成文件**（第 2 节表）。最省事，但来源是个人账号，无 README，tiny 无许可声明，转换参数不公开。
2. **自己从 k2 导出包转**：sherpa-onnx 的 `scripts/whisper/export-onnx.py` 支持 tiny / tiny.en / base / small 等，导出**编码器**（输出各层交叉 K/V）与**解码器**（固定形状自注意力 KV 缓存 + `offset` 标量）两个 ONNX，并写入 sherpa 要读的元数据 [一手 S9]。再按 sherpa-mnn README 的流程转：`MNNConvert -f ONNX --weightQuantBits=8 --weightQuantBlock=64`，**从 fp32 ONNX 转，不要转 int8 ONNX** [一手 S5]。k2-fsa 在 GitHub release `asr-models` 提供现成的 fp32/int8 导出包（含 tiny、tiny.en、base 等）[一手 S10]，本机已有 M7 的转换脚本 `scripts/mnn/convert_all.py` 可套 [一手 S17]。

已知坑：

- **编码器输入长度**：k2 导出已把位置编码改为按输入长度切片，所以不必固定 30 秒；但没有一手数据说明 MNN 对变长编码器的数值是否稳定，早期有人遇到动态维度为 -1 与输出偏差（#2745，旧版本，2024 年）[一手 S6]。**需在桌面做 ORT 与 MNN 逐输出对拍**（M7 对 zipformer 已有此流程 [一手 S17]）。
- **解码器自回归**：k2 方案是固定形状的自注意力 KV 缓存（`n_text_layer×1×448×384`）+ `offset`，而不是动态增长的缓存，所以对 MNN 友好（形状固定）；代价是每步更新整块缓存，步数多时有拷贝开销 [一手 S2、S3]。无一手性能数据。
- **词嵌入表体积**：见 3.1，解码器大头是 fp32 嵌入表。
- **fp16 与无点积机器**：测试机无 fp16，fp16 档不会更快，只省存储，且无一手数值验证。
- 无一手证据的点：k2 导出的 whisper 在 MNN 下 w8 与 fp32 的文字对拍结果。社区作者只说“working perfectly”（tiny.en）[一手 S6]，**无数字，未核实**。

## 7. 候选对照（若真要多语种/粤语）

| 方案 | 体积 | 语言 | 流式 | MNN 路径 | 备注 |
|---|---|---|---|---|---|
| whisper-tiny（本文） | 约 102MB | 99 种，无粤语标签 | 否 | sherpa-mnn 有代码，社区文件 | 中文 CER 约 40% |
| whisper-base | 约 163MB | 同上 | 否 | 同上 | 中文 CER 约 34% |
| SenseVoice-Small | 现有 sherpa-onnx int8 包 163MB [一手 S10] | 中/粤/英/日/韩 [一手 S16] | 否 | sherpa-mnn 有 `offline-sense-voice-model.cc`（源码在）[一手 S1] | 许可为 FunASR 模型协议，**未核实**；MNN 实测未做 |
| Qwen3-ASR-0.6B | 权重约 0.94B 参数量级（safetensors 总数 938,008,576）[一手 S15] | 30 语种 + 22 方言，含粤语 | 官方称支持流式（仅 vLLM 后端）[一手 S15] | MNN LLM 引擎已支持（PR #4478）[一手 S15] | Apache-2.0；体积与端侧速度未知，需测 |

这几项只作线索，不在本文展开。SenseVoice 的中粤质量声明来自其 README，**未核对具体数字**。

## 8. 许可

| 项 | 许可 | 来源 |
|---|---|---|
| whisper 代码与权重（OpenAI GitHub） | MIT | [一手 S11] |
| `openai/whisper-tiny` HF 模型卡 | 标 **apache-2.0**（与 GitHub 的 MIT 不一致，二者都宽松；再分发时建议两份许可证文本都带，或以 GitHub 仓库的 MIT 为准） | [一手 S13] |
| MNN / sherpa-mnn | Apache-2.0 | [一手 S1 的仓库许可接口] |
| k2-fsa 的 whisper 导出包 | HF 页面无许可声明（卡片为空），按“whisper 权重的转换产物”处理为 MIT，**未核实** | [一手 S10] |
| 社区 MNN 转换：tiny / tiny.en / base / small | tiny 无声明；tiny.en 与 base 标 apache-2.0；small 标 mit；均无 README、无来源说明 | [一手 S7] |
| `pgf20160610/whisper-mnn` | Apache-2.0 | [一手 S8] |

**许可是否清楚**：上游（whisper 权重 MIT、MNN Apache-2.0）清楚；**社区转换仓库不清楚**（标签互相不一致，tiny 空白）。转换后的权重是上游权重的派生，按 MIT 保留版权声明即可，但社区仓库自己的标注不能作为依据。**稳妥做法是自己从 k2 包转一遍**，并随包带 whisper 的 MIT 文本（与 M7 遗留的“语音包没带许可证文本”一并补上 [一手 S17]）。

## 9. 结论与建议

**值不值得引入**：不值得替换现用语音识别，也不值得为中文口述引入。理由：中文差一个数量级、英文差一倍、没有流式、取消要自己写解码循环；体积省的 66MB 换不来这些。

**并存的唯一理由**：给“录音/文件转写”或“其他语种”留一条路。此时 tiny 仍偏弱，若用户有这类需求，优先考虑 base（体积与现用持平）或 SenseVoice / Qwen3-ASR（第 7 节），而不是 tiny。需用户拍板：是否要做这个场景。

**若引入的建议**：

- 来源：自己从 k2 fp32 导出包转（`MNNConvert` 固定提交，w8，`pack.py` 登记），不直接依赖社区文件；先不动词嵌入表量化，另开一步试。
- 档位：w8。测试机无 fp16，fp16 只省存储，不进候选。
- 引入新依赖需用户确认：新增的是一个模型包（非新运行库），原生库与 Kotlin API 均已在项目依赖内（sherpa-mnn 已有，只需拷 `OfflineRecognizer.kt` 与 `OfflineStream.kt` 等 Kotlin 文件，来自同一仓库）。待确认清单入 `docs/status.md`。

**最小 POC（不改项目代码前提下的做法，仅建议）**：

1. 桌面：用 k2 的 fp32 tiny 导出包与 sherpa-mnn 的桌面可执行（M7 已编出）跑 4 条测试音频，分别用 `language=zh`、自动检测，记录字错率与耗时；同一音频与现用 zipformer 并排比对。
2. 桌面对拍：ORT 与 MNN 输出逐字比，验证 w8 不掉字（沿 M7 流程）。
3. 真机：把 `.mnn` 与 tokens 放到应用外部目录，用 debug 入口调 `OfflineRecognizer`（`modelType=whisper`），记录 STG-AL00 上 5 秒、15 秒、30 秒音频的总耗时、峰值内存、有无 6 token/秒截断。
4. 若 RTF 与准确率都过不了线（建议线：5 秒句子 ≤ 3 秒出字、中文字错率 ≤ 15%），到此为止，不写自研解码循环。
5. 只有通过前四步，才考虑在 Rust 里写带取消的解码循环（第 5 节）。

**风险与待核实项**：

1. 【最大】**tiny 在真实中文口语上的字错率没有项目内数据**；论文数字来自 PDF 文本提取，列对应是推断，需对照原表。
2. 手机端 RTF、内存、解码步耗时：无一手数据，需真机。
3. 社区 MNN 文件的转换细节（量化方式、是否含元数据外改动）与许可：推断多、声明少。
4. sherpa-mnn 的“每秒最多 6 token”上限是否截断中文：需真音频验证。
5. 现有 `libsherpa-mnn-jni.so` 的 `OfflineRecognizer` JNI 只核对了符号字符串，没有在设备上真正加载 whisper 模型跑过。
6. 词嵌入表能否被 MNNConvert 量化、对精度的影响：未核实。
7. ModelScope 上是否有 whisper MNN 模型：接口未通，未核实。
8. SenseVoice 的许可与 Qwen3-ASR 在 MNN 下的端侧速度：未核实。

## 来源清单

- S1：alibaba/MNN 仓库（master，2026-10-21，GitHub API 文件树与仓库许可接口），`apps/frameworks/sherpa-mnn`、`apps/Android/MnnLlmChat`、`tools/audio`、`transformers/llm/export`。https://github.com/alibaba/MNN
- S2：`apps/frameworks/sherpa-mnn/sherpa-mnn/csrc/offline-whisper-model.cc`（MNN 仓库）。
- S3：同目录 `offline-whisper-greedy-search-decoder.cc`。
- S4：同目录 `offline-recognizer-whisper-impl.h`。
- S5：`apps/frameworks/sherpa-mnn/README.md`。
- S6：alibaba/MNN issues：#4275（whisper-tiny 转 MNN）、#4276（请求转换新模型，维护者回复）、#2745（早期转换失败）。
- S7：HF `developerabu/whisper-tiny-mnn`、`whisper-tiny-en-mnn`、`whisper-base-mnn`、`whisper-small-mnn`（API 文件列表；tiny 编码器文件下载后做二进制元数据核对）。
- S8：GitHub `pgf20160610/whisper-mnn`（README、`export_model.sh`、仓库许可接口）。
- S9：k2-fsa/sherpa-onnx `scripts/whisper/export-onnx.py`。
- S10：HF `csukuangfj/sherpa-onnx-whisper-tiny`、`sherpa-onnx-whisper-base` 文件列表；k2-fsa/sherpa-onnx release `asr-models` 资产列表（含 SenseVoice int8 包）。
- S11：openai/whisper 仓库 README、`whisper/tokenizer.py`、仓库许可接口。https://github.com/openai/whisper
- S12：Radford 等，*Robust Speech Recognition via Large-Scale Weak Supervision*，arXiv 2212.04356（Table 11 CommonVoice9、Table 13 FLEURS；PDF 文本提取）。
- S13：HF `openai/whisper-tiny` 模型卡、`config.json`、文件列表；`openai/whisper-tiny.en` 模型卡。
- S14：HF `GilgameshWind/X-ASR-zh-en` 模型卡（Evaluation 表、许可）。
- S15：HF `Qwen/Qwen3-ASR-0.6B` 模型卡；alibaba/MNN PR #4478（Qwen3-ASR 导出与运行时）。
- S16：FunAudioLLM/SenseVoice README；MNN 仓库 `offline-sense-voice-model.cc`（存在性）。
- S17：本项目文档：`docs/research/onnx-to-mnn-migration.md`（M7 语音、真机 RTF 0.20、`asr-mnn-v1` 清单）、`docs/status.md`；本机缓存 `libsherpa-mnn-jni.so`（sha `aa79262f…c339`）的符号字符串核对。
- S18：MNN `tools/audio/include/audio/audio.hpp`（`whisper_fbank`）；MNN PR #4963。
- S19：`apps/frameworks/sherpa-mnn/sherpa-mnn/kotlin-api/OfflineRecognizer.kt`。
- S20：HF `taobao-mnn` 组织模型列表（按 whisper/asr 等关键词检索，无结果；有 Qwen2-Audio、Qwen2.5-Omni 等）。
