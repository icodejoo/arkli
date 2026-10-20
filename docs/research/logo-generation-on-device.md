---
title: 端侧 logo 生成：模型与方案调研
status: draft
updated: 2026-10-20
summary: 调研手机端能跑的 logo 生成方案：位图扩散（MNN diffusion 支持 SD1.5/太乙/Sana/SD3.5/Wan，测试机 CPU 无 fp16 基本不可用）、小模型写 SVG（0.8B 级大概率画不出可用 logo，推断未实测）、模板+图标库+字体排版（可商用、零新模型、文字 100% 正确）；推荐“模板排版为主、小 LLM 只出结构化参数”，位图扩散只作远期可选。含许可核对、MNN 可行性、产品形态与未核实清单
---

## 1. TL;DR 与推荐

**结论一句话**：logo 的刚需是“字对、形简、能矢量、能改色”，这四条里扩散模型一条都不占优，小 LLM 直接写 SVG 也过不了关。在测试机（4 大 4 小核、无 fp16/i8sdot、RAM 紧）上，现实的路是 **模板 + 图标库 + 字体排版**，让已有的 Qwen3.5-0.8B 只负责“把一句话变成结构化参数”。

| 排名 | 路线 | 体积 | 效果 | 工作量 |
|---|---|---|---|---|
| 推荐 1 | 模板 + 图标库 + 字体排版，小 LLM 选模板/配色/图标词 | 新增约 0.2~1MB 资源（图标子集 + 模板），LLM 复用现有 | 文字 100% 正确，风格受模板数量限制，但每张都能用 | 中（模板与渲染器是主要活） |
| 推荐 2（加分项） | 在 1 的基础上加 vtracer，把用户手绘/拍照的草图描成矢量 | 约 0.5MB 的 so/wasm | 只对“有图可描”的场景有用 | 小 |
| 不推荐现在做 | 位图扩散（SD1.5 / 太乙 / Sana） | 0.5~2GB+ 新模型 | 能出图，但 logo 质量差、字必错 | 大，且低配机不可用 |
| 不推荐 | 小 LLM 直出 SVG | 0 或几百 MB | 0.8B 大概率画不出闭合的好图形、汉字必废（推断，桌面验证因 pip 版 MNN 段错误未跑成） | 小但没意义 |

**风险**：
1. 模板路线“效果上限”由人决定——要有人设计一批像样的模板，这是设计活不是技术活。
2. 用户期待的“AI 生成”可能是扩散那种“凭空画图”，模板路线要在产品文案上说清楚是“智能排版”。
3. 位图扩散即使以后想做，也得先解决 CPU 速度与内存，见第 5 节。

## 2. 需求拆解：logo 到底要什么

- **文字正确**：品牌名（常是中文）必须一笔不错。这是硬指标，直接淘汰“靠模型画字”的路线。
- **简洁**：少色、扁平、纯色背景。扩散模型擅长细节与质感，恰好相反。
- **可矢量**：能无损放大、导出 SVG/PNG，印刷和头像都要用。位图只能事后描摹，边缘质量受限。
- **可改色/可微调**：用户几乎一定会说“换个颜色”“字大一点”。参数化渲染天然支持，扩散要重新生成且结果不可控。
- **可商用**：很多用户拿去真用，模型、图标、字体的许可都得干净。
- **能在手机上跑**：包体小、耗时可接受、不能把低配机内存吃爆。

## 3. 各路线普查表

> 数据口径：许可、体积、开源状态均已在一手来源（官方仓库/HF 模型卡）核对，来源见第 9 节；手机耗时只有标注机型的才是一手数据，其余写“粗估”或“未知”。

### 3.1 位图扩散

