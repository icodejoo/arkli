---
title: ONNX 全量迁移到 MNN：盘点、spike 实测与施工方案
status: draft
updated: 2026-10-16
summary: 识物、翻译、语音、OCR 从 ONNX Runtime 迁到 MNN 是否可行、怎么转换和量化、目标架构、分步施工清单（给 sonnet low）、验收门槛与需要用户拍板的事
---
## TL;DR

- **全部可迁，没有必须保留 ONNX 的模型。** 识物 SigLIP2、翻译 NLLB、语音 zipformer、OCR 都已在桌面转成 MNN 并与 ORT 对过数；Qwen 本来就是 MNN。语音走 MNN 仓库自带的 **sherpa-mnn**（sherpa-onnx 的 MNN 改版），JNI 已用 NDK 28 + 我们固定提交的 `libMNN.so` 编出来（2.69MB）。
- **质量反而能变好**：现网 int4 是 ORT 的 `MatMulNBits`，MNN 不认；我们改从 fp32 原版出发、由 MNN 做 int8 仅权重量化。NLLB 现网 int4 在 29 句里有 4 句退化成“I'm going to be a little late.”，MNN int8 一句都没有；SigLIP2 向量余弦从 0.961 提到 0.991（运行态）。
- **体积**：去掉 `libonnxruntime.so`（22.25MB）和 `libsherpa-onnx-jni.so`（4.77MB），加 `libsherpa-mnn-jni.so`（2.69MB），APK 原始体积约 **−24.3MB**。模型下载量基本持平（SigLIP2 +40MB，可选 6 位方案只 +17MB）。
- **推荐架构**：Rust 仍是推理引擎层（UniFFI 边界不变），新增一层自写 C ABI（放进现有 `libarkli-mnn.so`），Rust 运行时按裸名 `dlopen`，与今天 `ort` 的 load-dynamic 同一套路；语音照旧在 Kotlin 侧，换成 sherpa-mnn。统一 AI 协议的提供者、端口、路由**一个都不用改**。
- **还没验证的**：全部真机数据（真机已收回，所有速度/内存只有桌面相对值）；目标机 STG-AL00 没有 dotprod/fp16，MNN int8 内核在它上面的速度必须实测后才能拍板。

## 1. 结论与需要拍板的事

| # | 事项 | 推荐默认 | 阻塞哪一步 |
|---|---|---|---|
| 1 | 修订决策 0002（“统一用 sherpa-onnx”）——**这会推翻 0002 的主体** | 同意分阶段迁；M9 删 ORT 时再正式改 0002 | M9 |
| 2 | SigLIP2 发布格式：int8 逐通道 94.8MB（运行态 cos 0.991）/ 6 位 HQQ 71.6MB（0.984） | int8 | M5 |
| 3 | NLLB 发布格式：6 位 HQQ 约 388MB（与现网持平）/ int8 约 493MB；两者质量与运行内存相同 | 6 位 HQQ（真机加载若明显变慢再换 int8） | M6 |
| 4 | Rust 侧 `dlopen` 用 `libloading`（已在 Cargo.lock 里，ort 的传递依赖，ISC）还是自写 | 用 `libloading`，钉版本 | M3 |
| 5 | 过渡期 APK 同时带 ORT 与 MNN（多约 2.7MB），每个模型真机过关再删 ORT | 是 | M5~M9 |
| 6 | 新依赖与对外发布（见下） | — | 各步 |

**需要用户同意的新依赖 / 下载 / 发布**：

- 开发机工具（只在 `scripts/mnn/` 用，不进 APK）：pip `MNN==3.6.1`（Apache-2.0；**它的 `mnnconvert` 包装脚本会带机器 ID 上报阿里云、还会自动 `pip install aliyun-log-python-sdk`**，我们只通过 `_tools.mnnconvert` 调用来绕开）、`onnx`、`onnxruntime`、`numpy`、`tokenizers`、`pillow`、`psutil`。
- 原生：sherpa-mnn（MNN 仓库 `apps/frameworks/sherpa-mnn`，Apache-2.0）及它构建时拉取的 kaldi-native-fbank / kaldi-decoder / kaldifst / openfst / simple-sentencepiece（均 Apache-2.0）、eigen（MPL-2.0，仅头文件）。这些在现用的 sherpa-onnx AAR 里本来就有，不是新类别。
- 下载（构建期，aria2）：NLLB fp32 原版（Xenova `encoder_model.onnx` 1,658,468,942 B、`decoder_model_merged.onnx` 1,865,158,686 B）、SigLIP2 `vision_model.onnx` 371,807,752 B、语音 fp32 包 584,120,230 B。sha256 见第 5 节。
- 对外发布（**由用户执行上传**）：release `mnn-478c10e-v2`（三个 so：不变的 `libMNN.so` 4,899,952 B `9cc1ff8b…a353`、新 `libarkli-mnn.so` 71,592 B `b4c9bf34…0f40`、新 `libsherpa-mnn-jni.so` 2,690,520 B `aa79262f…c339`；同一下载前缀，缺一个都会构建失败）、`siglip2-mnn-v1`、`nllb-mnn-v1`、`asr-mnn-v1`、（OCR 接入时）`ocr-mnn-v1`。

## 2. 盘点（现状，file:line）

| 位置 | 用 ONNX/ORT 的地方 |
|---|---|
| `app/build.gradle.kts:95-218` | `fetchOrtRuntime`：从 sherpa-onnx 1.13.8 AAR 取 `libonnxruntime.so`（ORT 1.28.2，22.25MB）、`libsherpa-onnx-jni.so`、`classes.jar`，sha256 校验 |
| `app/build.gradle.kts:226-272` | `fetchMnnRuntime`：release `mnn-478c10e-v1` 的 `libMNN.so`（sha `9cc1ff8b…`）与 `libarkli-mnn.so` |
| `core/crates/arkli-ai/Cargo.toml:11,17` | feature `ort-backend`，`ort =2.0.0-rc.14`（load-dynamic） |
| `core/crates/arkli-ai/src/backend.rs:87-115` | `Session` / `InferenceBackend` 抽象（单输入单输出 + `run_named`） |
| `core/crates/arkli-ai/src/ort_backend.rs:147-260` | ORT 实现、进程级共享环境 |
| `core/crates/arkli-ai/src/translate/engine.rs:20-25,535-1290` | 翻译引擎**直接**用 ort 类型（`DynValue`、`SessionOutputs`、merged decoder、KV、束搜索重排） |
| `core/crates/arkli-ffi/src/clip.rs:123`、`translate.rs:87` | `clip_load(ort_lib, …)`、`translate_load(ort_lib, …)` |
| `app/src/main/kotlin/com/let188/arkli/ai/AndroidClip.kt:23`、`AndroidTranslate.kt:43` | `ORT_LIB_NAME = "libonnxruntime.so"` 传给 Rust |
| `app/src/main/kotlin/com/let188/arkli/speech/SpeechEngine.kt:5-12,214-235` | sherpa-onnx Kotlin API，`OnlineRecognizer` zipformer2 transducer |
| `app/src/main/kotlin/com/let188/arkli/speech/SpeechPolicy.kt:14-38` | 模型目录与文件名（`encoder.int8.onnx` 等，手动放置） |
| `native/mnn/arkli_mnn_jni.cpp` | 只有 LLM 三个 JNI 函数；`giveBackMemory()` = `Executor::gc(FULL)` + `mallopt(M_PURGE)` |
| `native/mnn/build.sh:10,42-48` | 固定提交 `478c10e…`，`MNN_BUILD_LLM=ON`（**会强制打开 `MNN_LOW_MEMORY`**，见 MNN `CMakeLists.txt:118-119`）、`MNN_ARM82=OFF` |

| 模型 | 用途 | 现格式 / 体积 | 推理位置 | 能否迁 | 难点（已解决方式） |
|---|---|---|---|---|---|
| `siglip2-q4_half` | 识物 | ORT int4 `MatMulNBits` + fp16 scale，54.7MB | Rust `clip` | 能 | MNN 不认 `MatMulNBits` → 从 fp32 原版转 |
| `nllb600m-un6-ccm-int4` | 翻译 | encoder+merged decoder，`If` + KV，int4，388MB 权重 | Rust `translate` | 能 | `If` 拆成两张图、嵌入表移出图外、交叉 KV 单独小图（第 3.3 节） |
| `asr-zipformer-zh-en-int8`（未进清单，手动放置） | 语音输入 | encoder/decoder/joiner，ORT int8，约 169MB | sherpa-onnx JNI（ORT 链在里面） | 能 | 整个换成 sherpa-mnn JNI；模型从 fp32 包转 |
| PP-OCRv5 det/rec/cls（未上线） | OCR | fp32，22.5MB | Rust `pipeline`（还没接 UniFFI） | 能 | 小 CNN 不能 int8，用 fp16 存储 |
| 对联 GPT-2（release 已有，未接 App） | 对联 | ORT int4，88MB | 未接入 | 能（未实测） | 同 NLLB decoder 做法，接入时再做 |
| `qwen35-0.8b-mnn-q4` | L2 文本 | 已是 MNN | JNI | — | — |

另：`docs/research/spike-ort-sherpa.md`、`couplet-gpt2-onnx.md`、`garbage-classify-clip.md` 里的 ONNX 结论随迁移逐步标注过期，不在本次改动。

## 3. 调研与 spike 结果（证据）

**环境**：Windows 10、i5-13500、4 线程；MNN pip 3.6.1（运行时，x86）、ORT 1.31.0；固定提交的 `MNNConvert` 与 `ModuleBasic` 用 MSVC 14.44 在本机编出。**下面所有速度/内存都是桌面相对值，不代表手机。** spike 脚本与日志在会话 scratchpad `mnn-spike/`（不入库），M1 会把要用的脚本正式落到 `scripts/mnn/`。

### 3.1 转换工具链

- 固定提交的版本头是 3.6.1（`include/MNN/MNNDefine.h:75-77`），`3.6.1...478c10e` 领先 190 个提交；schema 增加 `FusedLinear`/`GatedRMSNorm`、**删了 `AttentionParam.attnScale`**（只影响 `--transformerFuse` 生成的融合注意力，我们不开），转换器有十几个 ONNX 修复（Softmax 旧 opset 默认值、Pad、Slice、Shape int64 等，GitHub compare 与 commits API 核实）。
- 用固定提交 MNNConvert 与 pip 3.6.1 分别转 SigLIP2 int8 和 NLLB 三张图：**体积逐字节相同、仅 27 个字节不同（模型 UUID），推理输出逐位一致**，NLLB 29 句 token 序列 29/29 相同。结论：**生产用固定提交编出的 MNNConvert**，pip 版可当等价的试验工具。
- Windows 编译坑：VsDevCmd 的扩展脚本在该环境下报错，改为手动设 `PATH/INCLUDE/LIB`（MSVC 14.44 + SDK 10.0.26100）；批处理必须 CRLF、纯 ASCII。
- 量化选项：`--weightQuantBits 2~8`、`--weightQuantBlock`、`--hqq`、`--fp16`、`--saveExternalData`。实测 **`--weightQuantAsymmetric` 与 `--weightQuantBlock` 同时给时分块不生效**（体积少了正好一份分块 scale），别这么用。
- ONNX 的 `metadata_props` 会被带进 .mnn（`tools/converter/source/onnx/onnxConverter.cpp:189`），sherpa-mnn 靠它读 `T`、`decode_chunk_len` 等，已用二进制检索确认。

### 3.2 运行时的两个关键开关（踩坑重点）

- `memory=normal`：权重量化模型**加载时还原成 float**，内存等于 fp32 体积（NLLB 实测 RSS 2.85GB），手机上不能用。
- `memory=low`：保持量化权重，对激活做**动态 int8 量化**（需 `MNN_LOW_MEMORY`，现有 libMNN.so 已开）。5/6 位权重运行时按 int8 展开，**6 位只省下载、不省内存**；4 位保持 4 位。
- 内存峰值：Module 加载时有约 2.5× 的瞬时峰值。`rearrange=true` 让稳态回到权重体积；再配 **`--saveExternalData` 外置权重**，NLLB 峰值从 +1094MB 降到 +563MB。外置权重路径挂在 RuntimeManager 上，**多个模型共用一个 RuntimeManager 时必须“设路径→加载→清空”**（MNN-LLM 的做法，`transformers/llm/engine/src/llm.cpp:411-419`），否则第二个模型会读错权重文件。
- MNN 能正确处理长度为 0 的 KV 输入（NLLB 首步 past 长度 0），int64 输入在 MNN 里是 int32。

### 3.3 NLLB（翻译）

做法（全部实测通过）：

1. 从 Xenova fp32（sha 已对 HF LFS）出发，按随包 `tokenizer.json`（61,795 词）把 token 字符串映射回原 id，抽出嵌入行与 lm_head 列——**复现了现网包的词表裁剪**，但保留 fp32 精度。
2. 嵌入表移出图：删 `Gather`，图改收 `inputs_embeds`（缩放仍在图里）；encoder 与 decoder 共用一张表（已校验相等），另存为 int8 + 每行 scale（63MB）。不移出的话 MNN 会把 253MB 的 fp32 表原样存进 .mnn。
3. 拆 merged decoder 的 `If`：`else_branch`=首步、`then_branch`=后续步。再**手写 `cross_kv` 小图**（每层 `H·Wk+bk → Reshape[0,-1,16,64] → Transpose`），所有步都走 `decoder_step`，首步喂长度 0 的自注意力 past。这样自注意力/FFN/lm_head 不再存两份。ORT 下这套拆法与参考**逐位一致**（29 句 teacher forcing 一致率 100%，最大误差 0.000）。
4. 坑：onnx 写外部数据会**追加到已存在的同名 `.data` 文件**，脚本必须先删旧文件。

结果（29 句，6 种语言，贪心，以拆图 fp32 为参考；“一致率”= teacher forcing 下逐步 top-1 相同的比例）：

| 配置 | 一致率 | 与 fp32 逐 token 相同句数 | 退化句 | 编码 ms | 解码 ms/token | 稳态内存* | 峰值* | 下载 |
|---|---|---|---|---|---|---|---|---|
| ORT 现网 int4 | 91.3% | 18/29 | 4 | 21 | 30.8 | +321MB | +400MB | 388MB |
| MNN int8，low | 97.1% | 25/29 | 0 | 13 | 20.4 | +446MB | +563MB（外置权重） | 约 493MB |
| MNN 6 位 HQQ，low | 97.1% | 24/29 | 0 | 13 | 20.6 | 同上 | — | 约 388MB |
| MNN 4 位 b32 HQQ，low | 90.8% | 15/29 | 0 | 12 | 17.7 | +344MB | — | 约 386MB |
| MNN int8，normal | 100% | — | 0 | 47 | 86 | 2.85GB | — | 不可用 |

\* 扣除 Python 进程基线；含 int8 嵌入表。混合精度（任一图用 4 位）一致率都掉到约 93%，没有收益；动态量化选项（`DYNAMIC_QUANT_OPTIONS`）只把 97.1% 推到 97.7%。

“你好世界”在 fp32 下也译成 “Good luck to you.”，属于 600M 蒸馏模型本身，不是量化能修的；Xenova 全词表 int8 能译对是偶然（另一个子代理的对照实验在 scratchpad `exp/`）。MNN 的 LLM 导出器只支持 decoder-only 模型，没有 M2M100/NLLB 路径，所以只能走上面的自拆方案。

#### 3.3.1 词表问题（M6a，2026-10-15）

起因：英译中出现“lazy dog→惰的狗”（缺“懒”）、“sunny day→阳光明的天”，怀疑六语裁剪词表（61,795/256,204）丢了常用字。**结论：不是裁剪丢的，是 NLLB 原版就没有**（脚本 `scripts/mnn/vocab_audit.py`，语料 `scripts/mnn/data/audit_*.txt`）：

| 检查项 | 数据 |
|---|---|
| GB2312 一级 3755 + 二级 3008 = 6763 字，有单字词条 | 官方 SentencePiece、原版 tokenizer.json、随包裁剪词表**同为 2575 个，缺 4188 个**（一级缺 1276、二级缺 2912）；原版有而裁剪丢了：**0** |
| 缺的字举例 | 懒 媚 妈 汤 哎 笨 苹 蕉 橘 钓 饺 咱 撸 瞧……（“晴”在词表里，“阳光明的天”是“媚”变 `<unk>` 被引擎丢掉） |
| 六语语料（中 219、英 67、法 67、西 66、俄 66、阿 65 句）与原版分词逐 token 一致 | 中 219/219、英 67/67、法 67/67、西 65/66（`▁rana` 被切成 `▁r`+`ana`）、俄 66/66、阿 65/65 |
| 含 `<unk>` 的句子（原版与随包词表相同） | 中 42/219，法/西/阿各 1，俄 3，英 0；非中文的 UNK 全部来自 `« » —` |
| fp32 原模型在缺字处的行为 | 概率直接压在 `<unk>`（懒→`<unk>` 0.32，媚→`<unk>` 0.95）；引擎禁掉 `<unk>` 才退成“惰”“阳光明的天” |
| 繁体字救援（Unihan `kTraditionalVariant`，缺字的繁体形在词表里） | 只有 144/4188（3.4%），不值得做 |

所以“补字”在词表层面做不到：没有嵌入行，也没训练过。能修的是**标点**：原版 tokenizer 没带 NLLB 训练数据用过的 Moses 标点规范化，`“ ” ‘ ’ « » – — 《》【】` 全是 `<unk>`（手机输入法、法/西/俄文的引号和破折号很常见）。

