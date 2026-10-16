---
title: Spike 报告：ort 对接 sherpa 自带 ORT 与 OCR 可行性
status: draft
updated: 2026-10-15
summary: 验证 Rust ort crate 能否驱动 sherpa-onnx 自带的 onnxruntime，以及 PP-OCR 在其上的算子兼容、耗时与体积
---
> **已迁移（2026-10-15，M7 桌面部分）**：语音识别已从 sherpa-onnx 切到 sherpa-mnn（`libsherpa-mnn-jni.so` + MNN 模型），识物/翻译也已迁 MNN；本文是迁移前的 ORT 路线历史记录，结论不改。迁移情况见 [onnx-to-mnn-migration.md](onnx-to-mnn-migration.md)。

## TL;DR
- **GO**：决策 0002 的"视觉类复用 sherpa 自带的同一份 ORT"在真机上走通了。`ort = "=2.0.0-rc.14"` + `load-dynamic` 直接加载 sherpa-onnx 1.13.8 的 `libonnxruntime.so`（ORT 1.28.2），无需任何适配；sherpa c-api 与 ort 在同一进程里共用同一个 ORT 实例（OrtApi 表指针一致）。
- PP-OCRv5 mobile 的 det/rec/cls（以及 v4 的 det/rec）Session 全部创建成功，无算子报错；Rust 手写前后处理 + DB 后处理 + CTC 解码端到端跑通，1080x2400 的仿手机截图 20 行文字全部检出且识别正确（仅中英数字间空格有出入）。
- 速度：4 线程识别一张 1080x2400 截图（20 行）整图约 2.2 秒，2 线程约 4.0 秒，1 线程约 5.9 秒（手机后台有负载，见噪声说明）。峰值 RSS 约 205MB。
- 体积：Rust 侧 so 仅 0.41MB（空 cdylib 基线 0.26MB，ort + 前后处理只增约 0.15MB）；ORT 22.25MB 原始 / 约 8MB deflate；OCR 模型下载约 21.5MB。
- **最大的坑**：这份 ORT **没有编入 XNNPACK**（只有 NNAPI 与 CPU 两个 provider）。设计文档里的 provider 链 `["xnnpack","cpu"]` 需要改；NNAPI 能注册但零加速。

## 1. 取得的 ORT 信息
来源：GitHub release `v1.13.8` 的 `sherpa-onnx-1.13.8.aar`（50,129,134 B，aria2c 下载），解压 `jni/arm64-v8a/`。

| 文件 | 原始大小 | AAR 内 deflate |
|---|---|---|
| libonnxruntime.so | 22,249,560 B（21.2 MiB） | 7,960,089 B |
| libsherpa-onnx-jni.so | 4,771,760 B | 1,966,038 B |
| libsherpa-onnx-c-api.so | 4,465,168 B | 1,887,124 B |
| libsherpa-onnx-cxx-api.so | 440,688 B | 143,248 B |

libonnxruntime.so 的细节（`llvm-nm -D` / `llvm-readelf`，运行时 `GetVersionString` 交叉验证）：
- 版本：`OrtApiBase::GetVersionString()` 返回 `1.28.2`；导出符号带版本标签 `@@VERS_1.28.2`。
- 导出符号只有 3 个函数：`OrtGetApiBase`、`OrtSessionOptionsAppendExecutionProvider_CPU`、`OrtSessionOptionsAppendExecutionProvider_Nnapi`（外加几个 absl 的 TLS 变量）。**`OrtGetApiBase` 已导出**，所以 `dlopen + dlsym` 或 `libloading` 均可用。
- NEEDED 只有 libdl / liblog / libm / libc，不依赖 libc++_shared，也不依赖 libandroid。
- PT_LOAD 对齐 0x4000（16KB），满足 Android 15+ 16KB 页要求；sherpa 的 jni / c-api 也是 0x4000。
- **内含 execution provider**（`OrtApi::GetAvailableProviders` 实测）：`NnapiExecutionProvider`、`CPUExecutionProvider`。没有 XNNPACK。显式注册 XNNPACK 的原文报错：

```
Error { code: InvalidArgument, message: "XNNPACK execution provider is not supported in this build. " }
```

