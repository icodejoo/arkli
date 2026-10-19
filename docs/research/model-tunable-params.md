---
title: AI 中心开放模型推理参数：调研与方案
status: draft
updated: 2026-10-19
summary: AI 中心开放“推理时可调参数”的调研与方案：MNN 基础参数（线程/精度/功耗等，钉死提交 478c10e 上哪些真实可用）、逐模型参数表（Qwen3.5、NLLB、PP-OCR、SigLIP2、对联 GPT-2、语音、抠图占位）含官方依据与开放/高级/不开放归类、数据模型与持久化、与 AiConstraints 的衔接、契约测试与分步实施计划
---

## 1. TL;DR 与推荐

**范围**：「参数微调」= 推理时可调的参数，不是训练。产品形态已拍板：AI 中心放一个「MNN 基础参数（所有模型公用）」入口，点开弹窗；每个模型详情弹窗（`ModelSourcesSheet`）底部加「参数调整区」，**仅已下载才显示**；范围与默认值由原生下发，页面按下发内容渲染。

**依据说明**：本文的代码结论是读钉死提交 `478c10e8…` 的 MNN 源码与本仓库代码得出的（标“读码”）；官方文档结论都带 URL；**本次没有跑任何新实测**，已有实测只引用 `qwen35-mnn-model.md` 等旧文档（标“旧实测”）。

**核心结论**

1. **参数分两类，处理完全不同**：
   - 调用参数（temperature、topK、numBeams、OCR 阈值……）：每次调用带，改了下一次调用就生效，不重建会话。
   - 会话参数（线程数、精度、功耗、mmap……）：加载模型时定死，改了要重建会话（沿用 `AiSessionControl.unloadSession`，下次调用自动重载）。
2. **MNN 基础参数里真正值得开放的只有 3 个**：线程数、功耗模式、精度（高级）。后端选择不可开放（OpenCL/Vulkan/ARM82 都没编进 `libMNN.so`）；`memory` 必须钉死 low（normal 会把量化权重还原成 float，NLLB 约 2.85GB）。
3. **数据流**：参数定义（key/类型/范围/默认/是否重建）由原生提供者声明并随 `native.ai.providers` 下发；值存原生 `SharedPreferences`；原生在没有显式传参时用“用户默认”补上。**工具页一行都不用改**，也不需要读这些值。
4. **改 C ABI / Rust 的部分集中在两处**：MNN 功耗/精度要在 `arkli_mnn_config` 加字段并 ABI 升到 2（或另加全局设置函数）；OCR 阈值、识物阈值要给 Rust 引擎加“按次选项”。线程数、Qwen 采样已有通道，纯 Kotlin/Web 即可。

**需要你拍板（最多 3 条）**

| # | 问题 | 推荐默认 |
|---|---|---|
| 1 | 用户设置与页面显式传参谁优先？现在对联页的“大模型”模式显式传了 `temperature`（`web/src/tools/couplet/index.vue:280`） | **显式传参 > 用户默认 > 内置预设默认**。即用户在 AI 中心调的值只作用于“页面没传”的调用，不会悄悄改掉页面自己的 UI |
| 2 | Qwen 的采样调整是否只作用于 `prompt` 预设（摘要/校对/改写/翻译保持贪心）？ | **是**。小模型做“只输出结果”的任务，调高温度只会增加翻车；贪心预设本身就不吃温度 |
| 3 | “线程数/功耗/精度”的改动立即重载还是下次调用时再重载？ | **下次调用自动重载**（会话指纹含设置），弹窗里提示“下次使用时会重新加载，约 3 秒”，不提供“立即重启”按钮 |

## 2. 现状

### 2.1 AI 中心与详情弹窗

| 位置 | 内容 |
|---|---|
| `web/src/views/AiView.vue:86-90` | 顶部“在线大模型配置（即将支持）”占位卡片，`onModelEntry` 只弹“敬请期待”（`:73-75`）。**MNN 基础参数入口可并排放在这里** |
| `web/src/views/AiView.vue:91-110` | “本地模型”列表，数据来自 `useModelsStore().list`（清单模型，一项一个 `models.json` id），点行 `showSources` 打开弹窗 |
| `web/src/shared/ModelSourcesSheet.vue:53` | 详情弹窗（`van-popup` 底部，`maxHeight 85vh`）。属性 `modelId/modelName/state`（`:14`）；内容区为下载地址与手动放置说明；**`:92-98` 是底部固定按钮（校验 / 下载 / 删除）**，参数调整区应放在内容区底部、按钮之上（“已安装”才渲染，判定同 `footerOf(state)` 的 remove 分支） |
| `web/src/stores/models.ts:72` | 模型 store，管理动作只在 AI 中心 |

**一个要处理的映射**：弹窗以清单模型 id 为单位（如 `qwen35-0.8b-mnn-q4`），参数声明却属于提供者（`local-qwen`）。`native.ai.providers` 已给本地提供者带 `modelId`（`ai-protocol.md` 报价一节），**按 `provider.modelId == 弹窗 modelId` 关联**即可。两个特殊情况：
- 抠图是 **两个提供者两个模型**（`local-matting-portrait` / `local-matting-general`，见 `ai-protocol.md` 抠图接入记录），各自一个弹窗，天然对得上。
- 语音识别（`asr-zipformer-zh-en-mnn-w8`）**不是 AiProvider**，走独立的 `SpeechModule`（`app/.../speech/`），没有报价与会话控制，本期弹窗不出参数区，见 4.7。
- `couplet-corpus` 是数据包，不是推理模型，不出参数区。

### 2.2 MNN 封装现有配置面（读码）

C ABI（`native/mnn/arkli_mnn_capi.h:46-56`，`.cpp:182-196`）现在只暴露：

| 字段 | 现状 |
|---|---|
| `threads` | 暴露，≤0 取 4，同时设 `INIT_THREAD_NUMBER` 提示 |
| `memory` | 只允许 low(2)；normal 需测试开关 `arkli_mnn_test_allow_normal` |
| `precision` | 暴露 0..3（normal/high/low/bf16），Rust `MnnConfig` 里字段有，但**没有 setter，全项目都用 0** |
| `rearrange` | 暴露，生产建议 1 |
| 后端 | **写死 `MNN_FORWARD_CPU`**；`libMNN.so` 构建（`native/mnn/build.sh:32-38`）关了 `MNN_OPENCL`、`MNN_VULKAN`、`MNN_ARM82` |
| `power` | **没暴露**（`BackendConfig::power` 保持默认 Normal） |
| 其余 `Interpreter::HintMode` | 只设了 `INIT_THREAD_NUMBER`；`CPU_LITTLECORE_DECREASE_RATE` 等都没暴露 |

