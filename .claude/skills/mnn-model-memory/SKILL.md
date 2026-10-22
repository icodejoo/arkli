---
name: mnn-model-memory
description: 引入、转换、上线任意本地 AI 模型（MNN / sherpa-mnn），或改 scripts/mnn/recipes.json、改 sherpa/MNN 加载器、排查「模型加载内存过高 / 加载太慢」时使用。给出外置权重（--saveExternalData）的做法、清单怎么填、加载器怎么认 .weight、真机怎么量、什么时候不该外置。
---

# 本地模型内存优化：外置权重

新模型默认按这套来：转换时把权重外置成 `.mnn.weight`，加载峰值能砍掉一半以上，加载还更快。没收益的别硬改，判定见第 6 节。

## 1. 结论与数据

设备 STG-AL00，实验包 `.debug.exp`，「增量」= 加载峰值 VmHWM 减启动时 RSS（MB），加载耗时取模型自报的 loadMs/elapsedMs。

| 模型 | 加载器 | 改前 增量 / 耗时 | 改后 增量 / 耗时 | 结论 |
|---|---|---|---|---|
| 语音 zipformer（asr w8） | sherpa-mnn JNI（需补丁） | 558~560 / 2450ms | 242~244 / 740~755ms | 改，RTF 仍 0.20，4 条文本逐字一致 |
| SDXS-512（logo） | 自家 JNI | 1173~1180 / 4600~5060ms | 578~587 / 2330~2340ms | 改，稳态 RSS 不变，只降峰值 |
| SigLIP2（识物） | 自家 JNI | 304~306 / 945~967ms | 112~121 / 564~613ms | 改 |
| BiRefNet-lite（抠图） | 自家 JNI | 293~295 / 836~842ms | 128 / 510~516ms | 改，成品 png 逐字节一致 |
| MODNet fp32（抠图） | 自家 JNI | 135 / 295~301ms | 55~70 / 247~266ms | 改 |
| PP-OCRv6 small（fp16） | 自家 JNI | 74~75 / 224~240ms | 38~56 / 162~164ms | 改，收益偏小 |
| U2Net-p（2.4MB）、PP-MattingV2（9MB） | 自家 JNI | 16 / 150ms、8~37 / 178ms | 未改 | 本来就小，增量在噪声里 |
| NLLB、对联、Qwen | 自家 JNI | 早已外置 | - | 沿用 |

别的 sherpa 系模型：目前没有（`noise` 是白噪音工具，没有 TTS/降噪模型）；以后有，看第 3 节能不能挂同一个补丁。

## 2. 峰值是怎么堆起来的

以 ASR 为例（构成是按源码和数据粗估，不是逐项实测）：

- sherpa 的 `ReadFile` 用 `istreambuf_iterator` 逐字节构造 vector，容量翻倍增长，又慢又占。只改成一次分配，峰值只少约 30MB，但加载耗时砍半。
- MNN 从 buffer 加载还会再拷一份；权重再常驻一份。三份叠起来就是整包版的峰值。
- 外置权重后，图文件只剩 2MB，权重由 MNN 按需读进最终位置，**峰值和稳态重合**。代价：稳态不降，只降加载瞬时峰值。

## 3. 必做清单

1. **配方**：`scripts/mnn/recipes.json` 对应变体的 `quant` 末尾加 `"--saveExternalData"`。例：`["--weightQuantBits","8","--saveExternalData"]`。`quant_by_graph` 里不想外置的图（如 sdxs 的 vae_decoder）保持原样。
2. **转换**：`E:\venv\arkli-mnn\Scripts\python.exe -I scripts\mnn\convert_all.py <模型> --variant <模型>=<变体> --force`。产物是 `x.mnn`（几百 KB~2MB）加 `x.mnn.weight`。
   没有配方的模型（如抠图）：`MNNConvert -f MNN --modelFile 旧.mnn --MNNModel 新.mnn --saveExternalData`。权重与 ONNX 直转逐字节相同（siglip2、sdxs、ocr 已比对），只有图文件头里的 UUID 不同。
3. **清单**：`python -I scripts\mnn\pack.py <产物id> --tag <release tag> --zip <输出目录> --apply app\src\main\assets\ai\models.json`。**`--apply` 不会更新 `totalBytes`**，必须手改成 files 字节之和；不一致整份清单会被拒，所有模型都报「未知的模型 id」。`.weight` 的 role 是 `weights`。
4. **自家 MNN JNI 加载器**：Rust 侧 `external_weight_path`（`core/crates/arkli-ai/src/mnn/mod.rs`）会自动带上 `<model>.weight`，一般不用改。Kotlin 侧要做的：
   - 该服务的 `REQUIRED_FILES`（或 `MattingMode.externalWeight`）把 `.weight` 列进去。缺权重时 MNN 只打日志，到前向才报错，所以必须在就绪判定里拦住。
   - 重载指纹要包含 `.weight` 的长度和修改时间（识物的 `ClipService.keyOf` 已做）。
