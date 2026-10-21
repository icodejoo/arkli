---
title: logo 专用小模型调研（第二轮）
status: draft
updated: 2026-10-20
summary: 现有模板排版效果差，第二轮调研能真画出 logo 主图形的端侧小模型：SDXS-512 一步扩散+vtracer、Qwen 小模型 LoRA 写 SVG/图元、程序化合成三条路线；含候选表、许可风险、spike 顺序与 antigravity 被否定说法；含三轮桌面质量对比（SDXS 只出符号 + App 画容器 + 质量闸门：严标准可用 37.5%、2/3 行业有图；SDXS int8 真机 4 张 32.5 s、峰值 1.3GB 达标；B 测试机跑不动；C 否定）
---
# logo 专用小模型调研（第二轮）

上一轮见 [端侧 logo 生成：模型与方案调研](logo-generation-on-device.md)，本文只写新候选与新事实。
标注约定：**[一手]** = 已打开 HF 模型卡 / 官方仓库 / arXiv 页面核对；**[推断]** = 我的推算，不是数据；**[未核]** = 没能核到；**[否]** = antigravity 的说法被否定。
排名标准（按用户反馈）：先看“能不能真的生成主图形本身”，只改排版/配色的方案单列一类，不进前列。

---

## 1. TL;DR

用户的四条抱怨：图形单调、排版呆板、配色难看、整体不像 logo。下面按“能否生成图形本身”排：

| 排名 | 路线 | 一句理由 | 主要风险 |
|---|---|---|---|
| 1 | **SDXS-512 一步扩散（只出无字图形）→ vtracer 描矢量 → 本地字体叠字** | 目前唯一“真生成新图形”且体积可控的路：UNet 约 0.32B、1 步、diffusers 标准 SD 管线（MNN 现成 SD 导出脚本大概率能用，[推断]）；权重公开、openrail++ 可商用 | ① 没有任何 SDXS 手机端耗时数据，STG-AL00 上单张可能是几十秒到分钟级 [推断]；② 没有 logo 风格版本，SDXS 训练码不开源，自训 logo LoRA 几乎走不通；③ 一步出图的质量/能否描成干净矢量**完全未验证**，必须先做桌面质量 spike |
| 2 | **Qwen3.5-0.8B（或更小）LoRA，直接写“简化 SVG / 图元 DSL”，数据全用可商用图标库（含彩色扁平 Fluent Emoji、Tabler filled、Phosphor duotone）** | 图形来自模型而非模板；训练便宜（单卡消费级，量级 [推断]）；MIT/ISC 数据无版权雷；已有 0.8B 的 MNN 管线，零新运行时 | ① 输出多半是“训练集图标的混合/记忆”，新颖度有限；② 彩色/填充图标路径很长，17 tok/s 下一张要几十秒；③ 若只用 Lucide 这类线性 UI 图标训练，等于把现有“线性 UI 图标”问题换个方式再来一遍；④ 公开先例都没做评测（见 3.2） |
| 3 | **程序化图形合成（无新模型）：首字母/字形印记 + 几何容器 + Path.op 布尔运算 + 多色图标库，由 Qwen 只挑参数** | 能直接缓解“图形单调”和“不像 logo”（monogram、负空间、字图相融是真 logo 常见做法），零体积、秒出、可矢量 | 它是“拼装”不是“生成”；设计感取决于人写的规则，和现有模板路线同源，**不能当 AI 专用模型的替代叙事** |

**单列：只改排版/配色的方案（不进前列）**：中文语义检索选图标（bge-small-zh）、Skia/JS 矢量艺术字变形、配色生成。它们只解决“排版呆板/配色难看”，不解决“图形单调/不像 logo”。

**直接否掉的**：FontDiffuser（仅限非商业研究）、DG-Font（仓库无许可证、字体来源方正非商用）、OmniSVG/InternSVG 一类 7B+ 模型（体积 + 训练数据 NC）、SnapGen/SnapGen++（权重未见公开）。

**对四条抱怨的覆盖**（详见第 5 节）：路线 1 主要解决“图形单调”，视风格可能带来“像 logo”；路线 2 解决“图形单调”的一部分；路线 3 解决“图形单调 + 不像 logo”的一部分。三条都**不自动解决排版和配色**，要配单列类里的排版/配色改进。

---

## 2. 对上一轮文档的更正

- 上一轮写“Logo.Redmond 只有 SDXL 版本，不能挂 SD1.5”——**不对**。HF 上有 SD1.5 版：`artificialguybr/logo-redmond-1-5v-logo-lora-for-liberteredmond-sd-1-5`，base_model = runwayml/stable-diffusion-v1-5，触发词（示例提示词里出现）`LogoRedAF`，许可 `other (bespoke-lora-trained-license)`，LoRA 文件 `LogoRedmond15V-LogoRedmAF-Logo.safetensors`，仓库 usedStorage 约 27.2MB（含 6 张示例图）[一手 S11]。许可原文页面只给了外链，**商用条款未核**。
- HF 上的 SD1.5 系 logo LoRA/微调还有：SedatAl/Logo-LoRa(-1)、iamkaikai/amazing-logo-v5-lora、amazing-logos(-v4)、nicky007/stable-diffusion-logo-fine-tuned，许可标签均为 creativeml-openrail-m，下载量都很低（几十）[一手 S12]。训练数据来源均未核，质量未知。

---

## 3. 候选表

字段：参数量/体积 | 权重（链接） | 许可（权重 / 训练数据） | 输出 | 步数与已知耗时 | MNN/ONNX | logo 适配 | 中文 | STG-AL00 可行性 [推断]

### 3.1 方向一：极小/一步位图扩散 + logo 风格

