---
title: 人像抠图模型普查与桌面实测（发丝更细的候选）
status: draft
updated: 2026-10-20
summary: 针对“MODNet 发丝不够细、有毛边”的候选模型普查（PP-MattingV2、RVM、BiRefNet 各变体、RMBG、ISNet、P3M-Net 等的体积/输入/许可/ONNX/MNN 风险），加 PP-MattingV2、RVM、BiRefNet-lite 的桌面 ORT 实测（7 张图、耗时、半透明占比、红/黑底对比图）与 MNN 转换结果；推荐先上 PP-MattingV2（w8 仅 9MB）接现有细化链，BiRefNet-lite 作质量上限对照，RVM 因 GPL 与非人物失败不推荐
---

## 1. TL;DR 与推荐

先说结论：**换个模型不会根治“发丝毛边”**，但有一个性价比很高的选择。

1. **推荐 A：PP-MattingV2（stdc1-human_512）**。PaddleSeg 仓库 Apache-2.0（权重单独许可未见声明，见第 6 节）。ONNX 约 36MB，MNN w8 只有 9.2MB，比 MODNet 还小。桌面 ORT 单张 0.07~0.14s（8 线程），MNN w8 桌面 0.13s，手机上大概率比 MODNet（1.1s）快（估计，未真机）。实测 alpha 比 MODNet 原始输出干净，外圈雾少，群像里没有 MODNet 那种“人与人之间镂空”，深色衣服也基本保住。
2. **推荐 B（质量上限对照，不一定上线）：BiRefNet-lite（Swin-T，44.4M 参数）**。MIT。边缘最利落、群像最干净；但 ONNX 224MB，MNN w8 仍 135MB，输入固定 1024×1024，桌面 ORT 要 10s，不符合“体积小”的基调，手机上基本不可用。

**2026-10-20 补充**：BiRefNet-lite@1024 真机推理峰值约 5.2GB 被系统杀掉。现成的低内存版只有社区重导出的 lite@512（studioludens/birefnet-lite-512），桌面实测内存降到约 1/3.4、预计真机约 1.4~1.6GB，仍比 PP-MattingV2 高一个数量级，详见第 10 节。

**不推荐 RVM**：GPL-3.0；对非人物（香蕉）直接失败；rvm1024 比 rvm512 更差，发丝处出现发白光晕。

**风险**：PP-MattingV2 导出的 ONNX 输入固定 512×512，我们是拉伸缩放进去再放大回原图，发丝细节上限就是 512 级。它比 MODNet 好是因为 alpha 更“干净”，不是因为更“细”。要真细，得 **模型 + 现有细化链（Blur-Fusion/引导滤波）串联**，用原图高分辨率信息来补，见第 7 节。

## 2. 现状问题

见 `docs/design/tools/matting.md`。用户反馈集中在：发丝外圈半透明“雾”、黑底上发丝泛米白、深色背景配深色衣服镂空、U2Net-p 发丝粗。真机 MODNet 1024×683 约 1.1s。

实测对照里 MODNet“强”档成品（对比图第 2 列）的特点：发丝处有一圈灰米色的雾（portrait-3 放大格最明显），这是引导滤波把周围背景色拉进来的副作用，不是模型本身的锅；原始输出（第 1 列）发丝糊成一片但没有这圈雾。

## 3. 候选普查表

“核实”= 我打开一手来源看到了；没打开的写“未核实”。各基准口径不同，别跨表硬比。