5. **sherpa-mnn 加载器**：补丁在 `native/mnn/patches/sherpa-mnn-ext-weight.patch`（ReadFile 一次分配 + 构造函数里每个 Init 前 `setExternalFile`，没有 `.weight` 就保持原行为）。`native/mnn/build-sherpa-mnn.sh` 的 2.5 步自动打补丁，用 `SHERPA_PATCH_MARK`（补丁里 ReadFile 那行注释的开头）判断是否已打过，**改补丁注释时同步改这个常量**。其他 sherpa 模型要用，先看对应 `online-*-model.cc` 的构造函数能不能同样挂 `setExternalFile`。
6. **重编 so**：`ANDROID_HOME=E:/sdk/android native/mnn/build-sherpa-mnn.sh <输出目录>`，把新 sha 填进 `app/build.gradle.kts` 的 `mnnLibs`，并复制到 `.gradle/arkli-mnn/<sha>-libsherpa-mnn-jni.so`。release 资产重编后**原地覆盖现有 tag**，不新开版本号。
7. **删校验的大小门槛**：不要给外置的小图文件设最小字节数（`SpeechPolicy.missingFiles` 现在只要求非空）。

## 4. 没用的方案，别再试

- `numThreads` 改 1/4：不改峰值，只改 RTF（1 线程 0.30，4 线程 0.156，2 线程 0.20）。
- 加载后 `purgeNativeHeap`：峰值和稳态都不降。
- MNN 的 memory / precision / mmap 选项：sherpa-mnn 的 Kotlin 配置里没有这些字段，`session.cc` 写死 `Memory_Low`、整文件读进内存；没传过 `MMAP_FILE_SIZE` 之类的 hint，也没试过。

## 5. 真机度量

脚本在 `scripts/mnn/devmem/`。设备序列号用环境变量 `ADB_SERIAL`。

1. **并行实验包，别覆盖原 debug 包**：临时把 `app/build.gradle.kts` 第 33 行 `applicationIdSuffix` 改成 `".debug.exp"`，`./gradlew :app:assembleDebug --offline`，安装后**立刻还原**这一行。
2. **每轮先强停再冷启动**（脚本里已做），设备端 `poll.sh` 每 0.1s 读 `/proc/<pid>/status` 的 VmHWM / VmRSS，口径取「峰值减启动 RSS」。启动底会在 190~250MB 浮动，不能直接比绝对峰值。
3. 稳态用 `adb shell dumpsys meminfo <包名>` 看 PSS。
4. 命令：
   - 推模型并写校验标记：`devmem/push-model.sh <本地目录> <模型id>` 后跟 `devmem/verify-model.sh <模型id>`（走 `native.model.verify`，状态要是 `installed`）。
   - 加载峰值：`devmem/ai-load.sh <标签> <provider>`，provider 如 `local-clip`、`local-ocr`、`local-logo-sdxs`、`local-matting-birefnet`。
   - 语音：`devmem/asr-wav.sh <标签>`，要先把 `0.wav`..`3.wav` 放到实验包 `cache/asrtest/`，并备好基线文本 `texts_REF.txt`。
   - 前向对比：`devmem/infer.sh <标签> <方法> '<params JSON>'`，把整包版与外置版的输出逐字对比。抠图成品比 sha256。
5. 每个配置至少 2 轮，第一轮日志偶尔抓不到（脚本显示「文本异(0条)」），内存数字仍有效，补跑即可。

## 6. 验收与「别外置」的判定

验收：外置版相对整包版，① 加载增量明显下降；② 加载耗时不增；③ 输出逐字（或逐字节）一致；④ `native.model.verify` 通过、`:app:testDebugUnitTest` 全绿。

不外置的情形：整包版增量本来就小（经验：增量 ≲ 40MB 且模型文件 < 10MB，如 U2Net-p 2.4MB、PP-MattingV2 9MB），收益落在噪声里，却要多管一个文件。任何一项出现「更慢」也不改，并写清原因。

注意：推理耗时只在 ASR 上严格对比过（RTF 0.202 → 0.202~0.207），其他模型改后没逐项对比，新模型请补测。

## 7. 相关文档

- `docs/research/asr-small-models.md`：语音模型调研与内存背景
- `docs/research/onnx-to-mnn-migration.md`：MNN 迁移、各 so 的 sha 与体积
- `docs/design/ai-protocol.md`：AI 协议、取消与生命周期
- `docs/design/model-download.md`：清单、下载、校验
- `scripts/mnn/README.md`：转换流程与环境