| 候选 | 参数量/体积 | 权重 | 许可 | 输出 | 步数与耗时 | MNN/ONNX | logo 适配 | 中文 | STG-AL00 [推断] |
|---|---|---|---|---|---|---|---|---|---|
| **SDXS-512-DreamShaper** | UNet 约 0.32B（论文表3 319M，S3b；HF 安全张量 315,746,244 参数，F32，S2）；论文表1：SD2.1 版文本编码器 0.33B、自研轻量解码器 1.2M（S3b，注意是 SD2.1 版表格，DreamShaper 版以仓库 `vae`/`vae_large` 为准，**未核**）；仓库 usedStorage 约 3.3GB（含 fp32 与两套 vae，S2）；int8 后体积**无一手数据** | HF：https://huggingface.co/IDKiro/sdxs-512-dreamshaper（另有 -Sketch、-Anime(LoRA) 版，S4） | **HF 卡：openrail++**（S1）；GitHub 仓库代码：Apache-2.0（S4）。训练数据：卡片未列，只写教师 dreamshaper-8-lcm 与方法 score distillation + feature matching（S1） | 512² 位图 | **1 步**，CFG=0（S1）。论文：单张未标型号的 GPU，fp16 编译后 9ms（S3b）；桌面 CPU 参考：FastSD CPU 在 i7-12700 上 SDXS-512-0.9 一步 PyTorch 4.8s、OpenVINO+TAESD 0.82s（S29，x86，**不是手机**）。手机：**未知** | HF 仓库是 `StableDiffusionPipeline`（diffusers，S2），无 ONNX 文件；MNN 官方 SD 导出脚本是否直接吃它：**未验证**，但结构同 SD 家族，风险较低 [推断] | 通用画风，**没有 logo 版本**；仓库明说训练代码不会开源、只提供 LoRA 推理 demo（S4）；SD1.5 的 logo LoRA 不能直接挂（UNet 被剪枝，结构不同）[推断] | 英文 CLIP；中文须先由 Qwen 译成英文提示 [推断] | 内存可行（int8 UNet 约 0.3GB 量级）；**耗时是最大未知**：按 i7 数据外推到 ARMv8.0 级 4 个大核，单张可能在几十秒～分钟级，**仅为数量级推断** |
| SnapGen（Snap） | 379M（T2I），论文称比 SDXL 小约 7 倍（S5） | **未见公开**：论文页未声明发布（S5）；我没找到官方仓库，只有项目页 snap-research.github.io/snapgen（未打开）。结论：**未确认发布** | 无 | 1024² | 论文摘要：移动设备约 1.4 秒，**未写机型**（S5）；Snap 新闻稿写 iPhone 16 Pro Max（S6）。CPU：未知 | 无权重，无法转 | 无法评估 | 未知 | 不可用 |
| SnapGen++（Snap，DiT） | 论文页未给参数量（S7） | 页面未确认发布（S7） | 同上 | 少步（例如 4 步）| 摘要页没有任何延迟数字（S7） | 无 | 无 | 未知 | 不可用 |
| Nitro-E（AMD） | HF/GitHub 写“只有 304M 参数”指 DiT（S8,S9）；**文本编码器是 Llama-3.2-1B**，解码器 DC-AE 32× 压缩（论文 S10，经搜索摘要核到）。整条管线体积：无一手数据 | https://huggingface.co/amd/Nitro-E | DiT：MIT（S8）；文本编码器 Llama 3.2 社区许可（条款**未核**）；训练数据：约 2500 万张，含 Segment-Anything-1B、JourneyDB、FLUX 生成图（S9，许可混杂，**未逐项核**） | 512² | 20 步；distill 版 4 步（S8）；速度只有 MI300X 与 Strix Halo iGPU（512px 约 0.16s）数据（S8,S9），手机：未知 | 可导出但要拆 LLM 编码器 + DiT + DC-AE 三块，[推断] 工作量大 | 通用 | Llama 编码器中文一般 [推断] | 带 1B LLM 编码器，内存与耗时都不友好；不推荐 |
| aMUSEd-256 | 卡片：表格 803M、正文约 600M、安全张量 0.6B（口径不一致，S14） | https://huggingface.co/amused/amused-256 | openrail++（S14） | 256² | 约 12 步（S14）；手机：未知 | 非 UNet 扩散（MUSE 类），MNN 无现成管线 | 通用，256² 太小 | 英文 CLIP-L | 不推荐 |
| EdgeFusion（BK-SDM-Tiny+LCM，Nota AI） | 基于 BK-SDM-Tiny UNet | **没找到公开权重页**（S15 搜索） | 未知 | 512² | 论文称 Samsung Exynos NPU 约 1 秒（S15，NPU，与我们无关） | - | 通用 | - | 无权重，跳过 |
| **Logolabs/agate-preview-003**（新） | 192.1M 生成器 + 68.1M 文本编码器，用 TAESD 约 261M、用 SD-VAE 约 309.8M；repo usedStorage 约 2.72GiB（含多套权重，S13） | https://huggingface.co/Logolabs/agate-preview-003 ；仓库里已带 `webgpu/*.onnx`（generator_512 / text_encoder / taesd_decoder）（S13） | **MIT（代码+权重）**；文本编码器 Ettin-68M 微调（MIT）；训练数据 FLUX-Reason-6M（FLUX.1-dev 合成，Apache-2.0 数据集卡）（S13）。**FLUX.1-dev 生成图的下游许可争议未核** | 512²（也支持 256²），仅方形 | 默认 **50 步** Euler；**CPU 约 100 秒/张（卡片，机型未写，非手机）**；RTX 4060 约 2.9s（S13） | 有 ONNX，但架构是自研“planner + renderer”（引用 FCDM），算子风险 [推断] | **不是 logo 专用**（“logo”是厂牌名，训练数据是通用推理提示）；卡片自述文字渲染不可靠（S13）；2026-09-29 创建，成熟度低 | 仅英文（en 标签）| 261M 体积好看，但 50 步 + 自研算子，STG-AL00 上大概率过慢；**只作观察项** |
| SD1.5 + Logo.Redmond 1.5 LoRA + LCM/Hyper-SD | UNet 860M（S3b 表3）+ LoRA ≤27MB（S11） | 见第 2 节 | SD1.5：CreativeML OpenRAIL-M（上一轮已核）；LoRA：bespoke，**未核**；LCM-LoRA openrail++（上一轮已核） | 512² | 2~4 步，手机 CPU 未知 | 走 MNN 官方 SD 管线，有路 | 比 SDXS 更接近 logo 风格 | 英文 | 860M UNet × 2~4 步，STG-AL00 [推断] 明显比 SDXS 慢数倍；**高端机选项**，单独记 |

**先例缺口**：没有找到任何“SDXS（或同级小底模）+ logo/flat-icon LoRA”的公开成品（HF 搜索 `logo` + text-to-image 前 40 条里无 SDXS，S12）。所以路线 1 的“logo 风格”要么靠提示词硬压，要么自己蒸馏——后者在训练码不开源的前提下基本不现实。

### 3.2 方向二：文本生成 SVG 的小模型（≤约 1.5B）