| 候选 | 体积 | 步数与耗时/内存 | 输出 | logo 适配 | 中文提示 / 中文字 | 许可 | MNN/ONNX |
|---|---|---|---|---|---|---|---|
| SD1.5（MNN diffusion 原生支持） | 原权重约 2GB（fp16 级），MNN 转换可 `--weightQuantBits=8`，约 1GB 量级（粗估，未实测） | MNN demo 固定 10 步；测试机 CPU 未测，按算力粗估单步十几秒以上、整张数分钟 | 位图 512² | 差，无专用微调时风格散、背景脏 | 英文提示；字必乱 | CreativeML OpenRAIL-M（可商用，但带使用限制条款，须随下游传递） | 有，官方 `transformers/diffusion` 导出脚本 |
| 太乙 Taiyi-SD-1B 中文版 | 同 SD1.5 量级 | 同上 | 位图 512² | 差 | 中文提示可用（中文 CLIP 文本编码器）；字仍乱 | **CreativeML OpenRAIL-M**（模型卡元数据，非 Apache） | 有，demo 的 `model_type=1` |
| Sana-Sprint 0.6B（MNN 支持 Sana） | 未知；文本编码器若用 Gemma-2-2B 则很大 | 一手数据（社区 MNN 版模型卡，骁龙 8 Gen3，1024px，2 步）：DiT 每步约 1.7s（OpenCL fp16）、解码约 19s、文本编码 CPU 约 31s 冷启动，总计约 29~60s；**依赖 GPU 的 fp16** | 位图 1024² | 未知 | 中英文都支持（官方 README 称） | DiT/DC-AE Apache-2.0；Gemma-2-2B 部分受 Gemma 使用条款约束，不是 Apache | 有（MNN 官方 sana demo；MNN 官方是否发布成品包未核实） |
| SD3.5 Medium | 约 2.5B 参数，体积大 | MNN 建议 20 步，耗时未知 | 位图 | 文字能力比 SD1.5 强（SD3 系列设计目标），但中文仍不行 | 英文为主 | Stability AI 社区许可（年收入门槛，非纯开源，需核原文） | MNN 有 `diffusion_sd35_demo` |
| BK-SDM-Tiny | UNet 0.33B（整体 0.50B 参数） | 论文基准用 25 步；手机未知 | 位图 | 蒸馏自 SD1.4，无 logo 能力 | 英文 | CreativeML OpenRAIL-M | 可自行转，需自己拼 pipeline |
| segmind tiny-sd / small-sd | 参数量模型卡未写 | 未知 | 位图 | 蒸馏自 Realistic Vision V4.0，偏写实，不适合扁平 logo | 英文 | CreativeML OpenRAIL-M | 可自行转 |
| SD-Turbo（1 步） | 0.9B 参数 | 1 步；手机未知 | 位图 512² | 差，1 步几何不稳 | 英文 | 模型卡写“商用请见 stability.ai/license / membership”，不是干净开源 | 需自改 scheduler |
| LCM-LoRA（SD1.5） | LoRA 参数 67.5M（文件大小模型卡未写） | 2~8 步（官方） | 位图 | 把 SD1.5 加速，不解决 logo 质量 | 英文 | openrail++ | 可合并进 UNet 再转 |
| Hyper-SD（SD1.5 1/2 步 LoRA） | 文件大小模型卡未列 | 1~2 步 | 位图 | 少步下质量下降 | 英文 | 未能从页面确认，待核 | 可合并后转 |
| Google MobileDiffusion | 论文称 UNet 约 520M | 论文称 Pixel 8 Pro 约 0.2 秒（GPU，非 CPU） | 位图 512² | 未知 | 未知 | **未见公开代码/权重**（未核实到官方发布页） | 无 |
| Snap SnapFusion | 论文称 UNet 约 0.8B 级（未核） | iPhone 14 Pro 约 2 秒（论文，非 CPU） | 位图 | 未知 | 未知 | 仓库只有主页/图，**没有代码与权重**，也没有许可文件 | 无 |
| Logo.Redmond（logo LoRA） | LoRA 文件大小模型卡未写 | 随底模 | 位图，扁平矢量风 | 目前最接近“logo 专用”。SDXL 版（2.6B 参数级）对手机 CPU 太重；**另有 SD1.5 版**（2026-10-20 更正，见 [第二轮调研](logo-small-models.md)） | 英文；字不可靠 | SDXL 版：OpenRAIL-M（模型卡标签）；SD1.5 版：bespoke-lora-trained-license，商用条款未核 | SDXL 版 MNN 无现成管线；SD1.5 版可走 MNN 官方 SD 管线 |

**高通/联发科公开数据**：高通 2023-02 官方演示，骁龙 8 Gen 2 参考机、INT8 量化、20 步 512² 少于 15 秒，跑的是 Hexagon NPU，不是 CPU（来源：Qualcomm OnQ）。联发科的“秒出图”同样是 NPU 方案。这些数字对我们的 CPU-only 测试机**没有参考意义**。

### 3.2 矢量 SVG 生成