sherpa 的 c-api / jni 都是 `NEEDED libonnxruntime.so`（动态依赖同名库），所以 APK 里只会有一份 ORT。

## 2. ort crate 对接
### 版本与特性
- crates.io 上 `ort` 最新 **2.0.0-rc.14**（2026-10-12 发布，MIT OR Apache-2.0），没有 stable；rc.13 为 2026-07-28。`ort-sys` 同版本。
- 支持 `load-dynamic`：`ort::init_from(path)` 或环境变量 `ORT_DYLIB_PATH`；加载后读 `GetVersionString`，**只比较次版本号**：库的次版本 < 编译期 API 版本则返回 `BadVersion`，库更新则只打 info 日志。
- 编译期 API 版本由特性 `api-17`（默认，最低）到 `api-31` 决定，对应 `OrtApi` 的 GetApi(version) 参数。默认 api-17 即要求 ORT >= 1.17。

### 实测（真机，arm64）
| 编译特性 | 加载 1.28.2 的 so | 结果 |
|---|---|---|
| 默认（api-17） | 成功 | Session 创建、推理均正常 |
| `api-28` | 成功 | 与 1.28 精确匹配，同样正常 |
| `api-30` | 失败，运行期干净报错 | `Error: BadVersion { version_str: "1.28.2", path: "/data/local/tmp/spike/./libonnxruntime.so" }` |

不匹配时是**运行期报错，不是编译错**，也不崩溃，可以据此做回退。结论：不用试相邻版本，rc.14 一次通过。

### 与 sherpa 共用同一实例
同进程先 `dlopen` sherpa c-api（`SherpaOnnxGetVersionStr = 1.13.8`），再让 ort 以裸文件名 `libonnxruntime.so` 加载：
```
dlopen 裸名 0x6255ea2496cea29b / 带路径 0x6255ea2496cea29b / 句柄相同 = true
OrtApi 表指针：dlsym 取得 0x7e980f5ba0 / ort 使用 0x7e980f5ba0 / 同一实例 = true
```
说明在 APK 里用 `init_from("libonnxruntime.so")`（裸名）即可与 sherpa 共享。注意：本次是 `adb shell` 里的独立可执行文件，没在 APK 的 classloader 命名空间里验证（见未解决问题）。

### API 形态（rc.14 与旧文档不同的地方）
- `Session::builder(&Environment)` 要显式传环境；`ort::init_from(so)?.build()?` 得到 `Environment`。
- `session.run` 需要 `&mut self`；张量用 `Tensor::from_array((Vec<i64> 形状, Vec<f32>))`，不需要 ndarray。
- XNNPACK/NNAPI 是 `ep::XNNPACK` / `ep::NNAPI`，要开对应 Cargo 特性；`.error_on_failure()` 才会在注册失败时报错（默认静默忽略）。

关键代码（`ortspike/src/main.rs`）：
```rust
let env = ort::init_from(so)?.build()?;                 // so = "libonnxruntime.so"
let mut b = Session::builder(&env)?
    .with_optimization_level(GraphOptimizationLevel::All)?
    .with_intra_threads(4)?.with_inter_threads(1)?;
let mut s = b.commit_from_file(model)?;
let outs = s.run(ort::inputs!["x" => Tensor::from_array((vec![1i64,3,48,320], data))?])?;
let (shape, data) = outs[0].try_extract_tensor::<f32>()?;
```

### 备选方案（未实测，仅评估）
rc.14 已通过，没有必要走备选。留作参考：①直接用 `ort-sys` 的原始 FFI（`disable-linking`），省掉 ort 的安全封装，但要自己管 `OrtStatus`、张量生命周期，工作量约 1~2 天，体积收益 < 0.1MB（ort 封装本身只占约 0.15MB）；②用 `onnxruntime_c_api.h` 自己 bindgen/手写最小绑定（只需 `CreateEnv/CreateSession/Run/GetTensorMutableData` 等约 15 个函数）：约 2~3 天，与 sherpa 的 ORT ABI 严格耦合，维护成本高于 ort。**推荐：用 ort，`Cargo.toml` 里钉死 `=2.0.0-rc.14`。**

## 3. OCR 模型算子兼容
### 模型来源
ModelScope `RapidAI/RapidOCR`（许可证 Apache-2.0，`https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master/<路径>`）：

