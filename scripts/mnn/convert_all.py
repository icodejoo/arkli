"""一键转换：按 recipes.json 把模型（siglip2 / nllb / asr / ocr，ocr6 为 PP-OCRv6 small，couplet 为对联 GPT-2，sdxs 为符号生成 SDXS-512）从 fp32 ONNX 原版转成 MNN 产物。

流程（每个模型）：检查原版是否已下载 -> 前处理（nllb：词表裁剪拆图、交叉 KV 小图、嵌入表 int8；couplet：去 KV cache、词嵌入 int8）
-> 逐张图调 mnnconv.convert -> 拷贝附带文件 -> 打印产物体积。产物放 out_dir()/<清单 id>/，转换日志放 work/logs/。

用法：
  python -I convert_all.py                       转各模型的默认变体（不含 sdxs，它要先 fetch.py sdxs 下约 1.8GB，需显式指定）
  python -I convert_all.py siglip2 ocr           只转指定模型
  python -I convert_all.py nllb --variant nllb=w8   指定变体（可重复；变体名见 recipes.json）
  python -I convert_all.py --list                列出模型、变体与产物 id
  python -I convert_all.py --force               已有产物也重转
  python -I convert_all.py nllb --variant nllb=w6hqq --model-json-only <目录>   只渲染 model.json（不转模型）
前置：先 `python -I fetch.py` 下好原版；nllb 还要先 `python -I vocab_build.py` 生成 v2 词表（dl/nllb-tok-v2）；
生产转换请先 native/mnn/build-tools.ps1 并设 ARKLI_MNNCONVERT（见 mnnconv.py）。
nllb 产物目录除了模型文件，还会生成 model.json、NOTICE.txt，并带上 LICENSE；split 目录里的 tokenizer.sha256 记录前处理用的词表，
词表变了会自动重做前处理并重转（避免把旧词表的拆图/产物误当成新的）。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (HERE, die, dl_dir, find_asr_model_dir, fmt_bytes, load_recipes, log, need_file,  # noqa: E402
                    out_dir, sha256_file, split_dir, work_dir)
import mnnconv  # noqa: E402

# 无参数时不转的模型（体积大、只服务单个工具，需显式指定，与 fetch.py 的缺省分组保持一致）
EXPLICIT_ONLY_MODELS = ("sdxs",)

# 产物目录里记录转换参数的文件名（pack.py 会跳过它）
INFO_NAME = "convert.json"
# 写文本产物统一用 LF 换行（Windows 上默认会写成 CRLF，sha 会随平台变）
LF = "\n"
# OCR 识别字典文件名（Rust 管线读它：一行一字）
OCR_DICT_NAME = "ppocr_keys.txt"
# 拆图目录里记录“前处理所用词表指纹”的文件名
TOKENIZER_STAMP = "tokenizer.sha256"
# nllb 前处理产物，齐了就不重做
NLLB_SPLIT_FILES = ["encoder.onnx", "decoder_first.onnx", "decoder_step.onnx", "cross_kv.onnx", "embed_fp32.npy", "embed.i8", "embed.scale"]


def resolve(ref):
    """把配方里的 `前缀:相对路径` 解析成绝对路径。前缀 dl / split / asr / data（scripts/mnn/data）。"""
    kind, _, rel = ref.partition(":")
    if kind == "data":
        return os.path.join(HERE, "data", rel)
    if kind == "dl":
        return os.path.join(dl_dir(), rel)
    if kind == "split":
        return os.path.join(split_dir(), rel)
    if kind == "couplet":
        return os.path.join(couplet_prep_dir(), rel)
    if kind == "sdxs":
        return os.path.join(sdxs_prep_dir(), rel)
    if kind == "asr":
        return os.path.join(find_asr_model_dir(os.path.join(dl_dir(), "asr", "fp32")), rel)
    die(f"配方里的路径前缀不认识：{ref}")


def couplet_prep_dir():
    """对联前处理产物目录（去 past + 词嵌入 int8 的 onnx）：<split 目录的上一级>/couplet。"""
    return os.path.join(os.path.dirname(split_dir()), "couplet")


def sdxs_prep_dir():
    """SDXS 前处理产物目录（三个 ONNX 与 tokenizer.json）：<split 目录的上一级>/sdxs。"""
    return os.path.join(os.path.dirname(split_dir()), "sdxs")


def run_script(name, *args):
    """用 python -I 在子进程里跑同目录脚本（隔离内存，也保证 -I 口径一致）。"""
    cmd = [sys.executable, "-I", os.path.join(HERE, name), *map(str, args)]
    log("$ " + " ".join(cmd))
    if subprocess.run(cmd).returncode != 0:
        die(f"{name} 执行失败")


def prepare_nllb(rec):
    """nllb 前处理：词表裁剪 + 拆图 -> 交叉 KV 小图 -> 嵌入表 int8。已齐且词表没变则跳过。
    词表取 rec["tokenizer"]（vocab_build.py 产出的 v2）；拆图目录里 tokenizer.sha256 记录上次用的词表。"""
    sd = split_dir()
    trim_tok = need_file(resolve(rec["tokenizer"]), "先运行 vocab_build.py")
    stamp = os.path.join(sd, TOKENIZER_STAMP)
    want = sha256_file(trim_tok)
    have = open(stamp).read().strip() if os.path.isfile(stamp) else None
    if all(os.path.isfile(os.path.join(sd, f)) for f in NLLB_SPLIT_FILES) and have == want:
        log(f"nllb 前处理产物已齐且词表一致，跳过（{sd}）")
        return
    if have != want and os.path.isfile(stamp):
        log("词表与拆图目录里记录的不一致，重做前处理")
    fp32 = os.path.join(dl_dir(), "nllb-fp32")
    full_tok = need_file(os.path.join(fp32, "tokenizer.json"), "先运行 fetch.py nllb")
    need_file(os.path.join(fp32, "encoder_model.onnx"), "先运行 fetch.py nllb")
    need_file(os.path.join(fp32, "decoder_model_merged.onnx"), "先运行 fetch.py nllb")
    run_script("nllb_prepare.py", fp32, full_tok, trim_tok, sd)
    run_script("nllb_crosskv.py", sd)
    run_script("nllb_embed.py", os.path.join(sd, "embed_fp32.npy"), sd)
    with open(stamp, "w") as f:
        f.write(want)


# 对联前处理产物文件名
COUPLET_PREP_ONNX = "model_e8.onnx"


def prepare_couplet(rec):
    """对联前处理：fp32 ONNX 去掉 KV cache（整句重算）并把词嵌入改成图内 int8，输出到 couplet_prep_dir()。已有就跳过。"""
    out = os.path.join(couplet_prep_dir(), COUPLET_PREP_ONNX)
    if os.path.isfile(out):
        log(f"对联前处理产物已有，跳过：{out}")
        return
    src = need_file(os.path.join(dl_dir(), "couplet", "couplet-gpt2-fp32.onnx"), "先运行 fetch.py couplet")
    run_script("couplet_prepare.py", "--int8-embed", src, out)


# SDXS 前处理产物，齐了就不重做
SDXS_PREP_FILES = ["text_encoder.onnx", "unet.onnx", "vae_decoder.onnx", "tokenizer.json"]


def prepare_sdxs(rec):
    """SDXS 前处理：原版 PyTorch 权重导出三张 ONNX 并生成 tokenizer.json（sdxs_prepare.py），输出到 sdxs_prep_dir()。已齐就跳过。"""
    out = sdxs_prep_dir()
    if all(os.path.isfile(os.path.join(out, f)) for f in SDXS_PREP_FILES):
        log(f"SDXS 前处理产物已齐，跳过：{out}")
        return
    src = os.path.join(dl_dir(), "sdxs")
    need_file(os.path.join(src, "model_index.json"), "先运行 fetch.py sdxs")
    run_script("sdxs_prepare.py", src, out)


# 前处理钩子表：recipes.json 的 prepare 字段 -> 函数
PREPARE = {"nllb": prepare_nllb, "couplet": prepare_couplet, "sdxs": prepare_sdxs}


def render_model_json(rec, var):
    """按配方与变体渲染 model.json 的文本：键序取配方顺序（再追加 id/display_name/quantization），缩进 2 空格，不转义中文，LF 换行并以换行结尾；
    同样的配方输出逐字节相同（可信版本的 sha256 见 README）。无 model_json 的模型返回 None。"""
    mj = rec.get("model_json")
    if not mj:
        return None
    out = json.loads(json.dumps(mj))  # 深拷贝
    out["id"] = var["id"]
    out["display_name"] = var.get("display_name", rec["display_name"])
    out["quantization"] = var.get("quant_label", "")
    return json.dumps(out, ensure_ascii=False, indent=2) + LF


def write_model_json(rec, var, dst, overwrite=True):
    """把 model.json 写进 dst（二进制写，保证 LF）；overwrite 为假且文件已存在时不动它。返回是否写了。"""
    text = render_model_json(rec, var)
    path = os.path.join(dst, "model.json")
    if text is None or (not overwrite and os.path.isfile(path)):
        return False
    with open(path, "w", encoding="utf-8", newline=LF) as f:
        f.write(text)
    return True


def write_package_files(rec, var, dst, overwrite_model_json=True):
    """按配方生成 model.json（运行时清单）与 NOTICE.txt（占位符 {vocab_size}、{quant_desc} 由词表与变体填）。没有 model_json 的模型（如 sdxs）只写 NOTICE。
    overwrite_model_json 为假时已有的 model.json 保持原样（已发布版本不被配方悄悄改写）。"""
    if rec.get("model_json"):
        write_model_json(rec, var, dst, overwrite_model_json)
    if rec.get("notice"):
        tok_path = os.path.join(dst, "tokenizer.json")  # 对联用 vocab.txt，没有 tokenizer.json，不填 {vocab_size}
        text = open(resolve(rec["notice"]), encoding="utf-8").read()
        if os.path.isfile(tok_path):
            tok = json.load(open(tok_path, encoding="utf-8"))
            text = text.replace("{vocab_size}", f"{len(tok['model']['vocab']):,}")
        text = text.replace("{quant_desc}", var.get("quant_desc", ""))
        with open(os.path.join(dst, "NOTICE.txt"), "w", encoding="utf-8", newline=LF) as f:
            f.write(text)


def write_ocr_dict(rec_onnx, dst):
    """从 PP-OCR 识别模型 onnx 的元数据字段 character 取识别字典，写成 ppocr_keys.txt（一行一字，LF，末尾换行）。"""
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.log_severity_level = 3
    meta = ort.InferenceSession(rec_onnx, so, providers=["CPUExecutionProvider"]).get_modelmeta().custom_metadata_map
    chars = meta.get("character")
    if not chars:
        die(f"{rec_onnx} 的元数据里没有 character 字段，无法生成识别字典")
    with open(os.path.join(dst, OCR_DICT_NAME), "w", encoding="utf-8", newline=LF) as f:
        f.write(chars if chars.endswith(LF) else chars + LF)


def write_ocr_dict_yaml(rec_yml, dst):
    """从 PP-OCRv6 识别模型的 inference.yml（PostProcess.character_dict）写 ppocr_keys.txt（一行一字，LF，末尾换行）。
    需要 PyYAML（开发机可选依赖，未写进 requirements.txt）；条目必须全是单行非空字符串，否则报错。"""
    try:
        import yaml
    except ImportError:
        die("解析 inference.yml 需要 PyYAML：pip install pyyaml（只在开发机转换时用）")
    with open(rec_yml, encoding="utf-8") as f:
        chars = yaml.safe_load(f)["PostProcess"]["character_dict"]
    if not all(isinstance(c, str) and c and LF not in c for c in chars) or len(set(chars)) != len(chars):
        die(f"{rec_yml} 的 character_dict 含非字符串、空项、换行或重复项")
    with open(os.path.join(dst, OCR_DICT_NAME), "w", encoding="utf-8", newline=LF) as f:
        f.write("".join(c + LF for c in chars))


def convert_model(key, rec, vname, force):
    """转换一个模型的一个变体，返回产物目录。"""
    var = rec["variants"].get(vname)
    if not var:
        die(f"{key} 没有变体 {vname}，可选：{', '.join(rec['variants'])}")
    # 先检查输入，缺了给出明确的补救提示
    if rec.get("prepare"):
        PREPARE[rec["prepare"]](rec)
    for g in rec["graphs"]:
        need_file(resolve(g["input"]), f"先运行 fetch.py {rec['group']}")
    dst = os.path.join(out_dir(), var["id"])
    os.makedirs(dst, exist_ok=True)
    logs = os.path.join(work_dir(), "logs")
    os.makedirs(logs, exist_ok=True)
    info = {"model": key, "variant": vname, "converter": mnnconv.converter_label(), "graphs": {}}
    if rec.get("tokenizer"):
        info["tokenizer_sha256"] = sha256_file(resolve(rec["tokenizer"]))
        old = os.path.join(dst, INFO_NAME)
        if not force and os.path.isfile(old) and json.load(open(old, encoding="utf-8")).get("tokenizer_sha256") != info["tokenizer_sha256"]:
            log(f"{var['id']} 的旧产物用的不是当前词表，整体重转")
            force = True
    exe = mnnconv.converter_exe()
    if exe:
        info["converter_sha256"] = sha256_file(exe)
    converted = False  # 是否真的转换过至少一张图
    for g in rec["graphs"]:
        out = os.path.join(dst, g["output"])
        args = list(var.get("quant_by_graph", {}).get(g["name"], var["quant"])) + list(rec.get("common_args", []))
        info["graphs"][g["name"]] = args
        if os.path.isfile(out) and not force:
            log(f"已有，跳过：{var['id']}/{g['output']}（--force 重转）")
            continue
        for stale in (out, out + ".weight"):  # 外置权重文件可能被追加写，先清掉旧的
            if os.path.exists(stale):
                os.remove(stale)
        converted = True
        log(f"转换 {var['id']}/{g['output']}  参数 {' '.join(args) or '（fp32）'}")
        mnnconv.convert(resolve(g["input"]), out, args, os.path.join(logs, f"{var['id']}_{g['name']}.log"))
    for ref in rec.get("copy", []):
        src = resolve(ref)
        need_file(src)
        shutil.copyfile(src, os.path.join(dst, os.path.basename(src)))
    # 没有 --force 且所有 .mnn 都跳过：不改写已有的 model.json（它可能含手工确认过、已登记 sha 的内容）
    write_package_files(rec, var, dst, overwrite_model_json=converted or force)
    if rec.get("ocr_dict"):
        write_ocr_dict(resolve(rec["ocr_dict"]), dst)
    if rec.get("ocr_dict_yaml"):
        write_ocr_dict_yaml(resolve(rec["ocr_dict_yaml"]), dst)
    with open(os.path.join(dst, INFO_NAME), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
    return dst


def summarize(dst):
    """打印产物目录里每个文件的字节数。"""
    total = 0
    for n in sorted(os.listdir(dst)):
        if n == INFO_NAME:
            continue
        b = os.path.getsize(os.path.join(dst, n))
        total += b
        log(f"  {n:28s} {b:>13,d} B  {fmt_bytes(b)}")
    log(f"  合计 {total:,d} B（{fmt_bytes(total)}）")


def main():
    """命令行入口。"""
    rec_all = load_recipes()["models"]
    ap = argparse.ArgumentParser(description="按 recipes.json 一键转换模型")
    ap.add_argument("models", nargs="*", help=f"模型，可选 {', '.join(rec_all)}；缺省除 {', '.join(EXPLICIT_ONLY_MODELS)} 外的全部")
    ap.add_argument("--variant", action="append", default=[], metavar="模型=变体", help="指定变体，可重复")
    ap.add_argument("--force", action="store_true", help="已有产物也重转")
    ap.add_argument("--model-json-only", metavar="目录", help="只把所选模型（单个）的 model.json 渲染到该目录，不转模型、不查输入；用来复现已登记的 sha256")
    ap.add_argument("--list", action="store_true", help="只列出配方")
    a = ap.parse_args()
    chosen = dict(v.split("=", 1) for v in a.variant if "=" in v)
    if a.list:
        for k, r in rec_all.items():
            print(f"{k}: 默认 {r['default']}；变体 " + "，".join(f"{n}->{v['id']}" for n, v in r["variants"].items()))
        return
    if a.model_json_only:
        if len(a.models) != 1 or a.models[0] not in rec_all:
            die(f"--model-json-only 需要且只要一个模型名，可选：{', '.join(rec_all)}")
        r = rec_all[a.models[0]]
        vname = chosen.get(a.models[0], r["default"])
        if vname not in r["variants"]:
            die(f"{a.models[0]} 没有变体 {vname}，可选：{', '.join(r['variants'])}")
        os.makedirs(a.model_json_only, exist_ok=True)
        if not write_model_json(r, r["variants"][vname], a.model_json_only):
            die(f"{a.models[0]} 的配方没有 model_json")
        log(f"已写 {os.path.join(a.model_json_only, 'model.json')}")
        return
    keys = a.models or [k for k in rec_all if k not in EXPLICIT_ONLY_MODELS]
    for k in keys:
        if k not in rec_all:
            die(f"未知模型 {k}，可选：{', '.join(rec_all)}")
    log(f"转换器：{mnnconv.converter_label()}")
    for k in keys:
        r = rec_all[k]
        dst = convert_model(k, r, chosen.get(k, r["default"]), a.force)
        log(f"== {k} 完成：{dst}")
        summarize(dst)


if __name__ == "__main__":
    main()
