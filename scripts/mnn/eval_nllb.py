"""NLLB 翻译评测：以“ORT 跑拆图 fp32”为基准，比较 MNN 产物（及可选的现网 ORT int4 merged 包）。

解码规则与 arkli-ai translate 引擎一致：编码输入 [源语言码]+词+</s>；解码以 </s> 起步，第 0 步强制目标语言码，
step < ceil(0.7*源长) 时禁 eos；贪心，最多 64 个新 token。所有后端共用同一份分词。
指标：
  一致率   teacher forcing（喂基准的 token 序列）下逐步 top-1 与基准相同的比例；
  同句数   贪心输出的 token 序列与基准逐 token 相同的句数；
  退化句   输出含已知的“万能句”幻觉（DEGENERATE_MARKS）的句数；
  编码 ms、解码 ms/token、进程 RSS/峰值（每个后端各开子进程，互不污染）。
门槛（方案第 7 节）：MNN 产物一致率 >= 0.96 且退化句 = 0；不过退出码为 2。（`trim_tail_repeat` 触发次数要在 Rust 引擎测试里看。）

用法：
  python -I eval_nllb.py [--mnn-dir DIR] [--split-dir DIR] [--tokenizer tokenizer.json] [--sentences file.tsv]
                          [--embed int8|fp32] [--baseline-dir DIR] [--memory 2] [--threads 4] [--limit N] [--dump out.json]
默认：mnn-dir 取 out/nllb600m-un6-mnn-w6；split-dir 取 nllb_prepare 的输出；tokenizer 取 dl/nllb-tok-v2/tokenizer.json（vocab_build.py 的输出）；
sentences 取 scripts/mnn/data/sentences_m6.tsv（149 句，30 个有向语言对，由 make_eval_set.py 生成；列：源语言<TAB>目标语言<TAB>文本；
原 29 句版是 data/sentences.tsv）；
--baseline-dir 缺省取 dl/nllb-int4（存在才跑，fetch.py baseline）；注意 int4 现网包用的是旧词表 id，评测它必须同时用旧词表
（--tokenizer 指向随包 tokenizer.json，--split-dir 指向旧词表的拆图目录），否则 id 对不上。
--dump 把各后端逐句译文与 token 序列存成 JSON（跨词表对比、人工查看用）。--embed int8 就是产物实际用的 embed.i8/embed.scale。
"""
import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import HERE, MEMORY_LOW, THREADS, die, dl_dir, log, need_file, out_dir, split_dir  # noqa: E402
import nllb_embed  # noqa: E402

# 语言码、特殊 token id、解码规则常量（与 arkli-ai 的 model.json generation 一致）
LANG = {"zh-CN": "zho_Hans", "en": "eng_Latn", "fr": "fra_Latn", "es": "spa_Latn", "ru": "rus_Cyrl", "ar": "arb_Arab"}
EOS = 2
START = 2
MIN_RATIO = 0.7
MAX_NEW = 64
SPECIAL = {"<s>", "<pad>", "</s>", "<unk>"}
# 注意力头数/每头维度/模型宽度
HEADS, HEAD_DIM, D_MODEL = 16, 64, 1024
# 已知的退化“万能句”片段（现网 int4 会把几句无关输入都译成它）
DEGENERATE_MARKS = ["to be a little late"]
# 方案第 7 节门槛
GATE_AGREE = 0.96
# 子进程结果行前缀
RESULT_TAG = "@@RESULT@@"
# 三张 MNN 图
GRAPHS = ("encoder", "cross_kv", "decoder_step")


def load_tok(path):
    """加载 tokenizer.json；个别版本里 Precompiled 的 charsmap 为 null 会让 tokenizers 报错，先剔除再加载。"""
    from tokenizers import Tokenizer
    try:
        return Tokenizer.from_file(path)
    except Exception:
        j = json.load(open(path, encoding="utf-8"))

        def fix(node):
            if isinstance(node, dict):
                if node.get("type") == "Precompiled" and node.get("precompiled_charsmap") is None:
                    return None
                return {k: fix(v) for k, v in node.items()}
            if isinstance(node, list):
                return [x for x in (fix(v) for v in node) if x is not None]
            return node

        return Tokenizer.from_str(json.dumps(fix(j)))


