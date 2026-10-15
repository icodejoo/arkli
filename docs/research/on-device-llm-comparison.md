---
title: 端侧 LLM 选型对比：模型与运行时（真机实测）
status: draft
updated: 2026-10-15
summary: Qwen3.5-0.8B 在 ORT 上的真机可行性、Qwen3 与 Qwen2.5 小模型、ORT/ORT GenAI/llama.cpp/MNN 四种运行时在同一台设备上的速度、体积与内存对比，以及对决策 0002 的影响
---
## TL;DR

> **2026-10-15 更新**：用户拍板 L2 改用 MNN，已接入并在真机验证（见 [Qwen3.5 MNN 模型](qwen35-mnn-model.md) 与 [0002 修订](../decisions/0002-ai-inference-base.md)）。下文是选型当时的对比数据，其中“改 0002 之前先复测”的约束已被这次决定取代，复测仍保留为待办。

- **换运行时比换模型提速大得多**：同一台真机（HUAWEI STG-AL00）、4 线程、干净时段，Qwen3.5-0.8B 解码 Rust ort 约 3.1 tok/s、ORT GenAI 约 3.8、llama.cpp 约 12–13、MNN 约 16.5；Qwen3-0.6B Rust ort 约 4.8、llama.cpp 约 21。
- **瓶颈是 ORT 的 `MatMulNBits` 在这颗 CPU 上走慢路径**（占内核时间 93%）：设备（高通 KHAJE）无点积指令、无 fp16 算术。**结论只在这台老 CPU 上成立，新 SoC 上差距可能缩小，未验证。**
- **ORT 路线可用但慢**：sherpa 自带的 ORT 1.28.2 能创建 Qwen3.5 的 Session，输出与 PC 逐 token 一致；不新增依赖。
- **ORT GenAI 不值得为速度换**：同模型同设备上与 Rust 手写循环速度几乎一样，还要多带 `libmat.so`（28.6MB，微软遥测库）和一份 ORT 1.31。
- **对 [0002](../decisions/0002-ai-inference-base.md)（不引入 llama.cpp）**：数据偏向 llama.cpp 与 MNN，但要改 0002 之前，先在有点积与 fp16 的新机型上复测。**待办，见末尾。**
- **对联不用通用小 LLM**：专用的 GPT-2 对联模型更稳，见 [对联 GPT-2 ONNX](couplet-gpt2-onnx.md)。

## 1. 测量条件与口径

- 设备：HUAWEI STG-AL00，Android 12，8 核（4 大核），约 7.8GB；`/proc/cpuinfo` 的 Features 里没有 `asimddp`、`fphp`。
- 提示与模板：同一句“你好，请用一句话介绍你自己。”，Qwen 聊天模板，非思考模式，贪心 32 token；预填 19 token（Qwen2.5 因带默认 system 提示为 36 token）。
- **设备被 SigLIP 验证间歇占用**（约 270–400% CPU）。`/proc/loadavg` 全程 8–13，不能当判据，改用 `top` 空闲百分比（8 核满值 800%）。采用“各配置交错轮询”，4 线程跑 3 轮，2 线程与 1 线程各 1 轮；稳态数字取空闲 ≥720% 的干净轮次。
- 上一轮 Qwen3.5 的 670 ms/步主要是负载污染（当时 loadavg 约 25）；同图同路线干净时段是 320 ms/步。
- “创建/加载”口径：llama.cpp 与 MNN 是加载进内存，ORT 是建 Session，略有不同。

## 2. Qwen3.5-0.8B 在 ORT 上的可行性（真机探测）

模型：`Qwen/Qwen3.5-0.8B`（Apache-2.0，2026-02-28 创建，约 0.87B 参数含视觉塔，混合注意力：18 层 Gated DeltaNet + 6 层普通注意力，稠密 FFN，非 MoE）。ONNX 取 `onnx-community/Qwen3.5-0.8B-ONNX` 的 q4：解码器 485MB + 词表嵌入 163MB，合计约 649MB（tokenizer 另 19MB）。