| 候选 | 体积/参数 | 输入 | trimap/背景图 | 发丝相关基准 | 许可 | 现成 ONNX | MNN 风险 | 手机 CPU |
|---|---|---|---|---|---|---|---|---|
| **PP-MattingV2-512** | 8.95M 参数，7.51 GFLOPs；ONNX 36MB，MNN w8 9.2MB（实测） | 默认 512×512；官方 deploy.yaml 按短边 512、32 倍数缩放，但 paddle2onnx 导出的 ONNX 是静态 512×512（实测） | 不需要 | PPM-AIM-195（PPM-100 + AIM-500 人像部分）：SAD 40.59 / MSE 0.0038 / Grad 33.86 / Conn 38.90（官方 README，核实，V100） | PaddleSeg 仓库 Apache-2.0（核实）；权重许可未单独声明 | 官方只发 Paddle 推理包；自己用 paddle2onnx 1.3.1 + paddlepaddle 2.6.2 转成功（实测） | 转 MNN 成功、无不支持算子（实测 w8，与 ORT 数值 mean abs diff 0.00025） | 未知（桌面 MNN 0.13s） |
| PP-Matting-512/1024 | 24.5M，91 GFLOPs | 512 / 1024 | 不需要 | PPM-AIM-195：512 SAD 31.56，1024 SAD 66.22（核实） | Apache-2.0 | 同上，未转 | 未测 | 未知，计算量约 V2 的 12 倍 |
| PP-HumanMatting | 63.9M，135.8 GFLOPs（2048²） | 大图 | 不需要 | PPM-AIM-195：SAD 53.15（核实） | Apache-2.0 | 同上 | 未测 | 太重，不考虑 |
| PP-HumanSeg | 未核实 | 未核实 | 否 | 分割，不出软 alpha（未核实） | 同仓库 Apache-2.0 | 未核实 | 未核实 | 未知 |
| **BiRefNet-lite**（Swin-T） | 44.4M；ONNX fp32 224MB、fp16 115MB（HF onnx-community，核实）；MNN w8 135MB（实测） | 固定 1024×1024（ONNX） | 不需要 | 通用 DIS 训练，无发丝专项指标；README 的 portrait 变体（SwinL）P3M-500-P S 0.983 / wF 0.989（核实） | MIT（核实） | 有（HF onnx-community、rembg 发布） | Swin 结构，MNN 转换成功无报错（实测）；数值与速度没测 | 桌面 ORT 10~12s，手机不可用 |
| BiRefNet portrait / general / matting（SwinL） | 参数量 README 未写；体积未核实 | 1024；HR 变体 2048；dynamic 版 256~2304（README，核实） | 不需要 | portrait：P3M-500-P S 0.983（核实） | MIT | 有 | 同上 | 不适合端侧 |
| **RVM MobileNetV3** | fp32 ONNX 14.3MB，fp16 7.16MB（releases 页，核实）；MNN w8 4.0MB（实测） | 任意分辨率，`downsample_ratio` 控制 | 不需要，但是视频模型（4 组循环状态） | 论文基准为视频，未核实 | **GPL-3.0**（核实） | 有（官方 release） | 转 MNN 成功（实测）；循环状态要自己喂 | 未知；桌面 0.27~0.72s（512）/ 1.0~1.9s（1024） |
| MODNet（photographic / webcam） | 现用约 25MB；其他权重体积未核实 | 固定尺寸 | 不需要 | PPM-100 数字未核实 | Apache-2.0（核实：代码、模型、demo） | 有 onnx 目录（核实），权重在 Google Drive | 已在用 | 现用 1.1s |
| ISNet / DIS（isnet-general-use） | 体积未核实 | 未核实（一般 1024） | 不需要 | 通用分割，非 matting | Apache-2.0（代码；DIS5K 数据集另有条款）（核实） | rembg release 有 | 未测 | 偏大，未评估 |
| InSPyReNet | 未核实 | 未核实 | 否 | 显著性检测，非 matting | MIT（核实） | 仓库未提（核实） | Res2Net/Swin，未测 | 未知 |
| RMBG-1.4 | 44.1M，fp32（核实） | 1024×1024 | 否 | 无 | **非商用，商用需与 BRIA 另签协议**（HF 卡，核实） | 有（含量化版，核实） | 未测 | 未知 |
| RMBG-2.0 | 0.2B（BiRefNet 架构，核实）；rembg 称约 1.02GB | 1024 | 否 | 无 | **CC BY-NC 4.0，商用需协议**（核实） | 有 | 未测 | 不适合 |
| MediaPipe Selfie Segmentation | 未核实（模型卡 PDF 抓不到文字） | 未核实 | 否 | 非 matting | 未核实 | 未核实 | 未核实 | 未核实 |
| SGHM | ResNet50 权重，体积未核实 | 未核实 | 否（两阶段，先出粗 mask） | 论文有 5 个基准，数字未核实 | 代码 MIT（核实）；权重条款未核实 | 仓库未提（核实） | ResNet50，未测 | 偏重 |
| P3M-Net | 未核实 | 未核实 | 否 | P3M-500 基准原论文，数字未核实 | 代码 MIT；P3M-10k 数据集与权重条款不明（页面未给全，核实） | 未提 | 未测 | 未知 |
| 需 trimap 的 FBA / ViTMatte | 未核实 | 需要 trimap | **需要 trimap** | 未核实 | 未核实 | 未核实 | ViTMatte 为 ViT，风险大 | 重，未评估 |

