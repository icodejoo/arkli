# scripts/mnn：ONNX 到 MNN 的转换与评测脚本

把识物（SigLIP2）、翻译（NLLB）、语音（zipformer）、OCR（PP-OCRv5）的 fp32 ONNX 原版转成 MNN 产物，并在桌面上和 ORT 对数。
背景、实测数字与取舍见 [docs/research/onnx-to-mnn-migration.md](../../docs/research/onnx-to-mnn-migration.md)。
**只在开发机上用，不进 APK；仓库不提交任何模型产物。**

## 一次性准备

```powershell
# 1. 虚拟环境（别用系统 Python；下载物视为不可信，一律 python -I 运行）
python -m venv E:\venv\arkli-mnn
E:\venv\arkli-mnn\Scripts\pip install -r scripts\mnn\requirements.txt

# 2. 用固定提交编出 MNNConvert.exe 与 ModuleBasic.out.exe（约 10 分钟，输出到 native/mnn/.work/build-tools/）
#    需要 VS 2022 生成工具 + Windows SDK、cmake、ninja；源码目录 native/mnn/.work/MNN-478c10e…/ 由 native/mnn/build.sh 首次运行时下载
.\native\mnn\build-tools.ps1

# 3. 告诉脚本用哪个转换器（不设也行：默认位置 native/mnn/.work/build-tools/MNNConvert.exe 存在就用）
$env:ARKLI_MNNCONVERT = "E:\workspaces\arkli\native\mnn\.work\build-tools\MNNConvert.exe"
```

**只在导出 SDXS（`convert_all.py sdxs`）时才需要 torch**，且要单独装（CPU 版走 PyTorch 官方源；`requirements.txt` 里故意不放 `--extra-index-url`，避免它对其余依赖生效造成依赖混淆）：

```powershell
E:\venv\arkli-mnn\Scripts\pip install torch==2.14.1+cpu --index-url https://download.pytorch.org/whl/cpu
```

不要调用 pip 版 MNN 带的 `mnnconvert` 命令：它会带机器 ID 上报阿里云，还会自动 `pip install aliyun-log-python-sdk`。
`mnnconv.py` 只走固定提交的 exe，找不到才退到 `_tools.mnnconvert` 底层函数（产物与 exe 等价，仅 UUID 的 27 字节不同）。

## 一键流程

```powershell
$py = "E:\venv\arkli-mnn\Scripts\python.exe"
& $py -I scripts\mnn\fetch.py                     # 下载并校验原版（缺省不含 baseline 与 sdxs，它们要显式指定；aria2；已有且校验通过的会跳过）
& $py -I scripts\mnn\vocab_audit.py               # （可选）NLLB 词表覆盖率审计，见下文“NLLB 词表”
& $py -I scripts\mnn\vocab_build.py               # NLLB 六语言词表 v2 -> dl\nllb-tok-v2（nllb 转换前必须先做）
& $py -I scripts\mnn\convert_all.py               # 转各模型的默认变体（缺省不含 sdxs，需显式指定）
& $py -I scripts\mnn\eval_siglip.py --images <图片目录>
& $py -I scripts\mnn\make_eval_set.py            # （data/sentences_m6.tsv 已提交，改语料时才需重生成）
& $py -I scripts\mnn\eval_nllb.py
& $py -I scripts\mnn\eval_asr.py
& $py -I scripts\mnn\eval_ocr.py
& $py -I scripts\mnn\fetch.py couplet && & $py -I scripts\mnn\convert_all.py couplet   # 对联 GPT-2（默认 w6hqq，产物 couplet-gpt2-mnn）
& $py -I scripts\mnn\eval_couplet.py mnn_w6=<产物目录>\model.mnn
& $py -I scripts\mnn\fetch.py sdxs && & $py -I scripts\mnn\convert_all.py sdxs       # SDXS-512 DreamShaper（需显式指定，约 1.8GB，先按上面装 torch；默认 w8，产物 sdxs512-mnn-w8）
& $py -I scripts\mnn\ocr_case.py --out <目录>   # （可选）Rust 真库 OCR 测试用例：case.rgb + expect.txt
& $py -I scripts\mnn\pack.py siglip2-mnn-w8       # 登记字节数与 sha256，生成 models.json 条目片段
# 单包发布：打可复现 zip 并把 archive/files 回写清单，再 gh release upload <tag> <zip>（只新增资产，别删旧的）
& $py -I scripts\mnn\pack.py <产物目录> --tag siglip2-mnn-v1 --zip E:\workspaces\arkli-models\_zip --apply app\src\main\assets\ai\models.json
```