- **Session 创建成功**：`embed_tokens_q4` 与 `decoder_model_merged_q4` 都能建，没缺算子。`MatMulNBits`×187、`GroupQueryAttention`×6、`RotaryEmbedding`×12、`SkipSimplifiedLayerNormalization`×48 和 18 个标准 `Scan` 都在 sherpa 那份 ORT 1.28.2 里。
- **正确性**：全 0 状态喂一个 token，设备 top5 与 PC 完全一致；聊天模板预填加贪心 32 token，设备与 PC 逐个相同；输出通顺。
- **输入输出**：decoder 51 个输入（18 层线性注意力每层 `past_conv.N` f32 `[B,6144,4]` 与 `past_recurrent.N` f32 `[B,16,128,128]`；6 层普通注意力 `past_key_values.N.key/value` f32 `[B,2,past,256]`；另有 `inputs_embeds`、`attention_mask`、`position_ids [3,B,S]`），49 个输出（`logits [B,S,248320]` 与各层 `present_*`）。
- **自写循环要点**：`present.*` 直接 `remove` 出来当下一步 `past.*`（零拷贝）；每轮新对话把 conv、recurrent 清零、KV 清成长度 0；`attention_mask` 等于累计长度；`position_ids` 三行相同；采样建议 temperature 0.6、top_k 20、top_p 0.95，eos 为 248046 与 248044；空张量 `[1,2,0,256]` 在 ort rc.14 下可直接创建。
- **端侧 tokenizer 未解决**：探测里分词在 PC 上做。端侧要么引入 `tokenizers` crate（新依赖，需先问用户），要么自写 BPE 解析 19MB 的 `tokenizer.json`，**均未验证**。

## 3. 对照表（4 线程，干净轮次）

| 模型 / 运行时 | 模型体积 | 加载 | 峰值内存 | 预填（19 token） | 稳态 ms/步（tok/s） | 正确性 |
|---|---|---|---|---|---|---|
| Qwen3.5-0.8B Rust ort 1.28.2（Scan 展开） | 约 520MB | 3.7 s | 602MB | 1477 ms | 320（3.13） | 与 PC 一致 |
| Qwen3.5-0.8B ORT GenAI + ORT 1.31 | 541MB | 2.2 s | 685MB | 971 ms | 265（3.77），范围 265–321 | 前 9 个 token 与 ort 一致 |
| Qwen3.5-0.8B llama.cpp Q4_K_M | 532MB | 0.75 s | 629MB（`-c 512`） | 约 0.67 s | 约 77（13.0） | 前缀一致 |
| Qwen3.5-0.8B llama.cpp Q4_0 | 507MB | 0.8–1.2 s | 607MB | pp19 27.8 tok/s | 约 77（12.95） | 同上 |
| Qwen3.5-0.8B MNN（4bit 块 64，fp16 激活） | 约 470MB | 3.3 s + 1.3 s 预热 | 约 915MB（污染时测，偏保守） | 0.53 s | 约 59（16.85） | 前缀一致 |
| Qwen3-0.6B HF q4 原图（Rust ort） | 919MB | 7.0 s | 2080MB | 720 ms | 207（4.84） | 与 PC 逐 token 一致 |
| Qwen3-0.6B h4 手术版（Rust ort） | 705MB | 2.5–3.1 s | 753MB | 617 ms | 207（4.84） | 5 个 token 后分歧（int4 head，预期） |
| Qwen3-0.6B ORT GenAI int4 + sherpa ORT 1.28.2 | 394MB | 1.6–1.9 s | 472MB | 760–790 ms | 204–213（4.7–4.9） | 前 7 个 token 与 ort 一致 |
| **Qwen3-0.6B llama.cpp Q4_0** | 382MB | 0.59 s | 477MB | 586 ms | 约 48（**20.8**） | 措辞与 ort 不同（量化不同） |
| Qwen3-0.6B llama.cpp Q4_K_M | 397MB | 未测 | 未测 | pp19 39.7 tok/s | 约 45（22.0） | 未逐 token 对 |
| Qwen2.5-0.5B q4 原图（Rust ort） | 786MB | 7.1 s | 1697MB | 988 ms（36 token） | 184（5.43） | 与 PC 一致 |
| Qwen2.5-0.5B h4 手术版（Rust ort） | 599MB | 3.2 s | 691MB | 800–847 ms（36 token） | 179（5.58） | 15 个 token 后分歧（预期） |

