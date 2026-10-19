---
title: 抠图（人像 / 通用）
status: active
updated: 2026-10-19
summary: 本地抠图工具：MODNet 人像与 U2Net-p 通用两个 MNN 模型、选型依据与真机数据、边缘细化（引导滤波 + 前景色去污染）、native.ai.matting 协议、取消限制、模型许可与已发布的 release、已知局限与待办
---
## TL;DR
- 新工具 `matting`（图片类，AI 标签）：选图 → 本地模型出 alpha → 合成**带透明通道的 PNG**；页面棋盘格预览，可选透明 / 纯白 / 自定义底色，保存 PNG（透明）或 JPG（带底色）、分享。
- 两个模型各是一个提供者（与 NLLB / Qwen 各自一个提供者的做法一致）：`local-matting-portrait`（MODNet fp32）、`local-matting-general`（U2Net-p f16）。页面的「人像 / 通用」标签页就是在切提供者，与右上角模型选择器共用同一个选择值。
- **模型 release 已发布**：单包 zip 已上传各自 release（`matting-modnet-mnn-fp32-1.zip`、`matting-u2netp-mnn-f16-1.zip`），线上回验通过，见 [模型下载管理](../model-download.md)「单包安装」。真机验证走 `scripts/device-push-models.sh` 推送。
- 一次前向无法中途打断：取消最迟约 0.5~0.8 秒后生效（实测 0.5 秒）。
- **边缘细化（2026-10-19）**：输出 PNG 的 RGB 不再是原图像素而是去污染后的前景色，alpha 也经引导滤波收紧，发丝换底色不再发亮发色边，见下文「边缘细化」。

## 选型与模型
| | 人像 MODNet | 通用 U2Net-p |
|---|---|---|
| 清单 id / 目录 | `matting-modnet-mnn-fp32` / `models/matting-modnet-mnn-fp32` | `matting-u2netp-mnn-f16` / `models/matting-u2netp-mnn-f16` |
| 文件 | `modnet512_fp32.mnn` | `u2netp_f16.mnn` |
| 字节 / gzip -9 | 25,886,772 / 23,946,676 | 2,394,164 / 2,164,557 |
| sha256 | `290f093b…99e900c1` | `9ccd77f5…2a34d8f2`（完整值见 `models.json`） |
| 输入输出 | `input` 1×3×512×512 → `output` 1×1×512×512，值域 0~1 | `input.1` 1×3×320×320 → `1959`（最后融合的 d0） |
| 前处理 | `(v-127.5)/127.5` | `v/max(全图)` 再 ImageNet mean/std |
| 后处理 | 夹到 0~1 | min-max 归一化 |
| 真机（STG-AL00，4 线程） | 约 724 ms，RSS 约 238MB（调研数据） | 约 611 ms，RSS 约 200MB（调研数据） |

- 选型结论（调研）：量化（w8 / w8a / f16 的 MODNet）不提速，所以人像用 fp32，通用用 f16（体积 2.4MB）。MODNet 在深色背景配深色衣服时会镂空；U2Net-p 的人像发丝很粗，所以拆成两个模式。PP-MattingV2、BiRefNet-lite **未评估**。
- 前后处理以 `native/mnn/.work/convert/matting-tools/{prep,eval}.py` 里已与 ORT 对拍的为准；缩放用 PIL 同款抗锯齿 bilinear（`arkli-ai::clip::resize_rgb`），alpha 用同一套系数缩回原图尺寸。
- **许可与来源**：两个模型代码与权重都是 Apache-2.0（MODNet：ZHKKKe/MODNet；U²-Net：xuebinqin/U-2-Net）。ONNX 权重来自**第三方转存**：MODNet 取自 Hugging Face `Xenova/modnet`，U2Net-p 取自 rembg release 的 `u2netp.onnx`，**未与官方权重逐字节核对**。随包说明在 `scripts/mnn/data/matting-{modnet,u2netp}/`（`NOTICE.txt` + `LICENSE-Apache-2.0.txt`），每个模型 release 三个文件：模型、NOTICE、LICENSE。