class Embed:
    """图外嵌入查表：fp32（拆图目录的 npy）或产物实际用的逐行 int8 + scale。"""

    def __init__(self, mode, split, mnn_dir):
        if mode == "fp32":
            self.table = np.load(os.path.join(split, "embed_fp32.npy"))
            self.q = None
        else:
            self.q, self.s = nllb_embed.load(mnn_dir, D_MODEL)
            self.table = None

    def __call__(self, ids):
        """token id 列表 -> [1, n, 1024] float32。"""
        ids = np.asarray(ids)
        if self.table is not None:
            return self.table[ids][None].astype(np.float32)
        return (self.q[ids].astype(np.float32) * self.s[ids][:, None])[None]


class OrtMerged:
    """现网 ORT int4 包（encoder.onnx + decoder.onnx merged，词嵌入在图内）。"""

    def __init__(self, d, threads):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.log_severity_level = 3
        self.enc = ort.InferenceSession(os.path.join(d, "encoder.onnx"), so, providers=["CPUExecutionProvider"])
        self.dec = ort.InferenceSession(os.path.join(d, "decoder.onnx"), so, providers=["CPUExecutionProvider"])
        self.past = [i.name for i in self.dec.get_inputs() if i.name.startswith("past_key_values.")]

    def encode(self, ids):
        """编码：返回 encoder_hidden_states。"""
        a = np.array([ids], np.int64)
        return self.enc.run(None, {"input_ids": a, "attention_mask": np.ones_like(a)})[0]

    def start(self, hidden):
        """开始新句：清空 KV。"""
        self.state = {n: np.zeros((1, HEADS, 0, HEAD_DIM), np.float32) for n in self.past}
        self.hidden, self.step_i = hidden, 0

    def step(self, tok):
        """解码一步：返回最后位置的 logits。"""
        feed = {"input_ids": np.array([[tok]], np.int64), "encoder_attention_mask": np.ones((1, self.hidden.shape[1]), np.int64),
                "encoder_hidden_states": self.hidden, "use_cache_branch": np.array([self.step_i > 0])}
        feed.update(self.state)
        outs = dict(zip([o.name for o in self.dec.get_outputs()], self.dec.run(None, feed)))
        for n in self.past:
            if ".encoder." in n and self.step_i > 0:
                continue
            self.state[n] = outs[n.replace("past_key_values.", "present.")]
        self.step_i += 1
        return outs["logits"][0, -1]


