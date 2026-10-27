"""桌面批量跑 SDXS-512 一步出图，生成单色剪影符号（对齐 App 的 Rust 流水线）。

流水线与 core/crates/arkli-ai 的 logo_gen.rs / logo_post.rs 保持一致：
CLIP 分词(77) -> text_encoder -> unet(t=999, 噪声来自 SplitMix64+Box-Muller)
-> latent = c1*x - c2*eps -> TAESD vae_decoder -> 灰度 -> 大津法二值化 -> 去外圈 -> 质量闸门。

依赖：numpy、Pillow（不依赖 MNN 的 Python 包，经 ctypes 调 arkli-mnn.dll）。

命令行：
    python -I scripts/mnn/sdxs_glyph.py --out <目录> --item coffee="a coffee bean" \
        --item rocket="a rocket" --seeds 4

库用法：
    from sdxs_glyph import GlyphEngine
    eng = GlyphEngine()
    r = eng.generate("a rocket", seed=1)   # r.gray / r.mask / r.gate_ok / r.reasons
"""
import argparse
import ctypes
import json
import math
import os
import re
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

# ---------- 路径与常量 ----------

# 仓库根目录
ROOT = Path(__file__).resolve().parents[2]
# 默认模型目录（w8 外置权重版）
DEFAULT_MODEL_DIR = ROOT / "native/mnn/.work/convert/out/sdxs512-mnn-w8"
# 默认桌面 MNN 运行时目录
DEFAULT_RT_DIR = ROOT / "native/mnn/.work/build-tools"
# 提示词模板，{} 处填概念词
PROMPT_TEMPLATE = ("flat pictogram glyph of {}, solid black emoji silhouette, "
                   "bold simple shape, minimalist icon, white background")

TOKEN_LEN = 77
TOKEN_EOS = 49407
LATENT_SHAPE = (1, 4, 64, 64)
LATENT_ELEMS = 4 * 64 * 64
TEXT_SHAPE = (1, TOKEN_LEN, 768)
SIDE = 512
N_TRAIN_STEPS = 1000
BETA_START, BETA_END = 0.00085, 0.012
ERR_LEN = 512
# MNN 张量类型码（见 arkli_mnn_capi.h）
F32, I32 = 0, 1
# MNN 内存模式 low
MEMORY_LOW = 2

# 二值化与外圈检测参数（同 logo_post.rs）
BINARIZE_MIN_AREA = 0.0008
RING_MIN_SPAN, RING_ASPECT_MIN, RING_ASPECT_MAX = 0.7, 0.85, 1.18
RING_BAND_ON, RING_BAND_OFF = 0.5, 0.3
RING_THICK_MIN, RING_THICK_MAX = 0.03, 0.35
RING_CUT_MARGIN = 5.0
RING_RESIDUAL_MIN_AREA = 30
EMPTY_INK = 50
ROT_ANGLES = (29.0, 61.0, 103.0)
BIG_AREA_RATIO = 0.0005
SPECK_AREA_MIN = 20
# 闸门阈值（同 gate.py / logo_post.rs）
GATE_INK_MIN, GATE_INK_MAX = 0.02, 0.2
GATE_ROT_MAX = 0.7
GATE_COMPS_MAX, GATE_SPECKS_MAX = 2, 1
GATE_SIZE_MIN, GATE_OFF_MAX = 0.5, 0.12


# ---------- CLIP BPE 分词（只读 tokenizer.json，不依赖 tokenizers 库） ----------

def _bytes_to_unicode():
    """GPT-2/CLIP 的字节到可见字符映射。"""
    bs = list(range(33, 127)) + list(range(161, 173)) + list(range(174, 256))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return {b: chr(c) for b, c in zip(bs, cs)}


# 预分词正则：\p{L} 近似为 [^\W\d_]，\p{N} 近似为 \d（英文提示词够用）
_PRETOK = re.compile(r"'s|'t|'re|'ve|'m|'ll|'d|[^\W\d_]+|\d|[^\s\w]+|_+")