线程来源：翻译/OCR/识物/对联/抠图各在 `AndroidXxx.kt` 里写死常量 4（`AndroidTranslate.kt:19`、`AndroidOcr.kt:20`、`AndroidClip.kt:26`、`AndroidCouplet.kt:19`、`AndroidMatting.kt:24`）；Qwen 的线程来自模型 `config.json` 的 `thread_num=4`（JNI 没覆盖）；语音是 `SpeechConst.NUM_THREADS = 2`（`SpeechPolicy.kt:86`，经 `SpeechEngine.kt:238` 传 sherpa-mnn）。

### 2.3 已开放的参数（别重复造）

| 模型/任务 | 已开放（桥上可传） | 范围（原生） | 缺省 | AI 中心有入口？ |
|---|---|---|---|---|
| Qwen 文本生成 | `preset`、`system`（仅 prompt）、`temperature`、`topK` | 温度 0~1.5、topK 1~100（`AiQwenPolicy.kt:101-104`，`AiConstraints.Generate`） | 摘要/校对/改写/翻译贪心；prompt 温度 0.7、topK 20（`AiQwenPolicy.kt:98`） | 无 |
| NLLB 翻译 | `numBeams` | 1~4（`AiTranslatePolicy.kt:69`） | 1（`model.json` 的 `generation.num_beams`，M6c 改的） | 无 |
| 对联 | `temperature`、`topK`、`seed` | 0~2、1~200（`AiCoupletPolicy.kt:46-49`，`AiConstraints.Couplet`） | 0.8、40（Rust `couplet.rs:35-39`） | 无 |
| 识物 | `topK` | 1~10（`AiClassifyPolicy.kt:30`） | 3 | 无 |
| OCR | 无 | — | — | 无 |
| 抠图 | `mode`（人像/通用，等于选提供者） | — | — | 无 |

也就是说：**现有开放参数都是“调用方每次传”的形态，没有“用户持久化默认值”这一层**，AI 中心更完全没入口。本方案补的是持久化默认值 + 入口 + 少量新参数。

## 3. MNN 基础参数（公用弹窗）

官方依据：
- MNN LLM 配置文档 https://mnn-docs.readthedocs.io/en/latest/transformers/llm.html （取到：`backend_type`、`thread_num` 默认 4、`precision` 默认 `low`“优先 fp16”、`memory` 默认 `low`“开启运行时量化”、`use_mmap`“内存不足时权重写磁盘，手机建议 true”、`kvcache_mmap`、`tmp_path`、`attention_mode`、`dynamic_option`、`cpu_sme2_neon_division_ratio`）。**该页没有 `power`，也没写哪些改动需要重载**（未核实，下文“是否重建”均为读码）。
- 钉死提交源码：`include/MNN/MNNForwardType.h`（`BackendConfig`）、`include/MNN/Interpreter.hpp`（`HintMode`）、`source/backend/cpu/CPUBackend.cpp:180-215`（power → 绑核）、`source/core/Session.cpp:75-130`（hint 落点）、`transformers/llm/engine/src/llm.cpp:213-262`（LLM 运行时 hint）。

本机口径：STG-AL00，4 大 + 4 小核，**无 `i8sdot`、无 fp16、无 `i8mm`**（`qwen35-mnn-model.md` §3 的 MNN 启动日志）。

| 参数 | 含义 | 项目现值 | 钉死提交上是否可用（读码） | 对这类 CPU 的意义 | 是否重建会话 | 调错风险 | 建议 |
|---|---|---|---|---|---|---|---|
| 线程数 `numThread` | CPU 算子线程 | 4（各 `AndroidXxx.kt` 常量；Qwen 来自 config.json；语音 2） | 可用。ABI 已暴露 `threads` | **有意义**。旧实测：设备只有 4 个大核，6 与 8 线程反而更慢（`qwen35-mnn-model.md` §5，Qwen） | 是（加载时定） | 设过大变慢；设 1 速度掉到约 1/3 量级（推测，未测） | **开放**：步进 1~6（默认 4）。其它机型大核数不同时才有意义 |
| 功耗 `power` | `Power_Normal/High/Low`；CPU 后端据此选绑核集合：Low 绑最小核簇 `groups[0]`，High 从最大核簇起按线程数凑核，Normal 不绑（`CPUBackend.cpp:190-206`） | Normal（没暴露） | 可用，但 **C ABI 没暴露，要加字段** | **有意义**：大小核机器上 Normal 不绑核，线程可能落在小核上拖慢；High 强制大核更稳；Low 省电但明显变慢。未实测收益 | 是 | High 发热、耗电；Low 极慢 | **实测后只开放“均衡 / 性能”两档**，默认均衡，性能档说明“更耗电、不保证更快”。**实测结论**：真机实测（STG-AL00，4 大 4 小核，无 fp16，MNN_ARM82=OFF）：性能(High)对均衡(Normal)，Qwen 校对热态约 4.8 s 对 4.8 s、NLLB 约 0.93 s 对 0.94 s，无收益；省电(Low) Qwen 约 10.2 s、NLLB 约 2.1 s，且切回均衡后不恢复（约 9.0 s / 2.1 s），原因是 MNN 线程池全局、重载不重建，Low 把线程绑到小核（Cpus_allowed_list 0-3），Normal 不绑核所以沿用旧绑定，切到 High 会主动绑大核才能恢复；精度高对普通无差别（本构建无 fp16 内核）。省电档因绑核残留且无收益而去掉。 |
| 精度 `precision` | Normal/High/Low/Low_BF16 | 0（Normal）；Qwen 的 `config.json` 里是 `low` | ABI 已暴露，Rust 无 setter。**构建 `MNN_ARM82=OFF`**，所以没有 fp16 内核 | 本机无 fp16；旧实测 `low` 与 `normal` 在本机“没有可见差别”（`qwen35-mnn-model.md` §3），有 fp16 新机才可能拉开（未测） | 是 | Low 在有 fp16 的机型可能溢出变乱码；bf16(3) 在无 bf16 指令上很慢（推测，未测） | **实测后整项不开放**（本构建无 fp16 内核，高/普通无差别），有 fp16 的机型可再评估；也不提供 low/bf16。读码补充：CPU 后端只在“编译开 `MNN_ARM82` + CPU 支持 fp16 + `Precision_Low`”三者同时满足时才切 fp16 内核（`CPUBackend.cpp:329-335`），`Precision_High` 在 CPU 后端无任何分支，所以“高/普通”在任何机型上都一样。fp16 是提速档不是提质档；**暂不引入**（2026-10-19 与用户讨论）：现有速度够用（Qwen 校对约 2.6 s、NLLB 约 0.9 s），重编 libMNN.so 与逐模型质量回归成本不划算，测试机也跑不了 fp16。将来速度成瓶颈再用 `scripts/mnn/eval_*.py` 对比 fp16 前后质量后决定，且应由原生按模型默认开启，不做成用户开关 |
| 内存 `memory` | Low=保持量化权重+激活动态量化 | low | 只能 low | normal 会把权重还原成 float（NLLB 约 2.85GB，`capi.h` 头注释） | — | OOM 闪退 | **不开放**（C ABI 已拒绝） |
| 后端 `type` | CPU/OpenCL/Vulkan/… | CPU | **不可用**：`MNN_OPENCL=OFF`、`MNN_VULKAN=OFF`；LLM 的 `backend_type` 同理 | 开 GPU 要重编 `libMNN.so`（体积、兼容、模型转换侧都要再评估） | — | 崩溃 | **不开放**；作为后续独立课题 |
| `rearrange` | 加载时预重排权重，稳态内存降到权重体积 | 1 | 可用 | 有意义（省内存），但关了只会更占内存/更慢 | 是 | 关掉峰值内存升高 | **不开放** |
| `use_mmap` + `tmp_path`（Qwen） | 权重写磁盘 mmap，降驻留内存 | 关（config.json 默认 false；JNI 没设 `tmp_path`） | 可用（读码：`llm.cpp:236-239` 需要 `tmp_path`；文档建议手机开） | **有意义但未测**：Qwen 稳态 PSS 约 775MB（旧实测），开 mmap 可能降内存、变慢，本机存储速度未知 | 是 | `tmp_path` 目录不可写时静默退化（`llm.cpp:207-214` 打日志后继续）；闪存慢时变卡 | **折叠到“高级”，仅 Qwen**，需要 JNI 设 `tmp_path`（应用 cache 目录）。先真机测再定是否上 |
| `CPU_LITTLECORE_DECREASE_RATE` | 大小核任务分配比例，默认 50 | 默认 | 可用（`Session.cpp:88`），C ABI 没暴露 | 只在 `power != Low` 且线程>1 时参与分配 | 是 | 调错变慢 | **不开放** |
| `attention_mode` / `dynamic_option` / `kvcache_mmap` / `cpu_sme2_*`（Qwen config） | 注意力量化、动态量化粒度、KV 落盘、SME2 | 模型 config.json 默认 | 部分可用；SME2 是 Arm 新指令，本机没有 | 对本机意义不明，且改错数值会输出乱码 | 是 | 乱码/崩溃 | **不开放** |

