"""对联 GPT-2 的桌面评测：ORT fp32 为基准，对比 MNN 各变体（也可加 ORT 的 int8/int4 onnx 做参照）。

指标（评测集 data/couplet/pairs.tsv：上联<TAB>真下联，自写，多为名联，所以困惑度绝对值偏低，只看相对涨幅）：
  - logits：沿 fp32 的等长约束贪心路径逐步比较，余弦均值/最小、最大绝对差、top-1 / top-5 一致率；
  - 贪心解码：下联与 fp32 整句一致率、逐字一致率（等长约束：该位上联是标点则照抄，否则只许汉字）；
  - 困惑度：真下联加 [SEP] 的 teacher forcing，对 fp32 的涨幅；
  - 速度：4 线程生成 7 字下联的总耗时（无 KV cache，整句重算，中位数）。桌面 MNN 是 MSVC 构建（缺 AVX 内核分发），耗时只作相对参考。
MNN 走 arkli-mnn.dll（与 Rust 运行时同一套 C ABI，ctypes 调用），模型按 memory=low 加载。
门槛（只判第一个变体）：余弦均值 >= 0.999、top-1 >= 0.95、困惑度涨幅 <= 2%；不过退出码为 2。

用法：python -I eval_couplet.py [--onnx <fp32.onnx>] [--vocab <vocab.txt>] 名字=路径 [名字=路径 ...]
  路径是 .mnn 则走 MNN，是 .onnx 则走 ORT（带 past 的原版图，传空 past）。--json 可存结果。
  例：python -I eval_couplet.py mnn_w6=out\\couplet-gpt2-mnn\\model.mnn ort_int4=dl\\couplet\\couplet-gpt2-int4.onnx
"""
import argparse
import ctypes as C
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DEFAULT_CONVERT_EXE, HERE, MEMORY_LOW, THREADS, die, dl_dir, log  # noqa: E402

import numpy as np  # noqa: E402

# 特殊 token id 与“-”分隔符
CLS, SEP, UNK = 101, 102, 100
DASH = "-"
# 需要照抄的标点
PUNCT = "，。、；：！？,.;:!?"
# 层数、头数、头维度（ORT 原版图的空 past 用）
NL, NH, HD = 12, 12, 64
# 计时用的 7 字上联与重复次数
TIME_UP = "春风送暖入屠苏"
TIME_REPS = 15
# 门槛
GATE_COS, GATE_TOP1, GATE_PPL_PCT = 0.999, 0.95, 2.0
# 错误信息缓冲长度
ERR_LEN = 2048


def load_dll():
    """加载 arkli-mnn.dll（与 MNN.dll 同目录），配好 ctypes 签名，返回库对象（带 Cfg 结构体类型）。"""
    bt = os.path.dirname(DEFAULT_CONVERT_EXE)
    os.add_dll_directory(bt)
    lib = C.CDLL(os.path.join(bt, "arkli-mnn.dll"))

    class Cfg(C.Structure):
        """与 C 的 arkli_mnn_config 同布局。"""
        _fields_ = [("threads", C.c_int), ("memory", C.c_int), ("precision", C.c_int), ("rearrange", C.c_int)]

    lib.Cfg = Cfg
    lib.arkli_mnn_net_load.restype = C.c_void_p
    lib.arkli_mnn_net_load.argtypes = [C.c_char_p, C.c_char_p, C.POINTER(C.c_char_p), C.c_int, C.POINTER(C.c_char_p), C.c_int,
                                       C.POINTER(Cfg), C.c_char_p, C.c_int]
    lib.arkli_mnn_val_new.restype = C.c_void_p
    lib.arkli_mnn_val_new.argtypes = [C.c_int, C.POINTER(C.c_int32), C.c_int, C.c_void_p]
    lib.arkli_mnn_net_forward.argtypes = [C.c_void_p, C.POINTER(C.c_void_p), C.c_int, C.POINTER(C.c_void_p), C.c_int, C.c_char_p, C.c_int]
    lib.arkli_mnn_val_read.restype = C.c_void_p
    lib.arkli_mnn_val_read.argtypes = [C.c_void_p]
    lib.arkli_mnn_val_shape.argtypes = [C.c_void_p, C.POINTER(C.c_int32), C.c_int]
    lib.arkli_mnn_val_free.argtypes = [C.c_void_p]
    lib.arkli_mnn_net_free.argtypes = [C.c_void_p]
    return lib