- 目录：默认全放 `native/mnn/.work/convert/`（已被 `.gitignore` 忽略）。环境变量 `ARKLI_MNN_WORK`（根）、`ARKLI_MNN_DL`、`ARKLI_MNN_SPLIT`、`ARKLI_MNN_OUT` 可分别改。
  下载目录布局是固定的（`siglip2/`、`nllb-fp32/`、`nllb-tok/`、`asr/`、`ocr6/`），已有同名且校验通过的文件会被直接复用（可以硬链接进来省下载）。
- 想看有哪些变体：`convert_all.py --list`；指定变体：`convert_all.py nllb --variant nllb=w8`；重转：`--force`。
- 每个 eval 都带门槛判定（见下表），不过门槛退出码为 2。
- 评测要的磁盘与内存：NLLB 拆图与产物共约 7GB 磁盘；`nllb_prepare.py` 约需 8GB 内存。

## 可信的 model.json（NLLB w6）

`nllb600m-un6-mnn-w6/model.json` 已登记进 `app/src/main/assets/ai/models.json`：**1,218 字节，sha256 `1db584251cde24fc8570f393f019ede6e7c6d58225b40ed0e71c330e16a14d36`**
（`generation.num_beams` 为 1；更早的 `1e8148b4…`，beams=2，已作废）。`recipes.json` 已同步为 `num_beams: 1`，且渲染是确定的（配方键序、缩进 2、不转义中文、LF、结尾换行），可不转模型直接复现并核对：

```powershell
& $py -I scripts\mnn\convert_all.py nllb --variant nllb=w6hqq --model-json-only $env:TEMP\mj
(Get-FileHash $env:TEMP\mj\model.json -Algorithm SHA256).Hash   # 应为 1DB58425…14D36
```

没有 `--force` 且所有 `.mnn` 都被跳过时，`convert_all.py` 不会改写已有的 model.json；改配方后想更新它，要加 `--force` 或手动删掉旧文件。

## 脚本一览