class Split:
    """三图后端（encoder / cross_kv / decoder_step），kind 为 ort（拆图 fp32，基准）或 mnn（产物）。"""

    def __init__(self, kind, model_dir, split, embed, memory, threads):
        import onnx
        self.embed = embed
        self.io = {}
        for g in GRAPHS:  # 张量名取自拆图 ONNX（不加载权重）
            m = onnx.load(os.path.join(split, g + ".onnx"), load_external_data=False)
            self.io[g] = ([i.name for i in m.graph.input], [o.name for o in m.graph.output])
        self.kind = kind
        if kind == "ort":
            import onnxruntime as ort
            so = ort.SessionOptions()
            so.intra_op_num_threads = threads
            so.log_severity_level = 3
            self.s = {g: ort.InferenceSession(os.path.join(model_dir, g + ".onnx"), so, providers=["CPUExecutionProvider"]) for g in GRAPHS}
        else:
            import MNN
            self.F = MNN.expr
            self.s = {}
            for g in GRAPHS:
                # 每张图一个 RuntimeManager，外置权重路径各设各的（共用一个时要“设路径→加载→清空”）
                rt = MNN.nn.create_runtime_manager(({"backend": "CPU", "numThread": threads, "memory": memory, "precision": 0},))
                w = os.path.join(model_dir, g + ".mnn.weight")
                if os.path.isfile(w):
                    rt.set_external(w)
                self.s[g] = MNN.nn.load_module_from_file(os.path.join(model_dir, g + ".mnn"), self.io[g][0], self.io[g][1],
                                                         runtime_manager=rt, rearrange=True)
                self.rt = getattr(self, "rt", []) + [rt]  # 持有引用，防止被回收

    def run(self, g, feed):
        """跑一张图，返回 {输出名: ndarray}。"""
        ins, outs = self.io[g]
        if self.kind == "ort":
            return dict(zip(outs, self.s[g].run(outs, {k: feed[k] for k in ins})))
        F = self.F
        vs = []
        for k in ins:
            a = feed[k]
            if a.dtype == np.int64:  # int64 输入在 MNN 里是 int32
                vs.append(F.const(a.astype(np.int32), list(a.shape), F.NCHW, F.int))
            else:
                vs.append(F.const(a, list(a.shape), F.NCHW))
        return {k: np.array(F.convert(y, F.NCHW).read()) for k, y in zip(outs, self.s[g].forward(vs))}

    def encode(self, ids):
        """编码：返回 last_hidden_state。"""
        a = np.array([ids], np.int64)
        return self.run("encoder", {"input_ids": a, "attention_mask": np.ones_like(a), "inputs_embeds": self.embed(ids)})["last_hidden_state"]

    def start(self, hidden):
        """开始新句：算一次交叉 KV，自注意力 past 长度为 0。"""
        self.hidden, self.step_i = hidden, 0
        self.past = dict(self.run("cross_kv", {"encoder_hidden_states": hidden}))
        for n in self.io["decoder_step"][0]:
            if n.startswith("past_key_values.") and ".decoder." in n:
                self.past[n] = np.zeros((1, HEADS, 0, HEAD_DIM), np.float32)

    def step(self, tok):
        """解码一步：返回最后位置的 logits。"""
        feed = {"input_ids": np.array([[tok]], np.int64), "inputs_embeds": self.embed([tok]),
                "encoder_attention_mask": np.ones((1, self.hidden.shape[1]), np.int64), "encoder_hidden_states": self.hidden}
        feed.update(self.past)
        out = self.run("decoder_step", feed)
        for k, v in out.items():
            if k.startswith("present."):
                self.past[k.replace("present.", "past_key_values.")] = v
        self.step_i += 1
        return out["logits"].reshape(-1, out["logits"].shape[-1])[-1]


def decode(be, tok, src, tgt, text, force=None):
    """解码一句。force 给定时为 teacher forcing（按它的 token 走，只收集 logits）。
    返回 (译文, token 列表, 各步 logits, 编码秒, 解码秒)。"""
    ids = [tok.token_to_id(LANG[src])] + tok.encode(text, add_special_tokens=False).ids + [EOS]
    t0 = time.perf_counter()
    hidden = be.encode(ids)
    t_enc = time.perf_counter() - t0
    be.start(hidden)
    min_len = math.ceil(MIN_RATIO * len(ids))
    forced = tok.token_to_id(LANG[tgt])
    cur, gen, logits_all = START, [], []
    steps = len(force) + 1 if force is not None else MAX_NEW
    t1 = time.perf_counter()
    for step in range(steps):
        lg = be.step(cur)
        if step == 0:
            nxt = forced
        else:
            logits_all.append(lg.astype(np.float32))
            l2 = lg.copy()
            if step < min_len:
                l2[EOS] = -np.inf
            nxt = int(np.argmax(l2))
        if force is not None:
            if step >= len(force):
                break
            nxt = force[step]
        if nxt == EOS:
            break
        gen.append(nxt)
        cur = nxt
    t_dec = time.perf_counter() - t1
    keep = [i for i in gen if tok.id_to_token(i) not in SPECIAL and i != forced]
    return tok.decode(keep, skip_special_tokens=False).strip(), gen, logits_all, t_enc, t_dec


def read_sentences(path):
    """读 TSV：源语言、目标语言、文本。"""
    rows = [l.rstrip("\n").split("\t") for l in open(path, encoding="utf-8") if l.strip()]
    return [r for r in rows if len(r) == 3]


