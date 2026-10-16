"""对联 GPT-2：把带 KV cache 的 fp32 ONNX 改成“无 cache、整句重算”的图，给 MNN 转换用。

为什么要改：原图每步都带 24 个 past 输入（首步 past_len=0 的空张量），MNN 对 0 长度张量与 Concat 不友好，
而对联序列只有 ≤ ~40 token，整句重算几乎不贵，所以直接去掉 past：
  - 删 24 个 past 输入与 24 个 present 输出（只留 logits，仍只算最后一个位置）；
  - 每层的 Concat(past, new_kv) 改成 Identity(new_kv)；
  - 原来 Shape(past)[2] 得到的 past_len 换成常量 0（位置掩码只依赖序列长度）。
输入：input_ids int64 [1, seq]、position_ids int64 [1, seq]；输出：logits float32 [1, 1, 21128]。
下载物视为不可信：只用 onnx 读写，不执行其中任何东西。

可选 --int8-embed：词嵌入表 wte（21128x768 fp32，65MB）改成图内 int8 逐行对称量化 + 逐行 scale，
Gather(int8) -> Cast -> Mul(scale)；lm_head 用的转置副本 wte_T 单独存成 fp32 初始值，交给 MNN 的权重量化。
（MNN 的 --weightQuantBits 不量化 Gather 的常量，不这么做 wte 会以 fp32 留在 .weight 里。）

用法：python -I couplet_prepare.py [--int8-embed] <couplet-gpt2-fp32.onnx> <输出.onnx>
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import die, log  # noqa: E402

import numpy as np  # noqa: E402
import onnx  # noqa: E402
from onnx import helper, numpy_helper  # noqa: E402

# past 输入名前缀与 present 输出名前缀
PAST_PREFIX = "past_key_values."
PRESENT_PREFIX = "present."
# past_len 的来源节点输出名（Gather(Shape(past_key_values.0.key), 2)）
PAST_LEN_TENSOR = "/Gather_3_output_0"


def strip_past(model):
    """原地去掉 past/present，返回改动统计 (替换的 Concat 数, 删除的节点数)。"""
    g = model.graph
    past = {i.name for i in g.input if i.name.startswith(PAST_PREFIX)}
    if len(past) != 24:
        die(f"past 输入数量不对：{len(past)}（应为 24），图结构与预期不符")
    for i in [i for i in g.input if i.name in past]:
        g.input.remove(i)
    for o in [o for o in g.output if o.name.startswith(PRESENT_PREFIX)]:
        g.output.remove(o)
    new_nodes, n_concat, n_removed = [], 0, 0
    for n in g.node:
        if n.op_type == "Concat" and n.input[0] in past:
            # Concat(past, new) -> Identity(new)，输出名不变（后面的注意力仍读它）
            new_nodes.append(helper.make_node("Identity", [n.input[1]], list(n.output), name=n.name + "_id"))
            n_concat += 1
        elif n.op_type == "Shape" and n.input[0] in past:
            n_removed += 1  # past 的形状节点，下面用常量 0 顶替它的下游
        else:
            new_nodes.append(n)
    # 删掉 past_len 的 Gather（输入是被删的 Shape），换成常量 0
    kept = []
    for n in new_nodes:
        if n.op_type == "Gather" and list(n.output) == [PAST_LEN_TENSOR]:
            kept.append(helper.make_node("Constant", [], [PAST_LEN_TENSOR], name="past_len_zero",
                                         value=numpy_helper.from_array(np.array(0, np.int64))))
            n_removed += 1
        else:
            kept.append(n)
    del g.node[:]
    g.node.extend(kept)
    return n_concat, n_removed


# 词嵌入初始值名、转置副本名、Gather 的输出名（用来定位节点）
WTE_NAME = "p.transformer__wte__weight"
WTE_T_NAME = "wte_T"
WTE_GATHER_OUT = "/Gather_output_0"
# int8 对称量化的最大值
INT8_MAX = 127.0


def int8_embed(model):
    """把词嵌入表改成图内 int8 + 逐行 scale；lm_head 的 wte_T 改为独立的 fp32 初始值。"""
    g = model.graph
    inits = {i.name: i for i in g.initializer}
    if WTE_NAME not in inits:
        die(f"找不到词嵌入初始值 {WTE_NAME}")
    w = numpy_helper.to_array(inits[WTE_NAME]).astype(np.float32)  # [V, D]
    scale = np.abs(w).max(axis=1, keepdims=True) / INT8_MAX
    scale = np.maximum(scale, 1e-12).astype(np.float32)
    q = np.clip(np.rint(w / scale), -INT8_MAX, INT8_MAX).astype(np.int8)
    nodes, found = [], False
    for n in g.node:
        if n.op_type == "Transpose" and list(n.output) == [WTE_T_NAME]:
            continue  # 转置节点由独立的 wte_T 初始值顶替
        if n.op_type == "Gather" and list(n.output) == [WTE_GATHER_OUT]:
            found = True
            ids = n.input[1]
            nodes += [
                helper.make_node("Gather", ["wte_i8", ids], ["wte_rows_i8"], name="wte_gather_i8"),
                helper.make_node("Cast", ["wte_rows_i8"], ["wte_rows_f"], name="wte_cast", to=onnx.TensorProto.FLOAT),
                helper.make_node("Gather", ["wte_scale", ids], ["wte_rows_s"], name="wte_gather_scale"),
                helper.make_node("Mul", ["wte_rows_f", "wte_rows_s"], [WTE_GATHER_OUT], name="wte_dequant"),
            ]
        else:
            nodes.append(n)
    if not found:
        die("找不到 wte 的 Gather 节点，图结构与预期不符")
    del g.node[:]
    g.node.extend(nodes)
    g.initializer.remove(inits[WTE_NAME])
    g.initializer.extend([
        numpy_helper.from_array(q, "wte_i8"),
        numpy_helper.from_array(scale, "wte_scale"),
        numpy_helper.from_array(np.ascontiguousarray(w.T), WTE_T_NAME),
    ])


def main():
    """命令行入口。"""
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if len(args) != 2 or not flags <= {"--int8-embed"}:
        die("用法：couplet_prepare.py [--int8-embed] <fp32.onnx> <out.onnx>")
    src, dst = args
    m = onnx.load(src)
    n_concat, n_removed = strip_past(m)
    if "--int8-embed" in flags:
        int8_embed(m)
    onnx.checker.check_model(m)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    onnx.save(m, dst)
    log(f"完成：Concat->Identity {n_concat} 个，删节点 {n_removed} 个，输入 {[i.name for i in m.graph.input]}，输出 {[o.name for o in m.graph.output]}")


if __name__ == "__main__":
    main()