**弹窗内容建议（MNN 基础参数）**：线程数（步进）、性能模式（均衡/性能两段选；计算精度已不开放）；底部「恢复默认」。说明文案写清“改完下次使用模型时会重新加载”。

**C ABI 要补的**：`arkli_mnn_config` 加 `power`、（可选）`little_core_rate`，`ARKLI_MNN_ABI` 升 2；`checkConfig` 校验 power 0..2；`net_load` 里 `backend.power = …`，`setHint(CPU_LITTLECORE_DECREASE_RATE, …)`。Rust `MnnConfig` 加 `with_precision/with_power`，并经一个**全局运行时设置**（FFI 新函数 `mnn_set_runtime_options(threads, precision, power)`，存进程内静态量，各 `*_load` 读取）带入，避免给 5 个 `*_load` 的 uniffi 签名各加参数。Qwen 走 JNI：`nativeCreate` 路径里 `set_config` 追加 `thread_num/power/precision`（读码：`llm.cpp:243-262` 从 config 读），也要重建 `libarkli-mnn.so`。

## 4. 逐模型参数

通用约定：“已开放”见 2.3；“归类”= 开放（弹窗常驻）/ 高级（折叠）/ 不开放。“重建”= 改了要不要重建会话。

### 4.1 Qwen3.5-0.8B 文本 LLM（`local-qwen`，L2）

官方依据：
- 模型卡 https://huggingface.co/Qwen/Qwen3.5-0.8B （已取到原文）：**非思考模式、文本任务**推荐 `temperature=1.0, top_p=1.00, top_k=20, min_p=0.0, presence_penalty=2.0, repetition_penalty=1.0`；思考模式 `temperature=1.0, top_p=0.95, top_k=20, min_p=0.0, presence_penalty=1.5, repetition_penalty=1.0`；推荐输出长度 32,768（复杂题 81,920）。
- HF 生成参数 https://huggingface.co/docs/transformers/main_classes/text_generation ：`temperature` 默认 1.0、`top_k` 默认 50、`top_p` 默认 1.0、`repetition_penalty` 1.0 = 无惩罚、`max_new_tokens` 为新生成上限。
- MNN 采样键 https://mnn-docs.readthedocs.io/en/latest/transformers/llm.html ：`temperature`、`topK`（默认 40）、`topP`（默认 0.9）、`minP`、`penalty`（旧字段，自动映射 `repetition_penalty`）、`n_gram`。钉死提交源码另有 `presence_penalty`、`frequency_penalty`、`penalty_window`（`llmconfig.hpp:526-620`）。

**与官方推荐不一致的地方（本次核实出来的）**：`ai-protocol.md` 第 6 步写过“没有联网逐字核对 Qwen3.5 官方模型卡”。现在核对了：官方非思考推荐 `top_p=1.0`、`presence_penalty=2.0`、`repetition_penalty=1.0`，而项目实际是 `top_p 0.95` 与 `penalty 1.1`（来自模型 `config.json`，`qwen35-mnn-model.md` §2）加 prompt 预设温度 0.7。**项目值是自己的折中，不是官方值**；是否改回官方值要真机比质量，不在本方案范围。