**关于“自动 trimap 串联”**：没有实测。思路是用 MODNet / PP-MattingV2 的 alpha 做膨胀腐蚀得到 trimap，再喂 FBA / ViTMatte。这两个模型都不小，ViT 的 MNN 转换风险高，不符合“体积小”的基调，本次不展开。我们现有的“Blur-Fusion + 引导滤波”实质上就是这条路线的轻量版。

**关于 antigravity**：第一阶段派给 antigravity 后，它只回了“正在调研”的进度话术，没有交付任何表格或数字，所以上表全部是我自己查一手来源完成的。

## 4. 桌面实测

**环境**：Intel Core i5-13500（14 核 20 线程），Windows 10，onnxruntime 1.31.0 CPU，`intra_op_num_threads=8`；每张预热一次，取 2 次最小值。新 venv `E:\venv\matting-probe`（onnxruntime、onnx、numpy、pillow、pymatting）；临时 `E:\venv\p2o312`（Python 3.12 + paddlepaddle 2.6.2 + paddle2onnx 1.3.1，仅用于把 Paddle 模型转 ONNX）。**项目里没加任何依赖。**

**测试图**：`E:\workspaces\arkli-verify\matting-refine\src\ArkliTest\*.jpg` 共 7 张（portrait-1/2/3、portrait-3-big、image-1-banana、image-2-group、image-3-darkbg）。

**预处理**：PP-MattingV2 拉伸到 512²、mean/std 0.5；BiRefNet 拉伸到 1024²、ImageNet 均值方差；RVM 按 downsample_ratio 让长边约 512 / 1024，并用第一遍输出的循环状态再跑一遍取第二遍。alpha 双线性放回原图尺寸。

**脚本**：`E:\workspaces\arkli-verify\matting-scripts\run_models.py`（跑模型）、`sheet_models.py`（出图与统计）。

**对比图**：`E:\workspaces\arkli-verify\matting-models\sheets\<图名>.png`，每张 6 列：MODNet 原始输出、MODNet“强”档成品（线上现状）、PP-MattingV2、RVM512、RVM1024、BiRefNet-lite。4 行：红底全图、黑底全图、发丝放大（黑底）、发丝放大（红底）。除“强”档成品外，其余各列都用 pymatting `estimate_foreground_ml` 估计的前景色合成，只比 alpha 好坏，不掺前景色污染。放大框取 BiRefNet alpha 在图上半部半透明最密的窗口。各模型原始 alpha 在 `E:\workspaces\arkli-verify\matting-models\out\<模型>\*.png`（RGBA）。

**数据**（7 张平均；半透明 = alpha 在 0.05~0.95 之间的像素占整图 %；淡雾 = alpha 在 0.02~0.25 之间占整图 %，越小说明边缘越利落、外圈雾越少；明细见 `sheets\stats.json`）：

| 模型 | 半透明% | 淡雾% | 桌面单张耗时（8 线程 ORT） |
|---|---|---|---|
| MODNet 原始 | 6.25 | 3.01 | 未测（真机 1.1s） |
| MODNet“强”档成品 | 4.65 | 2.25 | 同上 |
| PP-MattingV2 | 3.42 | 1.59 | 0.07~0.14s |
| RVM512 | 4.72 | 1.90 | 0.27~0.72s |
| RVM1024 | 5.37 | 2.11 | 1.0~1.9s |
| BiRefNet-lite | 3.27 | 1.37 | 10.0~11.9s |

注意：半透明占比低只说明“边缘利落”，不等于“发丝细”。BiRefNet 与 PP-MattingV2 的数字小，一部分是因为它们丢掉了最细的飞丝，所以数字必须配合肉眼判读。

**人工判读**（依据：红底放大格里发丝是否根根分明、外圈有无杂色雾、深色衣服是否镂空、群像是否误扣）