class ClipTokenizer:
    """CLIP BPE 分词器，等价于 tokenizer.json 的 BPE 配置。

    参数：path 为 tokenizer.json 路径。
    示例：ClipTokenizer(p).encode("a cat") -> 长度 77 的 int 列表
    """

    def __init__(self, path):
        d = json.loads(Path(path).read_text(encoding="utf8"))
        m = d["model"]
        self.vocab = m["vocab"]
        self.ranks = {}
        for i, mg in enumerate(m["merges"]):
            pair = tuple(mg.split(" ")) if isinstance(mg, str) else tuple(mg)
            self.ranks[pair] = i
        self.suffix = m.get("end_of_word_suffix") or "</w>"
        self.unk = self.vocab[m.get("unk_token") or "<|endoftext|>"]
        self.b2u = _bytes_to_unicode()
        self.cache = {}
        self.bos = self.vocab["<|startoftext|>"] if "<|startoftext|>" in self.vocab else 49406
        assert self.bos == 49406, "BOS id 不符"

    def _bpe(self, word):
        """对一个预分词单元做 BPE，返回 token id 列表。"""
        if word in self.cache:
            return self.cache[word]
        syms = list(word)
        syms[-1] += self.suffix
        while len(syms) > 1:
            best, bi = None, -1
            for i in range(len(syms) - 1):
                r = self.ranks.get((syms[i], syms[i + 1]))
                if r is not None and (best is None or r < best):
                    best, bi = r, i
            if best is None:
                break
            syms[bi:bi + 2] = [syms[bi] + syms[bi + 1]]
        ids = [self.vocab.get(s, self.unk) for s in syms]
        self.cache[word] = ids
        return ids

    def encode(self, text):
        """分词并补齐/截断到 77（超长保留前 76 个，末位置 EOS）。"""
        text = re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).lower()
        ids = [self.bos]
        for piece in _PRETOK.findall(text):
            word = "".join(self.b2u[b] for b in piece.encode("utf8"))
            ids.extend(self._bpe(word))
        ids.append(TOKEN_EOS)
        out = [TOKEN_EOS] * TOKEN_LEN
        if len(ids) > TOKEN_LEN:
            out[:TOKEN_LEN - 1] = ids[:TOKEN_LEN - 1]
        else:
            out[:len(ids)] = ids
        return out


# ---------- 噪声与一步采样 ----------