class MnnModel:
    """MNN 对联图：输入 input_ids / position_ids（int32 [1, seq]），输出最后位置的 logits。"""

    def __init__(self, path, threads=THREADS):
        """加载 .mnn（旁边有 .weight 就当外置权重），memory=low。"""
        self.lib = load_dll()
        weight = path + ".weight"
        err = C.create_string_buffer(ERR_LEN)
        cfg = self.lib.Cfg(threads, MEMORY_LOW, 0, 1)
        ins = (C.c_char_p * 2)(b"input_ids", b"position_ids")
        outs = (C.c_char_p * 1)(b"logits")
        self.net = self.lib.arkli_mnn_net_load(path.encode(), weight.encode() if os.path.isfile(weight) else None,
                                               ins, 2, outs, 1, C.byref(cfg), err, ERR_LEN)
        if not self.net:
            die(f"加载失败：{path}：{err.value.decode(errors='replace')}")

    def run(self, ids):
        """整句前向，返回最后一个位置的 logits（float64 [21128]）。"""
        n = len(ids)
        a, p = np.array(ids, np.int32), np.arange(n, dtype=np.int32)
        shape = (C.c_int32 * 2)(1, n)
        vals = [self.lib.arkli_mnn_val_new(1, shape, 2, a.ctypes.data), self.lib.arkli_mnn_val_new(1, shape, 2, p.ctypes.data)]
        out = (C.c_void_p * 1)()
        err = C.create_string_buffer(ERR_LEN)
        rc = self.lib.arkli_mnn_net_forward(self.net, (C.c_void_p * 2)(*vals), 2, out, 1, err, ERR_LEN)
        if rc < 0:
            die(f"forward 失败：{err.value.decode(errors='replace')}")
        dims = (C.c_int32 * 8)()
        nd = self.lib.arkli_mnn_val_shape(out[0], dims, 8)
        cnt = int(np.prod([dims[i] for i in range(nd)]))
        ptr = self.lib.arkli_mnn_val_read(out[0])
        lg = np.ctypeslib.as_array(C.cast(ptr, C.POINTER(C.c_float)), shape=(cnt,)).astype(np.float64)
        for v in vals + [out[0]]:
            self.lib.arkli_mnn_val_free(v)
        return lg

    def close(self):
        """释放会话。"""
        self.lib.arkli_mnn_net_free(self.net)


class OrtModel:
    """ORT 对联图（原版带 past 的导出，传空 past 即整句重算）。"""

    def __init__(self, path, threads=THREADS):
        """加载 .onnx，CPU，指定线程数。"""
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.log_severity_level = 3
        self.s = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])

    def run(self, ids):
        """整句前向，返回最后一个位置的 logits（float64）。"""
        feed = {"input_ids": np.array([ids], np.int64), "position_ids": np.arange(len(ids), dtype=np.int64)[None]}
        for i in range(NL):
            for k in ("key", "value"):
                feed[f"past_key_values.{i}.{k}"] = np.zeros((1, NH, 0, HD), np.float32)
        return self.s.run(["logits"], feed)[0].reshape(-1).astype(np.float64)

    def close(self):
        """ORT 会话随对象回收，无需显式释放。"""


def open_model(path):
    """按扩展名选后端。"""
    return MnnModel(path) if path.endswith(".mnn") else OrtModel(path)


def log_softmax(x):
    """数值稳定的 log softmax。"""
    x = x - x.max()
    return x - np.log(np.exp(x).sum())