线程缩放（解码 tok/s，单轮，4/2/1 线程）：Rust ort Qwen3-0.6B h4 4.84/2.7/1.36；Qwen3.5 Rust ort 3.13/1.7/0.95；ORT GenAI Qwen3.5 3.77/1.78/1.03；llama.cpp Qwen3.5 13.0/8.04/4.42；llama.cpp Qwen3-0.6B 20.8/约 11.4/6.05；MNN Qwen3.5 16.85/10.56/约 6.4（污染时测）。近似线性，6 与 8 线程反而更慢（只有 4 个大核）。

## 4. 为什么 ORT 慢

- profile 显示 `MatMulNBits` 占内核时间 93%（Qwen3.5 上约 66%，Qwen3 上更高）；设备无 `i8sdot` 与 fp16 算术，用不上 int8 点积内核。
- 给所有 `MatMulNBits` 加 `accuracy_level=4` 毫无变化（205→208 ms）；换成 `model_int8`（MatMulInteger）更慢（301 ms）且输出分歧。
- 1/2/4 线程近似线性，说明是算力不够，不是带宽。
- Qwen3.5 的 `Scan` 展开与 `If` 节点也占一部分，用 ORT GenAI 导出的融合 `LinearAttention` 算子比 Scan 展开快约 10–15%。

## 5. lm_head 优化（Qwen3-0.6B，Rust ort，4 线程）

Qwen 词表约 15 万，HF q4 图的 lm_head 是 fp32 `MatMul(x, Transpose(embed))`，ORT 常量折叠会多出一份约 622MB 的转置副本。

| 变体 | 创建 | 峰值内存 | 预填 | 稳态 ms/步 |
|---|---|---|---|---|
| 原图 | 7.0 s | 2080MB | 720 ms | 207 |
| 加 Slice（只算最后位置）+ embed 只存转置一份 | 4.3 s | 1497MB | 619 ms | 207 |
| int4 `MatMulNBits` lm_head + Slice + embed 改 fp16（h4） | 2.5 s | **753MB** | 614 ms | 205 |
| h4 再加 `accuracy_level=4` | 2.5 s | 753MB | 616 ms | 208（无效） |

- 真机上**速度没有改善**（瓶颈在 `MatMulNBits`），PC 上有（156→89 ms）。**价值是内存与冷启动**。Qwen2.5-0.5B 同理：峰值 1697MB→691MB，创建 7.1 s→3.2 s。
- 缓存 ORT 优化图（`optimized_model_filepath`）无效：创建耗时不变，保存时峰值反而升到 1888MB；创建慢是因为读 705MB 权重。
- 手术脚本 `surgery2.py` 只在 PC 上用 ORT 对照输出，没有单测。

## 6. 运行时对比（同一模型 Qwen3.5-0.8B）

| 运行时 | 体积增量 | 复用 sherpa ORT | 稳态 | 许可证 | 对 0002 | 接入工作量 |
|---|---|---|---|---|---|---|
| Rust ort + 手写循环（现方案） | 无新增（sherpa 的 so 22.2MB 已有） | 是 | 3.13 tok/s | 无新增 | 无冲突 | 已做通 |
| ORT GenAI 0.17.0 | AAR arm64：`libonnxruntime-genai` 6.7MB（gzip 2.6MB）+ `libmat` 28.6MB；另需 ORT 1.31（34.2MB，gzip 12.9MB） | **否**（Qwen3.5 需 ORT ≥1.30） | 3.77 tok/s | MIT | 仍是 ORT 路线，要多带一份 ORT | 中，导出有两个坑 |
| llama.cpp b11612 | libllama 37.4MB（gzip 9.7MB）+ ggml-base 8.2MB + ggml 4.9MB + cpu 后端 4.9MB（未 strip） | 否 | **12–13 tok/s** | 官方仓库 MIT（未在本次核对 license 文件） | **需改 0002** | 中，要写 JNI |
| MNN（自编 llm_demo） | libMNN 4.96MB + 模型约 470MB | 否 | **16.4–16.85 tok/s** | 未核对 | **需改 0002**（0002 点名排除） | 中，要写 JNI |
| LiteRT-LM | 模型 965MB（int8） | 否 | **未验证**（官方页给的旗舰机数字是厂商自报，release 无 Android 预编译，也不能装 APK） | 模型 Apache-2.0 | — | 需 Bazel 编译 |