- **portrait-3（用户实测图）**：RVM512 细发丝最多、最“毛”，但外圈带灰雾；PP-MattingV2 发丝被抹成柔边，没有强档那圈米色雾，也没有 RVM 的碎纹；BiRefNet 边缘最干净、主发束清楚，但最细的飞丝基本丢了。**没有一个模型在这张图上做到“根根分明”**，比 MODNet 明显好的是“雾”少。RVM1024 在左上发丝处出现一块发白光晕，是明显劣化。
- **portrait-3-big（2048×3072）**：结论同上；PP-MattingV2 和 BiRefNet 因为固定缩到 512/1024，放大后更糊，发丝细节上限被输入分辨率卡死。
- **image-3-darkbg（深色背景 + 深色衣服）**：MODNet 衣服大面积镂空；PP-MattingV2、RVM512、BiRefNet 都基本保住衣服。BiRefNet 衣服左下有一块直角切边，PP-MattingV2 右侧有一条黑色竖带，各有各的错，但都比 MODNet 少“镂空”。
- **image-2-group（群像）**：MODNet 在两人之间镂空一块；PP-MattingV2 基本正常，左下多出一小块深色（疑似椅背，不确定算不算误扣）；RVM 发丝/耳边有拖影；BiRefNet 最干净。
- **image-1-banana（非人物）**：PP-MattingV2 与 BiRefNet 正常；**RVM 只抠出小半根**，基本不可用（人像专用）。
- portrait-1/2 没逐张细看，统计数字与上面一致，图在 sheets 目录。

**M1 类指标**：没跑。各列合成已统一用估计前景，再算 M1 没有意义；要比“成品”，得先把各 alpha 接进我们的 Blur-Fusion。

## 5. MNN 转换可行性

用固定提交 `478c10e` 的 MNNConvert（`scripts/mnn/mnnconv.py`，`--weightQuantBits 8`），三个都 `Converted Success!`，日志无“不支持算子”：

| 模型 | MNN w8 体积 | 备注 |
|---|---|---|
| PP-MattingV2 | 9.2MB | 桌面 MNN（8 线程，precision high）0.133s；与 ORT 对比 mean abs diff 0.00025，max 0.17（个别像素） |
| RVM MobileNetV3 | 4.0MB | 只验证转换成功，循环状态输入没跑 |
| BiRefNet-lite | 135MB | 只验证转换成功，没跑数值与速度；量化只覆盖部分权重，体积降得有限 |

