"""SigLIP2 图像编码评测：以 ORT fp32 原版为基准，比较各 MNN 变体（以及现网 ORT q4_half）的向量保真度与桌面延迟。

指标：向量余弦（均值/最小）、与基准的 top-1 / top-3 词表匹配一致率（用随包 garbage_vocab 词表）、单张延迟中位数。
门槛（方案第 7 节，作用在“产物”= --mnn 的第一个文件、memory=low）：cos 均值 >= 0.985、最小 >= 0.95、top-1 一致 >= 0.9。
不过门槛时退出码为 2。

用法：
  python -I eval_siglip.py --images <图片目录> [--mnn a.mnn b.mnn ...] [--baseline q4_half.onnx] [--out result.tsv]
默认：fp32 基准取 dl_dir()/siglip2/vision_model.onnx；--mnn 缺省取 out_dir()/siglip2-mnn-w8/model.mnn；
词表取 app/src/main/assets/ai/garbage_vocab.{json,f16}；--baseline 缺省尝试 dl_dir()/siglip2/q4_half.onnx（不存在就跳过）。
图片目录请放 >= 30 张各类真实图片（jpg/png），数量越多门槛越可信。
"""
import argparse
import glob
import json
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MEMORY_LOW, MEMORY_NORMAL, REPO, THREADS, die, dl_dir, load_json, log, need_file, out_dir  # noqa: E402

# 模型输入边长，归一化到 [-1, 1]
SIZE = 224
# 模型的输入名与向量输出名
INPUT_NAME, OUTPUT_NAME = "pixel_values", "pooler_output"
# 随包词表位置与向量维度缺省值
VOCAB_JSON = os.path.join(REPO, "app", "src", "main", "assets", "ai", "garbage_vocab.json")
VOCAB_F16 = os.path.join(REPO, "app", "src", "main", "assets", "ai", "garbage_vocab.f16")
VOCAB_DIM = 768
# 方案第 7 节的数值门槛
GATE_COS_MEAN, GATE_COS_MIN, GATE_TOP1 = 0.985, 0.95, 0.9


def prep(path):
    """读图、缩放到 224x224、归一化，返回 [1,3,224,224] float32。"""
    im = Image.open(path).convert("RGB").resize((SIZE, SIZE), Image.BILINEAR)
    a = (np.asarray(im, dtype=np.float32) / 255.0 - 0.5) / 0.5
    return a.transpose(2, 0, 1)[None].copy()


def norm(v):
    """展平并 L2 归一化（float64）。"""
    v = v.reshape(-1).astype(np.float64)
    return v / np.linalg.norm(v)


def ort_embed(model, xs):
    """ORT 推理，返回 (归一化向量列表, 逐张耗时列表)。"""
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.intra_op_num_threads = THREADS
    so.log_severity_level = 3
    s = ort.InferenceSession(model, so, providers=["CPUExecutionProvider"])
    s.run([OUTPUT_NAME], {INPUT_NAME: xs[0]})  # 预热
    out, ts = [], []
    for x in xs:
        t = time.perf_counter()
        y = s.run([OUTPUT_NAME], {INPUT_NAME: x})[0]
        ts.append(time.perf_counter() - t)
        out.append(norm(y))
    return out, ts


def mnn_embed(model, xs, memory):
    """MNN 推理（pymnn），memory 取 MEMORY_NORMAL / MEMORY_LOW；返回 (归一化向量列表, 耗时列表)。"""
    import MNN
    F = MNN.expr
    rt = MNN.nn.create_runtime_manager(({"backend": "CPU", "numThread": THREADS, "memory": memory, "precision": 0},))
    net = MNN.nn.load_module_from_file(model, [INPUT_NAME], [OUTPUT_NAME], runtime_manager=rt)

    def run(x):
        y = net.forward([F.const(x, list(x.shape), F.NCHW)])[0]
        return np.array(F.convert(y, F.NCHW).read(), dtype=np.float32)

    run(xs[0])  # 预热
    out, ts = [], []
    for x in xs:
        t = time.perf_counter()
        y = run(x)
        ts.append(time.perf_counter() - t)
        out.append(norm(y))
    return out, ts


