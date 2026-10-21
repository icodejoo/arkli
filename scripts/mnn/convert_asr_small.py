"""小号流式语音（zipformer1 transducer，如 small-bilingual-zh-en-2023-02-16）转 MNN 的临时脚本。

官方包里文件名带 `-epoch-xx-avg-1...` 后缀（自动识别），这里统一转成 encoder/decoder/joiner.mnn，并拷 tokens.txt，
目录结构与 eval_asr.py 的 --mnn-dir 一致。只用 fp32 ONNX（不要用 int8 ONNX）。
用法：python -I convert_asr_small.py <fp32 目录> <输出目录> [w8|w8b64|w8b32|fp16|fp32]
"""
import glob
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import die, fmt_bytes, log  # noqa: E402
from mnnconv import convert  # noqa: E402

# 三个子网络的名字
GRAPHS = ("encoder", "decoder", "joiner")
# 变体对应的转换参数
VARIANTS = {"w8": ["--weightQuantBits", "8"], "w8b64": ["--weightQuantBits", "8", "--weightQuantBlock", "64"],
            "w8b32": ["--weightQuantBits", "8", "--weightQuantBlock", "32"], "fp16": ["--fp16"], "fp32": []}


def find_fp32(src, g):
    """在目录里找子网络 g 的 fp32 ONNX（文件名形如 g-epoch-xx...onnx 或 g.onnx，排除 int8）。"""
    c = [f for f in glob.glob(os.path.join(src, g + "*.onnx")) if ".int8." not in f]
    if len(c) != 1:
        die(f"{src} 里 {g} 的 fp32 ONNX 应恰有 1 个，实际 {c}")
    return c[0]


def main():
    """命令行入口：逐个子网络转换并打印体积。"""
    if len(sys.argv) < 3:
        die(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    variant = sys.argv[3] if len(sys.argv) > 3 else "w8"
    if variant not in VARIANTS:
        die(f"未知变体 {variant}")
    os.makedirs(dst, exist_ok=True)
    for g in GRAPHS:
        out = os.path.join(dst, g + ".mnn")
        convert(find_fp32(src, g), out, VARIANTS[variant], log_path=os.path.join(dst, g + ".convert.log"))
        log(f"{g}.mnn {fmt_bytes(os.path.getsize(out))}")
    shutil.copy(os.path.join(src, "tokens.txt"), os.path.join(dst, "tokens.txt"))


if __name__ == "__main__":
    main()
