"""探测 sherpa-onnx paraformer-zh-small（仅有 int8 ONNX）能否转 MNN。

用法：python -I probe_paraformer_small.py <model.int8.onnx> <输出目录>
结论写在 docs/research/asr-small-models.md 第 9 节；本脚本只做算子统计和转换尝试。
"""
import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mnnconv  # noqa: E402

# 转换变体：名称 -> MNNConvert 额外参数
VARIANTS = {"plain": [], "fp16": ["--fp16"]}


def op_stats(path):
    """统计 ONNX 算子，返回 Counter。参数：path 为 onnx 文件路径。"""
    import onnx
    m = onnx.load(path, load_external_data=False)
    return collections.Counter(n.op_type for n in m.graph.node)


def main():
    """入口：打印算子统计，并逐个变体尝试转换，失败只打印不退出。"""
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    c = op_stats(src)
    print("量化相关算子：", {k: v for k, v in c.items() if "Integer" in k or "Quantize" in k})
    for name, extra in VARIANTS.items():
        dst = os.path.join(out, name + ".mnn")
        try:
            mnnconv.convert(src, dst, extra, os.path.join(out, name + ".log"))
            print(name, "成功", os.path.getsize(dst), "字节")
        except SystemExit as e:
            print(name, "失败", e)


if __name__ == "__main__":
    main()