| 文件 | 路径 | 大小 |
|---|---|---|
| PP-OCRv5 det mobile | onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx | 4,819,576 B |
| PP-OCRv5 rec mobile | onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx | 16,631,306 B |
| PP-OCRv5 文本行方向 cls | onnx/PP-OCRv5/cls/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx | 1,018,508 B |
| 字典 | paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile/ppocrv5_dict.txt | 74,012 B（18,383 行） |
| PP-OCRv4 det / rec mobile（对照） | onnx/PP-OCRv4/det、rec | 4,745,517 B / 10,857,958 B |

HuggingFace 的 SWHL/RapidOCR 只到 v4，没有 v5。该仓库还有 **PP-OCRv6**（tiny det 1.8MB + rec 4.5MB；small det 9.9MB + rec 21.2MB），本次没测，是缩体积的线索。

### ① Session 创建（4 线程，CPU）
| 模型 | 结果 | 输入 / 输出 | 创建耗时 |
|---|---|---|---|
| v5 det | 成功 | x [-1,3,-1,-1] → [-1,1,-1,-1] | 约 100 ms |
| v5 rec | 成功 | x [-1,3,48,-1] → [-1,-1,18385] | 约 200 ms |
| v5 cls | 成功 | x [-1,3,80,160] → [-1,2] | 约 39 ms |
| v4 det | 成功 | 同 det | 约 123 ms |
| v4 rec | 成功 | x [-1,3,-1,-1] → [-1,-1,6625] | 约 215 ms |

**没有任何不支持的算子报错**。ORT 在 Session 创建阶段就会查全部 kernel，创建成功即说明算子齐全。

### ② 虚拟输入输出形状
det [1,3,960,448] → [1,1,960,448]；det [1,3,640,640] → [1,1,640,640]；rec [1,3,48,320] → [1,40,18385]；rec [1,3,48,640] → [1,80,18385]（时间步 = 宽度 / 8，类别 18385 = blank + 18383 字典 + 空格）。

### ③ 端到端（真机）
流程全在 Rust 里手写（约 150 行，无额外依赖）：PPM 读入 → 双线性缩放（长边 ≤ 960，边长取 32 倍数）→ BGR + ImageNet 归一化 → det → 阈值 0.3 二值化 → 8 邻域连通域 → 外接矩形（框分数 < 0.6 或最小边 < 3 丢弃）+ unclip 1.6 外扩 → 按行排序 → 逐框裁剪、高度缩到 48、宽度至少补到 320 → rec → CTC 贪心解码。用 Pillow 生成两张测试图（微软雅黑）。

- 简单图（4 行，含中英混排与数字）：4/4 逐字正确，置信度 0.97~0.99。
- 仿手机截图（1080x2400，状态栏 + 标题 + 8 个设置条目 + 按钮）：检出 20/20 个框，文本与真值**只差空格**：「已使用 48.6 GB，共 128 GB」被识别为「已使用48.6GB，共128 GB」，「序列号 7NQBB236」为「序列号7NQBB236」（PP-OCR 对中文与数字/英文之间的空格本来就不稳定）。其余 18 行完全一致，置信度 0.92~1.00。

没有做的：旋转/竖排框（只用外接矩形）、cls 方向分类的串联、多边形 unclip（Clipper）。这些不影响"算子与流程通"的结论。v4 的 rec 用 v5 字典解出来是乱码，那是我拿错了字典（v4 是 6625 类、需配 `ppocr_keys_v1`），不是模型问题。

## 4. 性能与内存基准
环境：STG-AL00 / SM6225（4 小核 1.9GHz + 4 大核 2.4GHz），Android 12，USB 供电，`adb shell` 里的独立可执行文件（非 APK 进程）。每项 30 次、丢弃首次预热，**跑 3 轮取中位数**；`opt-level="s"` 的 release 构建。

**噪声说明**：手机并非空闲：后台常驻 Lark、番茄小说、Telegram 等，另一个并行 spike 也在用机器，`/proc/loadavg` 在 9~14 之间（8 核）。单次中位数最大波动约 ±15%（例如 det 960x448 的 4 线程三轮分别是 336 / 360 / 335 ms；det 640x640 的 4 线程第一轮 404 ms 明显受干扰，另外两轮 312 ms）。下表取 3 轮中位数；P95 是 3 轮各自 P95 的中位数。

