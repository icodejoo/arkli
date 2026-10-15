"""用 SigLIP2 文本塔给垃圾分类词表算“英文裸词”向量，输出 App 用的词表资源。

用法（依赖见 README，不属于项目依赖）：
    python build_vocab.py <siglip2 HF 目录> <输出目录>
产物：
    garbage_vocab.json  元数据（含“分类是草稿，需核对”的提示）
    garbage_vocab.f16   count x dim 的小端 fp16 矩阵，行已 L2 归一化
"""
import json
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vocab_draft import CLS_NAME, V  # noqa: E402

# 词表文件格式版本，Kotlin 侧按它校验
FORMAT_VERSION = 1
# 文本塔 padding 长度（SigLIP2 训练时的约定）
TEXT_MAX_LEN = 64
# 写进元数据的提示，Kotlin / 人工都能看到
DRAFT_NOTE = "分类为草稿，需对照官方《生活垃圾分类投放指引》核对后才能当作权威结果"
MODEL_ID = "siglip2-base-patch16-224"


def slug(name_en: str) -> str:
    """英文名转稳定 id：小写，非字母数字换成下划线。"""
    return re.sub(r"[^a-z0-9]+", "_", name_en.lower()).strip("_")


def embed(model_dir: str, texts: list) -> np.ndarray:
    """文本塔向量，裸词不加模板，小写，L2 归一化。返回 float32 [N, dim]。"""
    import torch
    from transformers import AutoModel, AutoTokenizer

    model = AutoModel.from_pretrained(model_dir).eval()
    tok = AutoTokenizer.from_pretrained(model_dir)
    out = []
    with torch.no_grad():
        for i in range(0, len(texts), 64):
            enc = tok([t.lower() for t in texts[i:i + 64]], padding="max_length",
                      max_length=TEXT_MAX_LEN, truncation=True, return_tensors="pt")
            r = model.get_text_features(input_ids=enc["input_ids"])
            r = getattr(r, "pooler_output", r)
            out.append(r.numpy())
    e = np.concatenate(out).astype(np.float32)
    return e / np.linalg.norm(e, axis=1, keepdims=True)


def main() -> None:
    model_dir, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    ids = [slug(v[1]) for v in V]
    assert len(set(ids)) == len(ids), "英文名转 id 有重复"
    vec = embed(model_dir, [v[1] for v in V])
    # 先转 fp16 再按存储值落盘，保证与 App 读到的一致
    half = vec.astype("<f2")
    meta = {
        "format": FORMAT_VERSION,
        "note": DRAFT_NOTE,
        "model": MODEL_ID,
        "dtype": "f16le",
        "dim": int(vec.shape[1]),
        "count": len(V),
        "prompt": "bare english name, lowercase, no template",
        "categories": CLS_NAME,
        "items": [{"id": i, "nameZh": v[0], "nameEn": v[1], "category": v[2]} for i, v in zip(ids, V)],
    }
    with open(os.path.join(out_dir, "garbage_vocab.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
        f.write("\n")
    half.tofile(os.path.join(out_dir, "garbage_vocab.f16"))
    print("ok", vec.shape, "bytes", half.nbytes)


if __name__ == "__main__":
    main()
