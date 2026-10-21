# SD1.5 logo 模型端侧部署：引擎选型与降门槛手段

> 状态：draft（2026-10-21）。所有手机耗时、内存、倍数均为估算或第三方数据，**无我们自己真机实测**；接入前须真机 POC。
> 前置：桌面训练链路与 v1/v2 LoRA 见 D:/ai（ComfyUI + kohya sd-scripts + vtracer，不在仓库内）。相关旧调研：[端侧 logo 生成](logo-generation-on-device.md)、[logo 小模型](logo-small-models.md)。

## 1. 我们当前的 MNN 基座支持 SD1.5 吗

结论：**引擎支持，现有编译产物不能直接用，要重编并改官方管线。**

- 官方有 `transformers/diffusion/` 示例，MnnLlmChat 安卓 App 带文生图；社区 DreamShaper 8 的 MNN 版 int8 整包约 1.2GB，可作体积参照。
- 现状：钉死提交版本头 3.6.1（`native/mnn/mnn-source.sh:6-8`）；`MNN_OPENCL/VULKAN/ARM82` 全关，后端写死 CPU（`native/mnn/build.sh:32-38`）；未开 `MNN_BUILD_DIFFUSION`（官方要求同时开 `MNN_IMGCODECS`、`MNN_BUILD_OPENCV`）。C ABI 只封装 LLM 与 Module，需新增 SD 接口。
- 官方管线限制（均需改源码）：采样器写死 PLMS；CFG 系数写死 7.5；无运行时 LoRA，只能合并进 UNet 后再转；无取消（去噪循环每步查原子标志即可，粒度为一次 UNet 前向）。
- 导出：官方脚本把输入形状固定、UNet 按 batch=2 导出，换分辨率须重导；MNN 官方只支持 8 位权重量化。
- 取消：约定见 `docs/design/ai-protocol.md`，需补“取消后可再生成”单测与真机取消延迟实测。
- 注意：代码细节部分来自网页摘要，接入前须对着钉死提交核一遍。

## 2. MNN 与 stable-diffusion.cpp 对比

| | MNN | sd.cpp |
|---|---|---|
| 基座 | 已有，零增量 | 新增一套引擎，so 估计多 3~6MB（估算） |
| LoRA | 合并后转换 | 运行时挂载，也可离线合并 |
| LCM / 少步 | 自己改调度器 | 原生，cfg=1、2~8 步 |
| 量化 | int8 | GGUF q4~q8，加载时在线量化或离线转 |
| 取消 / 进度 | 改源码 | 官方有 `sd_cancel_generation`、进度回调 |
| GPU | OpenCL（当前关） | OpenCL 仅 Adreno；Vulkan 稳定性未知 |
| 协议 / 维护 | Apache-2.0 | MIT，2026-09 仍活跃 |

sd.cpp 运行时是“底模 + LCM-LoRA + logo LoRA + TAESD”四个独立文件，换风格、开关 LCM/TAESD 只改参数和文件，**不需重新转换或重编译**（只有库本身用 NDK 编一次）；MNN 每个变体都要重走 ONNX→MNN。具体参数名凭记忆，接入前对 README 核对。

### 多版本 / 分机型推荐

要做多档量化、官方原版、按机型分档时，**sd.cpp 明显更合适**：一份源文件可出多档 GGUF，官方 `.safetensors` 直接读；MNN 的“量化档 × 分辨率”每个组合都是一套独立模型，且无 q4。MNN 仅在“固定单一变体、CPU 内核调优后可能更快”时有优势（无数据）。机型推荐表须靠实测，建议首次跑分自动推荐档位。

## 3. 降门槛手段（按收益/难度）

1. **LCM-LoRA + cfg=1，4 步**：步数 20→4 且省一半 CFG，合计约 8~10 倍（估算）；扁平图标画质损失可接受。可与 logo LoRA 合并使用。
2. **权重量化** int8（约 1GB）→ q4（约 0.5GB，估算）。
3. **降分辨率** 384/256 出图再矢量化：算量约 56% / 25%。
4. **TAESD** 小 VAE：解码更快更省内存，矢量化后影响小。
5. **分阶段加载**（CLIP→UNet→VAE 依次载入释放）：降峰值，6GB 机型关键。
6. **预存常见提示词 embedding**：省 CLIP，代价是只能用预设词，作兜底。
7. Flash Attention；Hyper-SD / TCD 作 LCM 的替代。