**词表 v2**（`scripts/mnn/vocab_build.py`，产出 `dl/nllb-tok-v2/tokenizer.json`）：
- 保留集 = 随包 61,795 词 ∪ 补充集（GB2312 与六语文字的原版单字、审计语料里原版用到的 token）∪ 特殊 token + BPE 闭包；本次补充集实际只有 `▁rana` 一个词，**共 61,796 行**（+1）。按原版 id 升序顺排，`<s>=0 <pad>=1 </s>=2 <unk>=3` 不变，语言码排最后（arb 61790 起，zho_Hans 61795）。
- normalizer 在 Precompiled 之后插入 Replace 补丁（“”«»《》〈〉〝〞→`"`，‘’‚→`'`，–→`-`，—→` - `，【〖→`[`，】〗→`]`，～→`~`，bidi 控制符删除）；其余字段（pre_tokenizer、decoder、charsmap、`Replace` 多空格、`Strip`）原样取自随包 tokenizer.json。tokenizers 0.23.3 加载通过。
- 自检：新词表里每个 token 逐词重新分词都得到自身（原版可达而新词表不可达 0）；550 句语料与“原版全词表 + 同一套 normalizer”分词逐 token 一致 550/550；补丁后六语含 `<unk>` 句只剩中文的缺字句（非中文 0）。
- **译文级等价**（`eval_vocab_equiv.py`，149 句）：原版 fp32 全词表（ORT merged）与新词表 fp32 拆图，token 序列完全相同 **149/149**，即裁剪到 61.8k 词对贪心译文零影响。
- 体积：嵌入 int8 = 61,796×1024 + 4×61,796 = 63,526,288 B（比随包 +1,024+4 B）；decoder 的输出投影随词数线性，每 +1 词 6 位约 +768 B、8 位约 +1 KB。整包：6 位 **392,177,035 B（374.0MB）**，8 位 **496,114,242 B（473.1MB）**，与此前 M1 的 392MB / 496MB 基本一致（差 ~2KB）。

### 3.4 SigLIP2（识物）

30 张本机图片（系统壁纸与 MNN 仓库样图），以 ORT fp32 为基准；top-1 用随包 `garbage_vocab.f16` 词表：

| 配置 | 体积 | cos 均值/最小 | top-1 一致 | 延迟 | 内存（稳态/峰值） |
|---|---|---|---|---|---|
| ORT q4_half（现网） | 54.7MB | 0.9612 / 0.9143 | 0.833 | 120ms | +101MB |
| MNN fp32 | 371.8MB | 1.0000 | 1.000 | 124ms | +372 / +1080MB |
| MNN int8，low（推荐） | 94.8MB | 0.9908 / 0.9564 | 0.933 | 122ms | **+107 / +284MB**（rearrange） |
| MNN int8，normal | 94.8MB | 0.9995 / 0.9983 | 1.000 | 134ms | +459MB（解压成 float） |
| MNN 6 位 HQQ，low | 71.6MB | 0.9838 / 0.9462 | 0.867 | 116ms | +174MB（未开 rearrange；开了未测） |
| MNN 4 位（各种分块/HQQ） | 59~94MB | 0.90~0.95 | 0.67~0.80 | — | 更低 |

旧文档里 ORT int8 余弦只有 0.77，原因是 ORT 动态量化把激活也量化了；MNN 的仅权重量化没有这个问题。把 q4_half 的 int4 网格原样搬进 MNN int4 反而掉到 0.82~0.88，所以别走“反量化再 4 位”这条路。

### 3.5 语音（sherpa → sherpa-mnn）

- 现用模型 `sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct`（2026-06-05）有 fp32 包（GitHub release `asr-models`，584,120,230 B，digest `7e82f0a2…`，已校验）。sherpa-mnn 文档明确要求从 fp32 转、别转 int8 ONNX。
- 结构对得上：sherpa-mnn 的 zipformer2 期望 `层数×6+2` 个状态、`processed_lens` 按 int 处理（`online-zipformer2-transducer-model.cc:225-330`）；本模型层数 2+2+4+5+4+2=19，正好 116 个状态。
- 自写 numpy Kaldi fbank + 流式贪心解码，4 条中英混说测试音频：

| 配置 | 结果 | 编码器 RTF | 进程 RSS |
|---|---|---|---|
| ORT fp32 | 基准 | 0.124 | 708MB |
| ORT int8（现网） | 1 处少逗号 | 0.076 | 292MB |
| **MNN int8 逐通道，low** | **与 fp32 逐字一致** | **0.054** | **259MB** |
| MNN int4 b32 HQQ | “频繁→平凡”“时态→时代”等错字 | 0.055 | 222MB |

- sherpa-mnn JNI：NDK 28、`BUILD_SHARED_LIBS=OFF`、关掉 TTS/说话人分离/websocket/portaudio，链接固定提交的 `libMNN.so`（sha `9cc1ff8b…`），产物 `libsherpa-mnn-jni.so` 剥离后 2,685,976 B（gzip -9 967,869 B），NEEDED 只有 `libMNN.so` 与系统库。（M7 由 `native/mnn/build-sherpa-mnn.sh` 正式重编：2,690,520 B、gzip -9 968,155 B，见 M7 一节。）Windows 上 FetchContent 路径超 260 字符会失败，用 `subst` 映射短盘符解决。
- 风险：sherpa-mnn 基于 sherpa-onnx **1.10.46**（我们用 1.13.8），Kotlin 包名 `com.k2fsa.sherpa.mnn`，`OnlineRecognizerConfig`/`OnlineModelConfig`/`FeatureConfig`/`EndpointRule` 字段同构；JNI 端到端还没在手机上跑过。兜底方案：自己写流式解码（spike 的 Python 版约 150 行，fbank + 状态管理 + 贪心），放 Rust，模型仍用 MNN。

### 3.6 OCR（PP-OCRv5，ModelScope RapidAI，sha 与 API 一致）

8 张合成文字图（微软雅黑，中英混排，带旋转与噪声）：

| 配置 | det 二值图 IoU | rec 逐步 argmax | cls | 体积（det+rec+cls） |
|---|---|---|---|---|
| MNN fp32 | 1.0000 | 320/320 | 8/8 | 22.3MB |
| **MNN fp16 存储（推荐）** | 0.9949 | 319/320 | 8/8 | **11.3MB** |
| MNN int8，normal / low | 0.92 / 0.75 | 304/320 | 8/8 | 6.2MB |

### 3.7 固定提交运行时的一致性（桌面）

用 `ModuleBasic`（固定提交，MSVC 编）跑 ORT 生成的用例：SigLIP2 fp32 误差率 2×10⁻⁶；NLLB int8 三张图在 normal 下 0.3%~1.5%、low 下 0.7%~1.8%（相对 fp32 参考，量化误差属预期）。工具内置门槛是 1%，**只适用于 fp32/fp16 模型**；量化模型用任务指标判。MSVC 版缺 AVX 内核分发，耗时不可参考。安卓版 `ModuleBasic.out`（84KB）与 `benchmark.out`（270KB）已编好，留给真机验收。

## 4. 目标架构

### 4.1 方案比较

| 方案 | 说明 | 体积 | 性能 | 生命周期/内存 | 测试 | 构建复杂度 | 结论 |
|---|---|---|---|---|---|---|---|
| A. Rust 经自写 C ABI 调 MNN | `libarkli-mnn.so` 增加 `extern "C"` 薄封装；Rust `dlopen` 裸名 | 最小（无新 so） | KV 句柄留在 C++ 侧，不来回拷 | 沿用 `AiHeavyGate`、`AiRecycle`、`purge_heap` | Rust 现有 mock 模式不变；真库测试用桌面 DLL | 低：只加一个 cpp | **推荐** |
| B. C++/JNI 封装会话，Kotlin 编排 | Rust 只做分词/束搜索 | 同上 | NLLB 每个 token 要 JNI→Kotlin→Rust 来回 | 同上 | 推理循环落到 Kotlin，难单测 | 中 | 只适合单次推理模型，不选 |
| C. 用第三方 `mnn-rs` 之类 crate | | +新依赖 | 同 A | 同 A | 同 A | 绑定版本难跟固定提交 | 不选 |

语音单独：Kotlin + sherpa-mnn JNI（与今天的 sherpa-onnx 同位置），不进 Rust。

### 4.2 C ABI（新增 `native/mnn/arkli_mnn_capi.h/.cpp`，编进 `libarkli-mnn.so`）

```c
// 所有函数线程不安全，由调用方串行（Rust 侧 Mutex + Kotlin AiHeavyGate）。
#define ARKLI_MNN_ABI 1
typedef struct arkli_mnn_net arkli_mnn_net;   // 一个 Module + 自己的 RuntimeManager
typedef struct arkli_mnn_val arkli_mnn_val;   // VARP 句柄，引用计数
typedef struct { int threads; int memory; int precision; int rearrange; } arkli_mnn_config; // memory: 0 normal / 2 low
enum { ARKLI_F32 = 0, ARKLI_I32 = 1 };
int  arkli_mnn_abi_version(void);
arkli_mnn_net* arkli_mnn_net_load(const char* model, const char* weight /*可空：外置权重*/,
    const char* const* in_names, int n_in, const char* const* out_names, int n_out,
    const arkli_mnn_config* cfg, char* err, int err_len);
arkli_mnn_val* arkli_mnn_val_new(int dtype, const int32_t* shape, int ndim, const void* data); // 拷贝 data
int  arkli_mnn_val_shape(const arkli_mnn_val* v, int32_t* shape, int cap);  // 返回 ndim
const void* arkli_mnn_val_read(arkli_mnn_val* v);  // 只读视图，生命周期跟句柄
int  arkli_mnn_net_forward(arkli_mnn_net* n, arkli_mnn_val* const* in, int n_in, arkli_mnn_val** out, int n_out, char* err, int err_len);
void arkli_mnn_val_free(arkli_mnn_val* v);
void arkli_mnn_net_free(arkli_mnn_net* n);
void arkli_mnn_release_memory(void);  // Executor::gc(FULL) + mallopt(M_PURGE)
```

要点：`net_load` 内部每个模型一个 RuntimeManager，`setExternalFile(weight)`→`Module::load(..., rearrange)`→`setExternalFile("")`；`val_new` **必须拷贝**数据（MNN 的 `_Const` 只借用内存，pymnn 已因此崩过）；所有异常在边界内捕获转成错误字符串；符号用 `__attribute__((visibility("default")))` 导出（现 CMake 是 `-fvisibility=hidden`）。

#### 4.2.1 M2 落地后的接口说明（以 `native/mnn/arkli_mnn_capi.h` 为准）

与上面草图相比的差异与补充（M3 的 Rust 绑定按这里写）：

| 符号 | 说明 |
|---|---|
| `arkli_mnn_abi_version()` | 返回 `ARKLI_MNN_ABI`（现为 1）；`dlopen` 后先校验 |
| `arkli_mnn_config_default(cfg)` | **新增**：填 threads=4、memory=2(low)、precision=0、rearrange=1；`net_load` 的 `cfg` 传 NULL 等价于它 |
| `arkli_mnn_net_load(model, weight, in_names, n_in, out_names, n_out, cfg, err, err_len)` | 成功返回会话，失败返回 NULL。`weight` 为 NULL/空串表示权重在 .mnn 里 |
| `arkli_mnn_val_new(dtype, shape, ndim, data)` | 一定拷贝 `data`。`ndim` 0..8，允许某维为 0（此时 `data` 可为 NULL，用于首步长度为 0 的 KV）；只有 `ARKLI_F32` / `ARKLI_I32` |
| `arkli_mnn_val_shape(v, shape, cap)` | 返回 ndim，最多写 `cap` 个维度，`shape` 可为 NULL |
| `arkli_mnn_val_dtype(v)` | **新增**：返回 `ARKLI_F32` / `ARKLI_I32` |
| `arkli_mnn_val_read(v)` | 只读数据指针（按 dtype 当 float 或 int32 读），元素数为 0 时返回 NULL；生命周期跟句柄 |
| `arkli_mnn_net_forward(net, in, n_in, out, n_out, err, err_len)` | 按位置对应加载时的名字顺序；成功返回 0，输出是新句柄（逐个 `val_free`）；失败返回负数错误码且 `out[]` 全置 NULL |
| `arkli_mnn_val_free` / `arkli_mnn_net_free` | NULL 安全；输出 val 可以比会话活得久，输入 val 在 forward 返回后仍归调用方 |
| `arkli_mnn_release_memory()` | `Executor::gc(FULL)`，安卓上再 `mallopt(M_PURGE)`；JNI 的 `nativeDestroy` 也改调它（行为不变） |
| `arkli_mnn_last_error(buf, len)` / `arkli_mnn_last_error_code()` | **新增**：线程本地的最近一次失败描述与错误码；`net_load`/`forward` 同时写调用方给的 `err` 缓冲 |
| `arkli_mnn_test_allow_normal(1)` | **新增，仅测试**：打开后才允许 `memory=0`（normal） |

错误码：`ARKLI_MNN_OK=0`、`ERR_ARG=-1`（参数非法）、`ERR_LOAD=-2`、`ERR_INPUT=-3`（类型/形状与模型声明不符）、`ERR_RUN=-4`、`ERR_UNSUPPORTED=-5`（输出不是 float32/int32）、`ERR_INTERNAL=-6`（捕获到 C++ 异常）。

约定与踩坑：

- **线程**：同一会话、以及不同会话的 `forward` 都由调用方串行（共用 MNN 全局执行器）。仅 `last_error` 系列线程安全。
- **所有权**：句柄互相独立，`net` 与 `val` 谁先释放都行；`val_new` 拷贝输入，MNN 只借用 C ABI 自己持有的内存。
- **内存模式**：只有 low(2) 可用，传 normal(0) 或其它值直接报 `ERR_ARG`，Rust 侧不要暴露这个选项。
- **int64**：ONNX 的 int64 输入在 MNN 里是 int32，必须用 `ARKLI_I32` 传；传错类型会被 `forward` 拦成 `ERR_INPUT`。
- **形状校验**：模型声明了固定维时在 `forward` 里拦截（`ERR_INPUT`）；声明为动态维（如 SigLIP2 的输入）则只校验维数，具体形状错误由 MNN 在推理时报 `ERR_RUN`，同样不崩溃。
- **外置权重**：`net_load` 内部严格“设路径、加载、清空”（守卫对象保证异常路径也清空），测试验证了前一个会话设过的路径不会泄漏给后一个。**但 MNN 找不到权重文件时只打日志，`Module::load` 仍返回成功**（实测：没有同名 `.weight` 的 `.mnn` 不给 `weight` 会加载成功，`forward` 才返回 `ERR_RUN`）。所以外置权重模型调用方必须总是传 `weight`；`weight` 给了但文件不存在会在 `net_load` 里直接报 `ERR_LOAD`。另：不传 `weight` 时 MNN 默认去找 `<model>.weight` 同名文件，所以 `model.mnn` + `model.mnn.weight` 这种命名不传也能加载，不要依赖它。
- **名字**：输入/输出名不在图里时 `net_load` 返回 NULL（`ERR_LOAD`）；`forward` 全部按位置传参，没有按名字设张量的接口（草图里也没有）。
- **输出**：`forward` 内部对每个输出做一次读取，保证计算已完成；NC4HW4 布局的输出会转成 NCHW。输出句柄可原样作为下一次的输入（KV 零拷贝），已用合成模型验证拼接内容正确。

宿主测试（Windows，不碰真机）：

```powershell
.\native\mnn\build-tools.ps1 -HostDll        # 额外编 MNN.dll、arkli-mnn.dll、capi_smoke.exe，输出到 native/mnn/.work/build-tools/
# 用例见 scripts/mnn/README.md（make_case.py）；外置权重版用 MNNConvert --saveExternalData 另转一份
.\native\mnn\.work\build-tools\capi_smoke.exe <siglip2 fp32 model.mnn> <用例目录> [外置权重版 .mnn] [临时目录]
```

`native/mnn/test/capi_smoke.cpp` 覆盖：SigLIP2 fp32 数值（对照 ORT 期望，门槛 1%，实测 `pooler_output` 约 2e-6、`last_hidden_state` 约 9e-5，low 与 normal 一致）、normal 默认被拒、文件/名字/形状/类型/个数错误、重复创建释放与输出比会话活得久、外置权重顺序、合成模型的 int32 输入与长度为 0 的 KV 输入。

### 4.3 Rust（`arkli-ai`）

- 新 feature `mnn-backend`，模块 `src/mnn/`：`ffi.rs`（`libloading` 打开裸名 `libarkli-mnn.so`，校验 `abi_version`）、`mod.rs`（`MnnBackend`、`MnnNet`、`MnnValue: Drop`）。`MnnBackend` 实现现有 `InferenceBackend`/`Session`（clip、OCR 直接可用）。
- `backend.rs` 新增多输入多输出接口，翻译引擎改为依赖它而不是 ort 类型：

```rust
/// 不透明张量句柄：输出可原样作为下一步输入（KV 零拷贝）。
pub trait GraphValue: Send { fn shape(&self) -> Vec<i64>; fn to_f32(&self) -> Result<Vec<f32>>; }
pub trait GraphSession: Send {
    type Value: GraphValue;
    fn input_names(&self) -> &[String];
    fn output_names(&self) -> &[String];
    fn value_f32(&self, shape: &[i64], data: &[f32]) -> Result<Self::Value>;
    fn value_i32(&self, shape: &[i64], data: &[i32]) -> Result<Self::Value>;
    /// 按 input_names 顺序给输入，返回 output_names 顺序的输出
    fn run(&mut self, inputs: &[&Self::Value]) -> Result<Vec<Self::Value>>;
}
```