| 候选 | 体积与开源 | 手机可行性 | logo 适配 | 中文 | 许可 |
|---|---|---|---|---|---|
| Qwen3.5-0.8B 直接写 SVG | 已有，MNN 4bit 约 460MB | 速度没问题（热态约 2.6s 首字，整张 SVG 若 500+ token 要十几秒级，粗估） | 基本画不出像样图形，只能拼几何；**未验证**，见第 5.2 节 | 汉字不可能手写 path | Apache-2.0 |
| StarVector 1B / 8B | 权重在 HF，1B 约 1B 参数 | 是**图像转 SVG**（im2svg）模型，不是文字生成 logo；基于 StarCoder，MNN 未适配 | 擅长“把现成 logo/图标图片转 SVG” | 不涉及 | Apache-2.0 |
| OmniSVG（3B/4B/8B） | 权重 8.49GB(3B)/7.69GB(4B)/17.2GB(8B)；官方要求约 17GB 显存 | 手机不可能 | 学术上有文字转 SVG | 未知 | 代码 Apache-2.0；**训练数据集 MMSVG 是 CC BY-NC-SA 4.0**，权重许可未明确，商用风险高 |
| IconShop | 有 Google Drive 预训练权重 | 自研结构，需手写导出 | 单色小图标 | 否 | **仓库无 LICENSE，不可商用**（默认版权保留） |
| DeepSVG | 学术（2020），文本到 SVG 不是它的能力 | - | - | - | 未逐项核，不建议 |
| Chat2SVG | 管线依赖 LLM + SDXL 等重模型 | 手机不可能 | - | - | 未核 |
| vtracer（位图转矢量） | Rust，有 crate、npm wasm | CPU 毫秒~百毫秒级（量级，未实测） | 适合“已有位图”后处理 | 靠输入图 | **MIT**（仓库页面核对） |
| potrace | C 库 | 极快 | 只能黑白 | 靠输入图 | **GPL v2**，闭源 App 链接要小心，不建议 |

### 3.3 模板 + 图标库 + 字体

**图标库（均为可商用开源，数量以官方页为准）**

| 库 | 许可 | 备注 |
|---|---|---|
| Lucide | ISC（官方页：免费商用） | 1600+ 个线性图标，风格统一，最适合当 logo 主图形 |
| Tabler Icons | MIT | 数量最多（数千个），覆盖面广 |
| Phosphor | MIT | 多种粗细与 duotone，质感好 |
| Material Symbols | Apache-2.0 | 偏 UI，logo 辨识度一般 |
| IconPark（字节） | Apache-2.0 | 原生支持双色参数化 |
| Remix Icon | Apache-2.0（本次未能打开官方页核对，待核） | 国内常用 |

体积：只打包“名称→path d”的 JSON 子集，几千个图标压缩后在百 KB 到 1MB 量级（粗估，需实测）。

**中文字体**

| 字体 | 许可 | 说明 |
|---|---|---|
| 系统自带 Noto Sans CJK / 思源黑体同源 | 系统字体 | 零体积；但**导出 SVG 给别的设备时要转成 path**，不能只写 `<text>` |
| 思源黑体 / 思源宋体 | SIL OFL 1.1 | 全量十几 MB，需裁剪子集 |
| 霞鹜文楷 | SIL OFL 1.1（官方页：可商用、可打包，需附 OFL；禁止用其保留名发布衍生字体） | 有 Lite 版；风格文艺 |
| 站酷系列 | 各款许可不同，**逐款核原文**，本次未逐项核 | 站酷快乐体等为 OFL，但须确认 |

**如何让字零差错**：字形一律来自字体文件。在原生层用 `Paint.getTextPath()`（或 Rust 端 `ttf-parser`/`rustybuzz` 之类）把品牌名转成矢量轮廓再写进 SVG，导出后在任何设备上都一致。

### 3.4 中文文字渲染：各路线如何保证

| 路线 | 字是否可靠 | 做法 |
|---|---|---|
| 位图扩散 | 否 | 只画无字图形，文字用字体排版叠加（等于退化为混合方案） |
| 小 LLM 写 SVG | 否 | 禁止 LLM 写汉字 path，只让它输出文字内容 |
| 模板 + 字体 | 是 | 字体轮廓直出，天然正确 |

## 4. 许可风险汇总