## 分层
- Rust：`arkli-ai::matting`（`Matter<G: GraphSession>`：缩放 → 归一化 → 单次前向 → alpha → 缩回原图尺寸 → 边缘细化，交出 8 位 alpha 与前景色 RGB；取消令牌）、`arkli-ai::matting_refine`（边缘细化，纯函数），`MnnRuntime::load_matter`；`arkli-ffi::matting`（`matting_load(lib, mode, model_path, threads)` / `matting_run(mode, w, h, rgb, refine)` / `matting_cancel()` / `matting_unload(mode)`，两个模式各一个槽位）。
- Kotlin（`com.let188.arkli.ai`）：`MattingMode`、`AiMattingPolicy`（参数、尺寸收敛、结果 JSON）、`MattingService`（`AiHeavyGate`、懒加载、指纹重载、解码、合成、PNG 编码写盘）、`LocalMattingProvider`（每个模式一个实例，实现 `MattingEngine` 与 `AiSessionControl`）、`AndroidMatting.kt`（UniFFI 桥与单例）。
- Web：`web/src/tools/matting/`（`index.vue` + `logic.ts`），`aiMatting(path, mode, signal?)`。

## 桥协议 `native.ai.matting`
- 请求 `{ provider?, path, mode: 'portrait' | 'general' }`；`mode` 必填，`provider` 可省，给了必须与 `mode` 对应，否则 `BAD_PARAMS`。`aiInvoke('matting', { path, mode }, { entry })` 同形。
- 结果 `{ path, width, height, mode, elapsedMs, inferMs, refineMs, modelId }`：`path` 是 `cache/out/matting_<mode>_<随机>.png`（RGBA PNG，随缓存清理回收）；大图解码后最长边收敛到 **3072**（`AiMattingPolicy.MAX_EDGE`，Rust 上限 4096），宽高是这张 PNG 的尺寸；`inferMs` 含 Rust 侧缩放、前向、alpha 缩回与边缘细化，`refineMs` 是其中细化那段。原图自带透明度的与抠图 alpha 相乘。**没有单独返回 alpha 蒙版**（页面用透明 PNG 铺底色即可）。
- 错误：`BAD_PARAMS`（path / mode / provider 不合法、路径不是缓存图片）、`NOT_READY`（模型未安装或未校验）、`INTERNAL`、`CANCELLED`。

## 取消
- 一次前向没有循环可插检查点。Kotlin 在预处理前、推理前、合成前各检查协程取消；Rust 在预处理前、前向前、后处理前与后处理按 256 行分块检查令牌，抛 `Cancelled` → `CancellationException` → 桥回 `CANCELLED`。**推理已经在跑时只能等这次前向结束**：4 线程最长约 0.6~0.8 秒。
- 取消后会话保留，下一次调用正常运行（Rust 每次调用换新令牌；单测覆盖“取消后再跑”）。页面点取消后立刻放开按钮，可马上重新开始；旧调用的收尾用序号隔离。

