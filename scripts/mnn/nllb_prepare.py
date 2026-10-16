"""把 optimum 导出的 fp32 NLLB（encoder_model.onnx + decoder_model_merged.onnx）改造成 MNN 友好的静态图，输出到拆图目录：
  encoder.onnx        输入 input_ids, attention_mask, inputs_embeds -> last_hidden_state
  decoder_first.onnx  无 past：输入 input_ids, inputs_embeds, encoder_attention_mask, encoder_hidden_states -> logits + present.*（含交叉注意力 KV）
  decoder_step.onnx   有 past：输入同上 + past_key_values.*（48 个）-> logits + present.*.decoder.*（不再透传交叉注意力 KV）
  embed_fp32.npy      裁剪后的词嵌入表 [V, 1024]（nllb_embed.py 再转 int8+scale）
并做三件事：
  1. 词表裁剪：按随包 tokenizer.json（裁剪后的词表）把嵌入行、lm_head 列按 token 字符串映射回原 id 后抽取（保留 fp32 精度）；
  2. 词嵌入移到图外：删掉 Gather，图改收 inputs_embeds（未乘 sqrt(d) 的原始嵌入，缩放仍在图里）；
  3. 拆掉 merged decoder 顶层 If（use_cache_branch），lm_head 存成裁剪后的常量 [d, V]，让转换器能对它做权重量化。
decoder_first 只是中间产物：后面由 nllb_crosskv.py 取出交叉注意力投影权重，所有解码步统一走 decoder_step。

用法：python -I nllb_prepare.py <fp32_dir> <full_tokenizer.json> <trimmed_tokenizer.json> <out_dir>
  fp32_dir 里要有 encoder_model.onnx 与 decoder_model_merged.onnx（fetch.py nllb 的 nllb-fp32/）
需要约 8GB 内存。
"""
import json
import os
import sys

import numpy as np
import onnx
from onnx import numpy_helper, helper, TensorProto

# 图里新增的嵌入输入名与模型宽度
EMB_INPUT = "inputs_embeds"
D_MODEL = 1024
# 原模型里的词嵌入共享权重名与 lm_head 的新常量名
SHARED_NAME = "model.shared.weight_merged_0"
ENC_EMBED_NAME = "embed_tokens.weight"
LM_HEAD_NAME = "lm_head.weight"


def vocab_map(full_path, trim_path):
    """裁剪词表 id -> 原词表 id。"""
    full = json.load(open(full_path, encoding="utf-8"))
    trim = json.load(open(trim_path, encoding="utf-8"))
    f = dict(full["model"]["vocab"])
    for t in full.get("added_tokens", []):
        f[t["content"]] = t["id"]
    tv = trim["model"]["vocab"]
    keep = np.empty(len(tv), np.int64)
    for tok, tid in tv.items():
        if tok not in f:
            raise KeyError(f"裁剪词表里的 {tok!r} 不在原词表")
        keep[tid] = f[tok]
    return keep


def rename_all(nodes, old, new):
    """把节点列表里所有名为 old 的输入/输出改名为 new。"""
    for n in nodes:
        for i, x in enumerate(n.input):
            if x == old:
                n.input[i] = new
        for i, x in enumerate(n.output):
            if x == old:
                n.output[i] = new


def strip_embedding(nodes, table_name):
    """删除查嵌入表的 Gather，把它的输出改名为图输入 inputs_embeds。返回新节点列表。"""
    out = []
    gather_out = None
    for n in nodes:
        if n.op_type == "Gather" and n.input[0] == table_name:
            gather_out = n.output[0]
            continue
        out.append(n)
    if gather_out is None:
        raise RuntimeError("没找到嵌入 Gather")
    rename_all(out, gather_out, EMB_INPUT)
    return out


def used_names(nodes):
    """返回节点列表用到的所有输入名集合（用来裁掉无用的初始化器）。"""
    s = set()
    for n in nodes:
        s.update(n.input)
    return s


def emb_input():
    """图新增的 inputs_embeds 输入声明 [batch, seq, 1024]。"""
    return helper.make_tensor_value_info(EMB_INPUT, TensorProto.FLOAT, ["batch_size", "sequence_length", D_MODEL])


def save(model, path):
    """保存带外部数据的 ONNX 并校验；先删旧的 .data（onnx 会往已有同名外部数据文件追加）。"""
    if os.path.exists(path + ".data"):
        os.remove(path + ".data")  # onnx 会往已存在的外部数据文件末尾追加
    onnx.save(model, path, save_as_external_data=True, all_tensors_to_one_file=True,
              location=os.path.basename(path) + ".data", size_threshold=1024)
    onnx.checker.check_model(path)
    print("saved", path)