- 翻译：`translate/engine.rs` 拆出 `Seq2SeqRunner`（`encode` / `cross_kv` / `step` / `reorder`），保留现有 ORT 实现直到 M9，新增 MNN 实现；清单加 `format` 字段（`onnx-merged` 缺省 / `mnn-split`）。嵌入表加载器（int8 + 每行 scale）是纯函数，可单测。（M6b 实际落地的 trait 是 `begin`/`step`/`commit`，MNN 实现按行单独执行，见 M6b 一节。）
- `arkli-ffi`：`clip_load`/`translate_load` 的首参改名为 `runtime_lib`（仍是字符串，Kotlin 传 `libarkli-mnn.so`），按模型文件扩展名或清单 `format` 选后端；卸载时调 `arkli_mnn_release_memory` 再 `purge_heap`。

#### 4.3.1 M3 落地情况

- **模块**：`core/crates/arkli-ai/src/mnn/ffi.rs`（`libloading` 打开运行库、校验 `ARKLI_MNN_ABI`、解析 12 个符号，缺符号报“缺少符号 xxx”；**不绑定** `test_allow_normal`）、`mnn/mod.rs`（`MnnRuntime` / `MnnNet` / `MnnValue` / `MnnConfig`）。feature `mnn-backend = ["dep:libloading"]`，`libloading` 钉 `=0.9.0`（ort 的传递依赖，Cargo.lock 里已有同版本）。
- **命名与草图的差异**：没有 `MnnBackend` 类型，改为 `MnnRuntime`（持库句柄，`load_net` / `release_memory`）；`MnnConfig` 是 `#[repr(C)]`，`memory` 字段私有且恒为 low，只能改线程数与 rearrange。
- **抽象**：`backend.rs` 新增 `GraphValue`（另加 `to_i32`）、`GraphSession`、`GraphTensorSession`（把单输入图会话适配成现有 `Session`，OCR 管线与 `ClipEncoder` 因此直接可用）、`backend_for_model`。`ClipEncoder::from_graph(graph)` 是新入口，ORT 路径不变。
- **选择规则**：`backend_for_model(path)`——扩展名 `.mnn`（忽略大小写）走 MNN，**其余一律走 ORT**（保持旧行为，`.mnn.weight` 不算 MNN 模型）。`arkli-ffi/src/clip.rs` 的 `clip_load(runtime_lib, model_path, threads)` 据此分派：`.mnn` 加载 `runtime_lib` 指向的 `libarkli-mnn.so`，旁边有 `<model>.mnn.weight` 时自动作为外置权重传入；`clip_unload` 多调一次 `release_memory`。`arkli-ffi` 的 feature `mnn-backend`（默认开）透传，Android 构建脚本不传 feature，所以产物同时含 ORT 与 MNN。
- **并发**：跨会话的 `forward` 由模块内全局锁串行；同一会话靠 `&mut self`。
- **Windows 宿主测试**：绝对路径加 `LOAD_WITH_ALTERED_SEARCH_PATH`，同目录的 `MNN.dll` 自动被找到，不必改 PATH。
- **真库测试**（`#[ignore]`，环境变量 `ARKLI_MNN_DYLIB` / `ARKLI_MNN_CASE` / `ARKLI_MNN_MODEL`，外置权重用 `ARKLI_MNN_MODEL_EXT`）：`cargo test -p arkli-ai --features mnn-backend -- --ignored --nocapture mnn`。SigLIP2 fp32 实测误差率 `pooler_output` 2.07e-6、`last_hidden_state` 8.5e-5（与 C++ 侧同量级）；外置权重版一致；覆盖文件不存在、输入/输出名错、维数错（ERR_INPUT）、形状错（ERR_RUN）、类型错、个数错、输出比会话活得久。ABI 版本不符无法用真库构造，只测了纯函数 `check_abi`。

### 4.4 Kotlin 与统一 AI 协议

- **提供者、端口、`AiRouter`、`AiModule.providers` 都不动**：`LocalClipProvider`、`LocalNllbProvider` 照旧，只是它们背后的 `UniffiClipBackend`/`UniffiTranslateBackend` 把 `ORT_LIB_NAME` 换成 `MNN_RUNTIME_LIB = "libarkli-mnn.so"`，`ClipService.MODEL_ID`/`TranslateService.MODEL_ID` 与必需文件列表换新。`AiProviderContractTest` 因此自动覆盖，不需要新增契约测试。
- 生命周期：`AiHeavyGate` 串行、`addReleaseHook` 删模型前卸载、`AiRecycle.releaseAll` 不变；Rust 卸载路径多一次 `arkli_mnn_release_memory`。
- Rust `dlopen` 前要保证 `libarkli-mnn.so` 能被找到：APK 内裸名 dlopen 与 ORT 同理（已在 APK 进程验证过 ORT 的做法）；保险起见在 `ClipRuntime/TranslateRuntime.get` 里先 `MnnNative` 的静态初始化（`System.loadLibrary("arkli-mnn")`）。
- 语音：`SpeechEngine` 的 import 从 `com.k2fsa.sherpa.onnx.*` 换成 `com.k2fsa.sherpa.mnn.*`，Kotlin API 源文件随包（Apache-2.0，保留版权头与 NOTICE）。
- 前端：模型 id 写死在 `web/src/stores/models.ts:17-18`、`web/src/shared/aiCatalog.ts:41-46`、`web/src/tools/waste-classify/logic.ts:6`。用户选择存的是提供者 id，换模型 id 不丢选择；旧 id 要留在 `LEGACY_CHOICE_MIGRATION` 里。**这几个文件正被统一协议子代理改动**，M5/M6 的前端部分要等它的“模型目录 / offers”合并后再做，最好那时 id 已改为由原生目录下发。

## 5. 模型产物与分发

- 转换在开发机做，脚本放 `scripts/mnn/`（第 6 节 M1）；转换器用固定提交编出的 MNNConvert（`native/mnn/build-tools.ps1` 产出到 `native/mnn/.work/build-tools/`，已被 `.gitignore` 忽略）。
- 命名：清单 id `<模型>-mnn-<量化>`，目录同名：`siglip2-mnn-w8`、`nllb600m-un6-mnn-w6`、`asr-zipformer-zh-en-mnn-w8`、`ppocrv5-mnn-fp16`。release tag `<模型>-mnn-v<n>`，文件名稳定（`model.mnn`、`encoder.mnn`、`encoder.mnn.weight` …），**每次转换都由 `scripts/mnn/pack.py` 打印字节数与 sha256 并生成 `models.json` 条目片段**，人工贴进清单。
- 输入原版（脚本里写死 URL 与 sha256，aria2 下载，下载后校验不过就停）：

| 文件 | 字节 | sha256 | 来源 |
|---|---|---|---|
| NLLB `encoder_model.onnx` | 1,658,468,942 | `d3d9f993…07714` | hf-mirror `Xenova/nllb-200-distilled-600M/onnx/` |
| NLLB `decoder_model_merged.onnx` | 1,865,158,686 | `004adde6…204e9` | 同上 |
| NLLB 原版 `tokenizer.json` | 17,331,224 | `8ac789ad…50c94` | 同上（仓库根） |
| SigLIP2 `vision_model.onnx` | 371,807,752 | `c0573e3f…bcad` | hf-mirror `onnx-community/siglip2-base-patch16-224-ONNX/onnx/` |
| 语音 fp32 包 `.tar.bz2` | 584,120,230 | `7e82f0a2…7b88` | GitHub `k2-fsa/sherpa-onnx` release `asr-models` |
| PP-OCRv5 det / rec / cls | 4,819,576 / 16,631,306 / 1,018,508 | `4d97c44a…` / `5825fc7e…` / `54379ae5…` | ModelScope `RapidAI/RapidOCR` |

（完整 sha 写进脚本常量；这里截断只为表格可读。）

- NLLB 裁剪词表以随包 `tokenizer.json`（sha `d7c3b1f9…bebb`）为准；**M6a 修订**：新包改用词表 v2（61,796 行，见 3.3.1，`dl/nllb-tok-v2`），沿用 CC-BY-NC-4.0 授权文本，NOTICE 的“Modifications”改写为“fp32 原版重新导出、词表按六语言扩充裁剪、拆图、MNN 6 位权重量化”（模板 `scripts/mnn/data/nllb/NOTICE.txt`，由 `convert_all.py` 填词数与量化说明）。
- 旧模型清理：`models.json` 新增 `retired: [{ id, dir }]`，启动时（`ModelModule.install`）在后台、排在 `AiHeavyGate` 后删除这些目录；目录与现行条目重名时跳过。设备上已下载的 `siglip2-q4_half`（55MB）、`nllb600m-un6-ccm-int4`（405MB）、手动放置的 `asr-zipformer-zh-en-int8` 都靠它回收。
- 对外发布步骤（用户执行）：`gh release create <tag> <文件...> --repo icodejoo/arkli --title ... --notes ...` → 用 `curl -sIL --ssl-no-revoke` 确认 302 落到 `release-assets.githubusercontent.com` → 下载一次校验 sha256 → 再合并改了 `models.json` 的提交。单文件小于 2GB（最大的 NLLB `decoder_step` 外置权重约 190~250MB，没问题）。

## 6. 施工清单（给 sonnet low）

通用规则：每一步单独提交、测试全绿再进下一步；验证命令统一为 `cd core; cargo test --workspace`、`cd core; cargo test -p arkli-ai --features mnn-backend`、`.\gradlew.bat testDebugUnitTest`、`cd web; pnpm test`（只改到哪层就跑哪层）。标 **[真机]** 的步骤需要设备，其余桌面可完成。回滚一律是 revert 该步提交；涉及 release 的步骤，旧 release 不删，清单回指旧 URL 即可。

**M1 转换脚本与桌面工具（不碰 App）**
- 新增 `scripts/mnn/`：`requirements.txt`（钉版本：MNN 3.6.1、onnx 1.23.2、onnxruntime 1.31.0、numpy、tokenizers 0.23.3、pillow、psutil）、`fetch.py`（aria2 下载 + sha 校验）、`mnnconv.py`（只调 `_tools.mnnconvert`，或优先用 `ARKLI_MNNCONVERT` 指向的固定提交 exe）、`dequant_nbits.py`、`nllb_prepare.py`、`nllb_crosskv.py`、`nllb_embed.py`（int8+scale 导出）、`convert_all.py`（读一份 `recipes.json`：每个模型的输入、量化参数、输出名）、`make_case.py`（ModuleBasic 文本用例）、`eval_siglip.py`、`eval_nllb.py`、`eval_asr.py`、`eval_ocr.py`、`pack.py`。脚本可从 scratchpad `mnn-spike/scripts/` 拷贝后整理（加中文注释、去硬编码路径）。
- 新增 `native/mnn/build-tools.ps1`：用固定提交源码编 `MNNConvert.exe` 与 `ModuleBasic.out.exe`（参数见 3.1），以及给 Rust 宿主测试用的 `MNN.dll` + `arkli-mnn.dll`（M2 之后）。
- 验证：在干净虚拟环境（`python -I`）跑 `convert_all.py` + 各 `eval_*.py`，数字与第 3 节一致（误差在噪声内）。完成判据：脚本可一键复现四类模型的转换与评测；仓库不提交任何模型产物。

**M2 C ABI**
- 新增 `native/mnn/arkli_mnn_capi.h`、`arkli_mnn_capi.cpp`；`CMakeLists.txt` 把它加进 `arkli-mnn` 目标；`arkli_mnn_jni.cpp` 的 `giveBackMemory` 改调公共函数。`build.sh` 不变。
- 宿主测试（**已完成**，见 4.2.1）：`build-tools.ps1 -HostDll` 额外编 `arkli-mnn.dll`；新增 `native/mnn/test/capi_smoke.cpp`（加载 SigLIP2 fp32 用例，比对输出，误差率 ≤1%）。
- 发布：用户上传 `mnn-478c10e-v2`（`libMNN.so` 不变，`libarkli-mnn.so` 新 sha）；改 `app/build.gradle.kts` 的 `mnnReleaseBase` 与 sha。
- 验证：`.\gradlew.bat assembleDebug` 能取到新 so；Qwen 相关单测不变。完成判据：Qwen 功能无回归（真机冒烟一次可放到 M5 一起做）。

**M3 Rust MNN 后端**
- `core/crates/arkli-ai/Cargo.toml` 加 feature `mnn-backend = ["dep:libloading"]`；新增 `src/mnn/{ffi.rs,mod.rs}`；`backend.rs` 加 `GraphSession`/`GraphValue`；`lib.rs` 导出。
- 单测：mock `GraphSession` 跑通 `ClipEncoder`；`#[ignore]` 真库测试读 `ARKLI_MNN_DYLIB` 与 `ARKLI_MNN_CASE`（M1 的 ModuleBasic 用例目录），逐个输出比对。
- 验证：`cargo test -p arkli-ai`（默认无 feature）、`cargo test -p arkli-ai --features mnn-backend`、`-- --ignored`（设环境变量）。完成判据：默认测试数不减；ignored 真库测试在桌面通过。

**M4 退役模型清理**
- `app/src/main/assets/ai/models.json` 支持 `retired`；`ModelManifest.kt` 解析；`ModelPolicy.kt` 新增纯函数 `retiredDirsToDelete(manifest, existingDirs)`；`ModelModule.install` 后台执行。
- 单测：重名跳过、路径必须是 `models/<单段名>`、空列表无操作。完成判据：`testDebugUnitTest` 全绿；此步 `retired` 先留空。

#### M5 落地情况（桌面部分，2026-10-15）

- **产物**（本机 scratchpad `m5-out/siglip2-mnn-w8/`，不入库）：`model.mnn` int8 逐通道，输出名 `pooler_output`，由 `scripts/mnn/convert_all.py siglip2 --variant siglip2=w8` 用固定提交 MNNConvert 转出**一次**，`pack.py` 登记。**94,775,452 B，sha256 `8af99950b0fb39c2df90e66d67181eecc4e538617fbfdc0242ee420b36ac60d5`**。MNN 每次转换的模型 UUID 不同，sha 每次不同：清单登记的就是这一份，**上传的必须是同一个文件，不能重转**；丢了只能重转并同步改清单的 bytes/sha。
- **数值验收**（`eval_siglip.py`，30 张图，ORT fp32 为基准，memory=low）：cos 均值 **0.9908**、最小 **0.9564**、top-1 一致 **0.933**（门槛 0.985 / 0.95 / 0.9，通过）；对照现网 q4_half 为 0.9612 / 0.9143 / 0.833。桌面延迟 119ms（q4_half 108ms，ORT fp32 112ms），桌面相对值，不代表手机。
- **待用户上传**（release `siglip2-mnn-v1`，仓库 `icodejoo/arkli`）：只有一个文件 `model.mnn`。清单 URL 为 `https://github.com/icodejoo/arkli/releases/download/siglip2-mnn-v1/model.mnn`（`models.json` 的 `note` 已注明待上传）。上传后按第 5 节做 302 与 sha256 复核。**上传前设备下载会失败。**
- **清单**：`models.json` 新增 `siglip2-mnn-w8`（`dir: models/siglip2-mnn-w8`，文件 `model.mnn`，apache-2.0，displayName「本地识物模型（SigLIP2，MNN 版）」）。
- **旧条目 `siglip2-q4_half` 保留，且没有放进 `retired`**（与上文清单的“旧条目移到 retired”不同，这是有意修订）：新模型 release 还没上传、真机还没验收，现在清理会让已装旧模型的设备失去可用的识物；**移入 `retired` 改到 M9 / 真机验收通过后再做**，到那时旧 release `siglip2-q4half-v1` 也不删。旧条目的 displayName 改成“旧 ONNX 版”，前端 AI 中心由工具声明驱动，不会列出它。
- **Kotlin**：`CLIP_MODEL_DIR=models/siglip2-mnn-w8`、`CLIP_MODEL_FILE=model.mnn`；`ClipService.MODEL_ID=siglip2-mnn-w8`；`UniffiClipBackend.load` 先 `MnnNative.ensureLoaded()`（`System.loadLibrary("arkli-mnn")`）再 `clipLoad(MNN_RUNTIME_LIB, …)`。**运行库传裸名 `libarkli-mnn.so`，不是 `nativeLibraryDir` 绝对路径**：APK 里 so 不解压（manifest 没设 `extractNativeLibs`，minSdk 高于 23 时默认 false），该目录下没有真实文件；先 `loadLibrary` 后，Rust 的 dlopen 按同名命中已加载的那份，与 ORT 裸名同一套路。ORT 路径代码（`ORT_LIB_NAME`、翻译用的 `translateLoad`）原样保留到 M9；**没有做“新模型未装时回退旧模型”**，沿用现有未就绪提示。
- **UniFFI 绑定**：Kotlin 绑定在 `app/src/main/kotlin/uniffi/`（被 .gitignore 忽略的生成物）。M3 改了 `clip_load` 首参名，按 `core/scripts/build-android.ps1` 流程重编了 `libarkli_ffi.so` 并重新生成（`clipLoad` 首参现为 `runtimeLib`）。**脚本缺陷**：脚本只在 `core\target\debug` 找宿主 debug 库，若设了环境变量 `CARGO_TARGET_DIR`（本机为 `C:\cargo-target\cisox`）会读到过期的旧库、生成旧绑定（缺 translate、首参仍是 `ortLib`）；本次改为手动对 `$env:CARGO_TARGET_DIR\debug\arkli_ffi.dll` 跑同一条 `uniffi-bindgen generate`。以后该脚本应改成用 `cargo metadata` 的 target_directory。
- **前端**：`registry.ts` 的 waste-sort 过渡 `models` 与 `waste-classify/logic.ts` 的 `MODEL_ID` 改为 `siglip2-mnn-w8`（标题「识物 SigLIP2（MNN）」）；`LEGACY_CHOICE_MIGRATION` 保留 `siglip2-q4_half → local-clip` 并新增 `siglip2-mnn-w8 → local-clip`；`stores/models.ts` 用途表两个 id 都登记。选择值存的是提供者 id（`local-clip`），换模型 id 不丢用户选择。
- **方案里不准确 / 缺的地方**：① 原方案写“运行库名”传给 Rust，实际要的是裸名 + 先 loadLibrary（见上）。② 方案漏了旧绑定过期问题与 `CARGO_TARGET_DIR` 对脚本的影响。③ 方案没写过渡期旧条目的去留，这里定为保留。④ `libarkli-mnn.so` 必须是 M2 之后带 C ABI 的版本（release `mnn-478c10e-v2`，`build.gradle.kts` 已指向它），否则 Rust 报“缺少符号”。

