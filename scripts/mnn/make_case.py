"""为 MNN 的 ModuleBasic 生成一致性用例（文本格式），并提供 siglip / nllb 的输入生成。

用例目录内容：input.json（输入名与形状、输出名）、<输入名>.txt、<输出名>.txt。输入取自 npz，期望输出用 ORT 跑 ONNX 得到。
之后用固定提交编出的校验工具：
  ModuleBasic.out.exe <model.mnn> <case_dir> 0 0 10 4 <mask>
    参数依次：runMask=0、后端 0(CPU)、循环 10 次、线程 4、mask；mask = precision + 4 * memory，
    所以 0 = fp32/normal，8 = memory low（量化模型对照用，记录 diff rate 即可）。
通过标准：每个输出 diffmax <= 1% * max（工具内置）。该门槛只适用于 fp32/fp16 模型；量化模型用任务指标判（见 eval_*.py）。
注意：MSVC 版没有 AVX 内核分发，耗时不可参考；这里只看 diff rate。

子命令：
  python -I make_case.py case <model.onnx> <inputs.npz> <case_dir> [输出名,逗号分隔，缺省全部]
  python -I make_case.py siglip-inputs <image> <out.npz>               用一张图生成 SigLIP2 的输入 npz
  python -I make_case.py nllb-inputs <split_dir> <tokenizer.json> <out_dir> [step=3]
        用 ORT 跑 NLLB 拆图，截取第 step 步 decoder_step 的全部输入，并存 encoder / cross_kv 的输入 npz
Rust 真库测试（M3）读 ARKLI_MNN_CASE 指向这里生成的用例目录。
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import die  # noqa: E402

# SigLIP2 输入边长与输入名
SIGLIP_SIZE = 224
SIGLIP_INPUT = "pixel_values"
# 文本输出的数字格式
FMT = "%.8g"
# NLLB 解码强制的语言码与特殊 id，示例句
NLLB_SRC_LANG, NLLB_FORCED_LANG, NLLB_SAMPLE, EOS = "zho_Hans", "eng_Latn", "你好，世界！", 2
HEADS, HEAD_DIM = 16, 64


def dump(case, name, a):
    """把张量按一维文本存成 <name>.txt。"""
    np.savetxt(os.path.join(case, name + ".txt"), np.asarray(a).reshape(-1), fmt=FMT)


def cmd_case(model, npz, case, names=None):
    """用 ORT 算期望输出，生成 ModuleBasic 用例目录。"""
    import onnxruntime as ort
    os.makedirs(case, exist_ok=True)
    so = ort.SessionOptions()
    so.log_severity_level = 3
    s = ort.InferenceSession(model, so, providers=["CPUExecutionProvider"])
    data = dict(np.load(npz))
    feed = {i.name: data[i.name] for i in s.get_inputs()}
    names = names.split(",") if names else [o.name for o in s.get_outputs()]
    res = s.run(names, feed)
    for k, v in feed.items():
        dump(case, k, v)
    for k, v in zip(names, res):
        dump(case, k, v)
    with open(os.path.join(case, "input.json"), "w", encoding="utf-8") as f:
        json.dump({"inputs": [{"name": k, "shape": list(v.shape)} for k, v in feed.items()], "outputs": names}, f)
    print("case", case, "inputs", len(feed), "outputs", len(names))


def cmd_siglip_inputs(image, out):
    """用一张图生成 SigLIP2 输入（与 eval_siglip.py 的预处理一致）。"""
    from PIL import Image
    im = Image.open(image).convert("RGB").resize((SIGLIP_SIZE, SIGLIP_SIZE), Image.BILINEAR)
    a = (np.asarray(im, dtype=np.float32) / 255.0 - 0.5) / 0.5
    np.savez(out, **{SIGLIP_INPUT: a.transpose(2, 0, 1)[None].copy()})
    print("saved", out)


def cmd_nllb_inputs(d, tokp, out, step_n=3):
    """跑 NLLB 拆图，截取第 step_n 步 decoder_step 的输入；同时存 encoder / cross_kv 的输入。"""
    import onnxruntime as ort
    from tokenizers import Tokenizer
    os.makedirs(out, exist_ok=True)
    so = ort.SessionOptions()
    so.log_severity_level = 3
    S = {g: ort.InferenceSession(os.path.join(d, g + ".onnx"), so, providers=["CPUExecutionProvider"]) for g in ("encoder", "cross_kv", "decoder_step")}
    emb = np.load(os.path.join(d, "embed_fp32.npy"))
    tok = Tokenizer.from_file(tokp)
    ids = [tok.token_to_id(NLLB_SRC_LANG)] + tok.encode(NLLB_SAMPLE, add_special_tokens=False).ids + [EOS]
    a = np.array([ids], np.int64)
    enc_feed = {"input_ids": a, "attention_mask": np.ones_like(a), "inputs_embeds": emb[ids][None]}
    np.savez(os.path.join(out, "encoder_in.npz"), **enc_feed)
    h = S["encoder"].run(None, enc_feed)[0]
    np.savez(os.path.join(out, "cross_kv_in.npz"), encoder_hidden_states=h)
    names = [o.name for o in S["cross_kv"].get_outputs()]
    past = dict(zip(names, S["cross_kv"].run(None, {"encoder_hidden_states": h})))
    for i in S["decoder_step"].get_inputs():
        if i.name.startswith("past_key_values.") and ".decoder." in i.name:
            past[i.name] = np.zeros((1, HEADS, 0, HEAD_DIM), np.float32)
    cur, forced = EOS, tok.token_to_id(NLLB_FORCED_LANG)
    for step in range(step_n + 1):
        feed = {"input_ids": np.array([[cur]], np.int64), "inputs_embeds": emb[[cur]][None], "encoder_attention_mask": np.ones((1, len(ids)), np.int64)}
        feed.update(past)
        if step == step_n:
            np.savez(os.path.join(out, "decoder_step_in.npz"), **{k: feed[k] for k in (i.name for i in S["decoder_step"].get_inputs())})
            break
        outs = dict(zip([o.name for o in S["decoder_step"].get_outputs()], S["decoder_step"].run(None, feed)))
        for k, v in outs.items():
            if k.startswith("present."):
                past[k.replace("present.", "past_key_values.")] = v
        cur = forced if step == 0 else int(outs["logits"][0, -1].argmax())
    print("saved inputs, step", step_n)


def main():
    """命令行入口：按子命令分发。"""
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    cmd, rest = a[0], a[1:]
    if cmd == "case" and len(rest) in (3, 4):
        cmd_case(*rest)
    elif cmd == "siglip-inputs" and len(rest) == 2:
        cmd_siglip_inputs(*rest)
    elif cmd == "nllb-inputs" and len(rest) in (3, 4):
        cmd_nllb_inputs(rest[0], rest[1], rest[2], int(rest[3]) if len(rest) == 4 else 3)
    else:
        die("参数不对，见脚本顶部用法")


if __name__ == "__main__":
    main()