| 项目 | 线程 | 中位数 ms | P95 ms | 备注 |
|---|---|---|---|---|
| det 960x448（截图缩放后尺寸） | 1 | 770 | 947 | 峰值 RSS 约 157MB |
| | 2 | 451 | 498 | |
| | 4 | 336 | 505 | P95 受后台负载拖高 |
| det 640x640 | 1 / 2 / 4 | 724 / 415 / 312 | 811 / 427 / 326 | |
| rec 48x320 | 1 | 190 | 195 | 峰值 RSS 约 54MB |
| | 2 | 105 | 112 | |
| | 4 | 70 | 92 | |
| rec 48x640 | 1 / 2 / 4 | 405 / 243 / 178 | 468 / 254 / 188 | RSS 约 67MB |

Session 创建耗时（中位）：det 约 100 ms，rec 约 200 ms（det+rec 合计约 0.3 秒，首次 OCR 要加上这一项）。

整图 OCR（det + 逐行 rec，同一进程里 det/rec 两个 Session 都加载，各 5 次整图计时）：

| 图 | 线程 | 整图中位数 | 说明 |
|---|---|---|---|
| shot 1080x2400（20 行） | 1 | 5.9 s | |
| | 2 | 4.0 s | |
| | 4 | **2.16 s** | 前处理 27 ms，det 约 330 ms，其余约 1.8 s 为 20 行 rec |
| simple 900x420（4 行） | 1 / 2 / 4 | 2.7 / 1.28 / 0.98 s | 1 线程受干扰偏高 |

峰值 RSS（`VmHWM`）：整图 OCR 约 205~211MB（含 7.7MB 的原图、det/rec 两个 Session、检测中间激活）；单跑 det 约 155MB，单跑 rec 约 54MB。其中 det 的 960x448 激活占大头，对大图分块检测时要注意。

**XNNPACK 对比**：做不了，这份 ORT 里没有（见第 1 节）。附带测了 NNAPI（4 线程，注册成功不报错）：

| 项 | CPU | NNAPI（已注册） |
|---|---|---|
| det 960x448 中位 | 334 ms | 332 ms |
| rec 48x320 中位 | 69 ms | 70 ms |
| Session 创建 det / rec | 约 100 / 200 ms | 258~821 / 345~369 ms |
| 峰值 RSS det / rec | 155 / 52MB | 190 / 87MB |

耗时一模一样，推断没有节点被 NNAPI 接管（模型是动态形状，NNAPI EP 不处理；没有查分配日志直接核实），却多付了约 35MB 内存与更长的创建时间。**NNAPI 对 PP-OCR 没有价值**，与决策 0002 里"NPU 现阶段不做"一致。

v4 对照（4 线程，960x448 det / 48x320 rec）：det 421 ms、rec 70 ms，比 v5 det（336 ms）慢，rec 相当。

## 5. 体积账
Rust 侧：`opt-level="s"`、`lto=true`、`strip=true`、`panic="abort"`、`codegen-units=1`，目标 aarch64-linux-android，cdylib：

| 构建 | 原始大小 | deflate |
|---|---|---|
| 空 cdylib（只导出一个函数，Rust std 基线） | 259,264 B | - |
| ort(load-dynamic，无 EP 特性) + 整套前后处理 | **410,200 B** | 217,938 B |
| 同上 + nnapi + xnnpack 特性 | 417,224 B | - |

即 ort + 前后处理在基线上只多约 0.15MB。so 的 NEEDED 只有 libdl、libc，PT_LOAD 为 0x4000 对齐。依赖 crate 解析到 16 个（ort、ort-sys、libloading、ndarray、num-*、tracing 等），许可证均为 MIT / Apache-2.0 / ISC；其中 libloading 是 ISC。

"随包 ORT + 按需下载 OCR 模型"体积表：