- **OpenRAIL-M（SD1.5、太乙、BK-SDM、tiny-sd、Logo.Redmond SDXL 版）**：允许商用，但有“使用限制”条款，且要求下游分发时带上同样限制。放进 App 并让用户下载时，需在 App 内附许可与使用限制说明。
- **SD-Turbo / SD3.5**：Stability AI 自家许可，商用要看收入门槛或会员，**别直接上**。
- **Sana 的 Gemma 文本编码器**：Gemma 使用条款不是 Apache，分发有附加条件。
- **OmniSVG**：数据集 CC BY-NC-SA，权重许可不清，避开。
- **IconShop**：无许可证，避开。
- **potrace**：GPL v2，避开；用 vtracer（MIT）。
- **图标与字体**：Lucide/Tabler/Phosphor/Material/IconPark 均宽松；字体 OFL 要随包附 OFL 文本。
- **品牌名侵权**：用户生成的 logo 可能撞已有商标，产品上建议加一句免责提示。

## 5. MNN 可行性

### 5.1 diffusion 引擎现状（读钉死提交 478c10e 的源码）

`transformers/diffusion/README.md` 列出四类：Stable Diffusion（`model_type` 0=SD1.5、1=太乙）、Sana、SD3.5、Wan2.1 文生视频（实验）。Stable Diffusion demo 步数写死 10 步；后端 0=CPU、3=OpenCL。导出走 `export/convert_mnn.py`，需先用 `onnx_export.py` 出 ONNX，再转 MNN，可加 `--weightQuantBits=8`。README 与 `docs/transformers/diffusion.md` 都**没有给手机耗时与内存数据**（antigravity 说的“README 明确要求至少 4GB 内存”**查无此语**，已作废）。

### 5.2 在测试机上的预估

- 无 fp16、无 i8sdot：MNN 的 CPU 卷积/矩阵乘只能走 fp32/少量 int8 通用内核，比有 fp16 的新机慢数倍。
- SD1.5 的 UNet 约 8.6 亿参数，每步算量在“数百 GFLOPs”量级；对 4 大核的低配 CPU，一步十几秒以上是合理估计，10 步就是几分钟（**粗估，未实测**）。内存上 UNet 8bit 权重约 0.9GB 加激活，叠加 Qwen 常驻会很紧，LMK 风险高。
- 唯一有手机一手数据的 MNN 扩散是社区的 Sana-Sprint，但它靠 OpenCL fp16 的 GPU 和 1024px，不是我们的条件，参考价值有限。
- 结论：**位图扩散在这台机器上不适合当主路线**；高端机（有 fp16/GPU）或许可行，可作为远期“高级功能，按机型开放”。

### 5.3 复用 Qwen3.5-0.8B 的可行性

- 做“结构化参数输出”（选模板/配色/图标关键词/字体风格）：输出几十 token 的 JSON，耗时与现有对话同量级，可行，需要提示词约束与 JSON 校验兜底。
- 做“直接写 SVG”：**本次验证没跑通**（见下）。

**第二阶段验证（尝试写 SVG，未成功）**：在独立 venv（`E:\workspaces\arkli-verify\logo-gen\venv-mnn`）装了 pip 版 `MNN 3.6.1` + `cairosvg`，用 `E:\workspaces\arkli-models\qwen35-0.8b-mnn-q4` 加载成功，但第一次推理就段错误（退出码 139）。原因推测是 pip 版比我们钉死的提交旧，不认 Qwen3.5 的结构；没有深挖。要做这项验证得自编桌面版 MNN（`MNN_BUILD_LLM`），或直接在真机上跑，**留作下一步**。目前“0.8B 写不出可用 SVG”是业界共识与论文评测上的判断，不是我们的实测。

## 6. 产品形态建议

- **工具页**：「Logo 工坊」。输入：品牌名、一句话描述（行业/风格/颜色偏好）。
- **流程**：输入 → Qwen 输出结构化参数（模板 id、主辅色、图标关键词、字体风格、标语）→ 本地渲染出 3~6 个候选 → 用户点选 → 微调（换色、换图标、字号、排版）→ 导出 PNG/SVG。
- **模型**：复用现有 Qwen3.5-0.8B；按 CLAUDE.md 约定，工具页只读状态，未就绪时仅提示先到 AI 中心下载。LLM 出错或没下载时，页面仍可手选模板，“AI”只是锦上添花，不是前置条件。
- **取消**：LLM 生成沿用现有取消机制。
- **取色**：一律用 `ColorPicker.vue`，不用原生 `input type=color`。
- **拍照/选图**：若后面加“草图描摹”，选图走原生 `native.file.pick`。
- **远期**：高端机上可选“AI 画图标”扩散模型，只生成无字图形，再由本地排版叠字。