| 候选 | 参数量 | 权重 | 许可（权重 / 数据） | 输出 | 耗时 | MNN | logo 适配 | 中文 | STG-AL00 [推断] |
|---|---|---|---|---|---|---|---|---|---|
| thesantatitan/Qwen2-0.5B-svg-SFT | 0.5B（F32，S16） | https://huggingface.co/thesantatitan/Qwen2-0.5B-svg-SFT（存在；注意 antigravity 给的链接重复了用户名，无效） | 卡片**未写许可**；基座 Qwen2.5-0.5B-Instruct；数据 deepseek-svg-dataset，标 5k 条（S16）；数据许可**未核** | SVG 文本 | 无数据 | Qwen2 架构 MNN 支持成熟 [推断] | 卡片自述目的“teach the model svg syntax”，**没有示例输出和评测**（S16）；5k 条训练量极小 | 继承 Qwen，但 5k 条 SVG 训练不涉及中文 [推断] | 速度没问题，效果大概率不可用 |
| thesantatitan/qwen3-0.6B-svg-sft | 0.6B | 仅在搜索结果里见到，未打开 | **未核** | SVG | - | - | 数据集 text2svg-stack-follow-constraints（搜索摘要）| - | 同上 |
| vinoku89/svg-code-generator | 0.6B（基座 Qwen3-0.6B，S17） | https://huggingface.co/vinoku89/svg-code-generator | Apache-2.0；训练数据**卡片未披露具体数据集**（S17） | SVG | 无数据 | Qwen3 系 MNN 已支持 [推断] | 无评测 | 未知 | 同上 |
| kaleidoscopicwhether/svg-gen-weights | 约 1.5B（由名称推断，卡片没写总数，S18），基座 Qwen2.5-Coder-1.5B-Instruct | https://huggingface.co/kaleidoscopicwhether/svg-gen-weights | **MIT**（S18）；数据：竞赛数据约 46k+45k 条；**卡片称加入 SVGX/OmniSVG 外部数据反而降分**（混合 76k 的 adapter 得 14.64，低于仅竞赛数据版）（S18） | SVG | 无数据 | - | 竞赛导向（评分指标未核），不是 logo | - | 1.5B 在 STG-AL00 上 [推断] 约 17 tok/s × 0.8/1.5 级别，一张图数十秒 |
| Norod78/gpt-fluentui-flat-svg（新） | GPT-2 架构，卡片显示 0.2B（F32+U8，S19） | https://huggingface.co/Norod78/gpt-fluentui-flat-svg | MIT（S19）；数据：微软 FluentUI 的 **flat emoji** SVG（Fluent Emoji 仓库为 MIT，S25） | SVG 文本，**无条件生成**（卡片没给文字提示格式，S19） | 无数据 | GPT-2 结构，MNN LLM 导出是否支持 **未核** | **“彩色扁平图形”正好是想要的风格**，但无条件生成、无评测、只有 3 张样例图（我看不到图） | 无 | 体积小，**是路线 2 最直接的公开先例**，值得做桌面 spike |
| dots.mocr-svg（新） | 3B（卡片 S20，GGUF 仓库文件名写 1.8B，口径不一致，**未核**） | rednote-hilab/dots.mocr-svg（镜像 S20） | MIT（S20） | **图像→SVG**，不是文字生成 | 无 | - | 只能“把图变 SVG”，可作 vtracer 的语义化替代，但 3B 太大 | - | 不可用（体积） |
| StarVector 1B | 上一轮已覆盖 | | Apache-2.0 | 图像→SVG | | | | | 不再展开 |
| SVGen（gitcat-404） | 最小 3B：SVGen-Qwen2.5-3B-Instruct、SVGen-StarCoder2-3B（3B），Llama-3.2-3B（页面显示 4B），Coder-7B（页面显示 8B）（S22 组织页）| https://huggingface.co/gitcat-404 | **许可未核**（页面未列） | SVG | - | - | - | - | 超 1.5B，不可用 |
| LLM4SVG | 论文页没写基座与规模；数据集 SVGX-SFT 约 58 万条指令数据（摘要）（S22） | 是否发布权重**未核** | **未核**；其 SVGX 数据与 MMSVG 的关系未核 | SVG | - | - | - | - | 不可用/未核 |
| Reason-SVG | 论文页没写规模；**CVPR 2026**（arXiv v2 页）（S22） | 未核 | 未核 | SVG + 设计推理 | - | - | - | - | 7B 级，不可用 |
| InternSVG | 论文页没写规模；**论文自身许可 CC BY-NC-SA 4.0**（S22）；数据 SAgoge 许可**未核**，建议当作非商用对待 | 未核 | **红色风险** | SVG | - | - | - | - | 不可用 |
| SVGThinker-7B / UniSVG | 7.6B / 7B 级（搜索结果）| featherless 镜像等 | 未核 | SVG | - | - | - | - | 不可用 |
| StrokeNUWA | antigravity 称 3B（Flan-T5-XL），**我没核**，反正 >1.5B | | | | | | | | 不可用 |

**结论**：HF 上 ≤1.5B 的“文字→SVG”公开权重，全是个人小训练（5k～46k 条），**没有一个带评测、示例或 logo 导向**。学术上有评测的都是 3B～8B（SVGen 3B 起、InternSVG、SVGThinker 7B），而 SGP-GenBench 一类工作自己的结论是“SVG 能力与通用编码能力强相关”（论文页摘要，S21）——这对 0.5～1.5B 不利。HF 搜索也确认没有 1B 级、带评测的 logo/icon SVG 模型（S23）。

### 3.3 方向三：自己在 Qwen3.5-0.8B 上用可商用数据做 LoRA

**基座核对**：Qwen3.5-0.8B，卡片写 0.8B（安全张量显示 0.9B），Apache-2.0，24 层，Gated DeltaNet 与 Gated Attention 混合，原生上下文 262,144，“需要最新 transformers”；**卡片没提 Unsloth / LLaMA-Factory 是否支持**（S24）。所以 antigravity 的“Unsloth 下 0.8B 约 6GB 显存、3 epoch 约 1.5～2.5 小时、总花费不足 5 元”**全部无出处**，且混合线性注意力架构的微调框架支持要先验证。

**可商用素材（一手核对）**

| 素材 | 数量 | 许可 | 风格 | 备注 |
|---|---|---|---|---|
| Tabler Icons | 6238（outline 5184 + filled 1054）（S25） | MIT | 线性为主，有 filled | **[否] antigravity 写“5,400+”**，实为 6238 |
| Phosphor（core） | 约 1,248 个图标（由类型定义示例推算，S25）；README 提 duotone 和按粗细分组，**“6 种粗细”页面未核** | MIT | 多粗细 + duotone（双层） | 数量为推算 |
| Fluent Emoji（微软） | 第三方转述 2022 年“超过 1500 个”，目录为 3D(png)/Color(svg)/Flat(svg)/High Contrast(svg)（S25，**官方页未能核到，来自搜索摘要**）；仓库许可 MIT（GitHub 页面）| MIT | **彩色扁平**，最接近“有设计感的主图形” | 官方 README 没写数量/风格，需自己 clone 点数 |
| Game-icons.net | 约 4180（由作者表数字相加，S25） | **CC BY 3.0，需署名**；页面没明说商用，条款以许可原文为准 | 黑白剪影，徽章/奇幻感强 | 训练出的模型是否构成“衍生作品”要署名，法务风险中 |
| Simple Icons | “3400+”品牌图标（S25） | CC0-1.0（仓库标注），**但要求读法律免责声明，品牌商标不属于 CC0** | 单色品牌 logo，最像真 logo | 用品牌 logo 训练可能让模型吐出别人的商标，**建议不用或仅作风格参考** |
| Lucide | 现有 180 个已入库；总数上一轮写 1600+（本轮未复核）| ISC | 线性 | 现有素材，不新增风格 |

