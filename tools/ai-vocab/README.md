# ai-vocab：识物词表向量生成

给 App 的“识物（垃圾分类）”生成词表资源：用 SigLIP2 文本塔，对每个物品的**英文裸词**（不加模板，小写）算向量，L2 归一化后存成 fp16。

## 产物（放进 `app/src/main/assets/ai/`，随包发布，约 280KB）

| 文件 | 内容 |
|---|---|
| `garbage_vocab.json` | 元数据：`format`（=1）、`note`（分类草稿需核对的提示）、`model`、`dtype`（`f16le`）、`dim`（768）、`count`（182）、`categories`（代码到中文名）、`items[]`（`id` / `nameZh` / `nameEn` / `category`） |
| `garbage_vocab.f16` | `count x dim` 的小端 fp16 矩阵，行优先，无文件头，每行已 L2 归一化；第 i 行对应 `items[i]` |

分类代码：`R` 可回收物、`H` 有害垃圾、`W` 湿垃圾、`D` 干垃圾（上海四分类）。**分类是草稿，需要对照官方《生活垃圾分类投放指引》核对**，`garbage_vocab.json` 的 `note` 字段保留了这条提示，改词表时不要删。

## 如何重算

依赖**不属于项目依赖**，只在跑脚本的 PC 上装（Python 3.10+）：

```
pip install numpy torch transformers sentencepiece
```

需要 SigLIP2 的 HuggingFace 权重目录（`google/siglip2-base-patch16-224`，含 `model.safetensors`、`tokenizer.model` 等；与 App 里的 `q4_half.onnx` 图像塔同源）：

```
python build_vocab.py <siglip2 权重目录> ../../app/src/main/assets/ai
```

- 词表草稿在 `vocab_draft.py`（中文名、英文名、分类）。改条目就改这里，再重跑。
- `id` 由英文名转成（小写，非字母数字换下划线），必须唯一，脚本会断言。
- 重算后向量应和旧版接近（改词表以外的情况下，余弦应 > 0.999）；图像塔换模型时，词表必须用同一个模型的文本塔重算。
- 语言：只用英文。中英融合在调研里验证过没有稳定收益，见 `docs/research/garbage-classify-clip.md`。

## 与 App 的约定

- Kotlin 在 `AiClassifyPolicy.parseVocab` 里校验 `format`、`dtype`、`count`、分类声明；字节数必须等于 `count * dim * 2`。
- 格式变了就升 `FORMAT_VERSION`（脚本里）与 `AiClassifyPolicy.VOCAB_FORMAT`，两边一起改。
- 打包测试 `AiClassifyPolicyTest.bundledVocab_isConsistent` 会读这两个文件校验一致性。