| 脚本 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `requirements.txt` | - | - | 钉版本：MNN 3.6.1、onnx 1.23.2、onnxruntime 1.31.0、numpy 2.5.4、tokenizers 0.23.3、pillow 12.3.0、psutil 7.2.2 |
| `common.py` | - | - | 目录约定、校验、日志等公共小工具；脚本用 `python -I` 跑，所以每个脚本开头先把本目录插进 `sys.path` |
| `recipes.json` | - | - | 每个模型的输入、输出名、各变体的量化参数与清单 id、release tag |
| `fetch.py` | 分组名 | `dl/` 下的原版文件 | URL 与 sha256 写死；aria2 下载；校验不过就停（文件留着，别用）；`baseline` 分组是对照用的现网模型 |
| `mnnconv.py` | onnx、MNNConvert 参数 | `.mnn` | 统一转换入口；可当命令行用，参数原样透传 |
| `convert_all.py` | `recipes.json` | `out/<清单 id>/` | 一键转换；nllb / couplet / sdxs 自动做前处理（sdxs 自动调用 `sdxs_prepare.py` 导出三图与 tokenizer.json）；随包生成 `model.json`（若有）、`NOTICE.txt`（若有）与 LICENSE；`convert.json` 记录转换参数与转换器 sha |
| `dequant_nbits.py` | ORT 的 `MatMulNBits` int4 onnx | 标准 MatMul + fp32 的 onnx | 只在拿现网 int4 包做对照实验时用，生产转换不用 |
| `vocab_audit.py` | 原版/待审 tokenizer.json、官方 `sentencepiece.bpe.model`（可选）、`data/audit_*.txt` | 覆盖率报告 | GB2312 6763 字单字覆盖、原版有而待审丢了的字、六语语料 UNK 与分词一致率、BPE 合并链完整性；SPM 用手写 protobuf 解析，不依赖 sentencepiece |
| `vocab_build.py` | 原版与随包 tokenizer.json、审计语料 | `dl/nllb-tok-v2/tokenizer.json` + `vocab_build.json` | 词表 v2 = 随包集 ∪ 补充集 + BPE 闭包 + 标点规范化补丁；自检可达性与分词一致；`--gold-out` 另存“原版全词表 + 同 normalizer”的金标准 |
| `nllb_prepare.py` | NLLB fp32 的 encoder / merged decoder、全词表与 v2 词表 | 拆图 `encoder/decoder_first/decoder_step.onnx` + `embed_fp32.npy` | 词表裁剪（按 token 字符串映射回原 id）；词嵌入移出图外；拆 merged decoder 的 `If` |
| `nllb_crosskv.py` | 拆图目录 | `cross_kv.onnx` | 手写的交叉注意力 K/V 小图，所有解码步统一走 `decoder_step` |
| `nllb_embed.py` | `embed_fp32.npy` | `embed.i8`（int8 行主序）+ `embed.scale`（float32 每行） | 63MB，对 fp32 的 253MB；格式在脚本顶部有说明，Rust/Kotlin 加载器照它读 |
| `make_case.py` | onnx + npz | ModuleBasic 用例目录 | 子命令 `case` / `siglip-inputs` / `nllb-inputs`；M3 的 Rust 真库测试读这个目录 |
| `eval_siglip.py` | 图片目录 | 对照表 | ORT fp32 为基准，对 MNN 各变体与现网 q4_half 比 cos / top-1 / 延迟 |
| `eval_nllb.py` | 拆图、MNN 产物、`data/sentences_m6.tsv` | 译文对照与指标表 | teacher forcing 一致率、与基准同句数、退化句、撞长度上限句、编码/解码耗时、RSS；`--dump` 存 JSON；每个后端一个子进程 |
| `eval_vocab_equiv.py` | 原版 fp32 merged（全词表）、金标准 tokenizer、v2 拆图 | 逐句译文对比 | 词表裁剪的译文级等价性（token 序列是否完全相同） |
| `make_eval_set.py` | `data/sentences.tsv`、`data/audit_*.txt` | `data/sentences_m6.tsv` | 原 29 句 + 30 个有向语言对各 4 句，共 149 句 |
| `eval_asr.py` | 语音包 `test_wavs`、MNN 产物 | 识别文字与 RTF/RSS | numpy 自写 fbank + 流式贪心解码；ORT fp32 / ORT int8 / MNN 各一个子进程 |
| `eval_ocr.py` | 合成文字图（或自己的图）、MNN 产物 | det IoU、rec/cls argmax 一致 | 合成图需要中文字体，默认微软雅黑；生成图时同目录写 `expect.json`（每张图画了哪些行） |
| `ocr_case.py` | 合成图目录（缺省生成） | `case.rgb`（前 8 字节小端 u32 宽高，其后 RGB）与 `expect.txt`（真值，一行一句） | 给 Rust 真库测试 `mnn::real_tests::真库跑通ocr管线` 与 `arkli-ffi` 的 `真库经ffi识别并可卸载重载` 用（环境变量 `ARKLI_OCR_RGB` / `ARKLI_OCR_EXPECT` / `ARKLI_OCR_DIR` / `ARKLI_MNN_DYLIB`） |
| `fetch.py ocr6` / `convert_all.py ocr6` | HF 官方 PP-OCRv6 small 的 det/rec ONNX 与 rec 的 `inference.yml` | `ppocrv6-small-mnn-fp16`（det/rec fp16，cls 沿用 v5 的） | 字典取自 yml（需 PyYAML）；评测见 migration 文档“M8 升级”一节 |
| `couplet_prepare.py` | 对联 fp32 ONNX（带 past） | 无 KV cache、词嵌入 int8 的 `model_e8.onnx` | 去掉 24 个 past 与 present，Concat 改 Identity，past_len 换常量 0；`--int8-embed` 把 wte 改成图内 int8 + 逐行 scale（MNN 的权重量化不量化 Gather 常量），lm_head 用独立 fp32 副本交给 MNN 量化；`convert_all.py couplet` 会自动调用 |
| `sdxs_prepare.py` | SDXS fp32 原版目录（HF 布局） | `text_encoder.onnx`、`unet.onnx`、`vae_decoder.onnx`、`tokenizer.json` | PyTorch 导出 ONNX（时间步固定 999，带精度对拍自检）并从 vocab/merges 构造标准 CLIP BPE tokenizer.json；`convert_all.py sdxs` 会自动调用；产物目录含三个 .mnn、tokenizer.json、NOTICE.txt 与 4 个 LICENSE |
| `eval_couplet.py` | 产物 `.mnn`/`.onnx`、`data/couplet/pairs.tsv`（52 条自写上联+真下联） | 对 ORT fp32 的 logits 余弦/top-1、等长约束贪心一致率、困惑度涨幅、7 字耗时 | MNN 经 ctypes 调 `arkli-mnn.dll`（同 Rust 的 C ABI，memory=low）；门槛：余弦均值 >= 0.999、top-1 >= 0.95、困惑度涨幅 <= 2% |
| `pack.py` | 产物目录 | 字节数、sha256、`models.json` 条目片段；`--zip` 另出可复现 zip 与 `<zip>.json`，`--apply` 回写清单 | 默认只读；上传 release 由人执行；`ppocr_keys.txt` 登记为 `tokenizer` |
| `data/sentences.tsv` | - | - | NLLB 评测句子（原 29 句） |
| `data/sentences_m6.tsv` | - | - | NLLB 评测集（149 句，30 个有向语言对；门槛判定用） |
| `data/sentences_zhchars.tsv` | - | - | “丢字”专项（28 句：含懒、媚、妈、汤、哎等原版缺字，只比译文，不判门槛） |
| `data/audit_{zh,en,fr,es,ru,ar}.txt` | - | - | 词表审计语料（中文 219 句，其余各 65~67 句，自写） |
| `data/nllb/` | - | - | NLLB 包随附的 `NOTICE.txt` 模板与 CC-BY-NC-4.0 授权文本 |