**数据量与分词的现实问题**（[推断]）：
- 各库按概念去重后，独立“概念”远少于 antigravity 说的 12,000～15,000（那是把粗细/变体/多库同名图标都算上了，**该数字无出处**）。
- 难点不在条数，而在 **token 长度**：线性图标一张约几十到几百 token，**彩色扁平 emoji 的 path 常常上千 token**（Norod78 的卡片说明其 SVG 全是独立 path 元素，S19，长度未给）。按已知 17 tok/s，1000 token 约 1 分钟。antigravity 的“4～7 秒出图”只适用于最简单的线性图标。
- 解决办法是不让模型写原始坐标，而是写“图元 DSL”（圆/矩形/圆弧/多边形/布尔组合 + 颜色 + 变换），由代码展开成 path。这样每张约 50～150 token，但**需要把现有图标重新拟合成图元**，这一步很重，训练数据要自己造。

**效果预期**（[推断]，无一手评测）：对训练分布内的概念，模型更像“图标检索 + 轻微混合”；超出分布就崩。公开先例（Norod78 GPT-2 on Fluent flat emoji、thesantatitan 5k 条）都没有评测可引。**如果训练数据只有 Lucide/Tabler 这类线性 UI 图标，产出的还是“线性 UI 图标”，和用户抱怨的同一类**；要改善风格，必须把彩色扁平（Fluent）、filled、duotone、徽章剪影纳入。

**训练成本**（[推断]）：数据 1 万级条目 × 几百 token × 3 epoch，在单张 24GB 消费级卡上，LoRA 训 0.8B 量级属于“小时级”，没有一手数字可引，需 spike 实测。合成描述需要云端大模型，数据量与成本同样无出处。

### 3.4 方向四：中文艺术字 / 字标

| 候选 | 一手核对结果 | 结论 |
|---|---|---|
| FontDiffuser（AAAI 2024） | README 写“**仅可用于非商业研究**”，商用需联系 Lianwen Jin 教授；权重在 Google Drive/百度网盘；无轻量变体；耗时无数据（S26） | **否**（许可）。antigravity 的“单字 20～50 步、手机 10 分钟”**无出处** |
| DG-Font（CVPR 2021） | 仓库页面**没有许可证信息**；字体来源提到方正字库“对非商用用户免费”；没有预训练权重下载说明、没有耗时、没有 ONNX/移动端（S26） | **否**。antigravity 的“25～35M、30MB ONNX、手机 80～150ms/字、128×128”**全部无出处** |
| zi2zi | Apache-2.0；**TensorFlow ≥1.0.1、Python 2.7**；预训练仅生成器，27 种字体训练（S26） | 许可干净但技术栈过时，移植成本高；“约 50MB”无出处 |
| ttf2mesh | MIT，C99，功能是**把字形做 Delaunay 三角剖分成网格**（S26） | **[否] antigravity 说它“读取轮廓、支持顶点拉伸”**：它的用途是三角网格，不适合做贝塞尔轮廓的封套扭曲 |
| warpjs | MIT，对 SVG path 的点做 interpolate/transform，示例是正弦波浪（S26）；是否仍维护**未核** | 可在 WebView 里直接用，思路对 |
| Android 原生 Path | `Path.op`（布尔运算，据我所知约 API 19）、`PathMeasure`、`Paint.getTextPath`：官方页没能打开，**来自训练知识 [未核]** | 很可能是最务实的实现，但要先核文档 |
| 得意黑（Smiley Sans） | SIL OFL 1.1，覆盖通规 8105 + 补充共 8335 个汉字（S26）；商用条款页面没单独写，**按 OFL 常规理解可商用，以 LICENSE 为准** | 可作为“有设计感的中文标题字体”候选 |
| 庞门正道标题体 | 本轮**未核** | - |

**结论**：没有找到能商用、能在手机跑、权重公开的中文艺术字神经模型。可行的是“矢量字形 + 参数化变形”（非 AI），属于“排版类”，单列。

### 3.5 方向五：其他 / 混合方案

| 方案 | 一手核对结果 | 解决哪类问题 |
|---|---|---|
| bge-small-zh-v1.5 做中文语义检索选图标 | MIT，24M 参数，向量维度 512（S27）；“int8 24MB、8～15ms”**无出处**（体积是算术推断：24M×1 字节）；HF 页面没提 ONNX，**MNN/ONNX 转换未验证**；本地 MNN 文档 grep 未发现嵌入模型的现成说明 | 只改善“选图标”命中，**不生成图形**，属排版/选择类 |
| Chinese-CLIP | MIT；最小 chinese-clip-rn50 总 77M（视觉 38M + 文本 39M），有 ONNX 部署说明（S27） | 同上；**[否] antigravity 的“ResNet-50 移动端版本”**：只是 rn50 规格，77M 并不小，无“移动端版”说法 |
| USearch / sqlite-vec | 本轮未核 | 数千个图标直接暴力点积即可，不需要 |
| Qwen 当“艺术总监”输出 JSON | 现有做法 | 排版类，且现有方案已经在做 |

---

## 4. 推荐路线落地草图

### 路线 1：SDXS 一步扩散 + vtracer + 字体叠字

**管线**
1. Qwen3.5-0.8B（已有）把“品牌名 + 描述”改写成英文无字图形提示词，如 `flat vector emblem, minimal, <概念>, solid colors, white background, no text`（提示词本身要在桌面上调）。
2. SDXS-512-DreamShaper：1 步、CFG=0，出 512² 位图（S1）。
3. 位图 → 颜色量化（限制到 2～4 色，并映射到现有 14 套配色之一）→ vtracer（MIT，上一轮已核）→ SVG。
4. 品牌名走现有字体排版（或转 path）叠在图形旁。

**体积**（[推断]）：UNet int8 约 0.3GB + 文本编码器 + 解码器，总体量级 0.4～0.6GB，要实测；需要新增一个下载模型（符合“AI 中心统一管理下载”的约定）。

**STG-AL00**：内存应可行；耗时未知，**不要承诺**。我能给的唯一一手数据是桌面 CPU：i7-12700 上 SDXS-512-0.9 一步 OpenVINO+TAESD 0.82s（S29）。把它外推到只有 4 个 ARMv8.0 级大核、无 fp16/点积的手机 CPU，差距通常是一到两个数量级，所以**单张几十秒到分钟级**是我的猜测，没有任何一手手机数据支撑。
**高端机**：有 fp16/点积的新机预计快数倍，仍无数据。