| 参数 | 含义 | 项目现值 | 官方推荐 | 影响 | 重建 | 风险 | 归类 |
|---|---|---|---|---|---|---|---|
| `temperature` | 采样温度，0=贪心 | 摘要/校对/改写/翻译 0（贪心）；prompt 0.7 | 1.0（非思考） | 越高越发散，越低越稳 | **会话级**：采样器只在 `Llm::load()` 里建一次，改了要在 JNI 里重建会话（`ai-protocol.md` 第 6 步，旧实测加载约 3.4s） | 贪心任务调高会乱 | **已开放（API）**，AI 中心**开放**，滑块 0~1.5，**只作用于 prompt 预设**（拍板 #2） |
| `topK` | 候选数 | 20（`AiQwenPolicy.kt:27`） | 20 | 越小越保守 | 同上 | 太小=近贪心 | **已开放（API）**；AI 中心 **高级**，滑块 1~100 |
| `topP` | 累积概率截断 | 0.95（config.json，JNI 没覆盖） | 非思考 1.0 / 思考 0.95 | 与温度叠加 | 同上 | — | **高级**（新增）：需 JNI `samplerConfig` 加 `topP`（现模板固定管线 topK→topP→temperature，`arkli_mnn_jni.cpp:25-27`），范围建议 0.5~1.0 |
| 重复惩罚 `repetition_penalty` | 压重复 | 1.1（config.json 的 `penalty`；读码：惩罚>1 时钉死提交会自动把 penalty 放在采样链最前，`sampler.cpp:211-225`） | 1.0 | 太高会回避必要重复（人名、代码） | 同上 | 太高输出怪异 | **高级**（新增），范围 1.0~1.3；同样要改 JNI |
| `presence_penalty` | 出现过就扣分 | 0（未设） | 非思考 2.0 / 思考 1.5 | 减少车轱辘话；官方给的值偏大，小模型实际效果未测 | 同上 | 值大时可能不愿重复关键词 | **不开放**（官方值偏激进且未实测，先不暴露） |
| `min_p` | — | 未用（管线里没有） | 0.0 | — | — | — | 不开放 |
| `max_new_tokens` | 单次最大生成 | 固定 256（`AiQwenPolicy.kt:41`）；翻译随原文 `clamp(字数×2,64,512)` | 官方 32768（不适合手机） | 直接决定耗时上限；0.8B 解码约 17 tok/s（旧实测），256 token 约 15 秒 | **否**（每次调用传） | 过大等很久，过小截断 | **开放**为“回答长度”三档（短 128 / 中 256 / 长 512），作用于 prompt/摘要/校对/改写四个文本任务（`applyTo` 即 `SUPPORTED_TASKS`）；翻译不受影响。**落地**：select 带 `optionValues`，直接存真实值 128/256/512，`AiCall.Run.maxTokens` 只由用户设置补入、页面不传 |
| `preset` | 预设模板 | 页面传 | — | — | 否 | — | 不进弹窗（页面决定） |
| `system` | 附加系统提示 | 页面传（仅 prompt） | — | — | 否 | — | 不进弹窗 |
| 思考模式 `enable_thinking` | 先输出 `<think>` | 关（`config.json` 已改，托管文件里） | 官方默认开 | 手机上太慢 | 是（模板） | 开了延迟翻倍以上 | **不开放**（`qwen35-mnn-model.md` §5 已决定关） |

### 4.2 NLLB-200-distilled-600M 翻译（`local-nllb`，L1）

官方依据：HF `GenerationConfig`（同上 URL）：`num_beams` “1 means no beam search”；`length_penalty` “applied as an exponent to the sequence length… >0 promotes longer sequences, <0 encourages shorter”；`no_repeat_ngram_size` “all ngrams of that size can only occur once”；`max_new_tokens` 新生成上限。NLLB 自身的推荐值官方页未取到（未核实）。

| 参数 | 含义 | 项目现值 | 影响 | 重建 | 风险 | 归类 |
|---|---|---|---|---|---|---|
| `numBeams` | 束宽 | 1（`model.json` 的 `generation.num_beams`）；API 范围 1~4 | 旧实测（M6b 桌面）：beams=2 约 2.1 倍耗时（894ms 对 422ms），因为 MNN 三图 batch 固定 1、每条束单独跑；质量收益没单独量化 | **否**（每次调用传，`TranslateOptions.num_beams`） | 4 在真机上可能多出数秒 | **已开放（API）**；AI 中心**开放**：分段控件“快速 1 / 均衡 2 / 精细 4”，旁注“越精细越慢”。**落地**：spec 是 select，带 `optionValues`，**存真实值 1/2/4**（`options` 只管显示），页面没传 `numBeams` 才补 |
| `length_penalty` | 束搜索长度惩罚 | 2.0（`manifest.rs:62`） | 只在 beams>1 起作用；抑制偏短译文 | 否（清单级，需改 `model.json` 或加按次选项） | 调错译文偏长/偏短 | **不开放** |
| `no_repeat_ngram_size` | 禁止 n-gram 重复 | 清单可选，缺省来自模型 config | 压叠词，但会误伤“谢谢谢谢”类 | 同上 | 误伤合法重复 | **不开放** |
| `min_length_ratio` | 最小输出长度占输入比 | 0.7 | 防译文过短 | 同上 | — | **不开放** |
| `max_new_tokens` | 每片段上限 | 256 | 防跑飞 | 同上 | 截断长句 | **不开放** |
| `short_phrase_wrap` | 极短输入引号包裹法 | 清单缺省 true | 见 `ai-protocol.md`“引号包裹法”，实测对短词有提升 | 清单级 | 关了短词译错变多 | **不开放**（是缺陷补丁，不是偏好） |

### 4.3 PP-OCRv5/v6 mobile 文字识别（`local-ocr`，L1）

官方依据：PaddleOCR 3.x 文档
- 管线 https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/OCR.html （已取到）：`text_det_limit_side_len` 默认 64（`text_det_limit_type` 默认 `min`）、`text_det_thresh` 0.3、`text_det_box_thresh` 0.6、`text_det_unclip_ratio` 2.0、`text_rec_score_thresh` 默认 0.0（不过滤）、`use_textline_orientation`。该页**没有**方向分类阈值。
- 检测模块 https://www.paddleocr.ai/latest/en/version3.x/module_usage/text_detection.html ：`thresh` 为像素得分阈值，`box_thresh` 为框平均分阈值，`unclip_ratio` 为 Vatti 裁剪外扩比，越大扩得越多。

项目值来自 `core/crates/arkli-ai/src/pipeline.rs`、`db.rs`、`preprocess.rs`；v6 的值取自模型 `inference.yml`（`pipeline.rs:131-136`）。**项目缺省与官方管线缺省不同**（项目 v5：box 0.5、unclip 1.6、检测最长边 960；官方管线：0.6、2.0、侧长 64/min）。官方管线与本项目的预处理口径不是同一套，不能直接套官方数。