## NLLB 词表（M6a 结论）

先问“缺字是裁剪造成的，还是原版就没有”，用 `vocab_audit.py --spm sentencepiece.bpe.model`（官方 SPM 从 hf-mirror 的 `facebook/nllb-200-distilled-600M` 取，约 4.8MB）：

- GB2312 6763 字里 **4188 个**（含懒、媚、妈、汤、哎、笨、苹、蕉）在官方 SPM、原版 tokenizer.json、随包裁剪词表里**都没有**单字词条，分词必出 `<unk>`；随包裁剪相对原版 GB2312 一个不丢。模型自己也学成了在这些位置输出 `<unk>`（引擎禁掉 `<unk>` 后才退成“惰”“阳光明的天”），词表层面补不回来：没有嵌入行，也没有训练过。用繁体字映射（Unihan `kTraditionalVariant`）只能救 144/4188，没做。
- 原版 tokenizer 没带 Moses 标点规范化：`“ ” ‘ ’ « » – — 《》【】` 都是 `<unk>`。这个可以补，`vocab_build.py` 在 Precompiled 之后插入 Replace 规则（“”«»《》→`"`，‘’→`'`，–→`-`，—→` - `，【】→`[]`，bidi 控制符删除），不增加嵌入行。
- 词表 v2 = 随包 61,795 词 + 补充 1 词（语料里原版用到而随包集漏掉的 `▁rana`）= **61,796 行**，id 按原版 id 升序顺排，`<s>=0 <pad>=1 </s>=2 <unk>=3` 不变，语言码在最后。`nllb_prepare.py` 按 token 字符串映回原 id 裁剪嵌入与 lm_head，机制不变。
- 复现：`fetch.py nllb` → `vocab_build.py`（默认输出 `dl/nllb-tok-v2`）→ `convert_all.py nllb`（recipes 的 `tokenizer` 指向它）。想扩大补充集，用 `vocab_build.py --corpus 你的语料.txt`（每行一句，语料里原版会用到的 token 都会补进来）。

## 门槛（方案第 7 节，桌面）

