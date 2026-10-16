"""把 nllb_prepare.py 导出的 fp32 嵌入表量化成“逐行 int8 + 每行 scale”，存成原始二进制（给 Rust/Kotlin 加载器读）。

格式（全部小端、无头部）：
  embed.i8      int8  [V, 1024]，行主序；q = clip(round(e / scale_row), -127, 127)
  embed.scale   float32 [V]；scale_row = max(|e_row|) / 127，全零行 scale 取 1.0
还原：e ~= q * scale_row（63MB 对 fp32 的 253MB；encoder 与 decoder 共用这一张表，nllb_prepare 已校验两者相等）。

用法：python -I nllb_embed.py <embed_fp32.npy> <out_dir>            导出 embed.i8 / embed.scale
      python -I nllb_embed.py --check <embed_fp32.npy> <out_dir>    导出后再读回，报告还原误差
"""
import os
import sys

import numpy as np

# int8 最大量化值（对称量化，不用 -128）
QMAX = 127
# 输出文件名
I8_NAME, SCALE_NAME = "embed.i8", "embed.scale"


def quantize(e):
    """逐行对称 int8 量化。返回 (q: int8[V,D], scale: float32[V])。"""
    e = np.asarray(e, np.float32)
    s = np.abs(e).max(axis=1, keepdims=True) / QMAX
    s[s == 0] = 1.0
    q = np.clip(np.round(e / s), -QMAX, QMAX).astype(np.int8)
    return q, s.reshape(-1).astype(np.float32)


def dequantize(q, scale):
    """把 int8 + 每行 scale 还原成 float32 [V, D]。"""
    return q.astype(np.float32) * scale[:, None]


def load(out_dir, dim):
    """从 embed.i8 / embed.scale 读回 (q, scale)；dim 是嵌入宽度。"""
    q = np.fromfile(os.path.join(out_dir, I8_NAME), dtype=np.int8).reshape(-1, dim)
    s = np.fromfile(os.path.join(out_dir, SCALE_NAME), dtype="<f4")
    if len(s) != len(q):
        raise ValueError(f"行数不一致：{len(q)} vs {len(s)}")
    return q, s


def main():
    """命令行入口。"""
    a = sys.argv[1:]
    check = bool(a) and a[0] == "--check"
    if check:
        a = a[1:]
    if len(a) != 2:
        sys.exit(__doc__)
    npy, out = a
    e = np.load(npy)
    os.makedirs(out, exist_ok=True)
    q, s = quantize(e)
    q.tofile(os.path.join(out, I8_NAME))
    s.astype("<f4").tofile(os.path.join(out, SCALE_NAME))
    print(f"embed rows={len(q)} dim={q.shape[1]} i8={q.nbytes}B scale={s.nbytes}B")
    if check:
        q2, s2 = load(out, e.shape[1])
        d = dequantize(q2, s2) - e
        print(f"还原最大绝对误差 {np.abs(d).max():.5f}，相对均方根 {np.sqrt((d ** 2).mean()) / np.sqrt((e ** 2).mean()):.5f}")


if __name__ == "__main__":
    main()
