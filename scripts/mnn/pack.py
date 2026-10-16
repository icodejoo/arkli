"""打包前登记：打印产物目录里每个文件的字节数与 sha256，并生成可贴进 app/src/main/assets/ai/models.json 的条目片段。

仓库不提交任何模型产物；上传 release 由用户执行。本脚本只读产物目录，不改任何文件。
URL 按 recipes.json 里该模型的 release_tag 拼成 https://github.com/icodejoo/arkli/releases/download/<tag>/<文件名>（发布前需核对）。
文件角色：.mnn -> model，.mnn.weight / .i8 / .scale -> weights，tokenizer.json / tokens.txt -> tokenizer，model.json -> config，其余（NOTICE、LICENSE）-> aux。

用法：
  python -I pack.py <产物目录或清单 id> [--tag release-tag] [--version 1] [--json out.json]
  例：python -I pack.py siglip2-mnn-w8
默认到 out_dir() 下找同名目录；--tag 缺省用 recipes.json 里对应模型的 release_tag。
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import die, fmt_bytes, load_json, load_recipes, log, out_dir, sha256_file  # noqa: E402

# 产物目录里不登记的内部文件名
SKIP = {"convert.json"}
# release 下载地址前缀
RELEASE_BASE = "https://github.com/icodejoo/arkli/releases/download"
# 清单里模型目录前缀
MODEL_DIR_PREFIX = "models"
# 按文件名后缀推断 role
ROLE_BY_SUFFIX = ((".mnn.weight", "weights"), (".i8", "weights"), (".scale", "weights"), (".mnn", "model"))
ROLE_BY_NAME = {"tokenizer.json": "tokenizer", "tokens.txt": "tokenizer", "ppocr_keys.txt": "tokenizer", "model.json": "config"}


def role_of(name):
    """按文件名推断清单里的 role。"""
    if name in ROLE_BY_NAME:
        return ROLE_BY_NAME[name]
    for suf, role in ROLE_BY_SUFFIX:
        if name.endswith(suf):
            return role
    return "aux"


def find_recipe(model_id):
    """按产物 id 反查 recipes.json 里的模型配方，返回 (key, 配方) 或 (None, None)。"""
    for k, r in load_recipes()["models"].items():
        if any(v["id"] == model_id for v in r["variants"].values()):
            return k, r
    return None, None


def build_entry(d, tag, version):
    """扫描产物目录 d，返回 (清单条目 dict, 文件登记列表)。"""
    model_id = os.path.basename(os.path.normpath(d))
    _, rec = find_recipe(model_id)
    tag = tag or (rec["release_tag"] if rec else None)
    if not tag:
        die("不认识这个 id，请用 --tag 指定 release tag")
    files = []
    for n in sorted(os.listdir(d)):
        p = os.path.join(d, n)
        if n in SKIP or not os.path.isfile(p):
            continue
        files.append({"name": n, "bytes": os.path.getsize(p), "sha256": sha256_file(p), "role": role_of(n),
                      "urls": [f"{RELEASE_BASE}/{tag}/{n}"]})
    if not files:
        die(f"{d} 里没有产物")
    entry = {"id": model_id, "displayName": rec["display_name"] if rec else model_id, "version": str(version),
             "dir": f"{MODEL_DIR_PREFIX}/{model_id}", "totalBytes": sum(f["bytes"] for f in files),
             "license": rec["license"] if rec else "unknown", "files": files}
    return entry, files


def main():
    """命令行入口。"""
    ap = argparse.ArgumentParser(description="打印产物字节数与 sha256，生成 models.json 条目片段")
    ap.add_argument("target", help="产物目录，或 out_dir() 下的清单 id")
    ap.add_argument("--tag", help="release tag（缺省取 recipes.json）")
    ap.add_argument("--version", default="1", help="清单 version 字段")
    ap.add_argument("--json", help="把片段另存为文件")
    a = ap.parse_args()
    d = a.target if os.path.isdir(a.target) else os.path.join(out_dir(), a.target)
    if not os.path.isdir(d):
        die(f"找不到产物目录：{d}")
    entry, files = build_entry(d, a.tag, a.version)
    log(f"== {entry['id']}")
    for f in files:
        log(f"{f['name']:28s} {f['bytes']:>13,d} B  {fmt_bytes(f['bytes']):>9s}  {f['sha256']}")
    log(f"合计 {entry['totalBytes']:,d} B（{fmt_bytes(entry['totalBytes'])}）")
    text = json.dumps(entry, ensure_ascii=False, indent=2)
    log("\n-- models.json 条目片段（URL 发布前核对）--")
    log(text)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            f.write(text + "\n")


if __name__ == "__main__":
    main()