| 参数 | 含义 | 项目现值 | 官方 | 影响 | 重建 | 风险 | 归类 |
|---|---|---|---|---|---|---|---|
| `det_post.thresh` | 检测像素二值化阈值 | v5 0.3 / v6 0.2 | 0.3 | 低→更多框、更多噪点；高→漏淡字 | **否**（需 Rust 加按次选项，现 `OcrOptions` 在加载时定） | 太低噪点爆炸（`max_candidates=1000` 兜底） | **高级** |
| `det_post.box_thresh` | 框平均得分阈值 | v5 0.5 / v6 0.45 | 0.6 | 过滤低置信框 | 否（同上） | 太高漏字 | **开放**为“检测灵敏度”（宽松/标准/严格 → box_thresh 0.35/默认/0.6），隐藏具体数 |
| `det_post.unclip_ratio` | 框外扩 | v5 1.6 / v6 1.4 | 2.0 | 大→框更宽，易吞相邻行；小→切字 | 否（同上） | 过大行粘连，过小切掉笔画 | **高级** |
| `det_pre.max_side` | 检测输入最长边 | 960（`DET_DEFAULT_MAX_SIDE`） | 管线 64/min 口径不同 | 大→小字更准但更慢更吃内存 | 否 | 太大 OOM/卡 | **高级**：640/960/1280 三档 |
| `drop_score` | 识别分低于它的行丢弃 | 0.5 | `text_rec_score_thresh` 默认 0.0 | 高→少垃圾行但漏字；低→噪声行 | 否（同上） | — | **开放**为“过滤低置信文字”开关/滑块 0~0.8 |
| `cls_thresh` | 文本行倒置判定阈值 | 0.9 | 官方 3.x 页未列（未核实；旧版 PaddleOCR 有 `cls_thresh`，本次没取到原文） | 高→更不愿翻转 | 否 | 过低会误翻正常行 | **不开放** |
| `max_input_side` | 入口缩图上限 | 4096（`pipeline.rs:19`；原生 `AiOcrPolicy.MAX_EDGE=4096`） | — | 防大图 OOM | 否 | — | **不开放** |

注意：OCR 当前桥上没有 `options`（`AiOcrPolicy.parse` 不收），**加开放参数要三层都改**：Rust `OcrPipeline` 暴露按次覆盖（或 `set_options`）、FFI `ocr_run` 加参数或 `ocr_set_options`、Kotlin `OcrEngine` 与 `AiOcrPolicy`。

### 4.4 SigLIP2 识物（`local-clip`，L1，`siglip2-mnn-w8`）

官方依据：HF SigLIP2 文档 https://huggingface.co/docs/transformers/model_doc/siglip2 （取到的是用法示例；`logit_scale/logit_bias` 与 sigmoid 损失的原文**未核实**，本次未取到对应段落）。

| 参数 | 含义 | 项目现值 | 影响 | 重建 | 风险 | 归类 |
|---|---|---|---|---|---|---|
| `top_k` | 返回物品数 | 3（`classify.rs:23`），API 1~10 | 只影响展示条数 | 否 | — | **已开放（API）**；AI 中心**高级**：步进 1~10 |
| `uncertain_threshold` | 聚合置信度低于它视为“拿不准” | 0.8（`classify.rs:21`） | 决定页面提示“不确定”的松紧；不改变排序 | 否（纯后处理） | 调错只会多/少提示 | **开放**为“识别严格度”（松/标准/严）。桥上现没有，要 Rust/FFI 加按次选项 |
| `temperature`（softmax） | 把余弦相似度放大成概率的尺度 | 100（`classify.rs:19`），是本项目词表标定值 | 改它会整体改变所有分类概率与置信度，`uncertain_threshold` 的含义随之失效 | 否 | 调错阈值全乱 | **不开放** |

### 4.5 对联 GPT-2（`local-couplet`，L1，`couplet-gpt2-mnn-w6`）

官方依据：GPT-2 采样的官方推荐值**未核实**（本次没有取到 GPT-2 原始仓库的采样说明）；采样键含义见 HF `GenerationConfig`（temperature/top_k/top_p/repetition_penalty，URL 同 4.1）。本模型是项目自己转的对联专用 GPT-2，解码带“等长约束”（见 `couplet-gpt2-onnx.md` 第 9 节），**通用 LLM 的经验值不能直接套**。

| 参数 | 含义 | 项目现值 | 影响 | 重建 | 风险 | 归类 |
|---|---|---|---|---|---|---|
| `temperature` | 采样温度，0=贪心 | 0.8，范围 0~2 | 越高越“新奇”越容易不通 | 否（每次传） | >1.4 常出不通顺 | **已开放（API）**；AI 中心**开放**：滑块 0~1.5（UI 范围收窄，原生上限仍 2），文案“稳妥 ↔ 新奇” |
| `topK` | 候选数 | 40，范围 1~200 | 同上 | 否 | — | **已开放（API）**；**高级** |
| `seed` | 随机种子 | 缺省系统时间 | 复现 | 否 | — | **不进弹窗**（是页面“再来一副/复现”的内部机制） |
| `top_p` / 重复惩罚 | — | 引擎未实现（`CoupletOptions` 只有 temperature/top_k/seed，`couplet.rs:69-78`） | — | 需改 Rust | — | **不开放**（要新增算法，收益未知） |

### 4.6 抠图：MODNet 人像 / U2Net-p 通用

边缘细化参数由另一个子代理在做（`matting_refine.rs` 等未提交文件），**这里只留占位，待并入**：

> 待并入：参数名/含义/默认值/范围/归类按 4.1 的表头格式补；声明方式沿用第 5 节的参数定义，不另起一套。
> 已知（引自 `ai-protocol.md` 抠图接入记录，不含未提交改动）：两个提供者各自一个模型/一个弹窗；输入尺寸由模型固定；取消只在阶段边界检查。

### 4.7 语音识别（sherpa-mnn，流式 zipformer transducer，仅 ASR）

项目只接了识别，没有 TTS，所以没有 speed/sid/noise_scale 一类参数。现用配置在 `SpeechEngine.kt:222-250`：`numThreads=2`、`provider="cpu"`、`decodingMethod="greedy_search"`、端点规则 rule1 2.4s / rule2 1.2s / rule3 20s（`SpeechPolicy.kt:89-95`）。

官方依据：sherpa-onnx 文档（sherpa-mnn 沿用其配置结构）本次访问 https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/index.html 只拿到目录页，**`num_threads`、`decoding_method`、端点规则的官方原文未核实**。

| 参数 | 现值 | 影响 | 归类 |
|---|---|---|---|
| `numThreads` | 2 | 识别要实时跟上，调低会卡 | 并入“MNN 基础参数”的线程数？**不建议**：语音与识别共享 CPU，且实时性敏感。**不开放** |
| `decodingMethod` | greedy_search | `modified_beam_search` 更准更慢（来自 sherpa 常识，本次未核实原文） | 不开放 |
| 端点规则 | 2.4 / 1.2 / 20 秒 | 决定停顿多久算说完，影响体验 | 可作后续“停顿等待时长”，**本期不做** |

