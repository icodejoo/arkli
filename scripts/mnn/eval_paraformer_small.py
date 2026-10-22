"""paraformer-zh-small（离线、单图）评测：ORT int8 为基准，对比 MNN 变体的识别文字与耗时。

用法：python -I eval_paraformer_small.py <模型包目录> <变体目录...> [--wav 额外wav ...]
  变体目录里放 plain.mnn / fp16.mnn（probe_paraformer_small.py 的输出）。
前端：80 维 fbank（汉明窗、样本×32768）-> LFR 7/6 -> CMVN（取自 ONNX 元数据）；解码：整图 logits 逐帧 argmax，取前 token_num 个。
"""
import glob
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eval_asr as ea  # noqa: E402  复用 Kaldi fbank 与 wav 读取

# 样本放大倍数（FunASR 前端按 int16 量级算 fbank）、LFR 窗口/步长、词表里的特殊符号 id 上限
PCM_SCALE, LFR_M, LFR_N, SPECIAL_MAX_ID = 32768.0, 7, 6, 2
# 英文 BPE 续接标记
CONT = "@@"


def features(samples, neg_mean, inv_std):
    """samples(float32) -> LFR+CMVN 特征 [T', 560]。"""
    ea.WINDOW = 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(ea.FRAME_LEN) / (ea.FRAME_LEN - 1))
    f = ea.fbank(samples * PCM_SCALE)[: -ea.TAIL_PAD_FRAMES]
    t = len(f)
    f = np.concatenate([np.repeat(f[:1], (LFR_M - 1) // 2, 0), f])
    n = (t + LFR_N - 1) // LFR_N
    f = np.concatenate([f, np.repeat(f[-1:], LFR_M, 0)])
    out = np.stack([f[i * LFR_N: i * LFR_N + LFR_M].reshape(-1) for i in range(n)])
    return ((out + neg_mean) * inv_std).astype(np.float32)


def decode(logits, n_tok, id2tok):
    """logits [T',V] -> 文本（去特殊符号、合并 @@ 续接、英文词间补空格）。"""
    ids = [int(i) for i in logits[: int(n_tok)].argmax(-1) if int(i) > SPECIAL_MAX_ID]
    s, glue = "", True
    for i in ids:
        p = id2tok[i]
        cont = p.endswith(CONT)
        p = p[:-2] if cont else p
        if not glue and p[:1].isascii() and s[-1:].isascii() and s[-1:].isalnum():
            s += " "
        s += p
        glue = cont
    return s


def main():
    """入口：逐条音频跑各后端并打印文字与一致性。"""
    import MNN
    import onnxruntime as ort
    d = sys.argv[1]
    rest = sys.argv[2:]
    extra = []
    if "--wav" in rest:
        k = rest.index("--wav")
        extra, rest = rest[k + 1:], rest[:k]
    onnx_p = os.path.join(d, "model.int8.onnx")
    sess = ort.InferenceSession(onnx_p, providers=["CPUExecutionProvider"])
    meta = sess.get_modelmeta().custom_metadata_map
    neg = np.array([float(x) for x in meta["neg_mean"].split(",")], np.float32)
    inv = np.array([float(x) for x in meta["inv_stddev"].split(",")], np.float32)
    id2tok = [l.rsplit(" ", 1)[0] for l in open(os.path.join(d, "tokens.txt"), encoding="utf-8").read().splitlines()]
    rt = MNN.nn.create_runtime_manager(({"backend": "CPU", "numThread": 4, "precision": 0},))
    mods = {}
    for vd in rest:
        for f in sorted(glob.glob(os.path.join(vd, "*.mnn"))):
            name = os.path.basename(vd.rstrip("/\\")) + "/" + os.path.basename(f)
            mods[name] = MNN.nn.load_module_from_file(f, ["speech", "speech_lengths"], ["logits", "token_num"], runtime_manager=rt)
    wavs = sorted(glob.glob(os.path.join(d, "test_wavs", "*.wav"))) + extra
    agree = {k: 0 for k in mods}
    used = 0
    for w in wavs:
        try:
            s = ea.read_wav(w)
        except SystemExit:
            print("跳过（非 16k）", os.path.basename(w))
            continue
        used += 1
        x = features(s, neg, inv)[None]
        ln = np.array([x.shape[1]], np.int32)
        t0 = time.time()
        lg, tn = sess.run(None, {"speech": x, "speech_lengths": ln})
        ref = decode(lg[0], tn[0], id2tok)
        print(f"[{os.path.basename(w)}] {len(s)/16000:.1f}s ORT int8 ({time.time()-t0:.2f}s): {ref}")
        for k, m in mods.items():
            t0 = time.time()
            o = m.onForward([MNN.expr.const(x.flatten().tolist(), list(x.shape), MNN.expr.NCHW, MNN.expr.float),
                             MNN.expr.const(ln.tolist(), [1], MNN.expr.NCHW, MNN.expr.int)])
            lgm = np.array(o[0].read()).reshape(o[0].shape)
            txt = decode(lgm.reshape(-1, lgm.shape[-1]), np.array(o[1].read()).flatten()[0], id2tok)
            ok = txt == ref
            agree[k] += ok
            print(f"    {k} ({time.time()-t0:.2f}s) {'一致' if ok else '不一致'}: {'' if ok else txt}")
    print("一致数：", {k: f"{v}/{used}" for k, v in agree.items()})


if __name__ == "__main__":
    main()