## 7. 下一步

1. 拍板：是否接受“智能排版”路线（本文推荐）。
2. 选图标库（建议 Lucide + Tabler 起步）并写脚本把 SVG 子集打成 JSON，实测体积。
3. 设计 8~12 个模板（徽章型、横排、竖排、字标、圆形章等），定义模板参数 schema。
4. 在真机上验证 Qwen 输出 JSON 的成功率与耗时（提示词 + 约束解码或重试）。
5. 补做第二阶段：真机或自编桌面 MNN 上验证 0.8B 写 SVG 的实际成功率，把数据补回本文。
6. 可选：vtracer 草图描摹；远期评估 Sana/SD1.5 在有 GPU 机型上的表现。

## 8. 来源清单

- MNN 钉死提交源码：`native/mnn/.work/MNN-478c10e8…/transformers/diffusion/README.md`、`docs/transformers/diffusion.md`
- Logo.Redmond：https://huggingface.co/artificialguybr/LogoRedmond-LogoLoraForSDXL ；SD1.5 版：https://huggingface.co/artificialguybr/logo-redmond-1-5v-logo-lora-for-liberteredmond-sd-1-5
- SD-Turbo：https://huggingface.co/stabilityai/sd-turbo
- BK-SDM-Tiny：https://huggingface.co/nota-ai/bk-sdm-tiny
- segmind tiny-sd：https://huggingface.co/segmind/tiny-sd
- LCM-LoRA：https://huggingface.co/latent-consistency/lcm-lora-sdv1-5
- Hyper-SD：https://huggingface.co/ByteDance/Hyper-SD
- 太乙：https://huggingface.co/IDEA-CCNL/Taiyi-Stable-Diffusion-1B-Chinese-v0.1
- Sana-Sprint MNN 社区版：https://huggingface.co/simota1987/Sana_Sprint
- SnapFusion：https://github.com/snap-research/SnapFusion
- StarVector：https://github.com/joanrod/star-vector
- OmniSVG：https://github.com/OmniSVG/OmniSVG
- IconShop：https://github.com/kingnobro/IconShop
- vtracer：https://github.com/visioncortex/vtracer
- Qwen3.5-0.8B：https://huggingface.co/Qwen/Qwen3.5-0.8B
- Lucide：https://github.com/lucide-icons/lucide
- 霞鹜文楷：https://github.com/lxgw/LxgwWenKai
- Qualcomm SD 演示：https://www.qualcomm.com/news/onq/2023/02/worlds-first-on-device-demonstration-of-stable-diffusion-on-android

## 9. 未核实清单

- 所有“测试机上的耗时/内存”均为粗估，无实测。
- SD1.5 / 太乙 MNN 量化后实际体积未量。
- MobileDiffusion 是否有公开代码权重：只确认没找到官方发布页，未做穷尽搜索。
- Hyper-SD 许可、LoRA 文件大小；Logo.Redmond LoRA 大小与商用细则；tiny-sd 参数量。
- SD3.5 的 Stability 社区许可原文。
- DeepSVG、Chat2SVG 的许可与体积（未打开一手页）。
- Remix Icon、Tabler、Phosphor、Material Symbols、IconPark 的许可与图标数量（凭已知信息，本次未逐一打开官方页）；站酷各字体许可；思源字体裁剪后体积。
- Sana 的 MNN 官方成品包是否存在、体积；Sana 文本编码器用 Qwen3-0.6B 还是 Gemma（MNN README 的 `llm/` 目录写 Qwen3-0.6B，社区版用 Gemma-2-2B，两者不一致）。
- Qwen3.5-0.8B 实际写 SVG 的成功率（本次验证失败，见 5.3）。
- antigravity 报告中的下列内容**已被一手来源否定或查无出处，未采用**：太乙许可为 Apache-2.0（实为 OpenRAIL-M）；Logo.Redmond 可挂 SD1.5（SDXL 版 LoRA 确实不能挂 SD1.5，但作者另发了 SD1.5 版，第二轮已更正）；MNN README 要求“至少 4GB 内存”；Potrace/VTracer 耗时、各图标库 Brotli 体积、站酷/思源子集体积等一批无来源数字；IconShop“模型约 350MB”等。