**结构性说明**：语音不是 `AiProvider`，不进报价与会话控制，所以本期它的弹窗不出参数区、也不受“MNN 基础参数”影响（它用独立的 `libsherpa-mnn-jni.so`，线程在 `SpeechEngine` 里传）。要纳入需先做“语音接入统一协议”，不在本方案内。

## 5. 方案

### 5.1 数据模型：参数定义归谁、放哪

**结论：参数定义放在“提供者”上，随 `native.ai.providers` 下发；值读写走新桥方法；`AiConstraints` 保持“调用输入的硬校验”不变。** 理由：

- `AiConstraints` 是**按任务**挂在 offer 上的“一次调用允许传什么”，目标是校验；而 AI 中心弹窗是**按模型**展示“这个模型有哪些旋钮、默认值、是否需要重建”。Qwen 一个提供者四个任务，把滑块挂在四个任务上会重复四份。
- 但**范围的唯一来源仍是同一批常量**：参数定义的 `min/max/default` 直接引用现有 `AiQwenPolicy.TEMPERATURE_RANGE`、`AiCoupletPolicy.TOP_K_RANGE` 之类，`AiConstraints.Generate/Couplet` 也引用它们，所以前后端、校验与展示不会出现两份。契约测试再断言“参数定义范围 ⊆ 对应 `AiConstraints` 范围”。

**原生新类型**（`AiParams.kt`，纯逻辑可单测）：

```kotlin
/** 一个可调参数的定义（范围、默认值、控件形态、生效方式）。 */
data class AiParamSpec(
    val key: String,            // 稳定键，如 "temperature"、"numBeams"
    val label: String, val desc: String,
    val kind: Kind,             // SLIDER / STEPPER / SWITCH / SELECT
    val default: Double,        // 统一用数值；SWITCH 为 0/1，SELECT 有 optionValues 时为真实值，否则为选项下标
    val min: Double, val max: Double, val step: Double,
    val options: List<String> = emptyList(),   // SELECT 用
    val advanced: Boolean = false,             // true 则折叠进“高级”
    val scope: Scope,                          // CALL 下次调用生效 / SESSION 需重建会话
    val applyTo: List<AiTask> = emptyList(),   // 只作用于哪些任务/预设（如 Qwen 温度只作用于 prompt）
)

/** 声明了可调参数的提供者（可选端口，与 TextGenerator 同类）。 */
interface AiTunable {
    /** 参数定义列表（只读，常量）。 */
    fun paramSpecs(): List<AiParamSpec>
}
```

- `native.ai.providers` 的每个提供者**追加** `params: AiParamSpec[]`（没有则省略，旧页面忽略）。MNN 公用参数单独声明在一个伪提供者 id `mnn`（只出现在参数方法里，不进 `providers` 的 offers、不参与路由）。
- **新桥方法**（挂在 `AiModule`，只接受主 frame）：
  - `native.ai.params.get` `{ provider }` → `{ provider, specs, values: { key: number } }`（`provider` 可为 `mnn`；**落地时没有 `fingerprint` 字段**，指纹只在原生内部用，且 `mnn` 伪提供者留到步 4）。
  - `native.ai.params.set` `{ provider, values: { key: number } }` → 同 get；逐项按 spec 校验（越界/未知 key → `BAD_PARAMS`，**拒绝而不是夹取**，与现有“不静默忽略”原则一致）。
  - `native.ai.params.reset` `{ provider, keys?: string[] }` → 恢复默认（缺省 keys=全部）。
  - 不新增事件推送：弹窗是打开时读一次、操作后用返回值更新。**不要轮询**。
- 持久化：原生 `SharedPreferences`（仓库已有 `AlarmStore`、`DirStore` 在用），文件名 `ai_params`，键 `<provider>.<key>`，只存**与默认不同**的值（默认改了老用户自动跟随，且“恢复默认”就是删键）。不放 Web 的 localStorage：推理在原生、工具页拿不到、而且清缓存会丢。

### 5.2 与 `AiCall` / `AiInvoker` 的衔接

不改 `AiConstraints` 与路由。在 `AiInvoker.dispatch` 里，`constraints.check(call)` 之前插一步 **`AiParamDefaults.fill(call, provider)`**：把调用里**没带**的参数用用户设置补上（显式 > 用户默认 > 内置预设默认，拍板 #1），补完再走原校验，所以越界的用户设置不会绕过校验（设置本身写入时已校验，是双保险）。落点：
- Qwen：`AiCall.Run.sampling` 为空且预设为 prompt 时补温度/topK；`topP`、重复惩罚、回答长度属于新参数，经 `AiSamplingParams` 扩字段传到 JNI（`nativeGenerate` 已有 temperature/topK 参数，再加 topP/penalty 即可；会话重建逻辑沿用“采样配置变了就重建”）。
- 翻译：`AiCall.Translate.req.numBeams` 为空时补。
- 对联：`AiCoupletRequest` 的 `temperature/topK` 为空时补。
- 识物/OCR：新增的阈值字段为空时补（需先给 `AiCall.Ocr` / `AiCall.Classify` 加可选字段）。

**页面显式传的值不被覆盖**，所以现有对联页的 `QWEN_TEMPERATURE` 不受影响（但用户在 AI 中心调的 Qwen 温度对它不生效，要在弹窗文案里写明“页面自带设置的功能以页面为准”）。

### 5.3 哪些改动要重建会话

`scope = SESSION` 的参数（线程、功耗、精度、Qwen 的 mmap 与新增的 topP/惩罚——后者因 MNN 采样器只在 `load()` 建一次）：
- 各 `XxxService` 现在“文件指纹变化重载”，**把“设置指纹”并进去**（`AiParams` 对该提供者的 SESSION 级值算一个 hash，包含 `mnn` 公用组），指纹变了下次调用自动卸载重建；不新增卸载逻辑。
- 设置写入时若会话已加载：**不立即重载**（拍板 #3），不打断正在跑的推理；弹窗提示“下次使用时生效”。需要立即生效的用户可到 AI 中心现有路径 `native.ai.unload`（`AiSessionControl`）——但页面规则禁止工具页调，AI 中心可调，本期不做按钮。
- Qwen 采样类（topP、惩罚）已有“采样变化 → JNI 内重建”，归为 CALL 级即可，**不走指纹**（但首次切换会多一次约 3.4s 加载，弹窗文案写明）。

### 5.4 校验与越界

