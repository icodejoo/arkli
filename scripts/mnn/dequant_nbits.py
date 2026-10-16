"""把 ONNX 里的 com.microsoft MatMulNBits（int4/int8 分块）还原成标准 MatMul + fp32 权重，MNN 转换器才能吃。

用途：只在“拿现网 ORT int4 包做对照实验”时用（例如验证“把 q4_half 的 int4 网格搬进 MNN 反而更差”）；
生产转换一律从 fp32 原版出发，不经过本脚本。对 If 子图递归处理；Cast(fp16 初始化器) 形式的 scales 也能解析。

用法：python -I dequant_nbits.py <in.onnx> <out.onnx> [--external]
  --external  输出用外部数据文件（<out>.data），大模型必须加，否则超 2GB 写不出来
"""
import os
import sys

import numpy as np
import onnx
from onnx import numpy_helper, helper

def build_consts(g, table):
    """收集图（含子图）里所有初始化器与 Constant 节点的张量，按名字存进 table。"""
    for i in g.initializer:
        table[i.name] = i
    for n in g.node:
        if n.op_type == "Constant":
            for a in n.attribute:
                if a.name == "value":
                    t = onnx.TensorProto(); t.CopyFrom(a.t); t.name = n.output[0]; table[n.output[0]] = t
        for a in n.attribute:
            if a.type == onnx.AttributeProto.GRAPH:
                build_consts(a.g, table)

def resolve(name, table, producers):
    """按名字取常量数组；若由 Cast 产生就递归取源再转 float32。"""
    if name in table:
        return numpy_helper.to_array(table[name])
    p = producers.get(name)
    if p is not None and p.op_type == "Cast":
        return resolve(p.input[0], table, producers).astype(np.float32)
    raise KeyError(name)

def dequant(node, table, producers):
    """把一个 MatMulNBits 的量化权重还原成 fp32 的 [K, N] 矩阵。"""
    at = {a.name: helper.get_attribute_value(a) for a in node.attribute}
    K, N, bits, bs = at["K"], at["N"], at.get("bits", 4), at["block_size"]
    B = resolve(node.input[1], table, producers).astype(np.uint8)
    S = resolve(node.input[2], table, producers).astype(np.float32)
    nb = (K + bs - 1) // bs
    B = B.reshape(N, nb, -1)
    if bits == 4:
        q = np.empty((N, nb, B.shape[2] * 2), np.uint8)
        q[..., 0::2] = B & 0x0F; q[..., 1::2] = B >> 4
    elif bits == 8:
        q = B
    else:
        raise ValueError(bits)
    q = q.reshape(N, nb, bs).astype(np.float32)
    if len(node.input) > 3 and node.input[3]:
        Z = resolve(node.input[3], table, producers).astype(np.uint8)
        if bits == 4:
            z = np.empty(Z.size * 2, np.uint8); z[0::2] = Z.ravel() & 0x0F; z[1::2] = Z.ravel() >> 4
            Z = z[: N * nb]
        zp = Z.reshape(N, nb, 1).astype(np.float32)
    else:
        zp = np.float32(2 ** (bits - 1))
    W = ((q - zp) * S.reshape(N, nb, 1)).reshape(N, nb * bs)[:, :K]
    return np.ascontiguousarray(W.T)  # [K, N]

def rewrite(g, table, producers, new_inits, cache, counter):
    """递归把图里的 MatMulNBits 换成 MatMul（有偏置再接 Add）；同一份权重只还原一次。"""
    nodes = []
    for n in g.node:
        for a in n.attribute:
            if a.type == onnx.AttributeProto.GRAPH:
                rewrite(a.g, table, producers, new_inits, cache, counter)
        if n.op_type == "MatMulNBits":
            key = n.input[1]
            if key not in cache:
                wname = key + "_fp32"
                new_inits.append(numpy_helper.from_array(dequant(n, table, producers), wname)); cache[key] = wname
            outs = list(n.output)
            if len(n.input) > 5 and n.input[5]:  # bias
                mid = outs[0] + "_nobias"
                nodes.append(helper.make_node("MatMul", [n.input[0], cache[key]], [mid], name=n.name + "_mm"))
                nodes.append(helper.make_node("Add", [mid, n.input[5]], outs, name=n.name + "_bias"))
            else:
                nodes.append(helper.make_node("MatMul", [n.input[0], cache[key]], outs, name=n.name + "_mm"))
            counter[0] += 1
        else:
            nodes.append(n)
    del g.node[:]
    g.node.extend(nodes)

def collect_producers(g, prod):
    """收集“输出名 -> 产生它的节点”的映射（含子图）。"""
    for n in g.node:
        for o in n.output: prod[o] = n
        for a in n.attribute:
            if a.type == onnx.AttributeProto.GRAPH: collect_producers(a.g, prod)

def prune(m):
    """清理不再被引用的初始化器与节点（原来给 scales 用的 Cast 等）。"""
    used = set()
    def walk(g):
        for n in g.node:
            used.update(n.input)
            for a in n.attribute:
                if a.type == onnx.AttributeProto.GRAPH:
                    walk(a.g); used.update(o.name for o in a.g.output)
    walk(m.graph); used.update(o.name for o in m.graph.output)
    keep = [i for i in m.graph.initializer if i.name in used]
    del m.graph.initializer[:]; m.graph.initializer.extend(keep)
    # 去掉不再被引用的 Cast（原来给 scales 用）
    changed = True
    while changed:
        changed = False
        def walk2(g):
            nonlocal changed
            consumers = set()
            def cons(gg):
                for n in gg.node:
                    consumers.update(n.input)
                    for a in n.attribute:
                        if a.type == onnx.AttributeProto.GRAPH: cons(a.g); consumers.update(o.name for o in a.g.output)
            cons(m.graph); consumers.update(o.name for o in m.graph.output)
            keepn = [n for n in g.node if any(o in consumers for o in n.output) or not n.output]
            if len(keepn) != len(g.node): changed = True
            del g.node[:]; g.node.extend(keepn)
        walk2(m.graph)
    used = set()
    walk(m.graph); used.update(o.name for o in m.graph.output)
    keep = [i for i in m.graph.initializer if i.name in used]
    del m.graph.initializer[:]; m.graph.initializer.extend(keep)

def main():
    """命令行入口：读 sys.argv 做还原并保存。"""
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    m = onnx.load(src)
    table, prod = {}, {}
    build_consts(m.graph, table); collect_producers(m.graph, prod)
    new_inits, cache, counter = [], {}, [0]
    rewrite(m.graph, table, prod, new_inits, cache, counter)
    m.graph.initializer.extend(new_inits)
    prune(m)
    keep_ops = [o for o in m.opset_import if o.domain not in ("com.microsoft",)]
    del m.opset_import[:]; m.opset_import.extend(keep_ops)
    print(f"replaced {counter[0]} MatMulNBits, {len(cache)} unique weights")
    if "--external" in sys.argv:
        onnx.save(m, dst, save_as_external_data=True, all_tensors_to_one_file=True, location=os.path.basename(dst) + ".data", size_threshold=1024)
    else:
        onnx.save(m, dst)

if __name__ == "__main__":
    main()