**待真机执行清单**（M5 的 [真机] 部分，本次未做；前提：用户已上传 `siglip2-mnn-v1/model.mnn`，且 `mnn-478c10e-v2` 的 so 在包内）

1. 装包后让设备得到新模型。正式路径：AI 中心下载 `siglip2-mnn-w8`（App 校验 sha256）。**不依赖 release 的做法**（debug 包）：`export MSYS_NO_PATHCONV=1; adb push model.mnn /data/local/tmp/`，`adb shell run-as com.let188.arkli.debug mkdir -p files/models/siglip2-mnn-w8`，`adb shell "run-as com.let188.arkli.debug cp /data/local/tmp/model.mnn files/models/siglip2-mnn-w8/model.mnn"`，再用 debug 广播调 `native.model.verify`（参数 `{"id":"siglip2-mnn-w8"}`，见 bridge-protocol 与 model-download）；手放文件是 `unverified`，verify 通过（sha 与清单一致）才算可用。
2. 单张延迟 ≤ 1.1 s（现网 0.97 s）：连续识别 10 次取中位数（`native.ai.classify` 的 `inferMs`）。目标机 STG-AL00 无 dotprod/fp16，这是第一个高风险门槛；不过关时按第 7 节对策试其他量化。
3. 加载耗时 ≤ 0.7 s（首次识别的 `elapsedMs` 减去 `inferMs`）。
4. 增量 RSS ≤ 130MB（加载前后 `run-as` 读 `/proc/<pid>/status` 的 VmRSS 与 `smaps_rollup`，口径同 status.md）。
5. 卸载后 ≤ 基线 +30MB（删除模型或 `AiRecycle` 触发卸载后等 30 秒再测，验证 Rust 卸载路径的 `release_memory`）。
6. 8 张真机图的 top-3 物品 id 与桌面（`eval_siglip.py` 同口径）一致。
7. 验收通过后：把 `siglip2-q4_half` 移入 `retired`（M9 一并做），并更新 status.md；不通过则回滚：`CLIP_MODEL_*`、`MODEL_ID`、前端 id 回指旧模型（ORT 仍在包里）。

**M5 SigLIP2 → MNN [真机]**
- 产物：`siglip2-mnn-w8/model.mnn`（int8 逐通道）；用户发布 `siglip2-mnn-v1`。
- Rust：`arkli-ffi/src/clip.rs` 首参改名 `runtime_lib`，按 `.mnn` 选 `MnnBackend`（config：memory=low、rearrange=1、threads=4）。
- Kotlin：`AndroidClip.kt` 的 `CLIP_MODEL_DIR/FILE` 与运行库名；`ClipService.MODEL_ID`；相关测试常量。`models.json` 新条目，旧条目移到 `retired`。
- 前端：等统一协议的目录改造合并后，再改三处 id（见 4.4）。
- 验收：见第 7 节 SigLIP2 行。回滚：清单与常量回指旧模型（ORT 仍在包里）。

**M6 NLLB → MNN [真机]**
- 产物：`encoder.mnn(+.weight)`、`cross_kv.mnn(+.weight)`、`decoder_step.mnn(+.weight)`、`embed.i8`、`embed.scale`、`tokenizer.json`、`model.json`（`schema_version` 不变，新增 `format: "mnn-split"` 与 `files.cross_kv/embed/embed_scale`）、LICENSE、NOTICE。
- Rust：抽 `Seq2SeqRunner`，ORT 实现原样搬过去（现有测试必须原样通过），新增 MNN 实现；束搜索重排对 MNN 句柄先读出再 gather 成新句柄；交叉 KV 只在 `cross_kv` 跑一次。`manifest.rs` 校验新字段。新增测试：嵌入表加载、`format` 分派、mock runner 下的贪心/束搜索。
- Kotlin：`TranslateService.REQUIRED_FILES` 按新文件表；`TRANSLATE_MODEL_DIR`；`MODEL_ID`；`AiTranslatePolicyTest` 等测试常量。清单新条目 + 旧条目进 `retired`。
- 宿主真库测试：`eval_nllb.py` 生成的 29 句（扩到 ≥100 句、六语互译）期望结果，Rust ignored 测试对 teacher forcing 一致率与无退化做断言。
- 验收：第 7 节 NLLB 行。

#### M6a 落地情况（桌面产物与评测，2026-10-15；Rust/Kotlin/清单 M6b 再做）

- **产物**（本机 scratchpad `m6a-out/`，不入库；各转换一次，`pack.py` 登记，**不能重转，重转 sha 会变**）：

| 目录 | 总字节 | 说明 |
|---|---|---|
| `nllb600m-un6-mnn-w6/` | 392,177,035 | 6 位 HQQ（默认发布格式） |
| `nllb600m-un6-mnn-w8/` | 496,114,242 | 8 位对照 |

  6 位各文件（字节 / sha256）：`encoder.mnn` 380,896 `497f3e7c…479f`；`encoder.mnn.weight` 118,985,648 `dafaee96…c135`；`cross_kv.mnn` 28,784 `8a860332…2ab8`；`cross_kv.mnn.weight` 19,170,960 `8236984b…126e`；`decoder_step.mnn` 624,080 `09e23123…8f5d`；`decoder_step.mnn.weight` 186,455,862 `ca32acd6…66d5`；`embed.i8` 63,279,104 `d1dc9511…ef23`；`embed.scale` 247,184 `7e49a46d…2591`；`tokenizer.json` 2,981,816 `d9388179…44f2`；`model.json` 1,218 `1db58425…4d36`；`NOTICE.txt` 2,136 `a4188346…f4a3`；`LICENSE-CC-BY-NC-4.0.txt` 19,347 `41003d4a…d3d0`。完整 sha 与 `models.json` 片段在 `pack.py` 输出（本机 scratchpad `m6a-work/pack-w6.json`、`pack-w8.json`）；8 位的 `.mnn` 与 `.weight` sha 不同，embed/tokenizer/LICENSE 与 6 位相同。
- **待用户上传**（release `nllb-mnn-v1`，仓库 `icodejoo/arkli`；URL 形如 `https://github.com/icodejoo/arkli/releases/download/nllb-mnn-v1/<文件名>`）：6 位的 12 个文件——`encoder.mnn`、`encoder.mnn.weight`、`cross_kv.mnn`、`cross_kv.mnn.weight`、`decoder_step.mnn`、`decoder_step.mnn.weight`、`embed.i8`、`embed.scale`、`tokenizer.json`、`model.json`、`NOTICE.txt`、`LICENSE-CC-BY-NC-4.0.txt`。8 位若要发布，同名文件会和 6 位冲突，需要另开 tag（如 `nllb-mnn-w8-v1`）；默认只发 6 位。
- **`model.json`**（`schema_version` 1 不变，由 `convert_all.py` 按 `recipes.json` 生成）：新增 `format: "mnn-split"`，`files` 键为 `encoder`/`encoder_data`/`cross_kv`/`cross_kv_data`/`decoder`/`decoder_data`/`embed`/`embed_scale`/`tokenizer`（`decoder` 指 `decoder_step.mnn`；`*_data` 指 `.mnn.weight`）；`languages`、`lang_tokens`、`generation`、`execution` 与现网一致。
- **评测**（`eval_nllb.py`，`sentences_m6.tsv` 149 句 / 30 个有向语言对，贪心，ORT 拆图 fp32 为基准，memory=low，int8 嵌入表；桌面 4 线程）：

| 配置 | teacher forcing 一致率 | 与 fp32 同句数 | 退化句 | 解码 ms/token |
|---|---|---|---|---|
| 新词表 6 位 HQQ | **97.8%** | 107/149 | 0 | 19.8 |
| 新词表 8 位 | **98.3%** | 112/149 | 0 | 19.0 |
| 旧词表 6 位 | 97.7% | 106/149 | 0 | 19.0 |
| 旧词表 8 位 | 98.3% | 111/149 | 0 | 19.4 |
| 现网 ORT int4（旧词表） | 93.5% | 63/149 | **4** | 27.2 |

  门槛（≥0.96、退化句 0）新旧词表的 6/8 位都过；现网 int4 不过。fp32 基准有 1 句撞到 64 token 上限（两个词表相同，与量化无关）。“丢字”专项 28 句（`sentences_zhchars.tsv`，小样本）：新词表 6 位 94.8%（9/28）、8 位 98.0%（20/28）、旧 6 位 94.6%；**6 位在这 28 句上低于 0.96，但样本太小，只作参考**，门槛按 149 句判。比 M1 的 29 句（97.1%）略有改善是评测集更大、更有代表性，不是模型变化。
- **丢字例句**（新旧词表 fp32 / 6 位 / 8 位译文逐字相同，词表无影响）：`…lazy dog.`→“快速的棕狐跳过惰的狗.”（单句）；整段英文 “…lazy dog. It was a sunny day in the city.”→“快速的棕狐跳过狗. 那是一个阳光明的城市日.”；“It was a sunny day in the city.”→“那是一个阳光明的天.”；“那只懒狗…”→“The dog sleeps on the couch all day.”（“懒”变 `<unk>` 后丢失）。**要含“懒”“晴”的译文做不到**：模型没有“懒”，输出里“晴”也不是 top-1。标点补丁的收益可见：“她擦干眼泪，坚定地说：“我不会放弃的。””旧词表译成 `…firmly: "Oh, I won't give up".`（弯引号 `<unk>` 引出幻觉的 “Oh,”），新词表译成 `…firmly, "I will not give up".`。
- **给 M6b（Rust 引擎）的约定**：① 特殊 id 不变：`decoder_start_token_id=2`、`eos=2`、`pad=1`、`<unk>=3`；语言码仍用 `lang_tokens` + `tokenizer.token_to_id`（引擎本来就这么做，无需改），id 为 arb 61790、eng 61791、fra 61792、rus 61793、spa 61794、zho_Hans 61795；② 词表 61,796 行，logits 最后一维 61,796，嵌入行数 = `embed.scale` 字节数/4，应校验与 tokenizer 词数一致；③ tokenizer.json 带标点补丁（Replace 规则），引擎 `load_tokenizer` 的 `patch_null_precompiled` 不受影响，Rust tokenizers 0.23.x 能读（Python 0.23.3 已验证，Rust 端待 M6b 测）；④ `manifest.rs` 目前把 `encoder`/`decoder`/`tokenizer` 当必需、`*_data` 可选，需要按 `format` 分派并新增 `cross_kv`/`embed`/`embed_scale`（建议 `cross_kv_data` 也可选）；⑤ 嵌入读法见 `scripts/mnn/nllb_embed.py` 顶部（int8 行主序 + float32 每行 scale，e≈q·scale）；输入嵌入未乘 √d，缩放仍在图里；⑥ NOTICE.txt / LICENSE 随包，清单里 role 为 aux，`model.json` 为 config。
- **没验证 / 方案里不准确的地方**：Rust 端的 tokenizers 对新 normalizer 的行为（只在 Python 0.23.3 验证）；真机速度、内存、冷启动全部待验；8 位 release 的 tag 方案待定；“补字”这件事方案的前提不成立（见 3.3.1），要真正解决中文缺字只能换模型（如 Opus-MT zh↔en，scratchpad `exp/opus_zh_en` 有过实验）或接受 `<unk>`，这是产品决策。NOTICE 里“标点规范化类似 Moses”是按 `<unk>` 现象和 Moses 规则对照写的，未逐条核对 NLLB 训练预处理脚本。

#### M6b 落地情况（Rust 引擎，桌面，2026-10-15；Kotlin/清单/真机留给 M6c）

- **trait**：新增 `translate/runner.rs` 的 `Seq2SeqRunner`（`begin(input_ids, rows)` 编码并准备会话 → 反复 `step(session, step, tokens, want_logits)` → `commit(session, step, reorder)`，另有缺省空实现的 `trim_memory`）。与方案草图的 `encode / cross_kv / step / reorder` 不同：ORT 的 merged decoder 在首步才产生交叉 KV、`present` 要等束搜索选完父束才能重排，所以拆成“跑一步（暂存 present）”与“提交（可带重排）”两段，ORT 的行为与原来逐位一致。`Engine<R: Seq2SeqRunner>` 是泛型而不是 `Box<dyn>`：会话类型各异（ORT 张量 / MNN 句柄），泛型零开销且便于 mock；运行时按清单 `format` 选哪种，由 `Translator` 内部的枚举分派（`Inner::Ort` / `Inner::Mnn`）。`translate()`/`translate_segment`/`translate_wrapped`/`wrap.rs`/`generate`/`generate_beam` 全在 `engine.rs`，不依赖具体后端；引号包裹法原样保留，MNN 下同样生效。
- **文件**：`engine.rs`（泛型编排）、`runner.rs`（trait + `StepLogits` + `last_position_logits`）、`ort_runner.rs`（ORT 实现，原 engine.rs 里的会话/KV/重排/arena 收缩代码原样搬入，`Engine::<OrtRunner>::load`）、`mnn_runner.rs`（MNN 实现，`Engine::<MnnRunner<MnnNet>>::load_mnn`）、`embed.rs`（嵌入表纯函数）、`mnn_real_tests.rs`（ignored 真库测试）。`translate` 模块现在在 `ort-backend` **或** `mnn-backend` 下编译：新增内部 feature `translate = [tokenizers, serde, serde_json, whatlang]`（都是已批准的既有依赖，没有新依赖），两个后端 feature 各自带上它，所以只开 `mnn-backend` 也带 tokenizers 与 whatlang。
- **MNN 数据流**：编码器一次（`input_ids`/`attention_mask`/`inputs_embeds` 全按 i32 传，嵌入在 Rust 里查 int8 表）→ `cross_kv` 图只跑一次，交叉 KV 句柄整句共享 → `decoder_step` 每步一次，`present.*` 句柄原样当下一步 `past_key_values.*`；首步自注意力 past 是 `[1,16,0,64]` 的空张量。输入输出名由 `graph_names(层数)` 生成（解码步 3+4×12=51 个输入、1+24 个输出）。三个 `.mnn` 的外置权重总是传 `weight`：清单 `*_data` 优先，缺省探测 `<model>.weight`。三张图顺序加载；`MnnRunner` 的字段顺序保证卸载时依次丢掉 encoder、cross_kv、decoder，最后一个 `ReleaseGuard` 调 `release_memory`（实测卸载后进程工作集回到 13MB）。嵌入表 63MB 常驻（`Vec<u8>` 按需 `as i8`，不再拷一份）。
- **方案/C ABI 里与实测不符的地方（重要）**：M6a 转出的三张 MNN 图把 batch 维**固定成 1**（`cross_kv` 报“第 0 个输入形状不符：模型要 [1,-1,1024]，给了 [2,9,1024]”；ONNX 里的 `batch_size` 符号维没有保留），Python 评测只用过 batch 1 所以没暴露。方案里“束搜索先把 KV 读成 f32 再 gather 成新句柄”的做法因此用不上，改为**按行单独执行**：束宽 W 时每条束各跑一次 `decoder_step`，每行持自己的自注意力 KV 句柄，重排就是“新第 i 行改拿旧第 parents[i] 行的 present 句柄”（句柄不可变，行间共享安全，零拷贝，不读不写 f32）；输入完全相同的行（同 token、同 past 句柄，如首步与补齐行）只跑一次。代价是束搜索每步约 W 倍解码器计算（见下表 beams=2 约 2.1×贪心）。要消除它得让 M6a 的转换保留动态 batch（或接受 MNN 默认束宽 1，清单 `generation.num_beams` 可设），这是产品/转换侧决定；trait 不变，将来换批量实现即可。C ABI 本身没问题（固定维拦截行为符合头文件）。
- **清单**（`manifest.rs`）：`format` 缺省视为 `onnx-merged`（兼容旧模型），`mnn-split` 必需 `encoder`/`cross_kv`/`decoder`/`embed`/`embed_scale`/`tokenizer`，`encoder_data`/`cross_kv_data`/`decoder_data` 可选且给了就必须存在；未知 `format`、`*_data` 缺文件、必需键缺失分别报 `Invalid`/`Missing`。校验 `embed.scale` 字节数是 4 的倍数且非 0、`embed.i8` 字节数能被行数整除（`validate_embed_files`，只看文件大小）；加载时再核对嵌入行数 = tokenizer 词数（`get_vocab_size(true)`，实测 61796 = 61796），不符报 `ManifestInvalid`。新增可选字段 `decoder_layers`/`kv_heads`/`kv_head_dim`（缺省 12/16/64，M6a 的 `model.json` 不用写）。`generation`（含 `short_phrase_wrap`）沿用；语言码走 `lang_tokens` + `token_to_id`，无需改（arb 61790 … zho_Hans 61795 实测取到）。
- **FFI**（`arkli-ffi/src/translate.rs`）：`translate_load(runtime_lib, model_dir, threads)`，首参由 `ort_lib` 改名 `runtime_lib`；先读 `model.json` 的 `format`：缺省/`onnx-merged` → `OrtBackend::load(runtime_lib)` + `Translator::load`（含义不变），`mnn-split` → `MnnRuntime::load(runtime_lib)`（翻译自己持一份运行时句柄，与识物的各自独立，同名库由系统引用计数）+ `Translator::load_mnn`。**Kotlin 需要跟着改（M6c）**：`translateLoad(ortLib: String, …)` → `translateLoad(runtimeLib: String, modelDir: String, threads: UInt)`（UniFFI 生成名 `runtimeLib`，需重新生成绑定）；新模型传 `"libarkli-mnn.so"` 且先 `MnnNative.ensureLoaded()`，老 ORT 模型仍传 `"libonnxruntime.so"`；`UniffiTranslateBackend` 要按模型（id 或目录里 `model.json` 的 `format`）选库名；`TranslateService.REQUIRED_FILES` 换成 12 个文件（`encoder.mnn(+.weight)`、`cross_kv.mnn(+.weight)`、`decoder_step.mnn(+.weight)`、`embed.i8`、`embed.scale`、`tokenizer.json`、`model.json`、NOTICE、LICENSE）。
- **测试**：默认（`cargo test --workspace`）arkli-ai 167 → 189 通过（含 ORT 与 MNN 两个 feature）、arkli-ffi 9 → 12；`--features mnn-backend` 86 → 185；无 feature 74；`--features ort-backend` 166。没有删改旧断言（原 `engine.rs` 里只属于 ORT 的 `opt_level_mapping`、`kv_dims_inference` 两个测试随代码搬到 `ort_runner.rs`；`manifest_with` 测试夹具因 `Manifest` 新增字段补了 `None`）。新增：嵌入表（还原、越界、大小校验、文件加载 4 个）、清单（`format` 分派、MNN 必需键与 `*_data`、嵌入大小、结构缺省、M6a 样式 `model.json` 共 5 个）、`runner`（2 个）、mock 三图 `MnnRunner`（命名、首步空 KV 与交叉 KV、KV 逐步传递、相同行只跑一次与重排复制、重排交换且 key/value 同步、越界与行数错误、嵌入越界、卸载回调，共 8 个；mock 图与真图一样只接受 batch=1）、`Engine<MnnRunner<mock>>` 贪心（强制位、最小长度屏蔽 eos、KV 长度逐步 +1、交叉 KV 不变、预算耗尽）与束搜索（KV 谱系）3 个、FFI 3 个。`cargo clippy -p arkli-ai --features mnn-backend --all-targets` 与 ort+mnn、无 feature、workspace 均无警告。
- **真库测试**（`#[ignore]`，环境变量 `ARKLI_MNN_DYLIB`、`ARKLI_MNN_NLLB_DIR`、`ARKLI_MNN_NLLB_REF`；运行 `cargo test -p arkli-ai --features mnn-backend --lib -- --ignored --nocapture mnn真库`；参考数据由 `ref_gen.py` 用 Python `tokenizers==0.23.3` 与 `eval_nllb.py` 的 `Split("mnn")` 生成，本机 scratchpad `m6b/`，不入库）。桌面 Windows，4 线程，memory=low，`arkli-mnn.dll`（M2 产物）：
  - **Rust tokenizers 0.23.2 对带 Replace 补丁的新 tokenizer.json**：592 句（149 句评测集 + 六语审计语料 + 弯引号/破折号/全角/bidi 控制符等专项）逐句逐 id 与 Python 0.23.3 **592/592 一致**。结论：normalizer 补丁在 Rust 端行为一致，`load_tokenizer` 不需要改。
  - **贪心译文**（`translate_segment`，贪心、上限 64，对拍 Python MNN 同产物同嵌入表）：6 位 **149/149 = 100%**，8 位 **149/149 = 100%**，退化句 0（口径：空输出、含“to be a little late”、连续 8 个相同字符；`trim_tail_repeat` 的触发次数没有对外暴露，没统计）。耗时（整句，含分词）：6 位均值 410ms、中位 429ms、最大 757ms；8 位 402 / 425 / 741ms。
  - **公共入口**（`Translator::translate`，分句、后处理、引号包裹法全开）：149 句 beams=1 均值 422ms / 中位 434 / 最大 704，退化 0；beams=2（清单缺省）均值 894 / 886 / 1639，退化 0；beams=4（前 30 句）均值 1021 / 947 / 2262，退化 0。
  - **引号包裹法**：你好→Hello（448ms）、谢谢→Thank you、你好！→Hello!、Hello→你好、auto 识别的“你好”→Hello；关闭包裹法时“你好”变成 “Hey, how are you?”；长句开关前后译文一致。同机对照现网 ORT int4（beams=2）同样四条 686~858ms，MNN 6 位 440~520ms（桌面相对值）。
  - **内存**（Windows 工作集，含测试进程基线约 4~6MB）：加载前 4MB → 加载后 512MB（加载峰值 634MB）→ 149 句后 524MB，beams=2/4 之后 530/536MB；卸载后回到 13MB；重载两轮同样的曲线。加载耗时 2.4s。
  - **ORT 回归**（int4 现网包 + ORT 1.31 动态库）：`translate::` 下 4 个 ignored 真模型测试（三方向、引号包裹法、auto 识别、与 Cisox 夹具对拍 9/9）全部通过，译文与改动前一致。
