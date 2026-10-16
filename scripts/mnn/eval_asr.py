"""语音（流式 zipformer2 transducer）评测：ORT fp32 为基准，对比 MNN 产物（及可选的现网 ORT int8）的识别文字、编码器实时率与进程内存。

做法：特征用 numpy 自写的 Kaldi fbank（povey 窗、25ms/10ms、80 维、snip_edges=False、无抖动），所有后端共用同一份特征；
解码是流式贪心（逻辑同模型包里的 test_onnx.py）。每个后端各开一个子进程，RSS 才互不污染。
门槛（方案第 7 节）：MNN 产物（memory=low）每条测试音频与 ORT fp32 逐字一致；不一致退出码为 2。

用法：
  python -I eval_asr.py [--mnn-dir DIR] [--fp32-dir DIR] [--int8-dir DIR] [--wavs a.wav b.wav ...] [--memory 2] [--threads 4]
默认：fp32-dir 取 fetch.py 解压的 dl/asr/fp32 里的模型目录；mnn-dir 取 out/asr-zipformer-zh-en-mnn-w8；
int8-dir 取 dl/asr/int8（存在才跑，需先 fetch.py baseline）；wavs 取 fp32 包里的 test_wavs/*.wav（16kHz 单声道 16 位）。
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import time
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MEMORY_LOW, THREADS, die, dl_dir, find_asr_model_dir, log, need_file, out_dir  # noqa: E402

# 特征参数：采样率、帧长/帧移（样本数）、FFT 点数、梅尔维数、预加重系数、最低频率
SR = 16000
FRAME_LEN, FRAME_SHIFT, NFFT, NMEL = 400, 160, 512, 80
PREEMPH, LOW_FREQ = 0.97, 20.0
EPS = np.finfo(np.float32).eps
# 尾部补的静音帧数（让最后一个 chunk 能吐完）
TAIL_PAD_FRAMES = 100
# 三个子网络的文件名主干与词表文件
ENC, DEC, JOI, TOKENS = "encoder", "decoder", "joiner", "tokens.txt"
# 子进程输出结果的行前缀
RESULT_TAG = "@@RESULT@@"


def mel(f):
    """赫兹转梅尔刻度。"""
    return 1127.0 * np.log(1.0 + f / 700.0)


def mel_banks():
    """构造 Kaldi 风格的三角梅尔滤波器组 [NMEL, NFFT/2]。"""
    nb = NFFT // 2
    fft_bin_width = SR / NFFT
    lo, hi = mel(LOW_FREQ), mel(SR / 2)
    delta = (hi - lo) / (NMEL + 1)
    banks = np.zeros((NMEL, nb), np.float32)
    freqs = mel(fft_bin_width * np.arange(nb))
    for m in range(NMEL):
        l, c, r = lo + m * delta, lo + (m + 1) * delta, lo + (m + 2) * delta
        up = (freqs - l) / (c - l)
        down = (r - freqs) / (r - c)
        banks[m] = np.where((freqs > l) & (freqs < r), np.minimum(up, down), 0.0)
    return banks


BANKS = mel_banks()
WINDOW = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(FRAME_LEN) / (FRAME_LEN - 1))) ** 0.85


def fbank(samples):
    """samples(float32,[-1,1]) -> 对数梅尔特征 [帧数+尾部补零, 80]。"""
    n = len(samples)
    nf = (n + FRAME_SHIFT // 2) // FRAME_SHIFT
    out = np.empty((nf, NMEL), np.float32)
    for i in range(nf):
        start = i * FRAME_SHIFT + FRAME_SHIFT // 2 - FRAME_LEN // 2
        idx = np.arange(start, start + FRAME_LEN)
        idx = np.where(idx < 0, -idx - 1, idx)  # snip_edges=False：两端镜像
        idx = np.where(idx >= n, 2 * n - 1 - idx, idx)
        x = samples[idx].astype(np.float64)
        x = x - x.mean()
        x[1:] = x[1:] - PREEMPH * x[:-1]
        x[0] = x[0] - PREEMPH * x[0]
        x = x * WINDOW
        spec = np.abs(np.fft.rfft(x, NFFT)) ** 2
        out[i] = np.log(np.maximum(BANKS @ spec[: NFFT // 2], EPS))
    return np.pad(out, ((0, TAIL_PAD_FRAMES), (0, 0)))


def read_wav(p):
    """读 16kHz 16 位 wav，返回 float32 单声道。"""
    with wave.open(p, "rb") as w:
        if w.getframerate() != SR or w.getsampwidth() != 2:
            die(f"{p} 必须是 {SR}Hz 16 位 wav")
        a = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
        if w.getnchannels() > 1:
            a = a.reshape(-1, w.getnchannels())[:, 0]
    return a


class OrtBackend:
    """ORT 后端：编码器/解码器/联合网络三个会话。"""

    def __init__(self, d, threads):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.log_severity_level = 3

        def mk(stem):
            # 兼容 int8 包的文件名（encoder.int8.onnx）
            p = os.path.join(d, stem + ".onnx")
            if not os.path.isfile(p):
                p = os.path.join(d, stem + ".int8.onnx")
            return ort.InferenceSession(need_file(p), so, providers=["CPUExecutionProvider"])

        self.e, self.dd, self.j = mk(ENC), mk(DEC), mk(JOI)
        meta = self.e.get_modelmeta().custom_metadata_map
        self.T, self.shift = int(meta["T"]), int(meta["decode_chunk_len"])
        self.ctx = int(self.dd.get_modelmeta().custom_metadata_map["context_size"])
        self.state_in = self.e.get_inputs()[1:]
        self.out_names = [o.name for o in self.e.get_outputs()]

    def init_states(self):
        """编码器的初始（全零）状态列表。"""
        dts = {"tensor(float)": np.float32, "tensor(int64)": np.int64, "tensor(int32)": np.int32}
        return [np.zeros([1 if isinstance(s, str) else s for s in n.shape], dts[n.type]) for n in self.state_in]

    def encoder(self, x, st):
        """跑一个 chunk，返回 (编码输出, 新状态)。"""
        feed = {self.e.get_inputs()[0].name: x}
        feed.update({n.name: s for n, s in zip(self.state_in, st)})
        out = self.e.run(self.out_names, feed)
        return out[0], out[1:]

    def decoder(self, hyp):
        """预测网络：最近 context 个 token -> 解码器输出。"""
        return self.dd.run(None, {self.dd.get_inputs()[0].name: np.array([hyp], np.int64)})[0]

    def joiner(self, e, d):
        """联合网络：编码帧 + 解码输出 -> logits。"""
        return self.j.run(None, {self.j.get_inputs()[0].name: e, self.j.get_inputs()[1].name: d})[0]


class MnnBackend(OrtBackend):
    """MNN 后端：张量名与状态形状取自 fp32 ONNX（只读元数据，不加载权重），推理走 MNN。"""

    def __init__(self, mnn_dir, onnx_dir, threads, memory):
        import onnx
        import MNN
        self.F = MNN.expr

        def meta(stem):
            m = onnx.load(os.path.join(onnx_dir, stem + ".onnx"), load_external_data=False)
            return m, {p.key: p.value for p in m.metadata_props}

        me, em = meta(ENC)
        md, dm = meta(DEC)
        mj, _ = meta(JOI)
        self.T, self.shift, self.ctx = int(em["T"]), int(em["decode_chunk_len"]), int(dm["context_size"])
        enc_in = [i.name for i in me.graph.input]
        enc_out = [o.name for o in me.graph.output]
        self.state_shapes = [([d.dim_value if d.dim_value else 1 for d in i.type.tensor_type.shape.dim], i.type.tensor_type.elem_type)
                             for i in me.graph.input[1:]]
        rt = MNN.nn.create_runtime_manager(({"backend": "CPU", "numThread": threads, "memory": memory, "precision": 0},))

        def ld(stem, i, o):
            return MNN.nn.load_module_from_file(os.path.join(mnn_dir, stem + ".mnn"), i, o, runtime_manager=rt, rearrange=True)

        self.e = ld(ENC, enc_in, enc_out)
        self.dd = ld(DEC, [md.graph.input[0].name], [md.graph.output[0].name])
        self.j = ld(JOI, [i.name for i in mj.graph.input], [mj.graph.output[0].name])

    def init_states(self):
        """全零初始状态（int64 状态在 MNN 里按 int32）。"""
        return [np.zeros(s, np.float32 if t == 1 else np.int32) for s, t in self.state_shapes]

    def _c(self, a):
        """numpy -> MNN 常量（整型按 int32）。"""
        F = self.F
        if a.dtype in (np.int64, np.int32):
            return F.const(a.astype(np.int32), list(a.shape), F.NCHW, F.int)
        return F.const(a.astype(np.float32), list(a.shape), F.NCHW)

    def _r(self, v):
        """MNN 变量 -> numpy。"""
        return np.array(self.F.convert(v, self.F.NCHW).read())

    def encoder(self, x, st):
        """跑一个 chunk（同 OrtBackend.encoder）。"""
        ys = [self._r(y) for y in self.e.forward([self._c(x)] + [self._c(s) for s in st])]
        return ys[0], [y.astype(s.dtype) for y, s in zip(ys[1:], st)]

    def decoder(self, hyp):
        """预测网络（同 OrtBackend.decoder）。"""
        return self._r(self.dd.forward([self._c(np.array([hyp], np.int32))])[0])

    def joiner(self, e, d):
        """联合网络（同 OrtBackend.joiner）。"""
        return self._r(self.j.forward([self._c(e), self._c(d)])[0])


def recognize(be, feats, id2tok):
    """流式贪心解码一条音频；返回 (文字, 编码器总耗时秒)。"""
    st = be.init_states()
    hyp = [0] * be.ctx
    dout = be.decoder(hyp)
    start, t_enc = 0, 0.0
    while start + be.T < feats.shape[0]:
        x = feats[start:start + be.T][None]
        start += be.shift
        t = time.perf_counter()
        eo, st = be.encoder(x, st)
        t_enc += time.perf_counter() - t
        for k in range(eo.shape[1]):
            tid = int(be.joiner(eo[0, k:k + 1], dout).argmax())
            if tid != 0:
                hyp.append(tid)
                dout = be.decoder(hyp[-be.ctx:])
    return "".join(id2tok[i] for i in hyp[be.ctx:]).replace("▁", " ").strip(), t_enc


def run_one(a):
    """子进程入口：跑单个后端，打印一行 JSON 结果。"""
    import psutil
    id2tok = {}
    for line in open(os.path.join(a.fp32_dir, TOKENS), encoding="utf-8"):
        t, k = line.rstrip("\n").rsplit(" ", 1)
        id2tok[int(k)] = t
    t0 = time.perf_counter()
    if a.one == "mnn":
        be = MnnBackend(a.mnn_dir, a.fp32_dir, a.threads, a.memory)
    else:
        be = OrtBackend(a.fp32_dir if a.one == "ort-fp32" else a.int8_dir, a.threads)
    load_s = time.perf_counter() - t0
    texts, audio, enc = [], 0.0, 0.0
    for w in a.wavs:
        s = read_wav(w)
        text, te = recognize(be, fbank(s), id2tok)
        texts.append(text)
        audio += len(s) / SR
        enc += te
    mi = psutil.Process().memory_info()
    print(RESULT_TAG + json.dumps({"texts": texts, "load_s": load_s, "rtf": enc / audio, "rss_mb": mi.rss / 2**20,
                                   "peak_mb": getattr(mi, "peak_wset", mi.rss) / 2**20}, ensure_ascii=False))


def find_int8_dir():
    """在 dl/asr/int8 里找现网 int8 包的模型目录；没有返回 None。"""
    root = os.path.join(dl_dir(), "asr", "int8")
    for dp, _d, fs in os.walk(root):
        if any(f.startswith("encoder") and f.endswith(".onnx") for f in fs):
            return dp
    return None


def main():
    """命令行入口：各后端各开子进程，汇总对照表并判门槛。"""
    ap = argparse.ArgumentParser(description="语音识别评测（ORT fp32 vs MNN）")
    ap.add_argument("--fp32-dir", default=None, help="fp32 ONNX 模型目录（缺省取 dl/asr/fp32 里含 encoder.onnx 的那层）")
    ap.add_argument("--mnn-dir", default=os.path.join(out_dir(), "asr-zipformer-zh-en-mnn-w8"))
    ap.add_argument("--int8-dir", default=None, help="现网 ORT int8 模型目录（缺省取 dl/asr/int8；不存在则跳过）")
    ap.add_argument("--wavs", nargs="*", default=None)
    ap.add_argument("--memory", type=int, default=MEMORY_LOW)
    ap.add_argument("--threads", type=int, default=THREADS)
    ap.add_argument("--one", choices=["ort-fp32", "ort-int8", "mnn"], help="内部用：只跑一个后端")
    a = ap.parse_args()
    a.fp32_dir = a.fp32_dir or find_asr_model_dir(os.path.join(dl_dir(), "asr", "fp32"))
    a.int8_dir = a.int8_dir or find_int8_dir()
    a.wavs = a.wavs or sorted(glob.glob(os.path.join(a.fp32_dir, "test_wavs", "*.wav")))
    if not a.wavs:
        die("没有测试音频（--wavs 或包内 test_wavs）")
    if a.one:
        run_one(a)
        return
    for m in (ENC, DEC, JOI):
        need_file(os.path.join(a.mnn_dir, m + ".mnn"), "先运行 convert_all.py asr")
    plan = [("ort-fp32", "ORT fp32（基准）")]
    if a.int8_dir:
        plan.append(("ort-int8", "ORT int8（现网）"))
    plan.append(("mnn", f"MNN {os.path.basename(a.mnn_dir)} memory={a.memory}"))
    res = {}
    for kind, label in plan:
        cmd = [sys.executable, "-I", os.path.abspath(__file__), "--one", kind, "--fp32-dir", a.fp32_dir, "--mnn-dir", a.mnn_dir,
               "--memory", str(a.memory), "--threads", str(a.threads)]
        if a.int8_dir:
            cmd += ["--int8-dir", a.int8_dir]
        cmd += ["--wavs", *a.wavs]
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        line = next((x for x in r.stdout.splitlines() if x.startswith(RESULT_TAG)), None)
        if r.returncode != 0 or not line:
            print(r.stderr[-2000:], file=sys.stderr)
            die(f"后端 {kind} 运行失败")
        res[kind] = json.loads(line[len(RESULT_TAG):])
        log(f"== {label}")
        for w, t in zip(a.wavs, res[kind]["texts"]):
            log(f"{os.path.basename(w)}\t{t}")
        x = res[kind]
        log(f"SUMMARY load_s={x['load_s']:.2f} encoder_RTF={x['rtf']:.3f} rss_MB={x['rss_mb']:.0f} peak_MB={x['peak_mb']:.0f}")
    same = sum(p == q for p, q in zip(res["mnn"]["texts"], res["ort-fp32"]["texts"]))
    log(f"MNN 与 ORT fp32 逐字一致：{same}/{len(a.wavs)}")
    sys.exit(0 if same == len(a.wavs) else 2)


if __name__ == "__main__":
    main()