- 写入：`params.set` 按 spec 逐项校验（类型、`min/max/step`、select 取值），整批原子——有一项非法整批拒绝。
- 读取：存的值若不在当前 spec 范围内（例如以后收窄了范围），`get` 返回时**回落默认并清掉该键**，不抛错。
- 调用时：用户值补进 `AiCall` 之后仍过 `constraints.check`；Rust 侧各引擎已有自己的范围校验（如 `CoupletOptions::validate`），三层都在。

### 5.5 取消 / 并发

- 改参数不碰 `AiHeavyGate`；读写设置是纯内存 + SharedPreferences，不排队。
- 一次推理在跑时改设置：这次调用在**入口处已经取了快照**（`fill` 发生在 dispatch 开头），所以不受影响，下次生效。
- SESSION 级设置改了而会话正被占用：重建发生在下次调用拿到闸门之后（服务里已有“拿闸门 → 查指纹 → 必要时重载”的顺序），不会在推理中途换会话。
- 取消语义不变：沿用 `CancellableCall`；新增的 OCR/识物选项是同步前向，不引入新的取消点。

### 5.6 页面侧（Web）

- 控件形态：连续量（温度、阈值）用 `van-slider` 并在旁边显示数值；整数小范围（线程数、topK、束宽）用 `van-stepper` 或分段选择；开关用 `van-switch`；互斥档位（功耗、识别灵敏度）用分段/下拉。
- 每个参数一行：标题 + 一句话说明（来自 spec.desc）+ 右侧控件，行尾一个“重置”小图标（只有值≠默认才显示）；区块底部「恢复默认」整体重置。`advanced=true` 的收在“高级”折叠里。
- 生效提示：SESSION 级行在说明里带“下次使用时重新加载（约 3 秒）”；Qwen 采样类提示“切换采样会多一次加载”。
- 提交时机：滑块拖动结束（`@change`）才调 `params.set`，不要每帧调；失败只 `showToast`，回滚到服务端返回值。
- 位置：新增 `web/src/shared/ModelParamsPanel.vue`（只收 `providerId`，内部读 spec 与值），放进 `ModelSourcesSheet` 内容区底部（已安装才渲染）；MNN 基础参数用同一组件包一层 `van-popup`，入口放在 `AiView.vue:86` 占位卡片旁。状态放新 store `web/src/stores/aiParams.ts`（只 AI 中心用；**不进工具页**，所以不会违反“业务工具页只读状态”的约定，还要加一个扫描测试保证 `tools/` 下不出现 `native.ai.params`，仿 `color-picker.test.ts` 的做法）。
- 颜色选择等其它约定与本方案无关。

### 5.7 测试策略（契约测试怎么自动覆盖）

沿用 `AiProviderContractTest` 的思路（对 `AiModule.providers(...)` 的每个提供者逐条检查，加进去自动受检）：

- **不变量 8（新增）**：`AiTunable` 提供者 ⇔ 报了非空 `paramSpecs()`；`key` 在提供者内唯一；`default ∈ [min,max]`；`step>0`；SELECT 的 `options` 非空；有 `optionValues` 时与 `options` 等长且默认在其中，否则默认是合法下标；`applyTo` 里的任务必须是该提供者报价里的任务。
- **不变量 9**：每个 spec 能 `set → get` 往返、`reset` 后回到默认、越界 `set` 抛 `BAD_PARAMS` 且不改已有值；整批原子。
- **不变量 10**：spec 范围 ⊆ 对应 `AiConstraints` 范围（Generate / Couplet / Translate 的 numBeams 范围），防止两份漂移。
- **不变量 11**：`scope=SESSION` 的 spec 改值后，该提供者的“会话指纹”必须变化（用替身服务断言重载被触发）；`CALL` 级改值指纹不变。
- 再加“说谎者”替身：声明了 spec 却没实现 `AiTunable`、spec 默认越界、SESSION 级改值指纹不变——确认检查器本身能抓到。
- `AiParamDefaultsTest`：显式 > 用户默认 > 内置默认的优先级；prompt 以外预设不吃用户温度。
- 前端：`ModelParamsPanel` 按 spec 渲染（slider/stepper/switch/select）、重置、高级折叠、失败回滚的单测；`aiCatalog.test.ts` 的 `nativeProviders()` 夹具加一份带 `params` 的提供者；扫描测试禁止工具页使用 `native.ai.params`。
- Rust/C：`capi_smoke` 加 power/precision 用例（宿主 DLL 能加载、非法值被拒）；Rust `MnnConfig` setter 单测；OCR/识物按次选项单测（越界报 `InvalidConfig`）。

## 6. 分步实施计划

按依赖排序。“重编”= 要重建 `libarkli-mnn.so`/Rust 并重新装机；“热更新”= 只改 `web/`，可用 HMR（`pnpm dev:device`），不用 build:app。

