---
title: Qwen3.5-0.8B MNN 4bit 文本模型（托管、溯源与使用建议）
status: draft
updated: 2026-10-15
summary: L2 本地文本模型 Qwen3.5-0.8B 的 MNN 权重与运行库：来源与改动、两个 release 的下载地址与 sha256、体积、真机速度与内存、运行时要求与使用建议
---
## TL;DR

- **用途**：L2 本地大模型（决策 [0005](../decisions/0005-ai-four-layers.md)）的文本生成：问答、摘要、校对、改写。**只做文本，不含视觉**。
- **下载**：<https://github.com/icodejoo/arkli/releases/tag/qwen35-mnn-v1>（tag `qwen35-mnn-v1`，6 个附件，公开仓库）。
- **体积**：合计 484,349,699 字节（约 462 MiB），其中权重 `llm.mnn.weight` 占 470,382,614 字节。
- **来源**：[taobao-mnn/Qwen3.5-0.8B-MNN](https://huggingface.co/taobao-mnn/Qwen3.5-0.8B-MNN)（Apache-2.0，基座 [Qwen/Qwen3.5-0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B)）。**权重与上游逐字节一致**，只改了两个配置。
- **运行时要求 MNN master**：MNN 3.6.1 加载这份权重会在 `Llm::forwardRaw` 里 SIGBUS 崩溃，master 正常（见第 4 节）。
- **真机速度**（STG-AL00，4 线程，`precision=low`）：解码约 17.4 tok/s，预填约 35.7 tok/s，加载约 3.1~3.4 s；**卸载后内存回落到基线 +3MB**（见 3.1）。
- **运行库**：`libMNN.so` + `libarkli-mnn.so`（v2 release 同时还放语音用的 `libsherpa-mnn-jni.so`，与 Qwen 无关，但三个同属 `mnn-478c10e-v2`）。`libMNN.so` 发布在 release `mnn-478c10e-v1`（<https://github.com/icodejoo/arkli/releases/tag/mnn-478c10e-v1>）；`libarkli-mnn.so` 在 M2 加了 C ABI（见迁移方案 4.2），新版计划放进 release `mnn-478c10e-v2`（**待用户上传**，上传前本地靠 `.gradle/arkli-mnn` 缓存构建；v2 里也要放一份不变的 `libMNN.so`，因为下载前缀是同一个）。由 `native/mnn/build.sh` 复现，sha256 见第 8 节。
- **建议**：先用 `precision=low`、4 线程、关闭思考；不用来写对联和背古诗（见 [对比文档](on-device-llm-comparison.md) 第 8 节）；事实类问答要提醒用户可能出错。

## 1. 文件清单与校验

下载地址统一形如 `https://github.com/icodejoo/arkli/releases/download/qwen35-mnn-v1/<文件名>`（302 跳到 `release-assets.githubusercontent.com`，已实测；`DOWNLOAD_HOSTS` 要保留这个域名）。

| 文件 | 字节 | sha256 | 用途 |
|---|---|---|---|
| `llm.mnn.weight` | 470,382,614 | `4e25ef4cbfb49a33013d17300c2f68cd9c9ce8f2e3f7b947fd2c574ec297ca5e` | 4bit 量化权重（块大小 64），与上游一致 |
| `llm.mnn` | 2,148,136 | `94e0459e10584487a3bda77dc3c3322c0c01cfc9d223a7284e8d07345bf877d5` | 计算图，与上游一致 |
| `llm.mnn.json` | 5,343,877 | `fe58a15987b391b443ade62a92221956349e11628fa36b1bfb9503af32923a1a` | 图的 JSON 描述，与上游一致 |
| `tokenizer.txt` | 6,465,727 | `7e75de1f279a10b65bd9dc1a5207205cb8993823861c4c42bbbd74e48e1c23a4` | 分词器与聊天模板，与上游一致 |
| `llm_config.json` | 8,692 | `1791174c5ee8fa45654485c756895a3befcdfa077d5216275d585408c7d5004d` | 模型参数。**已改**：`is_visual` 由 `true` 改为 `false` |
| `config.json` | 653 | `9724121a351f3aa6ada52470489a7cf17dccfd7f35f4b630afa9d9102434873b` | 运行配置。**已改**：`enable_thinking` 由 `true` 改为 `false` |

> 上游另有 `visual.mnn`（251,528 字节）与 `visual.mnn.weight`（63,043,212 字节），是视觉编码器，纯文本用不上，**没有托管**。

## 2. 与上游的差异（溯源）

- 下载时间：2026-10-15，来自 Hugging Face 仓库 `taobao-mnn/Qwen3.5-0.8B-MNN`（仓库修订 `3208b55b2e3c948016c9d380a697be881a1f12f8`，最后修改 2026-03-04）。
- 上游导出参数（`export_args.json`）：`quant_bit=4`、`quant_block=64`、`lm_quant_bit=4`、`act_bit=16`、`hqq=true`、`omni=false`、`tie_word_embeddings=true`；`llm.mnn.json` 里的转换器版本标为 3.4.0。
- 只改两处，其余文件原样上传：
  1. `llm_config.json`：`"is_visual": true` → `false`。不改的话 MNN 会去找 `visual.mnn`，找不到就报 `Can't open file:model/visual.mnn`、`LLM init error`。
  2. `config.json`：`"enable_thinking": true` → `false`。对话模板据此决定要不要先输出 `<think>` 思考段，手机上太费时间。
- `config.json` 里其余运行参数保持上游默认：`backend_type=cpu`、`thread_num=4`、`precision=low`、`memory=low`、采样 `penalty 1.1 / topK 20 / topP 0.95 / temperature 1.0`。

## 3. 真机数据（HUAWEI STG-AL00）

该机无 `i8sdot`、无 fp16 算术（MNN 启动日志：`i8sdot:0, fp16:0, i8mm:0`），CPU 为 Kryo 类 4+4 核。以下为 MNN master 在这台机上的一次实测：

| 项 | 数值 |
|---|---|
| 加载 | 约 3.4 s |
| 预填 | 19 token，0.53 s，约 35.7 tok/s |
| 解码，`precision=low` | 93 token，5.35 s，约 17.4 tok/s |
| 解码，`precision=normal` | 约 18.4 tok/s（只生成 17 token，样本太小，**不能据此说 normal 更快**） |
| `libMNN.so`（ARM82 关，已 strip） | 4,899,952 字节，gzip -9 后 1,982,865 字节 |
| `libarkli-mnn.so`（JNI 封装 + C ABI，M2 版） | 71,592 字节，gzip -9 后 31,003 字节（第 6 步：按次采样；M2 版 69,728 字节 / 30,047 字节；M2 之前的纯 JNI 版 37,752 字节 / 16,823 字节） |

### 3.1 接入后在 App 进程里的实测（2026-10-15）

经桥 `native.ai.run` → `local-qwen` → JNI → MNN，debug 包，同一台机：

| 项 | 数值 |
|---|---|
| 加载 | 约 3.1 s（日志 `ArkliQwen: 模型加载完成`） |
| 基线（未加载模型）PSS / VmRSS | 约 160MB / 191MB |
| 预热加载后 PSS / VmRSS | 约 950MB / 985MB（加载瞬间含临时缓冲，峰值 VmHWM 约 1.1GB） |
| 生成后稳态 PSS / VmRSS | 约 775MB / 807MB |
| **卸载后 PSS / VmRSS** | **约 163MB / 196MB（相对基线 +3MB / +5MB，过 +30MB 验收线）** |

- **内存踩坑**：首版 `nativeDestroy` 只调了 `Llm::destroy`，卸载后 PSS 仍有约 758MB（只释放 15MB）。原因是 MNN 全局执行器缓存了缓冲、分配器（scudo）没把空闲页还给系统。修法：`Executor::getGlobalExecutor()->gc(FULL)` 加 `mallopt(M_PURGE, 0)`（API 28 以下 `M_PURGE` 调用返回 0，无副作用），修后回落到基线。
- **输入输出走 UTF-8 字节数组**，不用 `jstring`：JNI 的改良 UTF-8 会拆 emoji，`NewStringUTF` 遇到 `maxNewTokens` 截断出的半个汉字会让 JVM abort。
- **样例输出**（`precision=low`，关思考，最多 256 token）：摘要任务把一段会议记录概括成一句话，通顺；“用一句话介绍杭州西湖”会编造景点（“钟书楼”“百鸟朝凤”），事实不可信，界面要提示核对。

局限：只测了一台机、一句提示；`low` 与 `normal` 在无 fp16 的机器上没有可见差别，有 fp16 的新机上才可能拉开（待复测，见 [对比文档](on-device-llm-comparison.md) 第 10 节）。

## 4. 运行时要求与已知坑

- **必须用 MNN master**：3.6.1 源码里已有 `LinearAttention` 算子，但加载这份权重后在 `MNN::Transformer::Llm::forwardRaw` 内 SIGBUS（`BUS_ADRALN`，fault addr `0x30000000a`，像是读到了错位的数据）。同样的构建选项换 master 后正常。我判断是算子参数结构在版本间有变化，**没有做版本二分来确认**。接入时要**钉死一个 master 提交号**，不能用浮动的 master。
- 构建选项：`MNN_BUILD_LLM=ON`、`MNN_BUILD_FOR_ANDROID_COMMAND=ON`（不加会因 OBJECT 库上挂 POST_BUILD 命令而配置失败）、`MNN_SEP_BUILD=OFF`、`MNN_ARM82=OFF`（开不开都崩在 3.6.1，不是原因）。
- 日志默认走 logcat（tag `MNNJNI`），终端里看不到性能统计。
- 在 Git Bash 里用 adb：要 `MSYS_NO_PATHCONV=1`，主机路径写 `E:/...`。

## 5. 使用建议

- **精度**：`precision=low`（用户 2026-10-15 拍板）、4 线程（设备只有 4 个大核，6 与 8 线程反而更慢）。
- **思考模式**：关。需要推理类任务再单独开，并给更长超时。
- **适合**：摘要、校对、改写、通用问答、把识别出的文字做轻量加工。
- **不适合**：对联（用专用模型）、背诵古诗、需要事实准确的问答。实测自我介绍里把自己说成“7B 参数”，**小模型会一本正经地说错**，界面上要有提示。
- **内存**：权重约 470MB，加载后占用要再测；用完要通过 `native.ai.unload` 释放，系统内存紧张时由 `AiLifecyclePolicy` 回收。
- **视觉**：如果以后想让它直接“看图翻译”，要另外下载 `visual.mnn*`、用 `MNN_BUILD_LLM_OMNI` 重新构建，并和现有 PP-OCR + NLLB 路线做真机对比再定，目前没做。

## 6. 许可证

- 模型：Apache-2.0（上游 HF 元数据标注 `license:apache-2.0`），再分发需保留许可与署名；本 release 说明里已写明来源与改动。
- 运行时 MNN：Apache-2.0，release 里附了从该提交源码取出的 `LICENSE.txt`（即 `MNN-LICENSE.txt`）。**MNN 的第三方依赖（`3rd_party/` 下的各库）各自的许可证我没有逐个核对。**

## 7. 运行库（so）的托管与溯源

- **下载**：<https://github.com/icodejoo/arkli/releases/tag/mnn-478c10e-v1>（tag `mnn-478c10e-v1`，4 个附件：两个 so、`MNN-LICENSE.txt`、`SHA256SUMS`）。`app/build.gradle.kts` 的 `fetchMnnRuntime` 构建时从这里下载并校验 sha256，缓存在 `.gradle/arkli-mnn/`。已实测：清缓存后重新下载，校验通过，产出与发布文件逐字节一致。
- **来源**：[alibaba/MNN](https://github.com/alibaba/MNN) 的固定提交 `478c10e8d2351c7a4ea6f6243b97841a1eb39190`（2026-10-15 的 master 头，Apache-2.0）。我先在当时的 master 上跑通，再核对该提交的源码与我编过的目录逐文件一致，才钉的。
- **复现**：`ANDROID_HOME=<SDK> native/mnn/build.sh`（NDK 28.2.13676358、SDK 里 CMake 自带的 ninja），产物在 `native/mnn/out/`，会打印大小与 sha256。`libMNN.so` 两次构建哈希一致（可复现）。

## 8. 运行库校验值

| 文件 | 字节 | sha256 |
|---|---|---|
| `libMNN.so` | 4,899,952 | `9cc1ff8b8b039431913a37ad1853dfa51162b41ae8b90927507204397096a353` |
| `libarkli-mnn.so`（JNI + C ABI + 按次采样，release v2；M2 版 69,728 字节 `1229e2f6…6f81` 已作废） | 71,592 | `b4c9bf34e2d72867a8b265fcedd5f14435cf1d994a7ee2af0253445c88c09f40` |
| `libsherpa-mnn-jni.so`（语音 sherpa-mnn JNI，release v2；Qwen 不用，随同一 release 发布） | 2,690,520 | `aa79262fa17431bf513c7c4ac9855df02d09c1fe364396c0d8032df652a0c339` |
| `MNN-LICENSE.txt` | 11,346 | `a830d59c4f98d110e0540d0581efada06192ba6e798434307d1794b07a290302` |

> 历史：release v1 里的 `libarkli-mnn.so` 是 37,752 字节、sha256 `a596c65c…bbf18f` 的纯 JNI 旧版（不含 C ABI 与“贪心采样/system 消息”改动）。
>
> **采样（第 6 步读 MNN 源码得出的结论）**：采样器只在 `Llm::load()` 里按配置建一次（`llm.cpp` 的 `mSampler.reset(...)`），`load()` 之后调 `set_config` 只改配置表、**不会重建采样器**。所以此前 JNI 在 `load()` 之后设的“贪心”其实没生效，实际一直是模型 config.json 的默认混合采样（`penalty 1.1 / topK 20 / topP 0.95 / temperature 1.0`）。现在 JNI 在 `load()` **之前**设采样配置，并在每次生成时比较采样参数，变了就在 JNI 里整个重建会话（加载约 3.4 s，见 §3）；字段：贪心 `{"sampler_type":"greedy"}`，温度采样 `{"sampler_type":"mixed","mixed_samplers":["topK","topP","temperature"],"temperature":T,"topK":K}`。
>
> 改了 so 要同步改 `app/build.gradle.kts` 里的 sha256 与本表，并用 `gh release upload --clobber` 替换 release 附件。

## 9. 复现模型

```bash
# 1) 下载上游权重（大文件用 aria2，HF 与 hf-mirror 互为备份）
# 2) 改两处配置：llm_config.json 的 is_visual、config.json 的 enable_thinking
# 3) 校验 sha256 与第 1 节一致
```