## 真机实测（2026-10-19，STG-AL00，debug 包，4 线程）
- 7 张测试图 × 2 模式全部跑通。1024×683：首次 1424 ms（含加载），之后约 1071 ms（推理段 911 ms）；1280×1707：1702 ms；通用模式比人像约快 150~200 ms。4000×3000 大图收敛到 3072×2304：人像 2687 ms、通用 2564 ms，无 OOM。
- 进程 RSS：基线约 202MB，人像加载并跑一次后约 353MB（峰值 410MB），两个模型 + 大图后约 440MB（峰值 519MB）。
- 与桌面 ORT 参考 alpha 对拍（同一图、同前后处理、alpha 缩到原图尺寸）：人像 mean 绝对差 ≤0.0011，>0.05 的像素占比 ≤0.1%（apollo、einstein），其余图 max ≤0.04；通用 mean ≤0.0077，占比 0.005%~3.7%（einstein 最大，max 0.63，f16 加 min-max 对边缘敏感）。**curie 人像在桌面 MNN 对 ORT 的对拍里有 6.7% 像素差 >0.05**（真机未复现），原因是 MODNet 对输入扰动本身敏感：对 ORT 的输入加 ±1 灰度噪声，同一张图就有 20% 像素变化 >0.05。所以容差口径是“均值差 <0.01、边缘个别像素允许大差”，不要求逐像素一致。
- 取消：发起后 0.35 秒发 `native.task.cancel`，取消应答后约 0.5 秒收到 `CANCELLED`；紧接着再跑一次正常出图（1660 ms，会话未重载）。
- 页面（debug 包，深色主题）渲染：标签页、模式说明、原图占位、底部动作栏正常，模型已就绪时无缺模型提示条。选图 → 出图 → 换底色 → 保存/分享的页面交互**未在真机逐步操作验证**（原生选图页需要手点），桥与结果文件已验证。
- 对拍脚本：`scripts/mnn/eval_matting.py`（桌面 MNN 真库对 ORT）；真机输出对拍与拼图脚本在会话临时目录，未入库。

## 边缘细化
- **成因**：① 模型只在 512（人像）/ 320（通用）上推理，alpha 放大回原图后发丝边缘又软又糊；② 半透明边缘的 RGB 若仍是原图像素，里面混着原背景色，换到绿 / 黑 / 白底就发亮、发色边（白底拍的人像换黑底最明显，发丝一圈灰白光晕）。
- **算法**（`arkli-ai::matting_refine`，自写，无新依赖，全部在原图分辨率上跑，模糊在 1/s 低分辨率上做，`s = round(长边 / 512)`）：
  1. alpha：以原图灰度为引导的快速引导滤波（He 2015，box 滤波，低分辨率估系数再双线性放大），只在“不确定带”（alpha 3~252）向外扩一圈的区域内生效；再过对比度曲线（线性拉伸 `[lo, hi]` 夹断两端，按比例混入 smoothstep）收紧半透明带。
  2. 前景色：Blur-Fusion（单遍）。`F_blur = blur(I·α)/blur(α)`、`B_blur = blur(I·(1-α))/blur(1-α)`，再 `F = F_blur + α(I - αF_blur - (1-α)B_blur)`；只对半透明像素算，alpha 为 0 / 255 的像素直接用原图。输出 PNG 的 RGB 用 F，**straight alpha（非预乘）**，PNG 编码本来就是非预乘，页面（`<img>` / canvas）与保存路径无需改动，单测用 ImageIO 读回断言像素 RGB 等于引擎给的 F。
  3. 单遍而非论文的两遍：试过两遍（大半径 + 小半径），与 pymatting 参考比并不更好，一遍大半径（长边/30，夹 8~96）更省一半扫描。半径要够大，因为模型的 alpha 往外晕得宽，窗口里要有足够的纯前景像素。