**解决四条里的哪几条**
| 抱怨 | 是否解决 | 说明 |
|---|---|---|
| 图形单调 | **是**（若出图质量过关） | 每次是新图形 |
| 排版呆板 | 否 | 叠字还是现有排版，要配“排版类”改进 |
| 配色难看 | 部分 | 量化到现有配色可控，但扩散原图的色彩要靠约束 |
| 看不出是 logo | **看风格**，没有 logo LoRA 时风险高 | 要靠提示词与后处理（强制纯色、简化）|

**真机/桌面 spike（按顺序，前一个不过就停）**
1. **桌面质量 spike（零成本，先做）**：SDXS-512-DreamShaper 一步出 30 个不同行业的“无字 emblem”，经量化 + vtracer，看 20 张里有几张能当 logo 主图形用；同时对照 SD1.5 + Logo.Redmond 1.5 LoRA + LCM 4 步（质量上限）和 agate-preview-003（50 步）。**如果 SDXS 一步的质量不及格，整条路线 1 作废**。
2. **MNN 导出 spike**：用钉死提交的 diffusion 导出脚本转 SDXS（UNet/文本编码器/VAE），验证算子与精度。
3. **真机 spike**：STG-AL00 上 4 线程 CPU，测 UNet 单步耗时、峰值内存、加载时间；叠加 Qwen 常驻时的 LMK 风险；记录取消延迟（按项目约定，扩散一步无法中途打断，要在文档里写明）。
4. **vtracer 后处理 spike**：位图尺寸、色数、简化参数对 SVG 干净度/体积的影响。

### 路线 2：小 LLM 直接写简化 SVG / 图元 DSL

**管线**：Qwen3.5-0.8B + LoRA（合并后用 MNN 导出）→ 图元 DSL → 本地展开 → 与现有渲染器合并。
**体积**：不增（复用 460MB 基座），只多一个 LoRA 合并后的新权重，若合并则要**另发一份 0.8B 权重（约 460MB）**，不能直接复用现有文件，这点要考虑；也可把 LoRA 保持独立（MNN 支持 LoRA 加载是否成熟**未核**）。
**STG-AL00**：线性小图标约 100 token 约 6s；彩色扁平长 path 约 1 分钟起（算术推断，17 tok/s 是已知数据）。
**四条覆盖**：图形单调（部分，分布内）；排版/配色否；像 logo（取决于数据风格）。
**spike**
1. 先拿 Norod78/gpt-fluentui-flat-svg 在桌面跑 200 次无条件采样，看合法率与图形质量，这是最便宜的“上限探针”。
2. 用 Qwen2.5-0.5B（支持最成熟）在 Fluent flat + Tabler filled 上做小规模 LoRA，对比“原始 path”与“图元 DSL”两种表示的合法率与观感；通过后再迁到 Qwen3.5-0.8B（先确认 transformers/PEFT 对其支持）。
3. 真机测 DSL 长度分布 × 17 tok/s 的实际耗时。

### 路线 3：程序化图形合成（保底，不算 AI 模型）

首字母/字形印记（`Paint.getTextPath` 取轮廓）、圆/盾/六边形容器、`Path.op` 做负空间与字图相融、双色/渐变、彩色扁平图标（Fluent Color/Flat，MIT）；Qwen 只选参数。零新增模型，秒出，可矢量。覆盖：图形单调（部分）、像 logo（monogram 较有效）；排版/配色要配套改。**这是现有模板路线的升级，不是新 AI 路线。**

### 单列：排版/配色类改进（不进前列）
- 中文语义检索（bge-small-zh-v1.5）选图标；Skia/warpjs 做艺术字变形；字体加得意黑（OFL）；配色生成。只改善“排版呆板/配色难看”。

---

## 5. 四条抱怨覆盖矩阵

| 方案 | 图形单调 | 排版呆板 | 配色难看 | 不像 logo |
|---|---|---|---|---|
| 1 SDXS 一步 + vtracer | 解决（若质量过关） | 否 | 部分（可约束） | 看风格，高风险 |
| 2 LLM LoRA 写图元/SVG | 部分（分布内） | 否 | 否 | 取决于数据风格 |
| 3 程序化合成 | 部分 | 部分（可同时改版式） | 部分 | 部分（monogram） |
| 排版/配色类（检索、艺术字、配色） | 否 | 解决 | 解决 | 否 |

---

## 6. 许可风险汇总

| 项 | 风险 |
|---|---|
| SDXS 权重 | HF 卡 **openrail++**（允许商用但带使用限制，需随包带条款）；GitHub 仓库 Apache-2.0 指代码；训练数据未披露 |
| SD1.5 系 logo LoRA | Logo.Redmond 1.5 = bespoke-lora-trained-license（**条款未核，商用不明**）；其他多为 creativeml-openrail-m；训练数据来源**均未核** |
| Nitro-E | DiT MIT，但文本编码器 Llama 3.2 社区许可（条款未核）；训练数据含 JourneyDB、FLUX 生成图（许可未核）|
| agate-preview-003 | 代码权重 MIT；训练数据由 FLUX.1-dev 合成，下游许可争议**未核** |
| aMUSEd | openrail++ |
| MMSVG（OmniSVG 数据） | **CC BY-NC-SA 4.0，禁商用（上一轮已核）**；InternSVG 论文页标 CC BY-NC-SA，**数据/权重许可未核，按非商用处理**；kaleidoscopicwhether 卡片显示其外部数据实验含 SVGX/OmniSVG，但最终最佳权重仅用竞赛数据（竞赛数据许可未核）|
| FontDiffuser | **非商业研究**，禁用 |
| DG-Font | 无许可证 + 方正字库非商用，禁用 |
| 训练数据素材 | Tabler/Phosphor/Fluent Emoji：MIT，干净；Game-icons：CC BY 3.0 需署名；Simple Icons：CC0 但含商标，不建议训练；Lucide：ISC |
| 通用 | 用户品牌名撞商标的免责提示（上一轮已有）|

---

## 7. 来源清单

