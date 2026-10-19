"""打包前登记：打印产物目录里每个文件的字节数与 sha256，并生成可贴进 app/src/main/assets/ai/models.json 的条目片段。

仓库不提交任何模型产物；上传 release 由用户执行。本脚本只读产物目录，不改任何文件。
URL 按 recipes.json 里该模型的 release_tag 拼成 https://github.com/icodejoo/arkli/releases/download/<tag>/<文件名>（发布前需核对）。
文件角色：.mnn -> model，.mnn.weight / .i8 / .scale -> weights，tokenizer.json / tokens.txt -> tokenizer，model.json -> config，其余（NOTICE、LICENSE）-> aux。

加 --zip <输出目录> 时另打单个可复现 zip（<id>-<version>.zip，条目按名排序、时间戳固定为 1980-01-01、权限固定），
条目布局 = 模型安装目录的最终布局；输出的清单条目改为 archive（zip 的 name/bytes/sha256/urls）+ files（解压后文件，不带 urls），
并在 zip 旁写 <zip>.json（包 sha256、字节数、解压后总字节数、条目数）。加 --apply <models.json> 把该条目回写进清单（只替换同 id 条目的 archive/files，其余字段原样）。
单文件 deflate 收益 <3% 就改用 stored（.mnn 权重基本压不动，省解压 CPU）。

用法：
  python -I pack.py <产物目录或清单 id> [--tag release-tag] [--version 1] [--json out.json] [--zip 输出目录] [--apply models.json]
  例：python -I pack.py siglip2-mnn-w8
默认到 out_dir() 下找同名目录；--tag 缺省用 recipes.json 里对应模型的 release_tag。
"""
import argparse
import json
import os
import sys
import zipfile
import zlib

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
ROLE_BY_NAME = {"tokenizer.json": "tokenizer", "tokens.txt": "tokenizer", "vocab.txt": "tokenizer", "ppocr_keys.txt": "tokenizer", "model.json": "config"}


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


# zip 条目固定时间戳（可复现构建）
ZIP_DATE = (1980, 1, 1, 0, 0, 0)
# 条目权限（rw-r--r--）写在 external_attr 高 16 位
ZIP_ATTR = 0o100644 << 16
# deflate 收益低于该比例就用 stored
MIN_GAIN = 0.03


def deflate_size(data):
    """返回 data 经 deflate（level 9）压缩后的字节数。"""
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    return len(c.compress(data)) + len(c.flush())


def build_zip(d, files, zip_path):
    """把 files（build_entry 的登记）按名排序写成可复现 zip，返回统计 dict。"""
    stats = {"entries": 0, "stored": 0, "deflated": 0, "raw": 0, "gain": {}}
    with zipfile.ZipFile(zip_path, "w") as z:
        for f in sorted(files, key=lambda x: x["name"]):
            with open(os.path.join(d, f["name"]), "rb") as fh:
                data = fh.read()
            gain = 1 - deflate_size(data) / max(len(data), 1)
            comp = zipfile.ZIP_DEFLATED if gain >= MIN_GAIN else zipfile.ZIP_STORED
            zi = zipfile.ZipInfo(f["name"], ZIP_DATE)
            zi.compress_type = comp
            zi.external_attr = ZIP_ATTR
            zi.create_system = 3
            z.writestr(zi, data, compress_type=comp, compresslevel=9)
            stats["entries"] += 1
            stats["raw"] += len(data)
            stats["deflated" if comp == zipfile.ZIP_DEFLATED else "stored"] += 1
            stats["gain"][f["name"]] = round(gain, 4)
    stats["zip_bytes"] = os.path.getsize(zip_path)
    return stats


def to_archive_entry(entry, files, zip_path, tag, stats):
    """把 build_entry 的结果改写成 archive 形态（files 去掉 urls），并返回条目。"""
    name = os.path.basename(zip_path)
    e = dict(entry)
    e["files"] = [{k: v for k, v in f.items() if k != "urls"} for f in files]
    e["archive"] = {"name": name, "bytes": stats["zip_bytes"], "sha256": sha256_file(zip_path), "role": "archive",
                    "urls": [f"{RELEASE_BASE}/{tag}/{name}"]}
    return e


def apply_manifest(path, entry):
    """把 entry 的 archive/files 回写到 models.json 里同 id 的条目（保留其余字段与顺序）。"""
    with open(path, encoding="utf-8") as fh:
        m = json.load(fh)
    for i, old in enumerate(m["models"]):
        if old["id"] == entry["id"]:
            new = {}
            for k, v in old.items():
                if k == "files":
                    new["archive"] = entry["archive"]
                    new["files"] = entry["files"]
                elif k != "archive":
                    new[k] = v
            m["models"][i] = new
            break
    else:
        die(f"{path} 里没有 id={entry['id']}")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(m, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def main():
    """命令行入口。"""
    ap = argparse.ArgumentParser(description="打印产物字节数与 sha256，生成 models.json 条目片段")
    ap.add_argument("target", help="产物目录，或 out_dir() 下的清单 id")
    ap.add_argument("--tag", help="release tag（缺省取 recipes.json）")
    ap.add_argument("--version", default="1", help="清单 version 字段")
    ap.add_argument("--json", help="把片段另存为文件")
    ap.add_argument("--zip", help="另打单个可复现 zip 到该目录，并输出 archive 形态的条目")
    ap.add_argument("--apply", help="（需配 --zip）把条目回写进该 models.json")
    a = ap.parse_args()
    d = a.target if os.path.isdir(a.target) else os.path.join(out_dir(), a.target)
    if not os.path.isdir(d):
        die(f"找不到产物目录：{d}")
    entry, files = build_entry(d, a.tag, a.version)
    log(f"== {entry['id']}")
    for f in files:
        log(f"{f['name']:28s} {f['bytes']:>13,d} B  {fmt_bytes(f['bytes']):>9s}  {f['sha256']}")
    log(f"合计 {entry['totalBytes']:,d} B（{fmt_bytes(entry['totalBytes'])}）")
    if a.zip:
        os.makedirs(a.zip, exist_ok=True)
        zp = os.path.join(a.zip, f"{entry['id']}-{entry['version']}.zip")
        tag = entry["files"][0]["urls"][0].rsplit("/", 2)[-2]
        st = build_zip(d, files, zp)
        entry = to_archive_entry(entry, files, zp, tag, st)
        side = {"name": os.path.basename(zp), "bytes": st["zip_bytes"], "sha256": entry["archive"]["sha256"],
                "unpackedBytes": entry["totalBytes"], "entries": st["entries"], "stored": st["stored"],
                "deflated": st["deflated"], "deflateGain": st["gain"]}
        with open(zp + ".json", "w", encoding="utf-8", newline="\n") as fh:
            json.dump(side, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        log(f"zip {zp}: {st['zip_bytes']:,d} B（解压后 {st['raw']:,d} B，{st['entries']} 条目，stored {st['stored']} / deflate {st['deflated']}）sha256 {entry['archive']['sha256']}")
        if a.apply:
            apply_manifest(a.apply, entry)
            log(f"已回写 {a.apply}")
    text = json.dumps(entry, ensure_ascii=False, indent=2)
    log("\n-- models.json 条目片段（URL 发布前核对）--")
    log(text)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            f.write(text + "\n")


if __name__ == "__main__":
    main()
