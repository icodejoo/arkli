"""手写交叉注意力 K/V 小图 cross_kv.onnx：encoder_hidden_states[B,S,1024] -> past_key_values.{l}.encoder.{key,value}[B,16,S,64]（12 层共 24 个输出）。

权重取自 decoder_first.onnx 里各层 encoder_attn 的 k_proj/v_proj（MatMul 权重 + Add 偏置）。
这样所有解码步都只用 decoder_step（第 0 步自注意力 past 长度为 0），自注意力/FFN/lm_head 权重不再存两份；
交叉 KV 只在编码后算一次，不在每步重算。

用法：python -I nllb_crosskv.py <split_dir>
  split_dir 是 nllb_prepare.py 的输出目录；读 decoder_first.onnx，写 cross_kv.onnx(+.data)
"""
import os
import re
import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

# 注意力头数与每头维度（NLLB-600M：16 头 x 64）、模型宽度、ONNX opset
HEADS, HEAD_DIM = 16, 64
D_MODEL = 1024
OPSET = 17
# 输入名
HIDDEN_INPUT = "encoder_hidden_states"
# 匹配 decoder_first 里交叉注意力的投影节点名
PAT_MM = re.compile(r"/model/decoder/layers\.(\d+)/encoder_attn/([kv])_proj/MatMul$")
PAT_ADD = re.compile(r"/model/decoder/layers\.(\d+)/encoder_attn/([kv])_proj/Add$")


def collect_proj(m):
    """从 decoder_first 里收集每层 k/v 投影的权重名与偏置名，返回 (权重表, 偏置表, 初始化器表)。"""
    inits = {i.name: i for i in m.graph.initializer}
    w, b = {}, {}
    for n in m.graph.node:
        if (mm := PAT_MM.match(n.name)):
            w[(int(mm[1]), mm[2])] = next(x for x in n.input if x in inits)
        if (ma := PAT_ADD.match(n.name)):
            b[(int(ma[1]), ma[2])] = next(x for x in n.input if x in inits)
    return w, b, inits


def build(m):
    """生成 cross_kv 的 ONNX 模型；返回 (model, 层数, 输出个数)。"""
    w, b, inits = collect_proj(m)
    layers = sorted({k[0] for k in w})
    if not (len(w) == len(b) == 2 * len(layers) and layers):
        sys.exit(f"错误：没找到完整的交叉注意力投影（w={len(w)} b={len(b)}）")
    nodes, outs = [], []
    new_inits = [numpy_helper.from_array(np.array([0, -1, HEADS, HEAD_DIM], np.int64), "kv_shape")]
    for l in layers:
        for kv, nm in (("k", "key"), ("v", "value")):
            wn, bn = f"l{l}_{kv}_w", f"l{l}_{kv}_b"
            new_inits.append(numpy_helper.from_array(numpy_helper.to_array(inits[w[(l, kv)]]), wn))
            new_inits.append(numpy_helper.from_array(numpy_helper.to_array(inits[b[(l, kv)]]), bn))
            out = f"past_key_values.{l}.encoder.{nm}"
            nodes += [
                helper.make_node("MatMul", [HIDDEN_INPUT, wn], [f"l{l}{kv}_mm"]),
                helper.make_node("Add", [f"l{l}{kv}_mm", bn], [f"l{l}{kv}_add"]),
                helper.make_node("Reshape", [f"l{l}{kv}_add", "kv_shape"], [f"l{l}{kv}_rs"]),
                helper.make_node("Transpose", [f"l{l}{kv}_rs"], [out], perm=[0, 2, 1, 3]),
            ]
            outs.append(helper.make_tensor_value_info(out, TensorProto.FLOAT, ["batch_size", HEADS, "encoder_sequence_length", HEAD_DIM]))
    inp = helper.make_tensor_value_info(HIDDEN_INPUT, TensorProto.FLOAT, ["batch_size", "encoder_sequence_length", D_MODEL])
    g = helper.make_graph(nodes, "cross_kv", [inp], outs, new_inits)
    model = helper.make_model(g, opset_imports=[helper.make_opsetid("", OPSET)], ir_version=8)
    return model, len(layers), len(outs)


def main():
    """命令行入口：读 decoder_first.onnx，写 cross_kv.onnx。"""
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    d = sys.argv[1]
    src = os.path.join(d, "decoder_first.onnx")
    if not os.path.isfile(src):
        sys.exit(f"错误：缺少 {src}，先运行 nllb_prepare.py")
    model, n_layers, n_outs = build(onnx.load(src))
    p = os.path.join(d, "cross_kv.onnx")
    if os.path.exists(p + ".data"):
        os.remove(p + ".data")  # onnx 会往已存在的外部数据文件末尾追加
    onnx.save(model, p, save_as_external_data=True, all_tensors_to_one_file=True, location="cross_kv.onnx.data", size_threshold=1024)
    onnx.checker.check_model(p)
    print("layers", n_layers, "outputs", n_outs)


if __name__ == "__main__":
    main()