- S1 https://huggingface.co/IDKiro/sdxs-512-dreamshaper
- S2 https://huggingface.co/api/models/IDKiro/sdxs-512-dreamshaper
- S3 https://arxiv.org/abs/2403.16627 ；S3b https://arxiv.org/html/2403.16627v2
- S4 https://github.com/IDKiro/sdxs
- S5 https://arxiv.org/abs/2412.09619
- S6 https://newsroom.snap.com/ai-text-to-image-model-for-mobile-devices
- S7 https://arxiv.org/abs/2601.08303
- S8 https://huggingface.co/amd/Nitro-E ；S9 https://github.com/AMD-AGI/Nitro-E ；S10 https://arxiv.org/pdf/2510.27135
- S11 https://huggingface.co/artificialguybr/logo-redmond-1-5v-logo-lora-for-liberteredmond-sd-1-5 （及同路径 /api/models/…）
- S12 https://huggingface.co/api/models?search=logo&filter=text-to-image&sort=downloads&direction=-1&limit=40
- S13 https://huggingface.co/Logolabs/agate-preview-003 （及 /api/models/…）
- S14 https://huggingface.co/amused/amused-256
- S15 https://nota.ai/techblog/edgefusion-on-device-text-to-image-generation
- S16 https://huggingface.co/thesantatitan/Qwen2-0.5B-svg-SFT
- S17 https://huggingface.co/vinoku89/svg-code-generator
- S18 https://huggingface.co/kaleidoscopicwhether/svg-gen-weights
- S19 https://huggingface.co/Norod78/gpt-fluentui-flat-svg
- S20 https://huggingface.co/dots-studio/dots.mocr-svg
- S21 https://arxiv.org/abs/2509.05208 （注意：这是 SGP-GenBench / Symbolic Graphics Programming，**不是 SVGen**）
- S22 https://huggingface.co/gitcat-404 ；https://arxiv.org/abs/2510.11341 ；https://arxiv.org/abs/2412.11102 ；https://arxiv.org/abs/2505.24499
- S23 https://huggingface.co/api/models?search=svg&sort=downloads&direction=-1&limit=40
- S24 https://huggingface.co/Qwen/Qwen3.5-0.8B
- S25 https://github.com/tabler/tabler-icons ；https://github.com/phosphor-icons/core ；https://github.com/simple-icons/simple-icons ；https://game-icons.net/about.html ；https://github.com/microsoft/fluentui-emoji
- S26 https://github.com/yeungchenwa/FontDiffuser ；https://github.com/ecnuycxie/DG-Font ；https://github.com/kaonashi-tyc/zi2zi ；https://github.com/fetisov/ttf2mesh ；https://github.com/benjamminf/warpjs ；https://github.com/atelier-anchor/smiley-sans
- S27 https://huggingface.co/BAAI/bge-small-zh-v1.5 ；https://github.com/OFA-Sys/Chinese-CLIP
- S28 https://github.com/xororz/local-dream （只确认 CPU 用 MNN，**没有任何 CPU 耗时数据**）
- S29 https://github.com/rupeshs/fastsdcpu （i7-12700 上 SDXS 数据，经搜索摘要转述，**未直接打开 README**）

---

## 8. 未核实清单

- 所有“STG-AL00 / 高端机上的耗时、内存”均为推断，无一手手机数据。**没有找到任何 SDXS 或 SD 类模型在手机 CPU 上的公开耗时**（Local Dream 只确认 CPU 走 MNN，无数字；Qualcomm 15s/20 步是 NPU，不适用）。
- SDXS 的 int8 体积、DreamShaper 版文本编码器与 VAE 的实际规格、MNN 导出是否直通。
- Civitai 页面（Modern Logo，模型 85750）：被公司代理拦截，**无法核实**。
- Logo.Redmond 1.5 许可原文、各 SD1.5 logo LoRA 的训练数据来源。
- Nitro-E 的 Llama 3.2 条款与训练数据许可；agate 的 FLUX 合成数据下游许可。
- SnapGen/SnapGen++ 是否发布权重（项目页未打开）。
- Small-SD 的参数量（上一轮已写“卡片未写”，本轮未复核）。
- SVGen 论文编号与许可、LLM4SVG/Reason-SVG/InternSVG/UniSVG/SVGThinker 的权重与许可、StrokeNUWA 规模。
- Qwen3.5-0.8B 的 LoRA 训练框架支持、合并后 MNN 导出、LoRA 热加载。
- Fluent Emoji 官方数量与 Flat 目录详情；Lucide 当前总数；Remix 数量；庞门正道许可；站酷各款许可。
- Android `Path.op` / `PathMeasure` / `getTextPath` 官方文档（本轮没打开到正文）。
- bge-small-zh / Chinese-CLIP 的 MNN 转换、本地 MNN 文档中是否有嵌入模型示例。

### antigravity 被否定或查无出处的说法

1. SDXS：许可写“OpenRAIL-M”→ HF 卡实为 **openrail++**；“Xiaomi”机构、“UNet 330M/整体 390M”口径、“FP16 780MB / 4bit 200MB”、“RTX 4090 约 10ms”、“STG-AL00 约 12～25 秒”→ **均无出处**（论文只写单 GPU 型号不明，9ms 为 fp16 编译后）；“ONNX 完全支持”→ 仓库无 ONNX，**未验证**。
2. SnapGen：“骁龙 8 Gen 2 / iPhone 14 Pro 的 NPU/GPU 1.4 秒”→ 论文摘要未写机型，Snap 新闻稿写的是 **iPhone 16 Pro Max**；SnapGen++“4 步约 1.8 秒”→ 摘要页**无任何延迟数字**；“权重不公开”→ 只能说**未确认发布**。
3. Nitro-E：“整条管线约 1.5B、权重 3GB、步数 4～8”→ 304M 只是 DiT（Llama-3.2-1B 编码器另算），体积 3GB **无出处**，卡片步数为 **20 / distill 4**。
4. Logo.Redmond SD1.5 版：链接存在（对），但“OpenRAIL-M、约 144MB”→ 实为 **bespoke-lora-trained-license**，仓库总占用约 27.2MB。Civitai 85750 的“OpenRAIL-M、36MB”**无法核实**。
5. SVG 小模型：
   - thesantatitan/Qwen2-0.5B-svg-SFT：链接**写错（用户名重复）**；“遵循 Qwen 宽松许可”→ 卡片**没写许可**；“4-bit 约 320MB、22～26 tok/s、3.5～5.5s”→ **无出处**；
   - vinoku89：“0.6B、Apache-2.0”对，但“4-bit 约 350MB、4～6s”**无出处**；训练数据卡片未披露；
   - kaleidoscopicwhether：“Qwen 商业许可”→ 实为 **MIT**；“4-bit 850MB、9～11 tok/s”**无出处**；训练数据是竞赛数据，而非它所暗示的通用 SVG 集。