- **没验证 / 遗留**：真机速度、内存、冷启动全部未测（beams=2 在手机上会是贪心的 2 倍，M6c 真机验收时要决定束宽）；`trim_tail_repeat` 触发次数未统计；Rust 的 `ort` 在同一进程里第二次“加载不存在的 ORT 库”会 panic（`ort-2.0.0-rc.14 lib.rs:241`，clip 的现有测试已占用这个场景，所以 FFI 没有再加“ORT 格式 + 坏库”的测试）；`cargo test -- --ignored` 不加 `--lib` 会把 ```ignore 文档示例也当真运行而失败（既有现象，与本步无关）。

#### M6c 落地情况（Kotlin、清单、前端、文档；桌面，2026-10-15；真机与 release 上传待用户）

- **默认束宽改 1**：M6b 实测三张 MNN 图 batch 固定 1，beams=2 每条束单独跑，桌面 894ms 对 422ms（约 2.1 倍），而贪心 149/149 与 Python MNN 参考一致、退化 0。所以只改了产物 `model.json` 的 `generation.num_beams`：2 → 1（文件仍是 1,218 字节，只有这一个字符变），其余 11 个文件没动、没重转；`pack.py` 重新登记。调用方显式传 `numBeams`（1~4）仍有效，引擎没改。取舍：贪心对 fp32 参考的 teacher forcing 一致率 97.8%、退化句 0；没有单独量化过 beams=2 的质量收益，长句可能略逊于 beams=2，真机验收时再比（见下）。
- **`model.json` 新值**：1,218 B，sha256 `1db584251cde24fc8570f393f019ede6e7c6d58225b40ed0e71c330e16a14d36`（旧值 `1e8148b4…6857` 作废）。整包总字节不变 392,177,035。上传的必须是这份改过的 `model.json`（本机 scratchpad `m6a-out/nllb600m-un6-mnn-w6/model.json`），丢了就不能再用其他版本，清单 sha 会对不上。
- **待用户上传**（release `nllb-mnn-v1`，仓库 `icodejoo/arkli`；`models.json` 的 `note` 已注明，上传前设备下载会失败）。12 个文件（字节 / sha256）：

| 文件 | 字节 | sha256 |
|---|---|---|
| `encoder.mnn` | 380,896 | `497f3e7cd5e6ae1de396d4fc17b803e0cd2b1d946fea66a0fc5cbc569cb0479f` |
| `encoder.mnn.weight` | 118,985,648 | `dafaee96b607b9c93532b53ab92f4e557eae6a7c9bc86e61e6a7288451e3c135` |
| `cross_kv.mnn` | 28,784 | `8a860332b7dab8c63e0d5b1a405d98bae1cc3156a85113a301fb8ab7b6422ab8` |
| `cross_kv.mnn.weight` | 19,170,960 | `8236984b2cebaac9104599553a2e916a3d67f0cb1ef55bcc03b77aefe914126e` |
| `decoder_step.mnn` | 624,080 | `09e231235a3938d40c86d7a9bcb09db096669c927613c036f4b2f1a44e838f5d` |
| `decoder_step.mnn.weight` | 186,455,862 | `ca32acd63cd3d6d129cac220f673d4c2c4b7b88ac2b0d20953908d67dd1a66d5` |
| `embed.i8` | 63,279,104 | `d1dc9511201a86481b84dfd3404e6c919da2fdb57b41482b22d6ce13324bef23` |
| `embed.scale` | 247,184 | `7e49a46dedb9a5bed0669a905b538ea451b8d139fb793c451d1cfee346d42591` |
| `tokenizer.json` | 2,981,816 | `d93881797f945c189dd89a9fee75764e8a8d564e780fc66dac30c0d3747044f2` |
| `model.json` | 1,218 | `1db584251cde24fc8570f393f019ede6e7c6d58225b40ed0e71c330e16a14d36` |
| `NOTICE.txt` | 2,136 | `a4188346a1266d3d9547558f08ef8893a9d077c3772b4aa6934457bafd52f4a3` |
| `LICENSE-CC-BY-NC-4.0.txt` | 19,347 | `41003d4a74749c0220e33dd415042164b5a1093ed401f36277234f772d22d3d0` |

  合计 392,177,035 B。上传后按第 5 节做 302 与 sha256 复核。
- **清单**：`models.json` 新增 `nllb600m-un6-mnn-w6`（`dir: models/nllb600m-un6-mnn-w6`，12 个文件逐个带 bytes/sha256/role/urls，`cc-by-nc-4.0`，displayName「本地翻译模型（NLLB-200 600M，6 语，MNN 版）」）。**旧条目 `nllb600m-un6-ccm-int4` 保留、没进 `retired`**（理由同 M5：release 未上传、真机未验收，提前清理会让设备失去可用翻译），displayName 加了「旧 ONNX 版」；退役改到 M9 / 真机验收通过后。旧条目的 URL 仍是 Cisox 占位，没动。
- **Kotlin**：`TranslateService.MODEL_ID=nllb600m-un6-mnn-w6`，`REQUIRED_FILES` 换成上面 12 个文件，`TRANSLATE_MODEL_DIR=models/nllb600m-un6-mnn-w6`；`UniffiTranslateBackend.load` 先 `MnnNative.ensureLoaded()` 再 `translateLoad(MNN_RUNTIME_LIB, …)`（裸名 `libarkli-mnn.so`，同 M5）。**默认只认新模型，不做新旧回退**：没装新模型就走既有 NOT_READY 提示，ORT 路径常量（`ORT_LIB_NAME`）与 Rust 的 ORT 分支保留到 M9。`LocalNllbProvider` 的 `sessionModelId`/可用性/`modelInfo` 都读 `TranslateService.MODEL_ID`，自动跟随。
- **UniFFI 绑定**已按 `core/scripts/build-android.ps1` 的流程重新生成（宿主 debug 库是新编的），核对：`translateLoad(runtimeLib, modelDir, threads)`、`clipLoad(runtimeLib, …)`。
- **`build-android.ps1` 修复**：宿主库目录改用 `cargo metadata` 的 `target_directory`（尊重 `CARGO_TARGET_DIR`），并检查宿主库修改时间不早于 `core` 下最新的 `.rs`/`Cargo.toml`/`Cargo.lock`，过期直接报错并提示 `cargo build -p arkli-ffi`。本次在本机只跑了新增的“定位 + 过期检查 + 生成绑定”这一段，没有编 Android 目标。
- **前端**：翻译页不写死模型 id（可用性来自原生 `providers` 的 `modelId` 与 `stores/models.ts`），所以只改了：`stores/models.ts` 用途表（新旧两个 id 都登记「多语翻译」）、`LEGACY_CHOICE_MIGRATION`（旧 `nllb600m-un6-ccm-int4` 仍映射 `local-nllb`，新增 `nllb600m-un6-mnn-w6 → local-nllb`）、`native/ai.ts` 注释，以及测试夹具里的 id。业务页仍只读 `stores/models.ts`。
- **方案里不准确 / 缺的地方**：① M6 条目写“旧条目进 `retired`”，实际有意推迟（同 M5）。② 方案没写 `num_beams` 的取舍，由 M6b 的 2.1 倍实测推出本步改 1。③ `build-android.ps1` 的过期绑定问题此前只记录未修，本步修了。④ Kotlin 侧没有按 `model.json` 的 `format` 选库名：旧模型不再被 Kotlin 认，没有必要。

**待真机执行清单**（M6 的 [真机] 部分，本次未做；前提：设备上有新模型，且包里是带 C ABI 的 `libarkli-mnn.so` 与新版 `libarkli_ffi.so`）

1. 让设备得到新模型。正式路径：用户先上传 `nllb-mnn-v1`，AI 中心下载 `nllb600m-un6-mnn-w6`（App 逐文件校验 sha256）。**不依赖 release 的做法**（debug 包）：`export MSYS_NO_PATHCONV=1`；把 12 个文件 `adb push` 到 `/data/local/tmp/nllb-mnn/`；`adb shell run-as com.let188.arkli.debug mkdir -p files/models/nllb600m-un6-mnn-w6`；逐个 `adb shell "run-as com.let188.arkli.debug cp /data/local/tmp/nllb-mnn/<文件> files/models/nllb600m-un6-mnn-w6/<文件>"`；再用 debug 广播调 `native.model.verify`（参数 `{"id":"nllb600m-un6-mnn-w6"}`）。校验标记是 `<dir>/.arkli-model.json`（版本 + 各文件长度与修改时间，见 model-download.md），手放文件的状态是 `unverified`，`verify` 会重算 sha256 并与清单比对，通过后写标记变 `installed`；拷贝改了修改时间也没关系，因为 verify 会重写标记；sha 不符的文件会被 verify 直接删除（所以上传前别拿旧 `model.json`）。
2. 冷加载首句（含加载）≤ 4.8 s；后续短句 ≤ 2.0 s（`elapsedMs`，各测 10 次取中位数）。目标机 STG-AL00 无 dotprod/fp16，这是高风险门槛。
3. `beams` 取舍：同一批句子分别跑 `numBeams` 缺省（1）与 2，对比耗时与译文；缺省 1 不过关（质量明显更差）时，把 `model.json` 改回 2 需重算 sha 并同步清单与重新上传。
4. 稳态增量 RSS ≤ 480MB、峰值增量 ≤ 620MB（加载前后 `run-as` 读 `/proc/<pid>/status` 的 VmRSS/VmHWM 与 `smaps_rollup`，口径同 status.md；桌面 Windows 工作集 512MB 仅供参考）。
5. 卸载后 ≤ 基线 +30MB（删模型或 `AiRecycle` 触发卸载后等 30 秒再测，验证 `release_memory`）。
6. 六语样句对拍：用 `scripts/mnn/data` 的评测句（`sentences_m6.tsv` 149 句抽 20~30 句，覆盖 30 个有向语言对）在手机上跑，译文与桌面 M6b 对拍结果逐字比较；注意引号包裹法（你好→Hello 等短句）与 `<unk>` 缺字句（懒、媚）的已知行为。
7. 验收通过后：把 `nllb600m-un6-ccm-int4` 移入 `retired`（M9 一并做），更新 status.md；不通过则回滚：Kotlin 常量与前端 id 回指旧模型（ORT 路径仍在包里）。

**M7 语音 → sherpa-mnn [真机]**
- 新增 `native/mnn/build-sherpa-mnn.sh`（参数见 3.5；源码取固定提交的 `apps/frameworks/sherpa-mnn`；短路径问题用 `subst` 或 WSL）；产物并入 `mnn-478c10e-v2`（或 v3）；`build.gradle.kts` 的 `mnnLibs` 增加一项。
- 随包 Kotlin API：拷 `sherpa-mnn/kotlin-api/` 里用到的文件到 `app/src/main/kotlin/com/k2fsa/sherpa/mnn/`（保留许可证头）；`SpeechEngine.kt` 换 import；`SpeechPolicy.kt` 文件名改 `encoder.mnn/decoder.mnn/joiner.mnn` 并重设最小字节数；语音模型**首次进入 `models.json`**（`asr-zipformer-zh-en-mnn-w8`），旧手动目录进 `retired`。
- 验收：用 debug 广播的离线喂 wav 路径跑 4 条测试音频，文字与第 3.5 节 MNN 结果一致；再口述实测。兜底：sherpa-mnn 在手机上跑不通时，转向 Rust 自写流式解码（另开一步）。

#### M7 落地情况（桌面部分，2026-10-15；sherpa-mnn JNI 在真机上能否跑通是**最高风险项，未验证**；release 上传与真机待用户）

- **sherpa-mnn JNI**：`native/mnn/build-sherpa-mnn.sh`（新增）用 NDK 28.2.13676358 + CMake 3.22.1 + Ninja，编固定提交 `apps/frameworks/sherpa-mnn`（版本 1.10.46）的 `sherpa-mnn-jni`，`arm64-v8a`、`android-26`、`BUILD_SHARED_LIBS=OFF`、关掉 TTS / 说话人分离 / 二进制 / Python / 测试 / CHECK / portaudio / websocket / C API，链接 `-Wl,-z,max-page-size=16384`；链接的 `libMNN.so` 必须是 sha `9cc1ff8b…a353` 的那一份（脚本校验，不符就停）。**构建期依赖**（sherpa-mnn 的 cmake 配置时才下载）六个源码包由脚本先按固定地址取到 `native/mnn/.work/sherpa-mnn-deps/` 并校验 sha256（主地址 + hf-mirror 备份，与各 `cmake/*.cmake` 里的 URL_HASH 一致，cmake 自己还会再校验一遍）：eigen 3.4.0（MPL-2.0，仅头文件）、kaldi-decoder 0.2.6、kaldifst 1.7.11、kaldi-native-fbank 1.21.1、openfst `sherpa-onnx-2024-06-19`、simple-sentencepiece 0.7（均 Apache-2.0），再复制进构建目录让 cmake 优先用本地文件。Windows 下构建树路径超 260 字符会失败，脚本用 `subst`（默认 `S:`，`SHERPA_MNN_SUBST_DRIVE` 可改）把 `.work` 映射成短盘符，结束自动解除；`MSYS2_ARG_CONV_EXCL` 只用于 `subst` 命令（Git Bash 下不要设 `MSYS_NO_PATHCONV=1`，M2 已记）。用法：`ANDROID_HOME=E:/sdk/android native/mnn/build-sherpa-mnn.sh <输出目录>`（默认写 `native/mnn/out`，只新增这一个文件）。
- **产物**（本机 scratchpad `m7-out/so/libsherpa-mnn-jni.so`，已剥离）：**2,690,520 B，sha256 `aa79262fa17431bf513c7c4ac9855df02d09c1fe364396c0d8032df652a0c339`，`gzip -9` 968,155 B**。NEEDED 只有 `libandroid.so`、`liblog.so`、`libMNN.so`、`libm.so`、`libdl.so`、`libc.so`。比 spike 的 2,685,976 B（sha `ba46a03e…`）大 4,544 B，是源码路径与构建目录不同造成的（二进制不可逐字节复现，按“登记最终一份”处理，**上传的必须是这份**）。`llvm-nm -D` 共导出 126 个 `T` 符号（`Java_com_k2fsa_sherpa_mnn_*`），语音要用的 12 个：`OnlineRecognizer_{newFromFile,newFromAsset,delete,createStream,reset,decode,isEndpoint,isReady,getResult}`、`OnlineStream_{acceptWaveform,inputFinished,delete}`；**包名是 `com.k2fsa.sherpa.mnn`**（与旧的 `com.k2fsa.sherpa.onnx` 不同），类名与方法名同构。
- **gradle**：`app/build.gradle.kts` 的 `mnnLibs` 增加 `libsherpa-mnn-jni.so`（sha 同上）；`mnnReleaseBase` 仍是 `mnn-478c10e-v2`，**把它并入 v2**。**用户上传 v2 时放三个文件**：`libMNN.so`（4,899,952 B，`9cc1ff8b…a353`，不变）、`libarkli-mnn.so`（71,592 B，`b4c9bf34…9f40`，**统一 AI 协议第 6 步版：JNI 按次采样，内容已变，v2 尚未上传所以仍放进 v2**；M2 版 69,728 B / `1229e2f6…6f81` 作废）、`libsherpa-mnn-jni.so`（2,690,520 B，`aa79262f…c339`）。上传前靠 `.gradle/arkli-mnn/<sha>-libsherpa-mnn-jni.so` 缓存本地构建（已复制好，`--offline` 即可 `assembleDebug`，不联网）。
- **随包 Kotlin API**：`app/src/main/kotlin/com/k2fsa/sherpa/mnn/{OnlineRecognizer,OnlineStream,FeatureConfig}.kt` 取自固定提交的 `sherpa-mnn/kotlin-api/`（与 `com.k2fsa.sherpa.onnx` 共存，旧的在 jar 里，M9 才删）。上游这三个文件**没有许可证头**；每个文件顶部加了来源与 Apache-2.0 说明，许可证全文放 `native/mnn/THIRD_PARTY_SHERPA_MNN_LICENSE`（取自 sherpa-mnn 的 `LICENSE`）。`OnlineRecognizer.kt` 删去了只供示例的 `getModelConfig`/`getOnlineLMConfig`/`getEndpointConfig`（引用 sherpa-onnx 的示例模型名，本项目不用）。字段与 JNI 里的 `GetFieldID` 逐个对过，一致。`SpeechEngine.kt` 换 import；`libOk` 探测改为先 `System.loadLibrary("MNN")` 再触发 `OnlineRecognizer` 的静态初始化（后者载入 `libsherpa-mnn-jni.so`），保证 `libMNN.so` 先可用。`SpeechPolicy.kt`：`MODEL_DIR` 与新增的 `MODEL_ID` 为 `asr-zipformer-zh-en-mnn-w8`，文件名 `encoder.mnn`/`decoder.mnn`/`joiner.mnn`/`tokens.txt`，最小字节数重设为 120,000,000 / 8,000,000 / 2,000,000 / 10,000（实际 155,527,912 / 10,603,880 / 2,623,028 / 58,806）。`proguard-rules.pro` 为 `com.k2fsa.sherpa.mnn.**` 补保留规则，旧 onnx 规则留着。`modelType = "zipformer2"` 保持；桌面版已确认 sherpa-mnn 能读到 `.mnn` 里带的元数据。
- **模型产物**（本机 scratchpad `m7-out/asr-zipformer-zh-en-mnn-w8/`，不入库；`scripts/mnn/convert_all.py asr` 用固定提交 MNNConvert、`--weightQuantBits 8` 转**一次**，`pack.py` 登记，不能重转，重转 sha 会变）：

| 文件 | 字节 | sha256 |
|---|---|---|
| `encoder.mnn` | 155,527,912 | `982314ac18794997a4e5d0ae8ff52bfcbf0299503caed8256fe469cab6b7af8f` |
| `decoder.mnn` | 10,603,880 | `bf91f6513a4d05b3c1c4f06c034e51caddda8d503caba3ad6250bd016950e018` |
| `joiner.mnn` | 2,623,028 | `47b490b2ae3abb402f54a35183ec07cd50bde180b5c55f12dd5241a116bba2e9` |
| `tokens.txt` | 58,806 | `b818a60878b9aae978cbb8ad594acbd403d76d1af2e31ef4197c84e2dbdba27c` |

  合计 168,813,626 B（现网 int8 ONNX 包 133,895,136 B，**下载量多约 35MB**）。输入是 fp32 语音包（584,120,230 B，sha `7e82f0a2…7b88`，M1 已下载并校验）。**来源与许可证（已核实）**：模型是 X-ASR（`Gilgamesh-J/X-ASR`，480ms 流式 zipformer，中英）的 sherpa-onnx 导出包；GitHub 仓库 API 与 Hugging Face `GilgameshWind/X-ASR-zh-en` 模型卡都标 **Apache-2.0**（包内 README 只写了来源链接，没有 LICENSE 文件）。**遗留**：Apache-2.0 要求随分发带许可证文本，本次产物只有 4 个文件，**没有加 NOTICE/LICENSE**（NLLB 包有）；要加的话需改 `recipes.json`/`convert_all.py` 并多登记两个文件，没做。
- **清单**：`models.json` **首次**加入 `asr-zipformer-zh-en-mnn-w8`（`dir: models/asr-zipformer-zh-en-mnn-w8`，4 个文件逐个带 bytes/sha256/role/urls，`apache-2.0`，displayName「本地语音输入模型（zipformer 中英，MNN 版）」，URL 为 release `asr-mnn-v1`，顶部 `note` 已注明待上传）。**旧手动放置目录 `asr-zipformer-zh-en-int8` 没进 `retired`**（理由同 M5/M6c：release 未上传、真机未验收）。语音就绪判定本来就读 `SpeechConst.MODEL_DIR` 下的文件，随常量改为新目录，没有另写逻辑；没装新模型时沿用既有“语音识别模型未就绪”提示，**不做新旧回退**。前端没有硬编码语音模型 id（`web/` 没改），AI 中心是否列出它取决于工具声明与目录，本次没动。
- **待用户上传**：（a）`mnn-478c10e-v2`：上面三个 so；（b）`asr-mnn-v1`（仓库 `icodejoo/arkli`，URL 形如 `https://github.com/icodejoo/arkli/releases/download/asr-mnn-v1/<文件名>`）：上表四个文件，文件名固定。上传后按第 5 节做 302 与 sha256 复核。**上传前设备下载会失败。**
- **桌面验证**（本机 scratchpad `m7-out/`）：
  - `eval_asr.py`（numpy fbank + 流式贪心，4 条测试音频，MNN w8 `memory=2`，ORT fp32 为基准）：**MNN w8 与 ORT fp32 逐字一致 4/4**（`eval_asr.txt`）；桌面编码器 RTF 0.149、稳态 RSS 261MB（峰值 1182MB 是加载瞬时）；ORT int8 现网仍是 1.wav 少一个逗号。
  - **sherpa-mnn 桌面版**：用 MSVC（/MT，与宿主 `MNN.dll` 一致）把 sherpa-mnn 的流式识别可执行 `sherpa-mnn.exe` 编出来了（一次成功；脚本在 scratchpad `m7-work/scripts/build_desktop.ps1`，不入库），链接我们的宿主 `MNN.dll`（`build-tools.ps1 -HostDll` 产物；sherpa-mnn 自己设 memory=low、rearrange）。同一份 w8 模型、4 条音频，**sherpa-mnn 自带的前处理（kaldi-native-fbank）与解码**的结果：

| 配置 | 0.wav | 1.wav | 2.wav | 3.wav |
|---|---|---|---|---|
| numpy eval（MNN w8 = ORT fp32） | 基准 | 含句末“？” | “频繁的” | 含句末“。” |
| sherpa-mnn 默认（`high_freq=-400`） | 与基准一致 | **缺句末“？”** | **“平凡的”** | **缺句末“。”** |
| sherpa-mnn 默认，fp32 MNN 模型 | 同上一行 | 同上 | 同上 | 同上 |
| sherpa-mnn `--high-freq=0` | 与基准一致 | 缺句末“？” | **“频繁的”（回正）** | 缺句末“。” |

  结论：① **量化没问题**：sherpa-mnn 下 w8 与 fp32 的 MNN 结果 4/4 相同。② “频繁→平凡”**来自 sherpa 的 fbank 默认 `high_freq=-400`（上限 7600Hz）**，numpy eval 与模型作者的 `test_onnx.py` 都是 0（奈奎斯特）；`--high-freq=0` 后与基准一致。Kotlin 的 `FeatureConfig` 只有 `sampleRate`/`featureDim`，**App 里改不了 high_freq**，真机上会是 `-400` 的行为（现网 sherpa-onnx 默认同样是 -400，所以不算迁移引入的回退；但此前“现网 4 条与 fp32 一致”只在 numpy 口径上成立，没用真 sherpa-onnx 跑过）。③ 句末标点：numpy eval 与 `test_onnx.py` 在**特征层**补 100 帧零，sherpa 在**波形层**补静音（桌面可执行补 0.8s，我再额外补 1s 静音结果不变；App 补 0.66s），模型对真静音不吐最后的“？”“。”——也是口径差，不是量化。要保住句末标点，得改 JNI/C++ 暴露 high_freq 与尾部处理，或走 Rust 自写解码；这是产品取舍，没做。
  - 速度（桌面 4 线程，`sherpa-mnn.exe`，w8）：RTF 0.058~0.087（含加载与解码），桌面相对值。
  - **因此文字一致的验收口径要改**：真机上 4 条音频应与上表“sherpa-mnn 默认”那一行逐字比，而不是与 numpy 的 MNN 结果比（第 7 节原写法不准确）。
- **Kotlin 全量与打包**：`./gradlew.bat :app:testDebugUnitTest --offline`：673 个测试，0 失败、0 错误、1 跳过（既有）；`SpeechPolicyTest` 新增 3 个（文件名为 MNN 版且无 onnx；随包清单有语音条目且 id/目录/文件名/字节数与常量一致、不低于最小字节数、URL 在白名单；旧目录不在 retired）。`./gradlew.bat :app:assembleDebug --offline`：成功，debug APK 54,214,287 B，`lib/arm64-v8a/` 同时有 `libsherpa-mnn-jni.so`（2,690,520 B，`aa79262f…`）与旧 `libsherpa-onnx-jni.so`（`3c6492ea…`），`libMNN.so`、`libarkli-mnn.so` 的 sha 与上面一致（逐个校验）。构建提示 “Unable to strip … libsherpa-mnn-jni.so”（已剥离过，无害）与上游 `OnlineRecognizer.kt` 的一处 unchecked cast 警告。
- **被改的旧断言**：没有删改旧断言；`SpeechPolicyTest` 里原来用常量名的测试自动跟随新文件名与最小字节数。
- **方案里不准确 / 缺的地方**：① 方案写“文件名改 `encoder.mnn/decoder.mnn/joiner.mnn`”，实际 `tokens.txt` 不变且要同时登记进清单；② 方案说“旧手动目录进 `retired`”，按 M5/M6c 的先例有意推迟；③ sherpa-mnn 的 Kotlin API 在 `sherpa-mnn/sherpa-mnn/kotlin-api/`（`kotlin-api-examples/` 里是 Windows 解压后的文本符号链接，不能直接拷），且没有许可证头；④ 方案第 7 节“文字与第 3.5 节 MNN 结果一致”的口径不准（见上，前后处理不同）；⑤ 方案没提 Apache-2.0 要求的随包许可证文本；⑥ 方案写“产物约 2.69MB”，实际 2,690,520 B；⑦ 版本差异风险：sherpa-mnn 基于 sherpa-onnx **1.10.46**，现网是 1.13.8；`FeatureConfig`/`EndpointRule`/`OnlineModelConfig` 等字段同构，但 1.10.46 之后上游对端点、标点、流式等的修复不在其中，真机表现要实测。
- **兜底**：sherpa-mnn JNI 在手机上跑不通（加载、崩溃、结果不对）时，转 Rust 自写流式解码（fbank + 状态管理 + 贪心，spike 的 Python 版约 150 行；可顺便把 high_freq 与尾部处理定成与基准一致），模型仍用本节这份 MNN 产物；**另开一步，本次没做**。

**待真机执行清单**（M7 的 [真机] 部分，本次未做；前提：包里是含 `libsherpa-mnn-jni.so` 的 `mnn-478c10e-v2` 版本，设备上有新语音模型）

1. 让设备得到新模型。正式路径：用户先上传 `asr-mnn-v1`（4 个文件）与更新后的 `mnn-478c10e-v2`（3 个 so），AI 中心下载 `asr-zipformer-zh-en-mnn-w8`（App 逐文件校验 sha256）。**不依赖 release 的做法**（debug 包）：`export MSYS_NO_PATHCONV=1`；把 4 个文件 `adb push` 到 `/data/local/tmp/asr-mnn/`；`adb shell run-as com.let188.arkli.debug mkdir -p files/models/asr-zipformer-zh-en-mnn-w8`；逐个 `adb shell "run-as com.let188.arkli.debug cp /data/local/tmp/asr-mnn/<文件> files/models/asr-zipformer-zh-en-mnn-w8/<文件>"`；再用 debug 广播调 `native.model.verify`（`adb shell am broadcast -a com.let188.arkli.debug.CMD --es cmd rpc --es method native.model.verify --es params '{"id":"asr-zipformer-zh-en-mnn-w8"}'`），手放文件是 `unverified`，verify 重算 sha256 并与清单比对，通过才变 `installed`，sha 不符的文件会被删除（上传前别用旧文件）。注意：语音 `status` 只看文件是否齐全且够大，不看 verify 状态，所以 verify 之前语音也可能已显示可用。
2. **JNI 能否加载与识别（最高风险，先做）**：把 4 条测试音频（`test_wavs/0~3.wav`，来自 fp32 语音包）`adb push` 到 `cacheDir/asrtest/`（`run-as` 拷入），`adb shell am broadcast -a com.let188.arkli.debug.CMD --es cmd asrwav`，看 logcat `ArkliDebug` 的 `DBGASR`：应有加载耗时与 4 条文字；若 `UnsatisfiedLinkError`、崩溃或 `NOT_READY` 立即停，走兜底。
3. 文字：4 条与上表“sherpa-mnn 默认”那一行逐字比对（0.wav 与基准一致；1/3 句末标点可能缺；2.wav 预期“平凡的”）。不一致时先核对模型文件 sha 与 so 的 sha。
4. 实时率 ≤ 0.3（`DBGASR` 行的 `RTF`；现网 sherpa-onnx 约 0.25，见 bridge-protocol）；首字延迟不劣于现网（麦克风口述，从开口到第一个 `speech.partial`）；RSS 不高于现网（`DBGASR done` 行的 `pss/nativeHeap`，`asrunload` 后等 30 秒再测回落）。目标机 STG-AL00 无 dotprod/fp16，MNN int8 动态量化内核在它上面的速度是风险点。
5. 麦克风口述冒烟：语音输入框说一段中英混说，看 partial/final 事件、停顿 endpoint、`native.speech.stop` 冲刷；再口述实测几句，确认没有明显错字。
6. 验收通过后：把 `asr-zipformer-zh-en-int8` 移入 `retired`、删 sherpa-onnx jar 与 `libsherpa-onnx-jni.so`（M9 一并做），更新 status.md；不通过则回滚：`SpeechConst`、`SpeechEngine.kt` 的 import 回指旧 onnx 包与旧模型文件名（旧 jar、旧目录都还在）。

**M8 OCR（随统一协议第 5 步“OcrEngine 端口”一起做）[真机]**
- 直接用 MNN fp16 模型（`ppocrv5-mnn-fp16`，约 11.3MB）与 `MnnBackend`；`pipeline.rs` 的算法不改。落地情况见下。

#### M8 落地情况（桌面部分，2026-10-16；真机与 release 上传待用户）

**产物**（`scripts/mnn/convert_all.py ocr` 转一次，只登记这一份；每次转换的 UUID 不同，重转会改 sha；本机产物在会话 scratchpad `m8-out/ppocrv5-mnn-fp16/`，不入库）：

| 文件 | 字节 | sha256 | 清单 role |
|---|---|---|---|
| `det.mnn` | 2,411,040 | `73d519a359883d440efce876a52691d2afa064ccdb5120f4c1cedff1a9d7d319` | model |
| `rec.mnn` | 8,423,236 | `9350d716fa78ae220736e3141ec89382367b3bf01d0592c379bec5db31437c18` | model |
| `cls.mnn` | 516,824 | `58ac0a454c0414352e41450220f4249d7c542eef3dbcf62290756a0815480d7c` | model |
| `ppocr_keys.txt` | 74,012 | `d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b` | tokenizer |
| `NOTICE.txt` | 1,555 | `9eb926caa8f5415e75a0b612a423cd30e86741ce10554101a1fdf26b2b9b7cb0` | aux |
| `LICENSE-Apache-2.0.txt` | 11,376 | `3840c5c0c61c294264d2dd77b8777be6ddd90121ef4e0e64abcd22edea581d6e` | aux |

三个模型合计 11,351,100 B（10.8MB），整包 11,438,043 B。转换参数 `--fp16`（权重 fp16 存储，计算仍 fp32），转换器是固定提交编的 `MNNConvert.exe`（sha `32a2d437…c623e`）。`recipes.json` 的 `ocr` 条目新增 `copy`（LICENSE、NOTICE）与 `ocr_dict`，`convert_all.py` 新增 `write_ocr_dict`，`pack.py` 把 `ppocr_keys.txt` 登记为 `tokenizer`；已有 `.mnn` 时再跑 `convert_all.py ocr` 只补字典与许可证文件、不重转。

**评测**（`eval_ocr.py`，ORT fp32 为基准，8 张合成图，数字与上文 3.6 节一致）：det 二值图 IoU 均值 0.9949（最小 0.9921，门槛 ≥ 0.99）；rec 逐步 argmax 319/320 = 99.69%（门槛 ≥ 99.5%）；cls 8/8；`memory=normal` 与 `low` 结果相同。门槛通过。

**识别字典**：来自 rec 的 ONNX 元数据（`onnxruntime` 的 `custom_metadata_map["character"]`，原版 `ch_PP-OCRv5_rec_mobile.onnx`），**没有**用 RapidOCR 配置里的 `ppocrv5_dict.txt`，原因是元数据就是这个模型训练时用的字符表，不会版本错配。格式：UTF-8、无 BOM、LF、一行一个字符（部分行是多码点的 emoji 国旗）、末尾一个换行；18,383 项，无空行、无重复，首项是全角空格 `U+3000`；`pipeline.rs` 的 `CtcDecoder::from_dict_text(dict, use_space = true)` 读它，类别数 = blank + 18,383 + 末尾空格 = 18,385，与 rec 输出最后一维一致（`decode` 会校验类别数，不一致直接报错，真库测试覆盖）。文件名 `ppocr_keys.txt` 是 `OCR_DICT_FILE`（`pipeline.rs`）与 `OCR_DICT_NAME`（`convert_all.py`）的同一个常量。

**许可证**：PaddleOCR 与 RapidOCR 的 GitHub 仓库经 GitHub API 核实都是 **Apache-2.0**；模型文件来自 ModelScope `RapidAI/RapidOCR`，其**模型页自己的许可证标注本次没能核实**（接口无返回），暂按上游 Apache-2.0 登记，**待用户在模型页确认**。随包带 `LICENSE-Apache-2.0.txt`（取自 PaddleOCR 仓库 `LICENSE`）与 `NOTICE.txt`（来源、修改说明、免责），源文件在 `scripts/mnn/data/ocr/`。

**清单**：`app/src/main/assets/ai/models.json` 新增 `ppocrv5-mnn-fp16`（`dir: models/ppocrv5-mnn-fp16`，displayName「本地文字识别模型（PP-OCRv5，MNN 版）」，6 个文件逐个带 bytes/sha256/role/urls，`apache-2.0`），顶部 `note` 已注明 release `ocr-mnn-v1` 待用户上传。

**待用户上传**（release `ocr-mnn-v1`，仓库 `icodejoo/arkli`；URL 形如 `https://github.com/icodejoo/arkli/releases/download/ocr-mnn-v1/<文件名>`）：上表 6 个文件，文件名必须原样（`det.mnn`、`rec.mnn`、`cls.mnn`、`ppocr_keys.txt`、`NOTICE.txt`、`LICENSE-Apache-2.0.txt`）。上传后逐个核对 sha256 与清单一致。上传前 AI 中心下载会失败。

**Rust**：
- `arkli-ai`：`OcrModelPaths::in_dir`（按约定文件名拼 det/rec/cls/字典路径）、`OcrOptions::for_ppocr_v5`、`OcrPipeline::load_with`（按“路径→会话”的闭包加载，`load` 改为调它，ORT 路径行为不变）、`MnnRuntime::load_ocr_pipeline(dir, threads)`（三个图输入输出名 `x` / `fetch_name_0`，经 `GraphTensorSession` 变成 `Session`，所以 `recognize` 的算法一行没改，既有测试原样通过）。
- **发现并处理的坑：方向分类模型的输入是固定 80×160，而 `OcrOptions` 默认是 48×192**（`lib.rs` 的“已知约定需真机复验”里写过）；`for_ppocr_v5` 把 cls 尺寸设为 `OCR_V5_CLS_HEIGHT/WIDTH = 80/160`，默认值保持不变（既有单测断言 48×192）。MNN 对 det/rec 的动态输入形状（每张图、每行宽度不同）可直接 resize，真库实测没问题。
- `arkli-ffi/src/ocr.rs`（新）：`ocr_load(runtime_lib, model_dir, threads)` / `ocr_recognize(width, height, rgb)` / `ocr_cancel()` / `ocr_unload()`，进程内单例 + Mutex；结果 `OcrResult { width, height, lines: [OcrTextLine { points: [OcrPoint{x,y}] ×4, text, score }], elapsed_ms }`；错误 `OcrFfiError { NotLoaded, InvalidInput, Cancelled, Backend }`。`ocr_cancel` 用单独的令牌锁，不必等推理结束；排队中的识别也会被取消。图像输入是**原生解码后的 RGB 像素**（Rust 没有 PNG/JPEG 解码器，`png` crate 一直没批准），与识物同一约定，Kotlin 侧不传路径给 Rust。只支持 MNN（OCR 从未接过 ORT，所以没有旧 ORT 路径要保留）。
- UniFFI 绑定已用 `core/scripts/build-android.ps1` 重新生成（`CARGO_TARGET_DIR=C:\cargo-target\cisox`），新绑定含 `ocrLoad(runtimeLib, modelDir, threads)`、`ocrRecognize`、`ocrCancel`、`ocrUnload` 与 `OcrFfiException`；`libarkli_ffi.so` 3,695,432 B，sha256 `a902742c22c709eee06da9e57a035162cf42d287fed14b04ae20690c70369875`（上一版 `6533a7d1…d602`），`assembleDebug` 的 APK 里是同一个 sha。绑定是生成物（已被 `.gitignore` 忽略），没有手改。

**Kotlin 与统一协议**（详见 [统一 AI 协议](../design/ai-protocol.md) 的“新增一个 AI 任务的 checklist”）：`AiTask.OCR`（wire `ocr`）、`AiPort.Ocr`（`OcrEngine`，入口 `native.ai.ocr`）、`AiCall.Ocr`、`AiOcrPolicy`（参数、尺寸收敛、结果 JSON）、`OcrService`（缺文件 NOT_READY、首次识别才加载、指纹变化重载、协程取消调 `ocr_cancel`）、`LocalOcrProvider`（`local-ocr`，L1，`sessionModelId = ppocrv5-mnn-fp16`，实现 `AiSessionControl`）、`AndroidOcr.kt`（`MnnNative.ensureLoaded()` 后传裸名 `libarkli-mnn.so`，线程 4）。解码最长边先降采样到不小于 2560，仍超过 4096（`MAX_INPUT_SIDE`）再等比缩小。`native.ai.ocr` 是 `native.ai.invoke` 钉 ocr 端口的别名（此前 Kotlin 从未注册过这个方法，前端 `AI_METHODS.ocr` 只是桩）。`AiProviderContractTest`、`AiRecycle`、预热/卸载处理器没有改检查逻辑，只同步了测试里的提供者列表。

**前端**：`registry.ts` 的 `ocr` 声明 `tasks: [{ task: 'ocr', entry: AI_METHODS.ocr }]`、去掉过渡 `models`；`table-extract` 补同样的 `tasks` 并加 `ai` 标签（否则没有选择器、也不出现在 AI 页）；两个页面改读 `useAiCatalog`、缺模型时显示共用的 `<model-missing-notice />`，不再依赖 `native.ai.status` 桩与 `useAiModel`（超分、抠图、融合、上色仍用，见 ai-protocol 已知局限）；`aiOcr(path, signal?)` 转调 `aiInvoke('ocr', …)`；`LEGACY_CHOICE_MIGRATION` 增加 `ocr`、`ppocrv5-mnn-fp16` → `local-ocr`。**旧 `aiOcr(path, lang, call)` 的签名变了**：`lang` 参数删除（PP-OCRv5 不分语言，OCR 页的“识别语言”单选一并删除）。

**验证（桌面）**：
- `cd core; cargo test --workspace`：arkli-ai 191 通过（19 忽略）、arkli-ffi 17 通过（1 忽略）、其余通过。`cargo test -p arkli-ai --features mnn-backend`：187 + 20 通过，12 + 57 忽略。
- 真库（`ARKLI_MNN_DYLIB=native/mnn/.work/build-tools/arkli-mnn.dll`，同目录 `MNN.dll`；Windows 下路径要用反斜杠，正斜杠 `LoadLibraryExW` 会失败）：`cargo test -p arkli-ai --features mnn-backend --lib 真库跑通ocr -- --ignored --nocapture`，输入 `eval_ocr.py` 的合成图 `text0.png`（1080×1400，经 `scripts/mnn/ocr_case.py` 转成 `case.rgb` + `expect.txt` 真值），debug 构建：加载 42 ms，识别 500 ms，6 行全部与真值一致（忽略标点全半角差异）：
  - `[0.975] 价格：￥128.50(含税)`（真值“价格：￥128.50 （含税）”，只差括号前空格与全角括号）
  - `[0.968] The quick brown fox jumps over`、`[0.996] Hello world 2026-10-15 12:34`、`[0.999] 今天天气很好，适合出去走走。`、`[1.000] 垃圾分类：可回收物、有害垃圾`、`[0.963] MNN 推理引擎 迁移方案`
  - `arkli-ffi` 的 `真库经ffi识别并可卸载重载`：同样 6 行（526 ms），卸载后识别报 `NotLoaded`，重新加载再识别通过。桌面 MSVC 构建缺 AVX 内核分发，耗时**不能**当真机参考。
- `./gradlew.bat :app:testDebugUnitTest --offline`：全部通过（含新增 `OcrServiceTest`、`AiOcrPolicyTest`、`AiInvokeTest` 的 OCR 用例与扩充后的契约测试）；`cd web; pnpm vitest run`：154 个文件、2137 个用例通过；`pnpm vue-tsc --noEmit`：无错误；`./gradlew.bat :app:assembleDebug --offline`：成功，APK 57,922,087 B，内含 `libarkli_ffi.so`（sha 同上）、`libarkli-mnn.so` 69,728 B（M8 当时；第 6 步起换成 71,592 B / `b4c9bf34…9f40`）、`libMNN.so` 4,899,952 B、`libonnxruntime.so`（M9 才删）。

**被改的旧断言**：`AiProviderContractTest`（注册 id 列表、层 map、`sampleInput`、会话提供者列表加 `local-ocr`）、`AiSessionDerivationTest`（两个提供者列表）、`aiCatalog.test.ts`（OCR 目录由“过渡项”改为 `local-ocr`、各工具声明快照、迁移表与 `migrateChoice` / `staticDefault` 示例从 `ocr` 换成 `image-upscale`、会话兜底列表多一项）、`useModelChoice.test.ts`（`ocr` 的默认与迁移）、`ai.test.ts`（`aiOcr` 从“查 status 的通用封装”改为单独的 invoke 封装用例）。原因都是 OCR 从过渡占位变成了真提供者。

**待真机执行清单**（方案第 7 节 OCR 行；前提：真机装了含新 `libarkli_ffi.so` 的 APK，且模型到位；本次未装机、未动 adb）：
1. 让设备得到模型：正式路径是用户上传 `ocr-mnn-v1`（6 个文件）后在 AI 中心下载 `ppocrv5-mnn-fp16`（逐文件校验 sha256）。**不依赖 release 的做法**（debug 包）：`export MSYS_NO_PATHCONV=1`；把 6 个文件 `adb push` 到 `/data/local/tmp/ocr-mnn/`；`adb shell run-as com.let188.arkli.debug mkdir -p files/models/ppocrv5-mnn-fp16`；逐个 `adb shell "run-as com.let188.arkli.debug cp /data/local/tmp/ocr-mnn/<文件> files/models/ppocrv5-mnn-fp16/<文件>"`；再用 debug 广播调 `native.model.verify`：`adb shell am broadcast -a com.let188.arkli.debug.CMD --es cmd rpc --es method native.model.verify --es params '{"id":"ppocrv5-mnn-fp16"}'`（手放文件是 `unverified`，verify 重算 sha256，通过才变 `installed`，不符的文件会被删除）。`local-ocr` 的可用性以 `installed` 为准，所以不 verify 就不可用。
2. 正确性与能否加载（最先做）：把含中英文的截图 `adb push` 到应用缓存 `cache/arkli/pick/dbg/`，调 `native.ai.ocr`（或 `native.ai.invoke` 的 `ocr` 任务，见 bridge-protocol 的调试写法），看 logcat `DBGMSG`：应有若干 `blocks`；出现 `UnsatisfiedLinkError`、`NOT_READY`、崩溃就停。对桌面真库的 6 行结果逐字比对同一张合成图。
3. 速度：1080×2400 截图整图 **≤ 2.2 s**（现网 ORT 4 线程基线；首次含加载，另记冷加载耗时）。看 `inferMs`（Rust 侧）与 `elapsedMs`（含解码）。目标机 STG-AL00 无 dotprod/fp16，MNN fp16 权重在它上面按 fp32 算，速度是风险点。
4. 内存：峰值 RSS **≤ 210MB**（口径同 status.md：`run-as` 读 `/proc/<pid>/status` 与 `smaps_rollup`）；识别后 `native.ai.unload` 等 30 秒，回落到基线 +30MB 内。
5. 页面：OCR 页点图上的框与下面的行能互相定位（坐标按 `width/height` 换算）；图片转表格页识别后生成表格；模型没装时两页都显示“无可用模型，去查看”并禁用识别；识别中离开页面应取消（logcat 应有取消，识别不会跑完）。
6. 旧 ORT OCR 没有进过 App，所以没有“旧模型对照”；与 ORT fp32 的对照只有桌面 `eval_ocr.py` 的数字。

**方案里不对或缺的地方**：① 方案没提识别字典：rec 模型本身不带字典文件，要从 ONNX 元数据取（本步做了，并随包登记）。② 方案写“`pipeline.rs` 不改”成立，但它的 cls 默认输入 48×192 与 PP-OCRv5 模型的 80×160 不符，必须在加载处设（`OcrOptions::for_ppocr_v5`），只改了配置、没改算法。③ 方案写模型“约 11.3MB”，三个 `.mnn` 实为 11,351,100 B，含字典与许可证整包 11,438,043 B。④ 方案没提许可证文本（Apache-2.0 要求随包）。⑤ 方案第 4.4 节说旧入口 `native.ai.ocr`“作为薄封装”，实际 Kotlin 从未注册过它，本步是新增注册。⑥ 方案把图像输入留成待定（路径或字节）：Rust 无解码器，只能收原生解码的 RGB。⑦ `status.md` 里“OCR 管线没接 UniFFI”的描述已过时（已更新）。

**遗留**：真机速度/内存/正确性未验；ModelScope 模型页许可证标注待核实；`ocr_cancel` 只在管线检查点（检测前后、每行识别前）生效，单个模型前向本身不可打断；识别 4096 以上大图靠 Kotlin 缩小而不是 Rust 分块（`max_tile_height` 仍未实现）；多行排序（`sort_reading_order`）在竖排、多栏版面上未评估；`aiOcr` 签名变了（`lang` 参数删除），若还有未改的调用方需同步。

#### M8 升级：PP-OCRv6 small（桌面部分，2026-10-16；真机与 release 上传待用户）

**来源与许可证**：官方 HF 仓库 `PaddlePaddle/PP-OCRv6_small_det_onnx`（sha `28fe5895…`）与 `PaddlePaddle/PP-OCRv6_small_rec_onnx`（sha `b8f84f0b…`），文件 `inference.onnx` / `inference.yml`（仓库里没有 LICENSE 文件，模型页元数据 `license: apache-2.0`，所以随包的 `LICENSE-Apache-2.0.txt` 仍取自 PaddleOCR 仓库）。原版 sha256：det.onnx（9,880,512 B）`d73e0058…410e`、rec.onnx（21,159,378 B）`5435fd74…4634`、det.yml `193f4352…b516`、rec.yml `ab078671…6806`（`fetch.py` 的 `ocr6` 分组写死）。ONNX 没有 `character` 元数据，字典取自 rec 的 `inference.yml` 的 `PostProcess.character_dict`。

**结构**：det 输入 `x[N,3,H,W]` 动态，输出 `fetch_name_0[N,1,H,W]`（与 v5 同名同布局）；rec 输入 `x[N,3,48,W]` 动态宽，输出 `[N,T,18710]`，字典 18,708 项 + blank + 末尾空格 = 18,710；rec 预处理与 v5 完全一样（高 48、宽按比例、最小 320、(x/255-0.5)/0.5、BGR）。官方 det 后处理（det `inference.yml`）：`thresh 0.2`、`box_thresh 0.45`、`unclip_ratio 1.4`（v5 现网用库默认 0.3 / 0.5 / 1.6，不动）。官方示例默认不开文本行方向分类（`use_textline_orientation` 可选）；包里仍带 v5 的 `cls.mnn`（516,824 B，与 `ppocrv5-mnn-fp16` 里同一个文件），因为它只有 0.5MB、对倒置行有保险作用，Rust 管线无需改。

**转换**：`mnnconv.py -f ONNX --modelFile inference.onnx --MNNModel det.mnn --fp16`（固定提交的 `MNNConvert.exe`，rec 同），两个图一次转换成功、无报错无不支持算子（det 含 RepLK 大核卷积、Erf 等，rec 含 MatMul/Softmax/LayerNorm 展开）。只转一次，只登记这一份：

| 文件 | 字节 | sha256 |
|---|---|---|
| `det.mnn` | 4,967,972 | `211314cc3cdfefb0b7589cd9126ef017f17688242934b7d1681625bcc9d1a487` |
| `rec.mnn` | 10,648,948 | `68195df0fef601a25ffe1ff1f5d412211563be52d18b1fb4840394e7a9d14bd2` |
| `cls.mnn` | 516,824 | `58ac0a454c0414352e41450220f4249d7c542eef3dbcf62290756a0815480d7c`（取自 v5 包） |
| `ppocr_keys.txt` | 74,947 | `b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d` |
| `NOTICE.txt` | 1,693 | `a1e05b9cecc18868145e32543fd5fa034fbdd8a4865f9b18abb975f296308dab` |
| `LICENSE-Apache-2.0.txt` | 11,376 | `3840c5c0c61c294264d2dd77b8777be6ddd90121ef4e0e64abcd22edea581d6e` |

三个模型合计 16,133,744 B，整包 16,221,760 B（v5 整包 11,438,043 B，+4.8MB）。`recipes.json` 新增 `ocr6`（`convert_all.py ocr6`，需要先 `fetch.py ocr ocr6`；脚本重转 `cls.mnn` 的 sha 会变，已登记的是取自 v5 包的那份），`convert_all.py` 新增 `write_ocr_dict_yaml`（需 PyYAML，开发机可选，没写进 requirements）。清单 `ppocrv6-small-mnn-fp16` 已进 `models.json`，release 标签 `ocr-mnn-v2` 待上传。

**Rust**：`OcrOptions::for_ppocr_v6()`（det 后处理取官方值）、`OcrOptions::for_dict_len(n)`（字典恰 18,708 项用 v6，否则 v5）、`MnnRuntime::load_ocr_pipeline` 按字典项数自动选参数、新增 `load_ocr_pipeline_with(dir, threads, options)`；v5 路径行为不变。新增忽略测试 `真库批量ocr输出`（`ARKLI_OCR_BATCH` 指向 `*.rgb` 目录，打印逐图文字与耗时）。

**桌面评测**（8 张合成图，ORT fp32 原版 vs MNN fp16）：det 二值图（>0.2）IoU 均值 0.9965、最小 0.9924；rec 对 Rust 检出的 48 个行裁剪，逐步 argmax 2956/2956 一致，解码文本 48/48 一致，最大绝对差 0.031。与 v5 同图对比（真值 48 行，忽略标点与空白后逐行命中）：v6 48/48，v5 44/48（v5 的错误：`MNN 推理引I擎`、`Hello World` 大小写、竖线噪声）；v6 的小毛病是 CJK 与拉丁字母间的空格有时丢（`MNN推理引擎迁移方案`）、括号前多一个空格（`128.50 (含税)`）。速度（release、桌面 4 线程、best-of-5、8 张 1080×1400 平均）：v5 约 265 ms/张，v6 约 295 ms/张（+11%）；MSVC 构建缺 AVX 分发，只能互相比较。真机待测。

**真机待测**：同 M8 的清单（正确性、1080×2400 ≤ 2.2 s、峰值 RSS ≤ 210MB，rec 增大约 2.2MB 权重，det 的大核卷积在无 fp16 的 STG-AL00 上的速度是风险点），用 `scripts/device-push-models.sh` 推 `ppocrv6-small-mnn-fp16` 并 `native.model.verify`。

**M9 移除 ORT**
- 删 `ort_backend.rs`、翻译的 ORT runner、`ort` 依赖与 `ort-backend` feature（`arkli-ffi/Cargo.toml` 同步）、`fetchOrtRuntime` 与 sherpa-onnx jar、`ORT_LIB_NAME`、`proguard-rules.pro` 里的 sherpa-onnx 规则；更新决策 0002（用户确认后）、`docs/status.md`、`docs/design/architecture.md`。**已完成，见文末“M9 落地情况”。**
- 验证：全部测试；`assembleRelease` 前后 APK 与各 so 体积（`gzip -9` 口径）写进 status。完成判据：APK 里不再有 `libonnxruntime.so`、`libsherpa-onnx-jni.so`。

## 7. 风险、回滚与验收

| 风险 | 影响 | 对策 |
|---|---|---|
| STG-AL00 无 dotprod/fp16，MNN int8 动态量化内核可能比 ORT 慢 | 速度回退 | M5 第一个真机门槛就测；不过关时试 `memory=normal`+int8 仅对小模型、或 6 位/8 位权衡 |
| `memory` 配错成 normal | NLLB 内存 2.85GB 级 | C ABI 默认 low，Rust 不暴露 normal（测试除外） |
| 加载瞬时峰值 | 低内存机被杀 | 外置权重 + rearrange；三张图顺序加载 |
| sherpa-mnn 版本老（1.10.46） | 端点/标点行为差异、JNI 崩溃 | 真机先跑离线 wav；兜底自写解码 |
| 量化质量只在小样本上测 | 线上个例变差 | 验收集扩充到 ≥100 句 / ≥100 图，阈值见下 |
| 用户手机上的旧模型占空间 | 存储浪费 | M4 `retired` 清理 |

**真机基准（有设备时照做；本次未执行，真机已收回）**：

1. 推送：`export MSYS_NO_PATHCONV=1`；`adb -s 7NQBB23606003715 push ModuleBasic.out benchmark.out libMNN.so /data/local/tmp/mnnbench/`（`native/mnn/build-tools` 的安卓目标产出），再推各模型的 `.mnn/.weight` 与 `make_case.py` 生成的用例目录。
2. 正确性：`cd /data/local/tmp/mnnbench && LD_LIBRARY_PATH=. ./ModuleBasic.out <fp32 或 fp16 模型> <用例目录> 0 0 10 4 0`，`diff rate` ≤ 1%；量化模型用 `... 4 8`（memory=low）记录 diff rate 供对照。
3. 速度与峰值内存：后台跑同一命令 `& pid=$!`，循环 `grep VmHWM /proc/$pid/status` 取最后一次；记录 `Avg`、`min`、VmHWM。线程 1/2/4 各一轮。
4. App 内：沿用 status.md 的口径（`run-as` 读 `/proc/<pid>/status` 与 `smaps_rollup`，卸载后等 30 秒），对比本表门槛。

| 模型 | 数值门槛（桌面） | 真机门槛（对比现网，见 status.md 与 garbage-classify-clip.md） |
|---|---|---|
| SigLIP2 int8 low | cos 均值 ≥ 0.985、最小 ≥ 0.95，top-1 一致 ≥ 0.9，top-3 与旧 q4_half 一样好或更好 | 单张 ≤ 1.1 s（现 0.97 s）；加载 ≤ 0.7 s；增量 RSS ≤ 130MB；卸载后 ≤ 基线 +30MB；8 张真机图 top-3 与桌面一致 |
| NLLB 6 位/8 位 low | teacher forcing ≥ 0.96，退化句 0，`trim_tail_repeat` 触发 0 次 | 冷加载首句 ≤ 4.8 s；后续短句 ≤ 2.0 s；稳态增量 ≤ 480MB、峰值增量 ≤ 620MB；卸载后 ≤ 基线 +30MB |
| 语音 int8 low | 4 条测试音频与 fp32 逐字一致（numpy 口径；真机用 sherpa-mnn 自带前处理，口径见 M7 一节） | 实时率 ≤ 0.3、首字延迟不劣于现网；RSS 不高于现网 |
| OCR fp16 | det IoU ≥ 0.99，rec argmax ≥ 99.5% | 1080×2400 截图整图 ≤ 2.2 s（现网 4 线程）；峰值 RSS ≤ 210MB |

哪些是实测、哪些待验：第 3 节全部数字是**桌面实测**；第 7 节真机门槛里的“现网”数字引自 `docs/status.md`、`docs/research/garbage-classify-clip.md`、`docs/research/spike-ort-sherpa.md` 的历史真机记录；MNN 在真机上的速度、内存、JNI 可用性**全部待验证**。

## 8. 不迁移项

没有。用户目标“全部迁到 MNN”在模型层面全部做通了；唯一的不确定是 sherpa-mnn JNI 在手机上的表现，已给出兜底路径（Rust 自写流式解码 + MNN 模型），不需要保留 ORT。对联 GPT-2 没接入 App，等接入时按 NLLB decoder 的做法转换（MNN 的 LLM 导出器不支持纯 GPT-2 结构，未实测）。

## 真机验收记录（2026-10-16，STG-AL00，debug 包，模型经 `scripts/device-push-models.sh` 推入并 verify 通过）

| 项 | 结果 | 对照门槛 |
|---|---|---|
| 语音 sherpa-mnn JNI | 加载正常；4 条音频与“sherpa-mnn 默认”基线一致（1.wav 句尾少“思啊”，3.wav“现代时”→“现代史”）；RTF 0.20；加载 2.5 s | RTF ≤ 0.3 通过 |
| NLLB | 冷加载 4.74 s、短句 0.5~1.0 s；“你好世界”→“Hello world”；稳态增量 RSS 约 545MB；卸载后回基线 +1MB | 冷加载 ≤ 4.8 s 通过；稳态增量 ≤ 480MB **未达标（超约 65MB）** |
| SigLIP2 | 加载 0.96 s；单张含解码约 1.15 s；增量 RSS +126MB；卸载后 +7MB | 加载 ≤ 0.7 s **略超**；单张 ≤ 1.1 s 临界；增量 ≤ 130MB 通过 |
| OCR | 8 张合成图文字准确；约 1.6 s/张（图小于 1080×2400，未按门槛口径测）；增量 RSS +116MB；卸载后 +14MB | 峰值 ≤ 210MB 通过 |
| Qwen | 贪心确定；贪心↔采样切换重建会话约 +3.5 s；非法预设/翻译端口带 temperature 均 `BAD_PARAMS` | 符合设计 |
| 并发 | **发现缺陷**：语音识别与 OCR/翻译/识图并发时进程 SIGSEGV/SIGABRT，且识别结果被截断（共用 MNN 全局执行器）。修复：`SpeechDecoder.feed/finish` 改为 suspend，每块解码走 `AiHeavyGate`。修复后连续 3 轮并发无崩溃、文字与单跑一致，重叠时语音被排队拉长 | 通过 |

未测：麦克风口述（需人说话）、1080×2400 整屏 OCR、冷缓存加载。

## M9 落地情况（2026-10-16）

真机验收通过后，把 ONNX 一套整体清掉。完成判据：APK 里不再有 `libonnxruntime.so`、`libsherpa-onnx-jni.so`，且仍有 `libMNN.so`、`libarkli-mnn.so`、`libsherpa-mnn-jni.so`、`libarkli_ffi.so`——已满足。

**删了什么**
- **Rust**：`arkli-ai` 的 `ort_backend.rs`、`translate/ort_runner.rs`（共 776 行）、`ort` 依赖与 `ort-backend` feature、`translate` 中间 feature（并入 `mnn-backend`）；`backend_for_model` / `BackendKind` 换成 `is_mnn_model`（识物只认 `.mnn`，其余报“不支持的模型格式”）；清单 `format` 只认 `mnn-split`（缺省或旧的 `onnx-merged` 报 Invalid）；ORT 专属的翻译对拍测试模块删除。`Seq2SeqRunner` 抽象保留，只剩 MNN 一个实现。`arkli-ffi` 去掉自己的 `mnn-backend` feature，固定依赖 `arkli-ai/mnn-backend`（翻译模块在该 feature 下，关掉就无法编译，留着开关没有意义），相关 `cfg` 分支与 `NO_MNN_BACKEND` 删掉。`Cargo.lock` 里的 `ort` 及其传递依赖随之消失。`build-android.ps1` 重新生成了 arm64 so 与 Kotlin 绑定（绑定文件不入库）。
- **Gradle**：`fetchOrtRuntime` 整个任务、sherpa-onnx AAR 的下载与 sha256、`libonnxruntime.so` / `libsherpa-onnx-jni.so` / `classes.jar` 的提取与打包、`ZipFile` import；`proguard-rules.pro` 里 `com.k2fsa.sherpa.onnx.**` 规则。本地缓存 `.gradle/arkli-ort/` 已删（未入库）。`com.k2fsa.sherpa.onnx` 此前就只在 jar 里，源码目录里没有，无需删源文件。
- **Kotlin**：`ORT_LIB_NAME`；几处“ORT / 本地 ONNX”注释。
- **native/**：没有只为 ORT 或 sherpa-onnx 存在的文件（`native/mnn/` 下的脚本都服务于 MNN 与 sherpa-mnn），无需删除；`build-sherpa-mnn.sh` 里引用的 `sherpa-onnx-cmake-deps` 镜像是 sherpa-mnn 的第三方源码依赖名，不是 ORT。
- **前端**：`stores/models.ts` 里两条旧 id 的用途映射；`useModelChoice` 与 `aiCatalog.ts` 的 `LEGACY_CHOICE_MIGRATION`（旧 id → 新提供者）**保留**，用于把用户已存的旧选择迁到新 id。AI 中心的“旧 ONNX 版”条目本来就由清单驱动，清单条目删掉后自然消失。

**退役登记**（`models.json` 的 `retired`，目录均为 `models/<id>`；启动后台回收，规则不变：只清 `models/` 直接子目录、不跟随符号链接、与现行条目 `dir` 重名则跳过）：`siglip2-q4_half`、`nllb600m-un6-ccm-int4`、`asr-zipformer-zh-en-int8`、`ppocrv5-mnn-fp16`。对应的旧清单条目（除语音那个本来就没在清单里）已删。旧 release `siglip2-q4half-v1` 不删。`couplet-gpt2` 没接入 App，没动。

**体积**（debug APK，`assembleDebug`，字节）：M9 前 57,923,226 → M9 后 49,426,775，减 8,496,451。`libarkli_ffi.so` 3,696,328 → 3,561,408（release 构建，减 134,920）。

| so（arm64-v8a，未压缩字节） | M9 前 | M9 后 |
|---|---|---|
| libonnxruntime.so | 22,249,560 | 删除 |
| libsherpa-onnx-jni.so | 4,771,760 | 删除 |
| libMNN.so | 4,899,952 | 4,899,952 |
| libsherpa-mnn-jni.so | 2,690,520 | 2,690,520 |
| libarkli_ffi.so | 3,696,328 | 3,561,408 |
| libarkli-mnn.so | 71,592 | 71,592 |

APK 只减 8.5MB 而 so 减了 27MB，是因为 APK 内对 so 做了 deflate 压缩（这两个 so 压缩后合计约 8.5MB）。release APK 与 `gzip -9` 口径的体积这次没有测。

**验证**：`cargo test --workspace` 全绿（arkli-ai 190 + 21 文档测试，arkli-ffi 17，arkli-core 1 + 1；忽略的是需要真库的用例）；`./gradlew :app:testDebugUnitTest --offline` 726 个用例 0 失败（1 个跳过）；`pnpm vitest run` 157 个文件 2183 个用例通过；`pnpm vue-tsc --noEmit` 无错误；`:app:assembleDebug --offline` 成功；`unzip -l` 确认 APK 里没有 `libonnxruntime*.so`、`libsherpa-onnx*.so`。没有上真机。

**残留（合理）**：`scripts/mnn/*.py` 与 `requirements.txt` 的 `onnxruntime`（桌面转换与对拍用，不进 App）、`fetch.py` 里 sherpa-onnx 的 ASR 模型 release 地址（转换的上游来源）、`com.k2fsa.sherpa.mnn.OnlineRecognizer.kt` 注释里提到 sherpa-onnx 的来源说明、`core/crates/arkli-ai/tests/fixtures/translate/nllb_parity.json`（原 ORT 对拍夹具，现在没有测试引用，留作参考数据）。

## 回收实测与修复（2026-10-16，STG-AL00，M9 之后）

回收触发条件：返回键退到底、Activity 结束、`onTrimMemory` ≥ RUNNING_CRITICAL(15)；语音另有闲置 60 秒自动释放。Home 键切后台不卸载。

| 场景 | PSS | 说明 |
|---|---|---|
| 新进程基线 | 123~134MB | |
| 翻译+识物+OCR+Qwen 同时常驻 | 约 1.52GB | 增量约 1.4GB，没有互斥卸载，靠上面的触发条件回收 |
| 再加语音 | 约 1.70GB | |
| trim CRITICAL 后（修复前） | 113MB | 但语音没被卸载，只能等 60 秒闲置计时 |
| 语音释放后（修复前） | 385→375MB | **bug**：识别器整块 malloc，释放后留在分配器里不还系统（Native Heap 已分配 46MB、空闲 233MB） |

发现并修复三处：
1. 语音释放没进 `AiHeavyGate`，和其他 MNN 推理并发会崩：`SpeechService.unload()` 改为 suspend 并排在闸门后。
2. 语音没接入统一回收：`AiRecycle.attachExtra("speech")`，返回键退出与内存告急时一起卸载。
3. 语音释放后不还堆：新增 UniFFI 导出 `purge_native_heap()`（`mem.rs`，`mallopt(M_PURGE)`），释放后调用。

修复后：语音释放 386→145MB，闲置自动释放后 149MB；五个模型全部加载 1.70GB，trim CRITICAL 后 135MB，回收日志 `已卸载 [local-clip, local-ocr, local-nllb, local-qwen, speech]`。