def run_one(a):
    """子进程入口：跑单个后端，把译文/token/logits 存到 --result 前缀，打印性能 JSON。
    若给了 --ref（基准结果前缀）就额外做 teacher forcing 对比。"""
    import psutil
    tok = load_tok(a.tokenizer)
    rows = read_sentences(a.sentences)[: a.limit or None]
    base_rss = psutil.Process().memory_info().rss
    t0 = time.perf_counter()
    if a.one == "ort-int4":
        be = OrtMerged(a.baseline_dir, a.threads)
    elif a.one == "ort-split":
        be = Split("ort", a.split_dir, a.split_dir, Embed("fp32", a.split_dir, a.mnn_dir), 0, a.threads)
    else:
        be = Split("mnn", a.mnn_dir, a.split_dir, Embed(a.embed, a.split_dir, a.mnn_dir), a.memory, a.threads)
    load_s = time.perf_counter() - t0
    ref = json.load(open(a.ref + ".json", encoding="utf-8")) if a.ref else None
    recs, all_logits, tenc, tdec, ntok = [], {}, 0.0, 0.0, 0
    agree = total = 0
    maxdiff = 0.0
    for i, (src, tgt, text) in enumerate(rows):
        out, gen, lg, te, td = decode(be, tok, src, tgt, text)
        tenc += te
        tdec += td
        ntok += len(gen)
        recs.append({"src": src, "tgt": tgt, "text": text, "out": out, "gen": gen})
        all_logits[f"l{i}"] = np.array(lg, np.float32)
        if ref:
            _, _, lg2, _, _ = decode(be, tok, src, tgt, text, force=ref["recs"][i]["gen"])
            ref_lg = np.load(a.ref + ".npz")[f"l{i}"]
            n = min(len(lg2), len(ref_lg))
            for x, y in zip(lg2[:n], ref_lg[:n]):
                agree += int(np.argmax(x) == np.argmax(y))
                total += 1
                maxdiff = max(maxdiff, float(np.max(np.abs(x - y))))
    mi = psutil.Process().memory_info()
    perf = {"load_s": load_s, "enc_ms": 1000 * tenc / len(rows), "dec_ms_tok": 1000 * tdec / max(ntok, 1),
            "rss_mb": (mi.rss - base_rss) / 2**20, "peak_mb": (getattr(mi, "peak_wset", mi.rss) - base_rss) / 2**20,
            "agree": agree, "total": total, "maxdiff": maxdiff}
    if a.result:
        json.dump({"recs": recs, "perf": perf}, open(a.result + ".json", "w", encoding="utf-8"), ensure_ascii=False)
        np.savez_compressed(a.result + ".npz", **all_logits)
    print(RESULT_TAG + json.dumps(perf))


def spawn(a, kind, result, ref=None):
    """开子进程跑一个后端，返回 (记录列表, 性能字典)。"""
    cmd = [sys.executable, "-I", os.path.abspath(__file__), "--one", kind, "--result", result, "--mnn-dir", a.mnn_dir,
           "--split-dir", a.split_dir, "--tokenizer", a.tokenizer, "--sentences", a.sentences, "--embed", a.embed,
           "--memory", str(a.memory), "--threads", str(a.threads), "--limit", str(a.limit)]
    if a.baseline_dir:
        cmd += ["--baseline-dir", a.baseline_dir]
    if ref:
        cmd += ["--ref", ref]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 or RESULT_TAG not in r.stdout:
        print(r.stderr[-2500:], file=sys.stderr)
        die(f"后端 {kind} 运行失败")
    d = json.load(open(result + ".json", encoding="utf-8"))
    return d["recs"], d["perf"]