6. SVGen 论文编号：antigravity 给的 arXiv 2509.05208 是 **SGP-GenBench（Qwen2.5-7B 强化学习）**，不是 SVGen。
7. Reason-SVG“CVPR 2025”→ arXiv 页写 **CVPR 2026**；InternSVG“ICLR 2025、8B”→ 论文页**没有会议信息，也没写参数量**（提交于 2025-10）；LLM4SVG“官方权重主要为 7B”**未核**。
8. 方向三数字：Tabler“5,400+”→ **6238**；“12,000～15,000 个设计图元”是把变体都算上的虚数；“10～15 万条描述对、>98% 合法率、训练 1.5～2.5 小时、成本不足 5 元、显存 6GB、Unsloth/LLaMA-Factory 已支持 Qwen3.5-0.8B”→ **全部无出处**；“4～7 秒出图”只适用于最简单的线性图标。
9. 方向四：FontDiffuser“20～50 步、10 分钟”无出处，且**许可为非商业**（antigravity 完全没提）；DG-Font“25～35M / 30MB ONNX / 80～150ms / 128×128”**全部无出处**，且无许可证、字体源非商用；zi2zi“约 50MB”无出处，且是 TF1.x/Python 2.7；ttf2mesh 被说成“生成轮廓点、支持顶点拉伸”→ 实为**三角网格化**。
10. 方向五：bge-small-zh“INT8 24MB、8～15ms”无出处（24M 与 MIT 属实）；Chinese-CLIP“ResNet-50 移动端版本”→ 只是 rn50 规格（77M），无“移动端版”；USearch/sqlite-vec 未核；“商业级精致度”“★★★★★”等评分纯主观。
11. 总表里的“极高（商业级精致度）”“总计 < 3 秒”等结论**无依据**：检索/Qwen/渲染各段耗时均无一手数据，且该方案本质是排版类改进，**不能解决“图形本身”**。

---

## 9. 桌面质量对比（第一轮，2026-10-20）