| 项 | 位置 | 原始大小 | 压缩后（deflate） |
|---|---|---|---|
| libonnxruntime.so（arm64） | 随包 | 22.25MB | 约 8.0MB |
| 视觉 AI 的 Rust 部分（ort + 前后处理，OCR 一项） | 随包 | 0.41MB | 0.22MB |
| 小计：APK 增量（so 不压缩 / 压缩） | 随包 | 约 22.7MB / 约 8.2MB | |
| sherpa JNI 或 c-api（做语音才需要，二选一） | 随包（可选） | 4.77MB / 4.47MB | 1.97 / 1.89MB |
| PP-OCRv5 det | 按需下载 | 4.82MB | 4.53MB |
| PP-OCRv5 rec | 按需下载 | 16.63MB | 14.10MB |
| 字典 | 按需下载 | 0.07MB | 0.05MB |
| 小计：OCR 模型下载 | | **21.5MB** | 18.7MB |
| cls（可选，文本行方向） | 按需下载 | 1.02MB | 0.93MB |

模型是 float 权重，deflate 几乎压不动（只省约 13%），下载包要按原始大小估。so 是否压缩取决于 `useLegacyPackaging`（见 media-ai 设计里的未决点）；这里按 22.25MB 与 8MB 两种口径都列出。

## 6. 三个结论
1. **"视觉类复用 sherpa 自带的同一份 ORT"——GO。** ORT 1.28.2 的 arm64 so 导出了 OrtGetApiBase，ort rc.14 的 `load-dynamic` 直接对接成功；与 sherpa c-api 同进程共用同一个 ORT 实例；PP-OCRv4/v5 的全部模型 Session 创建通过。
2. **ort 版本与对接**：`ort = { version = "=2.0.0-rc.14", default-features = false, features = ["std", "load-dynamic"] }`；运行时 `ort::init_from("libonnxruntime.so")?.build()?`，在 APK 里用裸名即可与 sherpa 共享。钉死版本（RC 有 API 变动风险）。不匹配时是运行期 `BadVersion`，可以优雅降级。
3. **PP-OCR 能跑，速度可接受**：4 线程识别一张 1080x2400 截图（20 行）约 2.2 秒，2 线程约 4 秒；按每行约 90 ms（4 线程）外推，一张文字很满的截图（50~60 行）约 5~6 秒（外推，未实测）。适合做"点一下识别、带进度条"的工具，不适合实时取景。耗时大头是逐行 rec，不是 det。

## 7. 对决策 0002 与 media-ai 设计的影响与建议
1. **决策 0002 成立，可以把"未验证"改成"已验证（见本报告）"**。口径不变：语音走 sherpa API，视觉走同一份 ORT。
2. **provider 链要改**：media-ai 里的 `["xnnpack","cpu"]` 不可用，这份 ORT 没有 XNNPACK。改为启动时用 `GetAvailableProviders` 探测，列出什么就能用什么；实际只剩 CPU。NNAPI 可注册但无加速、多占内存，默认不开。CPU 路径靠 ORT 自己的 MLAS（含 ARM NEON/点积）已经够用。想要 XNNPACK 只能自编 ORT（会换掉 sherpa 那份或再多一份，与"只带一份"冲突），不建议现在做。
3. **线程数默认值**：1→2→4 线程近似线性提速（det 770→451→336 ms），建议默认 4（与设计里 `min(4, 大核数)` 吻合），低电量/后台时降到 2。
4. **OCR 默认只带 det + rec，cls 做成可选**；字典随 rec 一起下载。先用 v5 mobile（21.5MB）；PP-OCRv6 tiny（det+rec 约 6.3MB）值得下一步评估体积与精度（small 约 31MB，比 v5 mobile 还大，不值得）。
5. **前处理要注意内存**：det 在 960x448 就占约 155MB 峰值，超长截图必须分块，不要整图送。
6. **sherpa 升级时加一条回归**：每次升 sherpa（即升 ORT）都跑一遍 OCR 端到端用例，防止新版 ORT 裁掉算子/provider 或次版本落后于 ort 的 api 特性（本次是 1.28 对 api-17，余量很大）。
7. media-ai 里"ort 动态加载要先做的技术验证"可以划掉，"sherpa 那份 ORT 的算子覆盖要拿真模型跑"也已覆盖（OCR 两套）；超分、抠图模型等其他视觉模型仍需各自验证算子。