def noise_from_seed(seed):
    """SplitMix64 + Box-Muller 的确定性高斯噪声，与 Rust 的 noise_from_seed 同序。

    参数：seed 为非负整数。返回：长度 16384 的 float32 数组。
    """
    mask64 = (1 << 64) - 1
    state = seed & mask64

    def nxt():
        nonlocal state
        state = (state + 0x9E3779B97F4A7C15) & mask64
        z = state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & mask64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & mask64
        return z ^ (z >> 31)

    def f64():
        while True:
            v = (nxt() >> 11) / 9007199254740992.0
            if 0.0 < v < 1.0:
                return v

    out = np.empty(LATENT_ELEMS, dtype=np.float32)
    for i in range(LATENT_ELEMS // 2):
        u1, u2 = f64(), f64()
        r = math.sqrt(-2.0 * math.log(u1))
        th = 2.0 * math.pi * u2
        out[2 * i] = r * math.cos(th)
        out[2 * i + 1] = r * math.sin(th)
    return out


def step_coeffs():
    """一步采样系数 (c1, c2)，约 (14.6444, 14.6040)；按 diffusers 的 float32 调度表现算。"""
    n = N_TRAIN_STEPS
    b0 = np.float32(math.sqrt(BETA_START))
    b1 = np.float32(math.sqrt(BETA_END))
    ac, prod = [], np.float32(1.0)
    for i in range(n):
        b = b0 + np.float32(i / (n - 1)) * (b1 - b0)
        prod = np.float32(prod * (np.float32(1.0) - b * b))
        ac.append(float(prod))
    ac_s, ac_n = ac[999], ac[0]
    s0 = math.sqrt((1 - ac_s) / max(ac_s, 1e-12))
    s1 = math.sqrt((1 - ac_n) / max(ac_n, 1e-12))
    a_s = 1 / math.sqrt(s0 * s0 + 1)
    a_n = 1 / math.sqrt(s1 * s1 + 1)
    sg_s, sg_n = s0 * a_s, s1 * a_n
    h = (math.log(a_n) - math.log(sg_n)) - (math.log(a_s) - math.log(sg_s))
    return a_n / a_s, sg_n * (math.exp(h) - 1.0)


# ---------- MNN C API（ctypes） ----------

class _Cfg(ctypes.Structure):
    """对应 arkli_mnn_config。"""
    _fields_ = [("threads", ctypes.c_int), ("memory", ctypes.c_int), ("precision", ctypes.c_int),
                ("power", ctypes.c_int), ("rearrange", ctypes.c_int)]


class MnnLib:
    """arkli-mnn.dll 的薄封装：加载图、前向，张量以 numpy 进出。

    参数：rt_dir 为含 MNN.dll 与 arkli-mnn.dll 的目录。
    """

    def __init__(self, rt_dir):
        rt_dir = str(rt_dir)
        os.add_dll_directory(rt_dir)
        ctypes.CDLL(os.path.join(rt_dir, "MNN.dll"))
        d = ctypes.CDLL(os.path.join(rt_dir, "arkli-mnn.dll"))
        vp = ctypes.c_void_p
        d.arkli_mnn_abi_version.restype = ctypes.c_int
        d.arkli_mnn_net_load.restype = vp
        d.arkli_mnn_net_load.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_char_p),
                                         ctypes.c_int, ctypes.POINTER(ctypes.c_char_p), ctypes.c_int,
                                         ctypes.POINTER(_Cfg), ctypes.c_char_p, ctypes.c_int]
        d.arkli_mnn_val_new.restype = vp
        d.arkli_mnn_val_new.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_int32), ctypes.c_int, vp]
        d.arkli_mnn_val_shape.argtypes = [vp, ctypes.POINTER(ctypes.c_int32), ctypes.c_int]
        d.arkli_mnn_val_read.restype = vp
        d.arkli_mnn_val_read.argtypes = [vp]
        d.arkli_mnn_net_forward.argtypes = [vp, ctypes.POINTER(vp), ctypes.c_int, ctypes.POINTER(vp),
                                            ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
        d.arkli_mnn_val_free.argtypes = [vp]
        d.arkli_mnn_net_free.argtypes = [vp]
        d.arkli_mnn_config_default.argtypes = [ctypes.POINTER(_Cfg)]
        self.d = d
        if d.arkli_mnn_abi_version() != 2:
            raise RuntimeError("arkli-mnn ABI 版本不是 2")

    def load(self, model, weight, ins, outs, threads=4):
        """加载一张图，返回 Net。weight 为 None 表示权重在 .mnn 内。"""
        cfg = _Cfg()
        self.d.arkli_mnn_config_default(ctypes.byref(cfg))
        cfg.threads, cfg.memory = threads, MEMORY_LOW
        err = ctypes.create_string_buffer(ERR_LEN)
        ia = (ctypes.c_char_p * len(ins))(*[s.encode() for s in ins])
        oa = (ctypes.c_char_p * len(outs))(*[s.encode() for s in outs])
        h = self.d.arkli_mnn_net_load(str(model).encode("utf8"), str(weight).encode("utf8") if weight else None,
                                      ia, len(ins), oa, len(outs), ctypes.byref(cfg), err, ERR_LEN)
        if not h:
            raise RuntimeError(f"加载 {model} 失败：{err.value.decode('utf8', 'replace')}")
        return Net(self, h, len(ins), len(outs))


class Net:
    """一个已加载的 MNN 图。forward 入参为 numpy 数组列表，返回 float32 数组列表。"""

    def __init__(self, lib, h, n_in, n_out):
        self.lib, self.h, self.n_in, self.n_out = lib, h, n_in, n_out

    def forward(self, arrays):
        d = self.lib.d
        vals = []
        try:
            for a in arrays:
                dt = I32 if a.dtype == np.int32 else F32
                a = np.ascontiguousarray(a, dtype=np.int32 if dt == I32 else np.float32)
                shp = (ctypes.c_int32 * a.ndim)(*a.shape)
                v = d.arkli_mnn_val_new(dt, shp, a.ndim, a.ctypes.data_as(ctypes.c_void_p))
                if not v:
                    raise RuntimeError("val_new 失败")
                vals.append(v)
            ins = (ctypes.c_void_p * len(vals))(*vals)
            outs = (ctypes.c_void_p * self.n_out)()
            err = ctypes.create_string_buffer(ERR_LEN)
            rc = d.arkli_mnn_net_forward(self.h, ins, len(vals), outs, self.n_out, err, ERR_LEN)
            if rc != 0:
                raise RuntimeError(f"forward 失败({rc})：{err.value.decode('utf8', 'replace')}")
            res = []
            for o in outs:
                shp = (ctypes.c_int32 * 8)()
                nd = d.arkli_mnn_val_shape(o, shp, 8)
                dims = tuple(shp[:nd])
                n = int(np.prod(dims)) if dims else 1
                p = d.arkli_mnn_val_read(o)
                buf = (ctypes.c_float * n).from_address(p)
                res.append(np.frombuffer(buf, dtype=np.float32).copy().reshape(dims))
                d.arkli_mnn_val_free(o)
            return res
        finally:
            for v in vals:
                d.arkli_mnn_val_free(v)

    def close(self):
        """释放图。"""
        if self.h:
            self.lib.d.arkli_mnn_net_free(self.h)
            self.h = None


# ---------- 后处理（numpy 重写 logo_post.rs） ----------

def rust_round(x):
    """Rust f32::round（四舍五入，远离 0），返回 int 数组。"""
    return (np.sign(x) * np.floor(np.abs(x) + 0.5)).astype(np.int64)


def label_components(mask):
    """4-连通标记。返回 (labels[H,W] int32，0 为背景, areas 列表, boxes 列表 (y0,y1,x0,x1))。

    用行程(run)加并查集，纯 numpy+Python，512x512 下毫秒~十毫秒级。
    """
    h, w = mask.shape
    parent = []

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    runs = []  # (y, x0, x1, id)
    prev = []
    for y in range(h):
        row = mask[y]
        cur = []
        if row.any():
            pad = np.concatenate(([0], row.view(np.int8), [0]))
            diff = np.diff(pad)
            starts, ends = np.flatnonzero(diff == 1), np.flatnonzero(diff == -1)
            for s, e in zip(starts, ends):
                rid = len(parent)
                parent.append(rid)
                cur.append((s, e, rid))
                runs.append((y, s, e, rid))
            # 与上一行重叠的行程合并
            j = 0
            for s, e, rid in cur:
                while j < len(prev) and prev[j][1] <= s:
                    j += 1
                k = j
                while k < len(prev) and prev[k][0] < e:
                    ra, rb = find(rid), find(prev[k][2])
                    if ra != rb:
                        parent[ra] = rb
                    k += 1
        prev = cur
    labels = np.zeros((h, w), dtype=np.int32)
    remap, areas, boxes = {}, [], []
    for y, s, e, rid in runs:
        root = find(rid)
        if root not in remap:
            remap[root] = len(remap) + 1
            areas.append(0)
            boxes.append([y, y, s, e - 1])
        i = remap[root]
        labels[y, s:e] = i
        areas[i - 1] += e - s
        b = boxes[i - 1]
        b[1] = max(b[1], y)
        b[2] = min(b[2], s)
        b[3] = max(b[3], e - 1)
    return labels, areas, boxes


def rgb_to_gray(rgb):
    """PIL 同款整数灰度：(R*19595+G*38470+B*7471+0x8000)>>16。rgb 为 HxWx3 uint8。"""
    r, g, b = [rgb[..., i].astype(np.uint32) for i in range(3)]
    return np.minimum((r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16, 255).astype(np.uint8)


def threshold_otsu(gray):
    """复刻 skimage threshold_otsu（uint8）。"""
    lo, hi = int(gray.min()), int(gray.max())
    if lo == hi:
        return lo
    hist = np.bincount(gray.ravel(), minlength=256)[lo:hi + 1].astype(np.float64)
    centers = np.arange(lo, hi + 1, dtype=np.float64)
    w1 = np.cumsum(hist)
    w2 = np.cumsum(hist[::-1])[::-1]
    m1 = np.cumsum(hist * centers) / np.where(w1 > 0, w1, 1)
    m2 = (np.cumsum((hist * centers)[::-1]) / np.where(w2[::-1] > 0, w2[::-1], 1))[::-1]
    var = w1[:-1] * w2[1:] * (m1[:-1] - m2[1:]) ** 2
    return int(round(float(centers[int(np.argmax(var))])))


def _drop_small(mask, min_area):
    """丢弃面积小于 min_area 的连通块。"""
    labels, areas, _ = label_components(mask)
    if not areas:
        return mask
    keep = np.concatenate(([False], np.array(areas) >= min_area))
    return keep[labels]


def binarize(gray):
    """灰度 -> 大津法 -> 暗为前景 -> 四角偏暗则反相 -> 丢小于 0.08% 的块。返回 (mask, 阈值)。"""
    h, w = gray.shape
    t = threshold_otsu(gray)
    dark = gray < t
    corners = sorted([int(gray[0, 0]), int(gray[0, w - 1]), int(gray[h - 1, 0]), int(gray[h - 1, w - 1])])
    if (corners[1] + corners[2]) / 2.0 < t:
        dark = ~dark
    return _drop_small(dark, BINARIZE_MIN_AREA * w * h), t


def find_ring(mask):
    """检测模型自画外圈。返回 (cx, cy, r_out, r_in) 或 None。"""
    _, areas, boxes = label_components(mask)
    if not areas:
        return None
    best = max(range(len(areas)), key=lambda i: (max(boxes[i][1] - boxes[i][0], boxes[i][3] - boxes[i][2]) + 1, -i))
    # Rust 里遇到同样大的保留先出现的，max 对相同 key 取先出现，这里 -i 保证一致
    y0, y1, x0, x1 = boxes[best]
    w, h = x1 - x0 + 1, y1 - y0 + 1
    ms = RING_MIN_SPAN * SIDE
    if w < ms or h < ms:
        return None
    asp = w / h
    if asp <= RING_ASPECT_MIN or asp >= RING_ASPECT_MAX:
        return None
    cy, cx = (y0 + y1 + 1) / 2.0, (x0 + x1 + 1) / 2.0
    r_out = (w + h) / 4.0
    r_start, r_end = int(r_out * 0.3), int(r_out) + 2
    if r_end <= r_start:
        return None
    yy, xx = np.mgrid[0:SIDE, 0:SIDE].astype(np.float32)
    d = np.sqrt((xx - np.float32(cx)) ** 2 + (yy - np.float32(cy)) ** 2)
    rf = np.floor(d).astype(np.int64)
    n = SIDE * 2
    tot = np.bincount(rf.ravel(), minlength=n)
    fg = np.bincount(rf[mask].ravel(), minlength=n)
    # 半径 r 的环带统计的是 floor(d) 为 r 或 r+1 的像素
    rs = np.arange(r_start, r_end)
    total = tot[rs] + tot[rs + 1]
    true = fg[rs] + fg[rs + 1]
    frac = np.where(total > 0, true / np.maximum(total, 1), 0.0)
    i = len(frac) - 1
    while i > 0 and frac[i] < RING_BAND_ON:
        i -= 1
    if frac[i] < RING_BAND_ON:
        return None
    j = i
    while j > 0 and frac[j] > RING_BAND_OFF:
        j -= 1
    r_in = float(r_start + j)
    if frac[j] > RING_BAND_OFF:
        return None
    r_band_out = float(r_start + i)
    t = (r_band_out - r_in) / r_out
    if not (RING_THICK_MIN < t < RING_THICK_MAX):
        return None
    return cx, cy, r_band_out, r_in


def extract_symbol(gray, remove_ring=True):
    """从 512 灰度图提取符号掩码。返回 (mask, ring_detected, r_in, otsu_t)。"""
    m, t = binarize(gray)
    ring = find_ring(m) if remove_ring else None
    if ring is None:
        return m, False, None, t
    cx, cy, _, ri = ring
    yy, xx = np.mgrid[0:SIDE, 0:SIDE].astype(np.float32)
    d = np.sqrt((xx - np.float32(cx)) ** 2 + (yy - np.float32(cy)) ** 2)
    m = m & ~(d >= (ri - RING_CUT_MARGIN))
    return _drop_small(m, RING_RESIDUAL_MIN_AREA), True, ri, t


def features(mask, r_in=None):
    """质量特征，字段同 SymbolFeatures。"""
    total = SIDE * SIDE
    ink = int(mask.sum())
    if ink < EMPTY_INK:
        return dict(ink_canvas=ink / total, rot_iou=1.0, comps=0, specks=0, size_rel=0.0, off=1.0,
                    fill_bbox=0.0, empty=True)
    ys, xs = np.nonzero(mask)
    bh, bw = ys.max() - ys.min() + 1, xs.max() - xs.min() + 1
    cx, cy = float(xs.sum()) / ink, float(ys.sum()) / ink
    c = SIDE / 2.0
    # 质心平移到画布中心
    idx = np.arange(SIDE, dtype=np.float32)
    oy = rust_round(idx - np.float32(c - cy))
    ox = rust_round(idx - np.float32(c - cx))
    vy, vx = (oy >= 0) & (oy < SIDE), (ox >= 0) & (ox < SIDE)
    base = np.zeros_like(mask)
    base[np.ix_(vy, vx)] = mask[np.ix_(oy[vy], ox[vx])]
    yy, xx = np.mgrid[0:SIDE, 0:SIDE].astype(np.float32)
    dx, dy = xx - np.float32(c), yy - np.float32(c)
    min_iou = 1.0
    for a in ROT_ANGLES:
        rad = np.float32(a * math.pi / 180.0)
        ca, sa = np.cos(rad), np.sin(rad)
        sx = rust_round(np.float32(c) + dx * ca + dy * sa)
        sy = rust_round(np.float32(c) - dx * sa + dy * ca)
        ok = (sx >= 0) & (sx < SIDE) & (sy >= 0) & (sy < SIDE)
        rv = np.zeros_like(base)
        rv[ok] = base[sy[ok], sx[ok]]
        u = int((base | rv).sum())
        iou = 1.0 if u == 0 else int((base & rv).sum()) / u
        min_iou = min(min_iou, iou)
    _, areas, _ = label_components(mask)
    big = BIG_AREA_RATIO * total
    comps = sum(1 for a in areas if a >= big)
    specks = sum(1 for a in areas if SPECK_AREA_MIN <= a < big)
    ref = 2.0 * r_in if r_in else float(SIDE)
    return dict(ink_canvas=ink / total, rot_iou=float(min_iou), comps=comps, specks=specks,
                size_rel=float(max(bh, bw)) / ref, off=math.hypot(cx - c, cy - c) / SIDE,
                fill_bbox=ink / float(bh * bw), empty=False)


def gate(f):
    """质量闸门。返回 (是否通过, 原因码列表)，原因码同 Rust GateReason.code()。"""
    if f["empty"]:
        return False, ["empty"]
    r = []
    if f["ink_canvas"] < GATE_INK_MIN:
        r.append("ink_low")
    if f["ink_canvas"] > GATE_INK_MAX:
        r.append("ink_high")
    if f["rot_iou"] > GATE_ROT_MAX:
        r.append("concentric")
    if f["comps"] > GATE_COMPS_MAX:
        r.append("fragments")
    if f["specks"] > GATE_SPECKS_MAX:
        r.append("specks")
    if f["size_rel"] < GATE_SIZE_MIN:
        r.append("small")
    if f["off"] > GATE_OFF_MAX:
        r.append("off_center")
    return not r, r


# ---------- 引擎 ----------

@dataclass
class GlyphResult:
    """单张结果：gray 为 512x512 uint8 灰度原图，mask 为布尔符号掩码（True=墨）。"""
    gray: np.ndarray
    mask: np.ndarray
    gate_ok: bool
    reasons: list
    features: dict
    ring_detected: bool
    otsu: int
    timings_ms: dict = field(default_factory=dict)
    rgb: np.ndarray = None  # 512x512x3 uint8 彩色原图


class GlyphEngine:
    """一次加载三张图，反复出图。

    参数：model_dir 模型目录；rt_dir 含 MNN.dll/arkli-mnn.dll 的目录；threads CPU 线程数。
    示例：GlyphEngine().generate("a rocket", seed=1)
    """

    def __init__(self, model_dir=DEFAULT_MODEL_DIR, rt_dir=DEFAULT_RT_DIR, threads=4):
        md = Path(model_dir)
        self.tok = ClipTokenizer(md / "tokenizer.json")
        lib = MnnLib(rt_dir)
        self.lib = lib

        def ld(name, ins, outs):
            w = md / f"{name}.mnn.weight"
            return lib.load(md / f"{name}.mnn", w if w.exists() else None, ins, outs, threads)

        self.te = ld("text_encoder", ["input_ids"], ["last_hidden_state"])
        self.unet = ld("unet", ["sample", "encoder_hidden_states"], ["out_sample"])
        self.vae = ld("vae_decoder", ["latent_sample"], ["sample"])
        self.c1, self.c2 = step_coeffs()

    def generate(self, concept, seed, remove_ring=True, template=PROMPT_TEMPLATE):
        """出一张图。concept 为英文概念词（如 "a rocket"），seed 为整数种子。返回 GlyphResult。"""
        t0 = time.perf_counter()
        prompt = template.format(concept) if "{}" in template else concept
        ids = np.array(self.tok.encode(prompt), dtype=np.int32).reshape(1, TOKEN_LEN)
        emb = self.te.forward([ids])[0]
        t1 = time.perf_counter()
        noise = noise_from_seed(seed)
        eps = self.unet.forward([noise.reshape(LATENT_SHAPE), emb.reshape(TEXT_SHAPE)])[0].ravel()
        t2 = time.perf_counter()
        latent = (np.float32(self.c1) * noise - np.float32(self.c2) * eps).reshape(LATENT_SHAPE)
        img = self.vae.forward([latent])[0].reshape(3, SIDE, SIDE)
        t3 = time.perf_counter()
        u8 = np.floor(np.clip(img * 0.5 + 0.5, 0, 1) * 255.0 + 0.5).astype(np.uint8)
        gray = rgb_to_gray(np.transpose(u8, (1, 2, 0)))
        mask, ring, r_in, t = extract_symbol(gray, remove_ring)
        f = features(mask, r_in)
        ok, reasons = gate(f)
        t4 = time.perf_counter()
        ms = lambda a, b: round((b - a) * 1000)
        return GlyphResult(gray, mask, ok, reasons, f, ring, t,
                           dict(text=ms(t0, t1), unet=ms(t1, t2), vae=ms(t2, t3), post=ms(t3, t4),
                                total=ms(t0, t4)), np.transpose(u8, (1, 2, 0)).copy())

    def close(self):
        """释放三张图。"""
        for n in (self.te, self.unet, self.vae):
            n.close()
        self.lib.d.arkli_mnn_release_memory()


def save_result(res, out_dir, name, seed):
    """保存原图灰度 PNG 与掩码 PNG（白底黑剪影，8 位灰度）。返回 (原图名, 掩码名)。"""
    a, b = f"{name}_s{seed}.png", f"{name}_s{seed}_mask.png"
    Image.fromarray(res.gray, "L").save(Path(out_dir) / a)
    Image.fromarray(res.rgb, "RGB").save(Path(out_dir) / f"{name}_s{seed}_rgb.png")
    Image.fromarray(np.where(res.mask, 0, 255).astype(np.uint8), "L").save(Path(out_dir) / b)
    return a, b


def main(argv=None):
    """命令行入口。"""
    ap = argparse.ArgumentParser(description="SDXS 批量出剪影符号")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--item", action="append", required=True, help="name=概念词，可重复，如 coffee=\"a coffee bean\"")
    ap.add_argument("--seeds", type=int, default=4, help="每个 item 的种子数（1..N）")
    ap.add_argument("--seed-start", type=int, default=1, help="起始种子")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR))
    ap.add_argument("--rt-dir", default=str(DEFAULT_RT_DIR))
    ap.add_argument("--template", default=PROMPT_TEMPLATE, help="提示词模板，{} 处填概念词；彩色图标可用多色模板")
    ap.add_argument("--keep-ring", action="store_true", help="不去除模型自画外圈")
    a = ap.parse_args(argv)
    items = []
    for s in a.item:
        if "=" not in s:
            ap.error(f"--item 需要 name=concept：{s}")
        n, c = s.split("=", 1)
        items.append((n.strip(), c.strip()))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rj = out / "results.json"
    results = json.loads(rj.read_text(encoding="utf8")) if rj.exists() else []
    t = time.perf_counter()
    eng = GlyphEngine(a.model_dir, a.rt_dir, a.threads)
    print(f"模型加载 {time.perf_counter() - t:.1f}s", flush=True)
    try:
        for name, concept in items:
            for seed in range(a.seed_start, a.seed_start + a.seeds):
                r = eng.generate(concept, seed, remove_ring=not a.keep_ring, template=a.template)
                img, msk = save_result(r, out, name, seed)
                results = [x for x in results if not (x["name"] == name and x["seed"] == seed)]
                results.append(dict(name=name, concept=concept, seed=seed, image=img, mask=msk,
                                    gate_ok=r.gate_ok, reasons=r.reasons, ring_detected=r.ring_detected,
                                    otsu=r.otsu, features=r.features, timings_ms=r.timings_ms))
                rj.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf8")
                print(f"{name} s{seed}: {'过闸' if r.gate_ok else '未过 ' + ','.join(r.reasons)} "
                      f"{r.timings_ms['total']}ms (unet {r.timings_ms['unet']}ms)", flush=True)
    finally:
        eng.close()


if __name__ == "__main__":
    main()