暂不做/不可行：SD-Turbo、SDXL-Turbo（许可不干净、LoRA 兼容差）；BK-SDM、SDXS（需重蒸馏）；SnapFusion、MobileDiffusion（无公开权重）；NPU/QNN（与“不做 NPU”决策冲突）；DeepCache/ToMe（少步下收益小）；tiled VAE（512² 用处小）。

### 3.1 桌面实测：LCM-LoRA 叠加 logo LoRA（2026-10-21，RTX 4060，ComfyUI）

底模 SD1.5 + `arkli_logo_v2`（权重 1.0）+ `lcm-lora-sdv1-5`，`lcm` 采样器、`sgm_uniform`、cfg 1.5，512²，耗时含 vtracer：

- 速度：标准 28 步约 4.1 秒，LCM 4 步约 1.1 秒。
- 4 步 + LCM 权重 1.0：风格保住，但边缘发糊、背景发灰，构图同质化（多张出同一图案）。
- 糊边主因是 **LCM 权重过高**；降到 0.5~0.7、步数提到 6~8 后边缘锐利、背景纯净。
- 参数对比（logo LoRA / LCM 权重 / 步数）：1.0/1.0/4 糊；1.0/0.7/4 仍脏；1.0/0.7/6 干净；1.2/0.7/6 偏怪；**1.0/0.5/8 最干净**；1.2/0.6/8 也干净。
- **手机端基线档**：logo LoRA 1.0、LCM 0.5~0.6、6~8 步（约为 28 步计算量的 21%~29%，省的是 3.5~4.5 倍而非 7 倍）。想压到 4 步又不糊，需用自有 logo 数据做 LCM 蒸馏，暂不做。
- 命中率与 LCM 无关：功能词（抛硬币、色盘）没绑牢，属训练集问题，见 3.2。

### 3.2 训练集风格问题与 v3 方向

v2 训练集全是 Lucide / Phosphor / Tabler 单色描边图标，出图“太线条化、太扁平、颜色单调”。v3 改用彩色、有层次的开源素材，并合成 iOS / Android 两种 app 图标风格：
- 来源（许可宽松）：Noto Emoji（Apache-2.0）、Fluent Emoji Flat（MIT）、Flat Color Icons（MIT）、IconPark Solid（Apache-2.0）、AOSP 自带 app 图标（Apache-2.0，可选）。CC-BY 的 Solar / Twemoji / Streamline Emojis 暂不用。
- 合成风格：iOS＝渐变圆角方块 + 高光 + 柔和阴影；Android＝Material You 双色分层。不抓商店真实 app 图标（商标与店铺条款风险）。

## 4. 推荐路线

- 主路线：优先做 **sd.cpp 真机 POC**（成本低于改 MNN 管线）：q8_0 / q4_0 × 384 / 512 × LCM-LoRA + TAESD，在测试机 STG-AL00（无 fp16、无点积）测单张耗时、峰值内存、取消延迟，产出“档位 × 耗时 × 内存”表。
- MNN 作回退：sd.cpp 包体或双引擎维护代价不可接受时，走“LoRA+LCM 合并 → ONNX → MNN int8”。
- 低端机兜底：256/384 + q4 + 分阶段加载 + 预存 embedding；仍超约 60 秒则只提供模板排版路线（已有）。

## 5. 风险与待核实

- 低端机（6GB、无 NPU）真机耗时与峰值内存**完全无数据**；Off Grid 等旗舰数据不可外推。
- 合并 LoRA 后 int8/q4 画质、LCM + logo LoRA 的 4 步效果未验证（桌面 ComfyUI 可先测）。
- SD1.5 与 LCM-LoRA 为 OpenRAIL，条款须随下游传递；Hyper-SD 许可未确认；Logo.Redmond 1.5 许可未核。
- Mali / 联发科机型的 Vulkan、OpenCL 稳定性未查。
- 引入 sd.cpp 属新增第三方依赖，须用户确认（见 docs/status.md 待确认清单）。

## 6. 下一步

1. 桌面：已验证 LCM 叠加（见 3.1）；下一步用 v3 彩色多风格训练集重训，再复测基线档。
2. 用户确认后：sd.cpp NDK 编译 + 真机 POC，产出档位表。