机器 i5-13500（14 核）、32GB、无独显，全部 PyTorch fp32 CPU；**不代表手机速度**。脚本、拼图、逐张打分在仓库外 `E:\workspaces\arkli-verify\logo-small-models\`（`out\results.md` 为原始记录）。测试集 30 个行业，提示词要求无字的扁平 logo 图形；A、B 每行业 2 个种子；后处理统一为“去底 → 压 4 色 → vtracer”。

| 方案 | 桌面单张 | 峰值内存 | 可用率（子代理宽松打分） | 矢量化后 path 中位（简化档） | 结论 |
|---|---|---|---|---|---|
| A SDXS-512 一步 | 2.3 s（首张冷启动 132~190 s，加载约 70 s） | 2.1 GB | 33%（20/60） | 21 | 继续调优 |
| B SD1.5 + LCM-LoRA + Logo.Redmond 1.5，4 步 | 33~45 s（加载约 360 s） | 约 5 GB（RSS 4.7 GB 时中止） | 37%（16/43，中止于第 22 个行业） | 8 | 测试机不考虑；留作高端机可选 |
| C gpt-fluentui-flat-svg（GPT-2 级） | 37 s/条（批 20） | 3.4 GB | 不打分（无条件生成） | 原生 SVG，平均 10 个 path | 放弃 |

**主会话复核**（看了 pair 拼图）：
- A 有颜色、主体清楚，但多数是**剪贴画/插画**：写实光影、立体透视（快递箱、手提袋、咖啡杯）、复杂纹样；按“一眼像 logo”的严标准，可用约两成，宽松打分偏高。30 张提示里没有一张出乱码文字。
- B 风格**明显更像 logo**：圆形徽章 + 扁平单色剪影，矢量化极干净；缺点是几乎全黑白灰、背景发灰、语义常跑偏（牙科出虎头）。单色反而便于套 App 现有配色。
- C 内容基本是 emoji 人物，不能按行业控制，“0.2B 小模型直写 SVG”这条路否定。

**B 作为高端机可选模型的前置条件**：Logo.Redmond 1.5 的许可是 bespoke-lora-trained-license，上传 release、随 App 分发前必须先读原文确认可商用；SD1.5 + 两个 LoRA 先合并进 UNet，再用 MNN 钉死提交的 diffusion 导出脚本转换，体积与精度待实测；“高端机”的判定口径（fp16/点积/GPU）待定。

**下一步**：第二轮只调 A——提示词改成单色徽章/剪影风、概念词改得更符号化、后处理改为“二值化 → vtracer → 套 App 配色”，按严标准重打分；有明显提升才进入 MNN 导出与真机测速。

## 10. 桌面质量对比（第二轮：只调 A，2026-10-20）

改动：概念词改成更符号化（咖啡馆→咖啡豆、牙科→牙齿）；提示词试 4 套（P2 圆形徽章单色剪影、P3 图标、P4 负空间几何、P5 杂交）；后处理新增单色模式：大津法二值化 → vtracer → 套 App 配色（`palettes.ts` 的 tech-blue / obsidian-gold / sunset-orange）。打分改严：2 分必须扁平、无光影立体、剪影清晰、矢量化后不碎。

| 提示套 | 张数 | 严标准 2 分率 | 2 分的语义 贴/勉强/跑偏 | 行业覆盖（≥1 张 2 分） |
|---|---|---|---|---|
| P1 基线（第一轮 A 重打） | 60 | 21.7% | 5 / 4 / 4 | 9/30（每行业 2 张） |
| **P2 徽章单色剪影** | 120 | **37.5%** | 21 / 24 / 0 | 15/30（每行业 4 张） |
| P4 负空间几何 | 120 | 35.8% | 9 / 17 / 17 | 16/30（每行业 4 张） |

- P3、P5 粗筛只有约 5/30、7/30，未正式打分。P2+P4 合起来覆盖 19/30 个行业。
- **换种子几乎没用**：P2 四个种子出的图基本相同（出 1 张覆盖 14 个行业，出 4 张 15 个）；要“多出几张挑一张”只能换概念词。
- **稳定出好图的**：物体简单、能剪影的行业（奶茶、瑜伽、民宿、火箭、购物袋、齿轮、胡萝卜、茶叶、耳机、火锅）。**始终出不来的 11 个**：咖啡馆、面包、宠物医院、健身房、书店、AI、物流、新能源、理发、游戏、环保，失败形态多为“靶心圆”或二值化后整块发黑。
- 单色 SVG 中位约 5.9KB、2 个 path（第一轮彩色 28.8KB、21.5 个），上色只换 fill，三套配色都干净。
- guidance 1.0/1.5 加负面词对一步模型无效，还慢 35~50%，不采纳。桌面单张仍约 2.0~2.4 s。

**主会话复核**（看了三联与配色拼图）：P2 成功时确实“一眼像 logo”（瑜伽、胡萝卜、火箭、耳机、奶茶），套深底金色最好看；失败时退化成靶心圆，需要质量闸门过滤。判断：**A + P2 可以作为“能出图就用、出不来就回落模板”的 AI 图形来源，不能单独当主力。**

**未测的改进方向**：外圈由 App 画、模型只画圈内符号；对失败行业改写概念词；自动质量闸门（识别靶心圆、整块黑、碎片）。

## 11. 桌面质量对比（第三轮：外圈交给 App、概念词 v3、质量闸门，2026-10-20）

**外圈交给 App**：容器按 `scene.ts` 比例由代码画（圆环 / 实心圆 / 圆角方块），符号占容器 58%。两种做法：a = 仍用 P2 出图再用径向分析去掉模型自己画的圈；b = 新提示只出符号不要圈，最佳是 P7 `flat pictogram glyph of <概念>, solid black emoji silhouette, bold simple shape, minimalist icon, white background`。同概念同种子下两者 2 分张数持平（11 对 11），但 **a 失败时塌成靶心圆、语义全丢，b 失败时只是形状散碎、语义还在**。

**概念词 v3**：每个行业 4 个不同的可剪影物体（失败的 11 个行业全部换新，如咖啡壶、羊角面包、爪印、壶铃、书堆、机器人头、货车、风力涡轮、剪刀、游戏手柄、回收箭头），“出 4 张”改成“4 个概念各 1 张”。

| 做法 | 张数 | 严标准 2 分率 | 2 分的语义 贴/勉强/跑偏 | 行业覆盖（4 张至少 1 张 2 分） |
|---|---|---|---|---|
| a P2 去圈 | 120 | 30.0% | 27 / 9 / 0 | 19/30 |
| **b P7 只出符号** | 120 | **37.5%** | **41 / 4 / 0** | **20/30** |

- 第二轮最佳覆盖是 15/30；a、b 合起来 21/30。11 个失败行业里 b 救回 6 个（咖啡、面包、宠物医院、健身、AI、环保）。b 仍未覆盖：编程培训、牙科、书店、律师、会计、物流、新能源、理发、音乐、游戏（多为抽象服务业）。
- 符号型提示换种子有效（第二轮的徽章提示换种子几乎无差别）。

**质量闸门**（纯图像启发式，7 条规则：墨量 0.02~0.2、旋转对称 IoU ≤ 0.7 判靶心圆、连通域 ≤ 2、小斑点 ≤ 1、符号尺寸 ≥ 0.5、质心偏移 ≤ 0.12）：480 张人工标注集上留一组交叉验证 **精确率 58.8%、召回 62.4%**。b 过闸后可用率 37.5% → 52.1%，但行业覆盖 20/30 → 16/30。**只能当排序和过滤用，不是可靠分类器**；4 张全被拒就回落 Lucide 模板。

**桌面耗时**（CPU fp32）：出图约 2.1 s，符号提取 17 ms，闸门 29 ms，vtracer 133 ms，端到端约 2.3 s。

**主会话复核**（看了容器对比与 4 概念全量拼图）：b 出的是能认出来的剪影（相机、猫头、壶铃、郁金香、小房子、奶茶杯），放进 App 容器套配色后一眼像 logo，图形多样性远超现有 180 个线性图标；但边缘偏“团块感”，达不到设计师水准，抽象服务业（律师、会计、编程）仍弱。结论：**b（P7 + App 容器 + 闸门 + 模板兜底）可以进入 MNN 导出与真机测速**；桌面 fp32 的 37.5% 是上限，int8 量化后要做画质回归。

**落地还缺**：行业 → 3~4 个可剪影物体的映射（Qwen 生成或查表）；vtracer 在端上的接入方式（Rust crate，与核心库同栈，未验证）；一步前向无法中途取消，取消延迟要在文档写明。

## 12. SDXS 转 MNN 与真机测速（2026-10-21）

记录与脚本在仓库外 `E:\workspaces\arkli-verify\sdxs-mnn\`（`results.md`、拼图在 `out\`）。

**导出**：MNN 官方 diffusion 导出脚本按标准 SD1.5 写，SDXS（剪枝 UNet + TAESD）用不了；改为自写 PyTorch → ONNX（opset 17）→ 钉死提交的 MNNConvert，三个模型无不支持算子。**调度器以 `model_index.json` 为准是 DEIS**（`scheduler_config.json` 写的 Euler 不是实际值），1 步等价于 `latent = 14.6444·x − 14.6040·eps`；手写版对 diffusers pipeline 图像 PSNR 94.8~102.3 dB。桌面 MNN fp32 对 PyTorch PSNR 59.2 dB。

**量化**：上式把 eps 误差放大约 14.6 倍，量化是主要矛盾。int8 原图 PSNR 约 19 dB、细节有损，但二值化 + 矢量化后与原版几乎一致（掩码 IoU 约 0.86）；int4 轮廓变形、背景有颗粒，不用；TAESD 保持 fp32（4.9MB），量化反而更慢。fp32 / fp16 权重档桌面峰值 5.6 / 4.8 GB，上不了手机。

**推荐档**：text_encoder w8 + unet w8 + TAESD fp32，总 550,304,640 字节（约 525MB）。

**真机 STG-AL00**（CPU、precision normal、memory low，模型常驻，实测）：

| 配置 | 加载 | 热态单张 text / unet / vae | 冷 4 张 | 热 4 张 | 峰值 VmHWM |
|---|---|---|---|---|---|
| **int8 × 4 线程** | 1.58 s | 0.20 / 6.11 / 1.81 s（8.1 s） | 34.9 s | **32.5 s** | **1307 MB** |
| int8 × 8 线程 | 1.64 s | 0.39 / 6.86 / 2.04 s（9.3 s） | 39.5 s | 37.2 s | 1277 MB |
| int4 × 4 线程 | 1.62 s | 0.20 / 6.77 / 1.81 s（8.8 s） | 38.3 s | 35.2 s | 1077 MB |
| int8，每段用完即卸载 | 每张重载 | 12.3 s/张 | 49.1 s | 49.1 s | 720 MB |

- 测法：程序内计时；峰值取 `/proc/self/status` 的 VmHWM，另用设备侧脚本 0.2 s 轮询 VmRSS 与 `smaps_rollup` Pss 交叉核对。模型文件刚推送、在页缓存里，重启后从闪存冷读未测。
- 8 线程比 4 线程慢约 15%（大小核混用）；int4 比 int8 还慢一点，不划算。
- 真机 int8 对桌面 int8 不逐位一致（ARM 与 x86 的 int8 内核不同，PSNR 21.8 dB），矢量化后 IoU 0.861，与桌面 0.855 同水平；4、8 线程输出逐位相同。
- **结论：达标**（热态 4 张 ≤ 60 s、峰值 ≤ 1.5 GB）。内存只有约 13% 余量：与 Qwen 同时常驻会超，需先卸载其他模型，或改用“每段用完即卸载”（720 MB、4 张 49 s）。
- 取消：一步前向无法中途打断，只能在 text / unet / vae 三段之间检查，最长等一次 UNet（6~8 s）。

**接进 App 还需要**：模型 release 上传；现有 `arkli_mnn_capi` 可直接加载三个模型，补一步采样业务层与 CLIP 分词（77 token）；端上二值化 + vtracer（Rust crate，MIT，属新依赖待批）+ 质量闸门；行业 → 3~4 个可剪影物体的映射；页面改为“AI 符号 + App 容器 + 配色”，过闸为零时回落 Lucide 模板。