- **参数与留口**：`RefineStrength { Off, Light, Standard, Strong(默认) }`（`matting_run` 的 `refine` 参数，Kotlin `MattingRefine`，桥参数 `refine?: 'off'|'light'|'standard'|'strong'`，缺省 `strong`，非法值 `BAD_PARAMS`）。**页面（抠图页）有四档分段控件「边缘细化：关 / 轻 / 标准 / 强」，默认“强”**，档位记在 localStorage；已经出过图时切档自动重抠（正在抠先取消再重跑），没出图只记住；**细化强度只放抠图页，不进 AI 中心（用户拍板）**。各档（引导滤波 eps / 曲线下端 / 上端 / smoothstep 混合比）：Light 4e-3 / 0.03 / 0.97 / 0；Standard 1e-3 / 0.06 / 0.94 / 0.5；Strong 4e-4 / 0.12 / 0.90 / 1.0；Off 等同旧行为（alpha 不变、F 即原图、`refineMs` 为 0）。引导滤波半径 `长边/150` 夹 3~24。**默认改为强（2026-10-19，用户拍板）**：依据是同日桌面对比 13 组样本，强档半透明像素占比比标准低约 30%~70%（用户实测人像 portrait-3 由 7.7% 降到 5.2%），发丝未见被削；对比图在 `E:\workspaces\arkli-verify\matting-refine\sheets\all.standard-vs-strong.png` 与 `hair-zoom.standard-vs-strong.png`。页面小字提醒“太强可能削掉极细的发丝，可以往回调”。
- **性能**：全分辨率只有几遍线性扫描（整数累加 + 只对半透明像素做浮点），任务按 64 行切块、多线程**动态领取**（最多 8 线程；静态分块在大小核混合的 SoC 上会被慢核拖住，实测 4 线程静态分块反而比 1 线程慢）。真机 STG-AL00，2048×3072（6.3MP）：1 线程 645 ms，4 线程 290~350 ms，8 线程 约 250 ms（桌面 harness 实测）；经 App 全链路实测 `refineMs` 141~187 ms（小图 84~167 ms）。目标“3072 长边 ≤ 300 ms”达成。内存：峰值 VmHWM 约 579MB（两个模型 + 全部测试图的累计峰值，上一版 547MB），多出的是 RGB 前景色一份（3072² 约 28MB）与传输拷贝。
- **指标**（桌面 `venv` 里装 pymatting 仅作评测，不进项目依赖）：对 alpha∈(0.05, 0.95) 的像素，以 `estimate_foreground_ml(I, 自身 alpha)` 为理想前景。M1 前景色偏差（0~255 平均绝对差）、M2 三底色（绿 / 黑 / 白）合成偏差、M3 黑底亮度偏差（正 = 发亮）、band 半透明像素占比。12 张（6 图 × 2 模式）均值：M1 45.9 → 19.5，M2 13.8 → 6.4，|M3| 12.6 → 4.0，band 6.1% → 4.4%。人像三张：M1 61.8/47.0/61.8 → 16.2/18.2/19.9。逐图数据与对比图在 `E:\workspaces\arkli-verify\matting-refine\`（`old/` `new/` 的 `metrics.json`、`sheets/`）。
- **取消**：细化阶段每波（线程数 × 64 行）之间检查令牌，抛 `Cancelled`；单测覆盖“分块检查”“细化阶段取消后可再跑”“结果与线程数无关”。真机：前向中取消约 0.15 秒内返回 `CANCELLED`，取消后立刻再跑正常。
- **局限**：① 暗背景配暗衣服的镂空是模型 alpha 的问题，后处理救不了（image-3-darkbg 肩部不变）；② 引导滤波用灰度引导，发丝与背景亮度相近时贴不准；③ 极细发丝若模型 alpha 本身为 0 则无从找回，Strong 档会削弱 alpha<0.12 的细丝；④ 源图是 JPEG 时 8×8 块效应放大 300% 后可见，前景色估计会继承；⑤ 单遍大半径在前景与背景颜色都很杂的边缘可能略偏向邻近前景色。

## 已知局限与待办
- MODNet 深色对深色会镂空；U2Net-p 发丝粗；两者都不是通用高精度分割。待评估 PP-MattingV2、BiRefNet-lite。
- 边缘细化四档的默认已改为“强”，真机已验（`a09cbbd`）；已出图时切档自动重抠仍待手点。浅色背景加头发高光时前景去污染洗不干净（黑底发丝泛米白）是算法上限，另起一项。
- 大图会被收敛到 3072 再抠，成品不是原分辨率。
- `native.media.preview` 尚未实现，页面预览用现有 `native.image.preview`（透明）或 `previewBlob`（带底色）。
- 证件照页（`id-photo`）仍读旧的 `native.ai.status` 桩 `matte`，可后续改接本任务（`mode: 'portrait'`）。
- `components.d.ts` 由构建插件生成，随构建变化。