| 模型 | 门槛 | 脚本 |
|---|---|---|
| SigLIP2 int8 low | cos 均值 >= 0.985、最小 >= 0.95、top-1 一致 >= 0.9 | `eval_siglip.py` |
| NLLB 6/8 位 low | teacher forcing >= 0.96、退化句 0（149 句） | `eval_nllb.py`（`trim_tail_repeat` 次数要在 Rust 测试里看） |
| 语音 int8 low | 测试音频与 fp32 逐字一致 | `eval_asr.py` |
| OCR fp16 | det IoU >= 0.98（v6 实测 0.9866）、rec argmax >= 99.5%、cls 全一致 | `eval_ocr.py` |

## 一致性用例（ModuleBasic）

```powershell
& $py -I scripts\mnn\make_case.py siglip-inputs <图片> case\siglip_in.npz
& $py -I scripts\mnn\make_case.py case <vision_model.onnx> case\siglip_in.npz case\siglip
native\mnn\.work\build-tools\ModuleBasic.out.exe <siglip2-mnn-fp32\model.mnn> case\siglip 0 0 10 4 0
```

参数依次是 runMask、后端（0=CPU）、循环次数、线程数、mask（`precision + 4 * memory`，0 为 fp32，8 为 memory low）。
`diff rate` 内置门槛是 1%，**只适用于 fp32/fp16 模型**；量化模型用任务指标判。MSVC 版缺 AVX 内核分发，耗时不可参考。

## 坑

- **memory 开关**：pymnn / Rust 里 `memory=normal`（0）会在加载时把量化权重还原成 float，NLLB 实测 RSS 2.85GB，手机上不能用；评测与产物一律 `memory=low`（2）。
- **外置权重**：`--saveExternalData` 生成 `xxx.mnn.weight`；评测脚本对每张图单独建 RuntimeManager 并 `set_external`。多个模型共用一个 RuntimeManager 时必须“设路径 → 加载 → 清空”。
- **onnx 外部数据会追加写**：写已存在的同名 `.data` 会追加，所以保存前都先删旧文件（`nllb_prepare.py`、`nllb_crosskv.py` 已处理）。
- **别同时给** `--weightQuantAsymmetric` 与 `--weightQuantBlock`：分块不生效。
- **OCR 字典与许可证**：`convert_all.py ocr6` 会从 rec 的 `inference.yml`（`character_dict`）写 `ppocr_keys.txt`，并拷入 `data/ocr6/` 的 `NOTICE.txt`、`LICENSE-Apache-2.0.txt`；已有 `.mnn` 时重跑只补这三个文件，不重转。
- **每次转换 sha 都会变**：.mnn 里带随机模型 UUID（约 27 字节），所以转换后只 `pack.py` 一次，发布的就是登记的那一份，别重转后沿用旧 sha。
- **转换器版本**：固定提交的 MNNConvert 与 pip 3.6.1 的产物体积逐字节相同、推理输出逐位一致，但生产用固定提交的 exe。
- **Windows 编译**：`build-tools.ps1` 不用 VsDevCmd（它的扩展脚本在部分环境报错），手动设 PATH/INCLUDE/LIB；输出目录别放太深，FetchContent 路径过长会失败。
- **aria2 解析超时**：Windows 上要 `--async-dns=false`（`fetch.py` 已加）。
- **不可信下载物**：各放新目录，脚本放别处，Python 一律 `-I`；`fetch.py` 解压 tar 用 `filter="data"`。
- **现网 int4 搬进 MNN 不划算**：把 q4_half 的 int4 网格还原再 4 位量化余弦只有 0.82~0.88，所以 `dequant_nbits.py` 只是对照实验工具。
- **“你好世界”**：fp32 下也译成 “Good luck to you.”，是 600M 蒸馏模型本身的行为，量化修不了。
- **OCR 的识别字典**：本目录只转模型；rec 的字符字典要在 M8 接入时从 onnx 元数据或 RapidOCR 配置取。

## 给 M2 / M3

- `build-tools.ps1` 的 `-HostDll` 开关留着：M2 加了 `arkli_mnn_capi.cpp` 后在那里补 `MNN.dll` + `arkli-mnn.dll` 的编译步骤。
- M3 的 Rust 真库测试读 `ARKLI_MNN_CASE`：用 `make_case.py case`（SigLIP2 fp32）与 `nllb-inputs` + `case`（三张 NLLB 图）生成用例目录即可。