def main():
    """命令行入口：先跑基准，再跑各后端，汇总表格并判门槛。"""
    ap = argparse.ArgumentParser(description="NLLB 翻译评测")
    ap.add_argument("--mnn-dir", default=os.path.join(out_dir(), "nllb600m-un6-mnn-w6"))
    ap.add_argument("--split-dir", default=split_dir())
    ap.add_argument("--tokenizer", default=os.path.join(dl_dir(), "nllb-tok-v2", "tokenizer.json"))
    ap.add_argument("--sentences", default=os.path.join(HERE, "data", "sentences_m6.tsv"))
    ap.add_argument("--embed", choices=["int8", "fp32"], default="int8")
    ap.add_argument("--baseline-dir", default=None, help="现网 ORT int4 包目录（缺省取 dl/nllb-int4）")
    ap.add_argument("--memory", type=int, default=MEMORY_LOW)
    ap.add_argument("--threads", type=int, default=THREADS)
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 句（0 为全部）")
    ap.add_argument("--dump", help="把各后端逐句译文与指标存成 JSON")
    ap.add_argument("--one", choices=["ort-split", "ort-int4", "mnn"], help="内部用")
    ap.add_argument("--result", help="内部用")
    ap.add_argument("--ref", help="内部用")
    a = ap.parse_args()
    if a.baseline_dir is None:
        d = os.path.join(dl_dir(), "nllb-int4")
        a.baseline_dir = d if os.path.isfile(os.path.join(d, "decoder.onnx")) else None
    if a.one:
        run_one(a)
        return
    need_file(a.tokenizer, "先运行 fetch.py nllb")
    need_file(a.sentences)
    for g in GRAPHS:
        need_file(os.path.join(a.split_dir, g + ".onnx"), "先运行 convert_all.py nllb（会生成拆图）")
        need_file(os.path.join(a.mnn_dir, g + ".mnn"), "先运行 convert_all.py nllb")
    tmp = tempfile.mkdtemp(prefix="arkli-eval-nllb-")
    ref_prefix = os.path.join(tmp, "ref")
    log("基准：ORT 拆图 fp32 ...")
    ref_recs, ref_perf = spawn(a, "ort-split", ref_prefix)
    rows = [("ORT 拆图 fp32（基准）", ref_recs, ref_perf)]
    if a.baseline_dir:
        log("对照：现网 ORT int4 merged ...")
        recs, perf = spawn(a, "ort-int4", os.path.join(tmp, "int4"), ref_prefix)
        rows.append(("ORT int4 现网", recs, perf))
    log(f"产物：MNN {os.path.basename(a.mnn_dir)}（embed={a.embed} memory={a.memory}）...")
    recs, perf = spawn(a, "mnn", os.path.join(tmp, "mnn"), ref_prefix)
    rows.append((f"MNN {os.path.basename(a.mnn_dir)}", recs, perf))

    log("")
    for i, rec in enumerate(ref_recs):
        line = [f"{rec['src']}->{rec['tgt']}", rec["text"], "|", ref_recs[i]["out"]]
        for name, rs, _ in rows[1:]:
            line += ["|", rs[i]["out"]]
        log("\t".join(line))
    log("")
    log("配置\t一致率\t与基准同句\t退化句\t撞长度上限句\t编码ms\t解码ms/token\t稳态RSS增量MB\t峰值增量MB")
    gate = None
    metrics = []
    for name, rs, p in rows:
        same = sum(r["gen"] == b["gen"] for r, b in zip(rs, ref_recs))
        degen = sum(any(m in r["out"] for m in DEGENERATE_MARKS) for r in rs)
        capped = sum(len(r["gen"]) >= MAX_NEW for r in rs)
        rate = p["agree"] / p["total"] if p["total"] else 1.0
        log(f"{name}\t{rate:.1%}\t{same}/{len(rs)}\t{degen}\t{capped}\t{p['enc_ms']:.0f}\t{p['dec_ms_tok']:.1f}\t{p['rss_mb']:.0f}\t{p['peak_mb']:.0f}")
        metrics.append({"name": name, "agree": p["agree"], "total": p["total"], "rate": rate, "same": same, "n": len(rs),
                        "degenerate": degen, "capped": capped, "perf": p})
        gate = (rate, degen)
    if a.dump:
        with open(a.dump, "w", encoding="utf-8") as f:
            json.dump({"sentences": [[r["src"], r["tgt"], r["text"]] for r in ref_recs], "metrics": metrics,
                       "backends": [{"name": n, "outs": [r["out"] for r in rs], "gens": [r["gen"] for r in rs]} for n, rs, _ in rows]},
                      f, ensure_ascii=False)
    ok = gate[0] >= GATE_AGREE and gate[1] == 0
    log(f"门槛（一致率>={GATE_AGREE}、退化句=0）：{'通过' if ok else '未通过'}")
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