产物在 `E:\workspaces\arkli-verify\matting-models\mnn\`。**真机耗时没测，PP-MattingV2 的 MNN 也只对拍了 portrait-3 一张。**

## 6. 许可风险

- **RMBG-1.4 / RMBG-2.0**：非商用（bria-rmbg 许可 / CC BY-NC 4.0），商用需 BRIA 协议。不要用。
- **RVM**：GPL-3.0，直接用等于要求 App 对应部分开源。建议绕开。
- **BiRefNet**：仓库与 lite 模型卡为 MIT；但 rembg 声明各权重“自带许可”，用其他权重前要逐个核对上游。
- **PP-MattingV2**：仓库 Apache-2.0，README 没单独声明权重许可，训练数据条款也没核，上线前再确认（未核实）。
- **P3M-Net**：数据集 Release Agreement 没看到全文，不明。
- **MODNet**：Apache-2.0，安全。

## 7. 下一步建议

“换模型”与“模型 + 现有细化串联”的取舍：**别单换，要串联**。

1. 先做“PP-MattingV2（w8，9MB）与 MODNet 并列/替换”的真机试验：量耗时与内存、确认 MNN 实机数值。
2. 它的 alpha 接进现有“Blur-Fusion + 引导滤波 + 对比度曲线”链。细化链用原图高分辨率补细节，是弥补其 512 输入的唯一出路；档位要重新调（它本身已更窄，“强”档可能过度）。
3. 若 512 固定输入在大图上仍嫌糊：评估用 paddle2onnx 的 `--input_shape_dict` 导出动态尺寸，或分块推理（本次没试）。
4. BiRefNet-lite 只当质量对照，不建议上端。
5. **先修我们自己的前景色估计**（主会话复核对比图时发现，2026-10-20）：`sheets/portrait-3.png` 第 3 行黑底发丝放大里，已上线的“MODNet 强档成品”比 MODNet 原始输出（直接用原图像素合成）多出一层明显的米白雾。也就是说，黑底上发丝泛白主要来自 Blur-Fusion 前景色估计把浅色墙当成了发丝颜色，不全是模型的锅。换模型之前，值得先试：低 alpha 区域的前景色向内侧（高 alpha）邻域取色或限制亮度、或换 pymatting `estimate_foreground_ml` 的多级估计做对照。改动只在 Rust 细化链里，不换模型、不加体积。
6. 需真机验证：PP-MattingV2 的 MNN 耗时与内存、w8 对发丝的影响、与细化链串联后的观感。取消延迟方面它只有一次前向、没有循环可插取消检查点，无法中途打断，按项目约定上线时要在文档里写明。
7. 已接入实验（2026-10-20）：PP-MattingV2 与 BiRefNet-lite 以“实验”标签页接进抠图工具，待真机对比耗时、内存与观感，细节见 `docs/design/tools/matting.md` 的“实验模型”一节。

## 8. 来源清单

- PaddleSeg Matting：https://github.com/PaddlePaddle/PaddleSeg/tree/release/2.9/Matting 、https://github.com/PaddlePaddle/PaddleSeg/blob/release/2.9/Matting/README.md
- PP-MattingV2 推理包：https://paddleseg.bj.bcebos.com/matting/models/deploy/ppmattingv2-stdc1-human_512.zip
- PaddleSeg 许可：https://github.com/PaddlePaddle/PaddleSeg
- BiRefNet：https://github.com/ZhengPeng7/BiRefNet 、https://huggingface.co/ZhengPeng7/BiRefNet_lite 、https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/tree/main/onnx
- RMBG-1.4：https://huggingface.co/briaai/RMBG-1.4 ；RMBG-2.0：https://huggingface.co/briaai/RMBG-2.0
- RVM：https://github.com/PeterL1n/RobustVideoMatting 、https://github.com/PeterL1n/RobustVideoMatting/releases
- MODNet：https://github.com/ZHKKKe/MODNet
- DIS / ISNet：https://github.com/xuebinqin/DIS
- InSPyReNet：https://github.com/plemeri/InSPyReNet
- P3M：https://github.com/JizhiziLi/P3M
- SGHM：https://github.com/cxgincsu/SemanticGuidedHumanMatting
- rembg：https://github.com/danielgatis/rembg
- MediaPipe 模型卡（抓不到文字）：https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf

## 9. 未核实清单

- PP-HumanSeg、MediaPipe Selfie、SGHM、InSPyReNet、ISNet、P3M-Net、FBA、ViTMatte 的体积/输入/基准数字；MODNet photographic 与 webcam 的体积、PPM-100 指标；RVM 的 P3M/PPM 指标。
- BiRefNet SwinL 各变体的权重体积与参数量；BiRefNet-lite 在 P3M-500 / AIM-500 的发丝指标。
- PP-MattingV2 权重的单独许可与训练数据条款；P3M-10k 数据集条款。
- 手机 CPU 耗时除 MODNet 现状外全部未知；桌面 i5-13500 的 ORT 数字与手机 MNN 没有换算关系。
- portrait-1/2 未逐张判读；PP-MattingV2 的 MNN 仅对拍 1 张。

## 10. BiRefNet 低内存版本（2026-10-20）

起因：BiRefNet-lite（1024×1024，Swin-T）转 MNN w8 后 135MB，真机 STG-AL00 推理到第 21 秒时 App 峰值约 **5.2GB**（VmHWM 5,191,896 kB），被系统内存回收杀掉。同机 PP-MattingV2（512 输入）峰值约 326MB、约 2.1 秒。用户要的是：有没有现成的低内存版。

**一句话结论**：有，但只有一个半成品——社区把 BiRefNet_lite 重导出成 512 输入的 ONNX（`studioludens/birefnet-lite-512`，MIT）。内存能降到可能活下来的程度（预计真机 1.4~1.6GB），但离“小工具”的 300MB 档还差很远，效果也有掉点。官方没发布任何“lite + 512”的权重，也没有蒸馏版或更小骨干的版本。

### 10.1 普查（一手来源核对）

HF API 与模型卡核对过：ZhengPeng7 账号下共 16 个模型，全部 MIT。骨干只有 Swin-L 与 Swin-T 两种（Swin-T 仅 lite 系）。

| 模型 | 输入 | 骨干 | 权重体积（HF 文件） | 备注 |
|---|---|---|---|---|
| ZhengPeng7/BiRefNet_lite | 固定 1024 | Swin-T | 177.6MB（safetensors，fp32） | 我们现在用的 |
| ZhengPeng7/BiRefNet_lite-matting | 固定 1024 | Swin-T | 89.0MB（fp16 存） | 抠图微调，仍是 1024 |
| ZhengPeng7/BiRefNet_lite-2K | 2560×1440 | Swin-T | 未逐个核对体积 | 更高分辨率，方向相反 |
| ZhengPeng7/BiRefNet_512x512 | 固定 512（官方按 512 训练） | **Swin-L** | 444.5MB（fp16 存） | 官方的 512 版是大骨干，不是 lite |
| ZhengPeng7/BiRefNet_dynamic / _dynamic-matting | 动态 256~2304 | Swin-L | 444.5MB | 能跑小尺寸，骨干仍是 L |
| BiRefNet、-portrait、-matting、-HR 等其余 | 1024 或 2048 | Swin-L | 未逐个核对 | 更大，与目标相反 |

社区 ONNX（HF API 的字节数）：

| 来源 | 输入 | 骨干 | 文件 | 备注 |
|---|---|---|---|---|
| onnx-community/BiRefNet_lite-ONNX | 固定 1024 | Swin-T | fp32 224.0MB / fp16 114.5MB | 没有 int8/q4；我们手上的 model.onnx 就是它（字节数一致） |
| onnx-community/BiRefNet_512x512-ONNX | 固定 512 | Swin-L | fp32 940.4MB / fp16 473.5MB | 官方 512 版的 ONNX |
| **studioludens/birefnet-lite-512** | **固定 512** | **Swin-T** | **fp32 191.9MB / fp16 98.5MB** | base_model 写明 ZhengPeng7/BiRefNet_lite，**1024 训练的权重直接换 512 导出**；MIT；作者说是为浏览器 OOM 做的，“边缘质量与 1024 基准无差别”是他们自己的说法 |

- 官方 README 的 ONNX 一节提到：**opset-22 的原生 DeformConv 在内存和耗时上比旧导出方式改进很大**，建议用最新 ONNX。我们的 ONNX 是 opset 17（转换日志可见）。这是个线索，没验证（见 10.5）。
- 官方 README 里查不到任何手机端内存/耗时数据；只有 A100 上 ONNX 约 93.8ms（Swin-T）。studioludens 的卡片只说 1024 版在浏览器 WASM/WebGPU 里 `std::bad_alloc`，原因归结为 1024 下解码器的中间张量过大，与我们的现象吻合。
- 更小骨干（MobileNet/PVT/ResNet）、蒸馏版：没找到现成权重。antigravity 称官方 issue #235 作者回复“没试过蒸馏”，我没单独打开核对。

### 10.2 桌面实测

环境：i5-13500，ORT 1.31.0 CPU 8 线程；峰值内存用 Windows `PeakWorkingSetSize`（同一方法量基线）；测试图为 ArkliTest 的 7 张。脚本：`E:\workspaces\arkli-verify\matting-scripts\bench_lowmem.py`、`mnn_peak.py`、`sheet_lowmem.py`。

| 方案 | ORT 首次推理峰值 | ORT 单张耗时（中位） | MNN w8 桌面峰值 | 按 0.74 换算真机 |
|---|---|---|---|---|
| lite@1024（基线，现状） | 7,283MB | 10.9s | 7,054MB | 5.2GB（实测，校准点） |
| **lite@512（studioludens）** | **2,047MB** | **2.3s** | **2,171MB**（memory low 模式 1,857MB） | **约 1.6GB（memory low 约 1.4GB）** |
| 大骨干@512（官方 512） | 2,811MB | 7.3s | 4,019MB | 约 3.0GB |

- ORT 的“峰值”会随连续跑多张图涨（1024 基线跑完 7 张涨到 11.9GB），是内存池只增不还，上表用的是首次推理，才可比。
- 换算系数 0.74 = 真机 5.19GB ÷ 桌面 MNN 1024 峰值 7.05GB，只有一个校准点，只能当数量级。桌面 MSVC 的 MNN 没有 ARM 内核，实际分配可能不同。
- 内存只降到约 1/3.4，不是理想的 1/4；模型本身与固定开销没跟着缩。
- MNN 桌面耗时不可参考（文档里早说过 MSVC 无 AVX 分发）；ORT 的耗时倍数 4.7x 可作参考，但手机耗时未知。

### 10.3 MNN 转换

用现有方式（固定提交 478c10e 的 MNNConvert.exe，`--weightQuantBits 8`）：

| 产物 | 体积 | 结果 |
|---|---|---|
| lite512_w8.mnn | **91.3MB** | 转换成功，无不支持算子；只有与 1024 版相同的 Resize“empty input”提示 |
| large512_w8.mnn | 493.1MB | 转换成功 |

产物在 `E:\workspaces\arkli-verify\matting-models\mnn\`。w8 对 ORT 的 diff rate：lite512 1.7%，大骨干 1.9%，1024 版 3.0%（工具门槛只适用 fp 模型，量化模型要看任务效果）。

### 10.4 效果（7 张，对比图）

对比图：`E:\workspaces\arkli-verify\matting-models\sheets-lowmem\*.png`，列为 MODNet raw / MODNet 强档 / PP-MattingV2 / lite1024 / lite512 / 大骨干512，行为红底、黑底、发丝放大（黑/红）。逐张判读了 portrait-3、image-2-group、image-3-darkbg，其余 4 张只看了统计。

- **portrait-3（发丝）**：lite512 与 lite1024 发丝差别很小，比 PP-MattingV2 利落。
- **image-2-group（三人）**：lite512 与 lite1024 都很干净，没有 MODNet 的镂空。
- **image-3-darkbg（黑外套配深色背景，难例）**：**lite512 把外套整块丢了**（只剩脸、领口一条三角），lite1024 丢一半，PP-MattingV2 丢右肩，**大骨干512 最完整**。这是 512 降分辨率最明显的伤。
- 半透明占比（越低越“干净”，不等于越好）：lite1024 3.27%、lite512 3.57%、PP-MattingV2 3.42%、大骨干512 4.01%。

### 10.5 推荐与风险

1. **想保留 BiRefNet，就换 lite@512 并在 memory low 模式跑**：预计真机峰值约 1.4~1.6GB，MNN 产物 91MB，输入固定 512。能不能活要看低端机；STG-AL00 本身 5.2GB 才被杀，说明机器内存不小，1.5GB 大概率能跑，但换到 4GB 以下的机器风险仍大。**必须真机实测，别信这个换算。**
2. 不推荐大骨干 512：真机约 3GB、产物 493MB，空间和内存都超标，只在难例上略好。
3. 如果目标是“小工具”的内存档（几百 MB），BiRefNet 没有现成答案，继续用 PP-MattingV2 + 细化链仍是更合适的主力；BiRefNet-lite@512 只适合当“高质量慢速档”，并且要在 UI 上标明耗时和内存。
4. 风险：lite@512 是 1024 权重硬降 512 导出，没有为 512 重训，难例（深色配深色）会退化；`studioludens` 是个人账号，MIT，需要在许可清单里记来源。

### 10.6 未核实项

- 真机上 lite@512 的实际峰值与耗时（全部是换算）；MNN 的 memory low 模式在手机上的效果。
- opset-22 原生 DeformConv 导出能否进一步省内存，以及 MNN 固定提交是否支持该算子：没试（环境里没有 PyTorch，也没导出）。
- 其它分辨率（384/448/768）的 lite 导出：没有现成权重，要自己用 PyTorch 导出，没做。
- antigravity 给出但我没有逐项打开核对的：anakhiu/birefnet-onnx-int8（301MB，大骨干 int8，许可未知）、rembg 各 release 文件体积、T8RIN/imagetoolbox-models 的内存评论、GitHub issue #19/#70/#235 的原话。另外它预测的“降到 500~800MB”被实测推翻（约 2GB 桌面、约 1.5GB 真机）。
- lite@512 对 image-1/portrait-1/2/3-big 四张只看统计，没逐张判读。