def main():
    """命令行入口。"""
    ap = argparse.ArgumentParser(description="对联模型桌面评测")
    ap.add_argument("variants", nargs="+", metavar="名字=路径")
    ap.add_argument("--onnx", default=os.path.join(dl_dir(), "couplet", "couplet-gpt2-fp32.onnx"), help="fp32 基准 onnx")
    ap.add_argument("--vocab", default=os.path.join(dl_dir(), "couplet", "vocab.txt"))
    ap.add_argument("--pairs", default=os.path.join(HERE, "data", "couplet", "pairs.tsv"))
    ap.add_argument("--json", help="结果存成 JSON")
    a = ap.parse_args()
    toks = [ln.rstrip("\n") for ln in open(a.vocab, encoding="utf-8")]
    t2i = {t: i for i, t in enumerate(toks)}
    han = np.array([len(t) == 1 and "一" <= t <= "鿿" for t in toks])
    pairs = [ln.rstrip("\n").split("\t") for ln in open(a.pairs, encoding="utf-8") if ln.strip()]
    ups = [p[0] for p in pairs]
    tgt = {p[0]: [t2i.get(c, UNK) for c in p[1]] + [SEP] for p in pairs}

    def enc(s):
        """字级编码，不在词表的字记 [UNK]。"""
        return [t2i.get(c, UNK) for c in s]

    def greedy(m, up):
        """等长约束贪心：返回下联 token 序列与每步 logits。"""
        ids, out, lgs = [CLS] + enc(up) + [t2i[DASH]], [], []
        for c in up:
            lg = m.run(ids + out)
            lgs.append(lg)
            mask = np.full(lg.shape, -1e30)
            if c in PUNCT and c in t2i:
                mask[t2i[c]] = 0
            else:
                mask[han] = 0
            out.append(int((lg + mask).argmax()))
        return out, lgs

    def forced(m, up):
        """真下联的 teacher forcing：每个位置一次整句前向。"""
        ids, t = [CLS] + enc(up) + [t2i[DASH]], tgt[up]
        return [m.run(ids + t[:i]) for i in range(len(t))]

    def ppl(fl):
        """困惑度：真下联加 [SEP] 的平均负对数似然取指数。"""
        nll = [-log_softmax(lg)[t] for u in ups for lg, t in zip(fl[u], tgt[u])]
        return float(np.exp(np.mean(nll)))

    def timing(m):
        """7 字下联生成总耗时中位数（ms）。"""
        greedy(m, TIME_UP)
        ts = []
        for _ in range(TIME_REPS):
            t0 = time.perf_counter()
            greedy(m, TIME_UP)
            ts.append((time.perf_counter() - t0) * 1000)
        return float(np.median(ts))

    ref = open_model(a.onnx)
    refgen, refpath = {}, {}
    for u in ups:
        refgen[u], refpath[u] = greedy(ref, u)
    res = {"n": len(ups), "ref_ppl": ppl({u: forced(ref, u) for u in ups}), "ref_ms7": timing(ref)}
    log(f"fp32 基准：{len(ups)} 条，困惑度 {res['ref_ppl']:.4f}，7 字 {res['ref_ms7']:.0f} ms（ORT，无 cache）")
    first = None
    for spec in a.variants:
        name, path = spec.split("=", 1)
        m = open_model(path)
        cos, mx, t1, t5, same, chs, nch = [], [], [], [], 0, 0, 0
        for u in ups:
            ids = [CLS] + enc(u) + [t2i[DASH]]
            for i, rl in enumerate(refpath[u]):
                lg = m.run(ids + refgen[u][:i])
                cos.append(float(lg @ rl / np.linalg.norm(lg) / np.linalg.norm(rl)))
                mx.append(float(np.abs(lg - rl).max()))
                t1.append(bool(lg.argmax() == rl.argmax()))
                t5.append(len(set(np.argsort(-lg)[:5]) & set(np.argsort(-rl)[:5])) / 5)
            g, _ = greedy(m, u)
            same += g == refgen[u]
            chs += sum(x == y for x, y in zip(g, refgen[u]))
            nch += len(g)
        r = {"cos_mean": float(np.mean(cos)), "cos_min": float(np.min(cos)), "maxabs_max": float(np.max(mx)), "top1": float(np.mean(t1)),
             "top5": float(np.mean(t5)), "sent_same": same / len(ups), "char_same": chs / nch, "ppl": ppl({u: forced(m, u) for u in ups})}
        r["ppl_pct"] = (r["ppl"] / res["ref_ppl"] - 1) * 100
        r["ms7"] = timing(m)
        res[name] = r
        log(f"{name}: " + json.dumps(r, ensure_ascii=False))
        m.close()
        first = first or (name, r)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=2)
    name, r = first
    ok = r["cos_mean"] >= GATE_COS and r["top1"] >= GATE_TOP1 and r["ppl_pct"] <= GATE_PPL_PCT
    log(f"门槛（{name}）：{'通过' if ok else '未通过'}")
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