| 步 | 内容 | 改哪些文件 | 工量 | 重编? |
|---|---|---|---|---|
| 1 | 原生参数框架：`AiParamSpec`、`AiTunable`、存储 `AiParamStore`（SharedPreferences）、`params.get/set/reset` 三个桥方法、`providers` 追加 `params`、`AiParamDefaults.fill` 接进 `AiInvoker.dispatch`、会话指纹并入 | 新增 `ai/AiParams.kt`、`ai/AiParamStore.kt`；改 `AiProvider.kt`、`AiModule.kt`、`AiHandlers.kt`、`AiInvoke.kt`、各 `XxxService` 指纹处；契约测试与 `AiFixtures` | L | 只装机（纯 Kotlin） |
| 2 | 先给**已有通道**的参数声明 spec：Qwen（temperature/topK/回答长度）、NLLB（numBeams）、对联（temperature/topK）、识物（topK） | 各 `LocalXxxProvider` 的 `paramSpecs()`；各 Policy 常量 | S~M | 否 |
| 3 | Web：`aiParams` store、`ModelParamsPanel.vue`、接进 `ModelSourcesSheet`（已安装才显示）、扫描测试 | `web/src/native/ai.ts`（`aiParamsGet/Set/Reset`）、`stores/aiParams.ts`、`shared/ModelParamsPanel.vue`、`ModelSourcesSheet.vue`、`AiView.vue`、测试、桥协议/文档 | M | **热更新**（原生步 1 装机后） |
| 4 | MNN 基础参数（线程数先做）：线程不用改 C ABI——各 `AndroidXxx.kt` 的常量改读 `AiParamStore`（Qwen 经 JNI `set_config` 的 `thread_num`）；公用弹窗入口与 `mnn` 伪提供者 | `AndroidClip/Ocr/Translate/Couplet/Matting.kt`、`MnnQwenBackend`、JNI（Qwen 一项）、`AiView.vue`、`MnnParamsSheet.vue` | M | Qwen 线程要重编 JNI；其余只装机 |
| 5 | C ABI：`power`（+可选 `little_core_rate`），`ARKLI_MNN_ABI` 升 2；Rust `MnnConfig::with_power`；FFI 新增 `mnn_set_runtime_options(power)`（precision 通道实测后已删）；Qwen 经包装 config 写 power；**真机测 Normal vs High 的 tok/s 与发热**，数据决定“性能模式”是否真上 | `arkli_mnn_capi.{h,cpp}`、`arkli_mnn_jni.cpp`、`core/crates/arkli-ai/src/mnn/{mod,ffi}.rs`、`arkli-ffi/src/lib.rs`、重新生成 uniffi 绑定、`build.gradle.kts` 的 sha256、`qwen35-mnn-model.md` 校验表 | L | **要**（`libarkli-mnn.so` + Rust，上传 release、改 sha） |
| 6 | Qwen 新采样参数 topP/重复惩罚：`samplerConfig` 加字段、`AiSamplingParams` 扩字段、spec | `arkli_mnn_jni.cpp`、`AiGenerate.kt`、`AiQwenPolicy.kt`、`MnnQwenBackend` | M | 要（并入步 5 一起重编更省事） |
| 7 | OCR / 识物按次选项（Rust 引擎 + FFI + Kotlin policy + spec） | `pipeline.rs`、`classify.rs`、`arkli-ffi/src/{ocr,clip}.rs`、`AiOcrPolicy.kt`、`AiClassifyPolicy.kt`、`AiCall`、`AndroidOcr/Clip.kt` | L | 要（Rust） |
| 8 | 抠图细化参数并入（待另一子代理的成果合并后） | 待定 | S~M | 视情况 |
| 9 | 文档：`ai-protocol.md` 加“参数调整”小节与 checklist 一项、`bridge-protocol.md` 加三个方法、`model-picker.md` 与 `status.md` 同步，索引由主会话统一改 | docs | S | 否 |

**实施进度**：步 1~3 已完成并真机验证（Qwen 温度因设备未装 Qwen 未实测）。步 9 的 `ai-protocol.md` / `bridge-protocol.md` / `model-picker.md` / `status.md` 已同步。步 4（MNN 基础参数入口 + 线程数）已实现，真机待验；步 5/6 已实现（2026-10-19，真机待验）：C ABI 升 2 加 `power`，Rust `mnn_set_runtime_options`，Qwen 的功耗/topP/惩罚走包装 config（读码确认 `power`、`precision` 键存在、topP/penalty 在 `load()` 里生效且不被 JNI `set_config` 覆盖，故不改 JNI；注意 LLM 引擎的 `precision` 默认是 `low`，所以 Qwen 的“普通”档沿用该默认、只在“高精度”时写键，此项随精度一并下线）。**实测收口（2026-10-19）**：真机实测（STG-AL00，4 大 4 小核，无 fp16，MNN_ARM82=OFF）：性能(High)对均衡(Normal)，Qwen 校对热态约 4.8 s 对 4.8 s、NLLB 约 0.93 s 对 0.94 s，无收益；省电(Low) Qwen 约 10.2 s、NLLB 约 2.1 s，且切回均衡后不恢复（约 9.0 s / 2.1 s），原因是 MNN 线程池全局、重载不重建，Low 把线程绑到小核（Cpus_allowed_list 0-3），Normal 不绑核所以沿用旧绑定，切到 High 会主动绑大核才能恢复；精度高对普通无差别（本构建无 fp16 内核）。用户拍板：性能模式只留均衡/性能，精度整项不开放，Rust/FFI/Kotlin 的 precision 通道已删（C ABI 字段保留恒传 0）；步 7、8 未做，详见 [状态](../status.md)。

建议交付顺序：**1+2+3 先上线一版**（**已实现，2026-10-19，未提交、真机未验**）（Qwen/NLLB/对联/识物的开放参数，纯 Kotlin + Web，立即可见效果），再做 4（线程），5/6 合并重编一次，7 单独一批。

## 7. 来源清单与“未核实”清单

**来源（已实际打开）**
- Qwen3.5-0.8B 模型卡：https://huggingface.co/Qwen/Qwen3.5-0.8B
- MNN LLM 配置文档：https://mnn-docs.readthedocs.io/en/latest/transformers/llm.html
- HF GenerationConfig：https://huggingface.co/docs/transformers/main_classes/text_generation
- PaddleOCR 3.x OCR 管线：https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/OCR.html
- PaddleOCR 3.x 文本检测模块：https://www.paddleocr.ai/latest/en/version3.x/module_usage/text_detection.html
- 钉死提交 MNN 源码（本地 `native/mnn/.work/MNN-478c10e8…/`）：`include/MNN/MNNForwardType.h`、`include/MNN/Interpreter.hpp`、`source/backend/cpu/CPUBackend.cpp`、`source/core/Session.cpp`、`transformers/llm/engine/src/{llm.cpp,llmconfig.hpp,sampler.cpp}`
- 本仓库：`docs/design/ai-protocol.md`、`docs/research/qwen35-mnn-model.md`、`onnx-to-mnn-migration.md` 与上文各代码行号

**未核实（不要当结论用）**
- MNN 文档里 `power` 键、各配置“是否需重载”的官方说法（文档页没有；本文“是否重建”全是读码）。
- （已实测：本构建高/普通精度无差别）`precision=low` 在本构建（`MNN_ARM82=OFF`）上到底走什么内核、与 normal 在无 fp16 机器上的差异：只有旧实测“无可见差别”（单机、小样本）。
- 功耗模式 High 对 tok/s 与发热的实际影响：只有读码得到“绑大核”的机制，**无实测数字**，步 5 必须真机测。
- `use_mmap` 对 Qwen 内存与速度的影响：文档建议手机开，本机未测。
- NLLB 官方推荐的 `num_beams`/`length_penalty` 取值、SigLIP2 `logit_scale/logit_bias` 原文、GPT-2 采样官方建议、sherpa-onnx/sherpa-mnn 的 `num_threads`/`decoding_method`/端点规则原文、PaddleOCR 方向分类阈值 `cls_thresh` 的官方说明。
- Qwen `presence_penalty=2.0` 在 0.8B 小模型上的实际效果（官方给了值，本项目未试）。
- 官方 Qwen 推荐值与项目当前采样值谁的质量更好：需要真机比，本方案不判断。
- 本文所有速度、内存数字都引自旧文档的单机实测，没有新增实测。