def main():
    """命令行入口：跑基准与各变体，打印对照表并判门槛。"""
    ap = argparse.ArgumentParser(description="SigLIP2 保真度评测")
    ap.add_argument("--images", required=True, help="图片目录")
    ap.add_argument("--fp32", default=os.path.join(dl_dir(), "siglip2", "vision_model.onnx"), help="ORT fp32 基准")
    ap.add_argument("--baseline", default=os.path.join(dl_dir(), "siglip2", "q4_half.onnx"), help="现网 q4_half 对照（可不存在）")
    ap.add_argument("--mnn", nargs="*", default=[os.path.join(out_dir(), "siglip2-mnn-w8", "model.mnn")], help="MNN 产物，第一个作为门槛对象")
    ap.add_argument("--vocab-json", default=VOCAB_JSON)
    ap.add_argument("--vocab-f16", default=VOCAB_F16)
    ap.add_argument("--out", help="把对照表另存为 tsv")
    a = ap.parse_args()

    imgs = sorted(p for p in glob.glob(os.path.join(a.images, "*")) if p.lower().endswith((".jpg", ".jpeg", ".png", ".bmp", ".webp")))
    if not imgs:
        die(f"{a.images} 里没有图片")
    need_file(a.fp32, "先运行 fetch.py siglip2")
    for m in a.mnn:
        need_file(m, "先运行 convert_all.py siglip2")
    xs = [prep(p) for p in imgs]
    meta = load_json(a.vocab_json)
    dim = meta.get("dim", VOCAB_DIM)
    vocab = np.frombuffer(open(need_file(a.vocab_f16), "rb").read(), dtype="<f2").astype(np.float64).reshape(-1, dim)
    vocab /= np.linalg.norm(vocab, axis=1, keepdims=True)

    ref, ref_t = ort_embed(a.fp32, xs)

    def topk(v, k):
        return list(np.argsort(-(vocab @ v))[:k])

    ref_top = [topk(v, 3) for v in ref]
    rows, gate = [], None

    def report(name, vecs, ts):
        """算一行指标并打印；返回 (cos均值, cos最小, top1一致)。"""
        cos = np.array([a_ @ b for a_, b in zip(vecs, ref)])
        t1 = float(np.mean([topk(v, 1)[0] == r[0] for v, r in zip(vecs, ref_top)]))
        t3 = float(np.mean([set(topk(v, 3)) == set(r) for v, r in zip(vecs, ref_top)]))
        row = f"{name}\tcos_mean={cos.mean():.4f}\tcos_min={cos.min():.4f}\ttop1_agree={t1:.3f}\ttop3_set_agree={t3:.3f}\tlat_ms_median={1000 * np.median(ts):.1f}"
        print(row, flush=True)
        rows.append(row)
        return cos.mean(), cos.min(), t1

    log(f"images={len(xs)} vocab={vocab.shape}")
    report("ort_fp32", ref, ref_t)
    if os.path.isfile(a.baseline):
        q, qt = ort_embed(a.baseline, xs)
        report("ort_q4_half(现网)", q, qt)
    for i, m in enumerate(a.mnn):
        name = os.path.basename(os.path.dirname(os.path.abspath(m))) + "/" + os.path.basename(m)
        for mem, tag in ((MEMORY_NORMAL, "normal"), (MEMORY_LOW, "low")):
            v, t = mnn_embed(m, xs, mem)
            r = report(f"mnn_{name}_{tag}", v, t)
            if i == 0 and mem == MEMORY_LOW:
                gate = r
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write("\n".join(rows) + "\n")
    if gate:
        ok = gate[0] >= GATE_COS_MEAN and gate[1] >= GATE_COS_MIN and gate[2] >= GATE_TOP1
        log(f"门槛（cos均值>={GATE_COS_MEAN} 最小>={GATE_COS_MIN} top1>={GATE_TOP1}）：{'通过' if ok else '未通过'}")
        sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