ORT GenAI 的发现：
- Qwen3.5 在 genai 上不是“不支持”：v0.17.0 的 model builder 有 `Qwen35TextModel`，默认导出 `LinearAttention` 算子；`gated_delta_net` 才限 CUDA/WebGPU。PR #2472 已关闭未合并（标题是 “Add paged hybrid state and speculative drafters”）。
- 导出的坑一：默认带 MTP 草稿头并共享 lm_head，genai 0.17.0 在 CPU 上抛 “GetMemoryInfo for CPU should not be used”，**导出时加 `exclude_mtp=true`**。坑二：Python 3.14 下 builder 命令行入口因 argparse 对 `%` 报错，改直接调用 `create_model`。
- 能 dlopen sherpa 的 `libonnxruntime.so`，链接无冲突；但 Qwen3.5 图用了 `com.microsoft:LinearAttentionGate`，ORT 1.28.2 报 “not a registered function/op”，要 ≥1.30。
- `libmat.so` 导出符号是 `Microsoft.Applications.Events`，被 genai 作为必需依赖拉入；**没核对它是否真的上报数据**，只确认体积与依赖关系。
- 运行时外壳几乎没有开销：Qwen3-0.6B genai 在 sherpa ORT 上 204–213 ms/步，Rust 手写循环 207 ms/步；升到 ORT 1.31 也只在噪声内（221 ms）。

## 7. 对决策 0002 的影响

- 数据：llama.cpp 解码约是 ORT 路线的 3–4 倍，冷启动更短，内存相当；MNN 更快。
- 引入 llama.cpp 要新增 libllama + ggml（gzip 后约 14MB 起）并写 JNI，不复用 sherpa 的 ORT；对 APK 体积预算的具体影响**没评估**。
- 这个结论只在**一台设备**上得到。新 SoC（有 `sdot`、fp16）上 ORT 的 `MatMulNBits` 走 int8 内核后差距可能大幅缩小，**未验证**。
- **决定**：改 0002 之前先做 fp16 机型复测（见末尾待办）；在那之前不改 0002，也不新增 llama.cpp 依赖。

## 8. 质量烟测（主观，样本小）

非思考模式，temperature 0.7、top_k 20，seed=0，每题一次；10 条对联上联、5 条古诗接句、5 条问答。

- **对联**：GPT-2 对联模型 10 条全部等长、无多余话。Qwen3-0.6B 有几条等长（“龙舞凤舞庆华章”“天增岁月人增年”），但不少复述上联或加“下联：”前缀；Qwen2.5-0.5B 话痨更严重；Qwen3.5-0.8B 也不稳，常多行、重复（如“和气生财”输出 5 遍）。
- **古诗接句**：Qwen3 对名篇能背；Qwen2.5 常串到别的诗；Qwen3.5 常复述半句。
- **问答**：三者通顺；Qwen2.5 偏啰嗦，Qwen3 有英文夹杂，Qwen3.5 有冗余。
- **结论**：通用小 LLM 不适合直接写对联，对联用专用模型。

## 9. 推荐

| 目标 | 路线 |
|---|---|
| 不新增依赖、复用 sherpa ORT | Rust ort + 手写 KV 循环，Qwen3-0.6B h4（705MB，峰值 753MB，约 4.8 tok/s，冷启动 2.5 s） |
| 要速度（需改 0002） | llama.cpp + Qwen3-0.6B Q4_0（358–382MB，约 21 tok/s），或 MNN + Qwen3.5-0.8B（约 470MB，约 16.5 tok/s） |
| ORT GenAI | 不为速度选它 |
| 对联 | GPT-2 对联模型（int4，88MB） |

## 10. 局限与待办

- 局限：只在 HUAWEI STG-AL00 一台设备上测；设备被其他任务间歇占用，已用交错轮询与空闲度校正；llama.cpp 与 MNN 的许可证未逐个核对；q4f16 在真机上未测（Kryo 类无 fp16 算术，预计无收益）；绑定输入输出避免拷贝、graph optimization 级别单项对比、MNN 2/1 线程干净数据均未做；LiteRT-LM 未复测。
- **待办（全部任务完成后做）**：找一台**有点积（`asimddp`）和 fp16（`fphp`）的手机**，复测本文表格里的 Rust ort、llama.cpp、MNN 三条线，再决定是否改 0002。
- 设备上 `/data/local/tmp/qwenspike/`（约 641MB）仍留着，用户尚未说清理。
- 产物（脚本、模型、测量原始数据）在会话临时目录，不在仓库，可能被清理；需要长期保留时再整理进仓库。