## 8. 复现步骤
工程与产物都在会话临时目录 `spike-ort/`（下载、脚本、工程分开放）：
```sh
# 1) 取 ORT：aria2c 下 AAR，解压 jni/arm64-v8a/
aria2c -x16 -s16 -k8M --continue=true -d dl-aar -o sherpa-onnx-1.13.8.aar \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-1.13.8.aar
# 2) 构建（Windows 下 ANDROID_NDK_HOME 要写 Windows 路径形式）
export ANDROID_NDK_HOME='E:\sdk\android\ndk\28.2.13676358'
cd ortspike && cargo ndk -t arm64-v8a build --release
# 3) 推送并运行（Git Bash 里 adb 路径要 MSYS_NO_PATHCONV=1，本地路径用 C:/ 形式）
adb -s 7NQBB23606003715 push ortspike libonnxruntime.so models/ data/ /data/local/tmp/spike/
adb -s 7NQBB23606003715 shell 'cd /data/local/tmp/spike; export LD_LIBRARY_PATH=.
  ./ortspike info ./libonnxruntime.so
  ./ortspike probe libonnxruntime.so models/ch_PP-OCRv5_det_mobile.onnx 4 0
  ./ortspike bench libonnxruntime.so models/ch_PP-OCRv5_rec_mobile.onnx 1,3,48,320 30 4 0
  ./ortspike ocr libonnxruntime.so models/ch_PP-OCRv5_det_mobile.onnx models/ch_PP-OCRv5_rec_mobile.onnx models/ppocrv5_dict.txt data/shot.ppm 5 4 0
  ./ortspike share ./libsherpa-onnx-c-api.so'
```
子命令：`info`（版本/provider）、`probe <so> <model> <线程> <xnn>`、`bench <so> <model> <n,c,h,w> <次数> <线程> <xnn>`（xnn=0 不挂 EP，>0 为 XNNPACK 线程数，99 为 NNAPI）、`ocr`、`share`。测试图由 `gen_img.py`（Pillow + 微软雅黑）生成，ground truth 同目录。版本对照实验用 `--features api30` 重编。

实验用的 crate：ort / ort-sys 2.0.0-rc.14（MIT OR Apache-2.0）、libloading 0.9.0（ISC）、ndarray 0.17.2、num-complex 0.4.6、num-integer 0.1.47、num-traits 0.2.19（均 MIT OR Apache-2.0）、tracing / tracing-core 0.1.x（MIT）、smallvec 1.16.3、once_cell 1.21.4、pin-project-lite 0.2.17、matrixmultiply 0.3.11、rawpointer 0.2.1、cfg-if 1.0.5、autocfg 1.5.1。

## 9. 未解决问题
- **没有在 APK 进程里验证**：本次是 `adb shell` 里的独立可执行文件，用 `LD_LIBRARY_PATH` 找 so。APK 里 so 在 nativeLibraryDir、受命名空间约束，裸名 `dlopen` 理论上能与 sherpa 共享，但要在集成时用真 App 再确认一次；此外前台应用的调度与 shell 进程不同，耗时可能略有偏差。
- **耗时有噪声**：手机后台有负载，且并行 spike 在用，数字带 ±15% 波动；没有等到空闲机再测一遍。
- **只做了水平矩形框**：旋转/竖排文字、多边形 unclip、cls 方向分类没串；真实截图的复杂背景、小字号、低光拍照的识别质量没评估（只有合成图）。
- **整图耗时的外推**：50~60 行截图的 5~6 秒是按每行耗时外推的，没实测；rec 可以按宽度分桶批量推理来省时，没试。
- **PP-OCRv6、量化模型（int8）**未测，它们可能显著缩小体积与耗时。
- **ort 仍是 RC**：rc.14 昨天才发布，API 还在变（Session::builder 要传 Environment 就是新变化）；`ort-sys` 的版本与 api 特性对应关系依赖其文档。
- NNAPI"零节点被接管"是由耗时一致推断的，没有读分配日志。
- 许可证：RapidOCR 仓库标 Apache-2.0，但 PP-OCR 模型的原始许可（PaddleOCR，Apache-2.0）与字典文件的再分发条款上线前应再核一遍；本报告没有逐项核实。
- `docs/README.md` 索引里还没有这篇文档，需要在提交时按 docs-index 约定补上（本次按要求没有改其它文件）。