def prepare_encoder(src, keep, out_dir):
    """处理 encoder：删嵌入 Gather、改收 inputs_embeds，保存并返回裁剪后的嵌入表。"""
    m = onnx.load(src)
    g = m.graph
    inits = {i.name: i for i in g.initializer}
    table = numpy_helper.to_array(inits[ENC_EMBED_NAME])
    emb = np.ascontiguousarray(table[keep])
    del table
    nodes = strip_embedding(list(g.node), ENC_EMBED_NAME)
    used = used_names(nodes)
    new_inits = [i for i in g.initializer if i.name in used]
    graph = helper.make_graph(nodes, "encoder", list(g.input) + [emb_input()], list(g.output), new_inits)
    model = helper.make_model(graph, opset_imports=m.opset_import, ir_version=m.ir_version)
    save(model, os.path.join(out_dir, "encoder.onnx"))
    return emb


def branch_graph(m, branch, name, keep, emb, drop_cross_out):
    """取 merged decoder 的 If 分支（else=首步/then=后续步）做成独立图；lm_head 换成裁剪后的常量。"""
    g = m.graph
    if_node = g.node[0]
    assert if_node.op_type == "If"
    sub = [a.g for a in if_node.attribute if a.name == branch][0]
    nodes = [onnx.NodeProto() for _ in sub.node]
    for dst, srcn in zip(nodes, sub.node):
        dst.CopyFrom(srcn)
    nodes = strip_embedding(nodes, SHARED_NAME)
    # lm_head：Transpose(shared) → 裁剪后的常量 [d, V]
    lm_name = LM_HEAD_NAME
    kept = []
    for n in nodes:
        if n.op_type == "Transpose" and n.input[0] == SHARED_NAME:
            rename_all(nodes, n.output[0], lm_name)
            continue
        kept.append(n)
    nodes = kept
    # 分支输出改名为顶层 If 的输出名；需要丢弃的交叉注意力 KV 不进输出
    outputs = []
    top_inputs = {i.name: i for i in g.input}
    for bo, top in zip(sub.output, if_node.output):
        if drop_cross_out and ".encoder." in top:
            continue
        if bo.name in top_inputs or bo.name in {o.name for o in outputs}:
            nodes.append(helper.make_node("Identity", [bo.name], [top], name="out_" + top))
        else:
            rename_all(nodes, bo.name, top)
        vi = helper.make_tensor_value_info(top, bo.type.tensor_type.elem_type, None)
        vi.type.CopyFrom(bo.type)
        vi.name = top
        if top == "logits":
            vi.type.tensor_type.shape.dim[-1].dim_value = len(keep)
        outputs.append(vi)
    used = used_names(nodes)
    inputs = [i for i in g.input if i.name in used and i.name != "use_cache_branch"] + [emb_input()]
    inits = [i for i in g.initializer if i.name in used and i.name != SHARED_NAME]
    lm = np.ascontiguousarray(emb.T)  # 共享权重：lm_head = shared^T
    inits.append(numpy_helper.from_array(lm, lm_name))
    graph = helper.make_graph(nodes, name, inputs, outputs, inits)
    return helper.make_model(graph, opset_imports=m.opset_import, ir_version=m.ir_version)


def main():
    """命令行入口：词表裁剪 + 拆图，输出到 out_dir。"""
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    fp32_dir, full_tok, trim_tok, out_dir = sys.argv[1:5]
    os.makedirs(out_dir, exist_ok=True)
    keep = vocab_map(full_tok, trim_tok)
    print("vocab", len(keep), "max orig id", keep.max())
    emb = prepare_encoder(os.path.join(fp32_dir, "encoder_model.onnx"), keep, out_dir)
    np.save(os.path.join(out_dir, "embed_fp32.npy"), emb)
    m = onnx.load(os.path.join(fp32_dir, "decoder_model_merged.onnx"))
    shared = numpy_helper.to_array([i for i in m.graph.initializer if i.name == SHARED_NAME][0])
    if not np.array_equal(shared[keep], emb):
        sys.exit("错误：encoder 与 decoder 的词嵌入不一致，不能共用一张表")
    print("encoder/decoder 嵌入一致：True")
    del shared
    for branch, name, drop in (("else_branch", "decoder_first", False), ("then_branch", "decoder_step", True)):
        save(branch_graph(m, branch, name, keep, emb, drop), os.path.join(out_dir, name + ".onnx"))


if __name__ == "__main__":
    main()
