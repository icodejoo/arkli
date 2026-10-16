"""把 derived.tsv 打成设备端可随机访问的语料包（zip，deflate -9）。

只用标准库，命令带 `python -I`：

    python -I build_pack.py                  # 默认读 arkli-models/_src/couplet-derived/derived.tsv
    python -I build_pack.py --src x.tsv --out-dir <目录> --manifest <清单片段.json>

包内文件（小端，见 docs/design/couplet-corpus.md）：
- lines.txt    ：每行 `上联\\t下联\\t横批\\n`（UTF-8，已去掉分类列）
- offsets.u32  ：N+1 个 u32，第 i 副对联在 lines.txt 里的字节区间 [off[i], off[i+1])
- flags.u32    ：N 个 u32，低 16 位是分类位图（按 CATS 顺序），16~19 位是首选分类下标
- pools.u32    ：各抽取池的对联序号（升序）顺序拼接
- meta.json    ：版本、条数、分类名、各池的名称/条数/在 pools.u32 里的起点（按 u32 个数计）
池 0 =「全部」（不含挽联）；池 k（1~16）= 含第 k-1 个分类的全部对联，其中挽联池就是含挽联标签的那些。
"""
import argparse
import hashlib
import json
import os
import struct
import zipfile

# 16 类，顺序固定（位图与池编号都依赖它，改了要升包版本）
CATS = ["春节", "节庆", "婚庆", "祝寿", "乔迁", "开业", "学业", "事业", "家国", "山水", "人生", "情感", "文墨", "怀古", "挽联", "通用"]
# 挽联在 CATS 里的下标
MOURN = CATS.index("挽联")
# 包格式版本
PACK_VERSION = 1
# 池 0 的展示名
ALL_POOL_NAME = "全部"
# 首选分类在 flags 里的移位
PRIMARY_SHIFT = 16
# zip 里固定的时间戳，保证重复打包字节一致
ZIP_TIME = (2026, 1, 1, 0, 0, 0)
# 默认路径
DEFAULT_SRC = "E:/workspaces/arkli-models/_src/couplet-derived/derived.tsv"
DEFAULT_OUT = "E:/workspaces/arkli-models/couplet-corpus"
DEFAULT_MANIFEST = "E:/workspaces/arkli-models/_src/couplet-derived/pack-manifest.json"
# 包文件名与 zip 名
PACK_FILES = ["lines.txt", "offsets.u32", "flags.u32", "pools.u32", "meta.json"]
ZIP_NAME = "couplet-corpus.zip"


def parse_cats(field):
    """解析 `山水:1.00,文墨:0.63` 为（位图，首选下标）；未知分类名忽略，空则落到“通用”。"""
    mask = 0
    primary = None
    for item in field.split(","):
        name = item.split(":")[0].strip()
        if name in CATS:
            i = CATS.index(name)
            mask |= 1 << i
            if primary is None:
                primary = i
    if primary is None:
        primary = CATS.index("通用")
        mask = 1 << primary
    return mask, primary


def build(src, out_dir):
    """读 src 写出五个文件到 out_dir，返回 meta 字典。"""
    os.makedirs(out_dir, exist_ok=True)
    offsets = []
    flags = []
    pools = [[] for _ in range(len(CATS) + 1)]
    pos = 0
    with open(src, encoding="utf-8", newline="") as fin, open(os.path.join(out_dir, "lines.txt"), "wb") as fout:
        for idx, line in enumerate(fin):
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 4:
                raise ValueError("第 %d 行不是四列" % (idx + 1))
            mask, primary = parse_cats(parts[3])
            raw = ("\t".join(parts[:3]) + "\n").encode("utf-8")
            offsets.append(pos)
            pos += len(raw)
            fout.write(raw)
            flags.append(mask | (primary << PRIMARY_SHIFT))
            if not mask & (1 << MOURN):
                pools[0].append(idx)
            for k in range(len(CATS)):
                if mask & (1 << k):
                    pools[k + 1].append(idx)
    offsets.append(pos)
    if pos >= 1 << 32:
        raise ValueError("lines.txt 超过 4GB，u32 偏移放不下")
    _write_u32(os.path.join(out_dir, "offsets.u32"), offsets)
    _write_u32(os.path.join(out_dir, "flags.u32"), flags)
    flat = []
    meta_pools = []
    for i, p in enumerate(pools):
        meta_pools.append({"name": ALL_POOL_NAME if i == 0 else CATS[i - 1], "count": len(p), "offset": len(flat)})
        flat.extend(p)
    _write_u32(os.path.join(out_dir, "pools.u32"), flat)
    meta = {"v": PACK_VERSION, "count": len(flags), "cats": CATS, "pools": meta_pools}
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
    return meta


def _write_u32(path, values):
    """把整数列表按小端 u32 写文件。"""
    with open(path, "wb") as f:
        for i in range(0, len(values), 65536):
            chunk = values[i : i + 65536]
            f.write(struct.pack("<%dI" % len(chunk), *chunk))


def sha256_of(path):
    """文件 sha256 小写十六进制。"""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def make_zip(build_dir, zip_path):
    """把五个文件按固定顺序与时间戳打成 deflate -9 的 zip。"""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in PACK_FILES:
            info = zipfile.ZipInfo(name, ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(os.path.join(build_dir, name), "rb") as f:
                z.writestr(info, f.read(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def manifest_fragment(build_dir, zip_path):
    """生成 models.json 条目里 archive 与 files 两段（字节数、sha256 以实际文件为准）。"""
    files = [{"name": n, "bytes": os.path.getsize(os.path.join(build_dir, n)), "sha256": sha256_of(os.path.join(build_dir, n))} for n in PACK_FILES]
    archive = {"name": ZIP_NAME, "bytes": os.path.getsize(zip_path), "sha256": sha256_of(zip_path)}
    return {"archive": archive, "files": files, "totalBytes": sum(f["bytes"] for f in files)}


def main(argv=None):
    """命令行入口。"""
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--out-dir", default=DEFAULT_OUT, help="zip 放这里（设备推送脚本按目录名当模型 id）")
    ap.add_argument("--work-dir", default=None, help="中间文件目录，默认 <out-dir>/../_pack_build")
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    a = ap.parse_args(argv)
    work = a.work_dir or os.path.join(os.path.dirname(os.path.abspath(a.out_dir)), "_pack_build")
    meta = build(a.src, work)
    os.makedirs(a.out_dir, exist_ok=True)
    zip_path = os.path.join(a.out_dir, ZIP_NAME)
    make_zip(work, zip_path)
    frag = manifest_fragment(work, zip_path)
    with open(a.manifest, "w", encoding="utf-8", newline="\n") as f:
        json.dump(frag, f, ensure_ascii=False, indent=2)
    print("条数", meta["count"], "zip 字节", frag["archive"]["bytes"], "解压后", frag["totalBytes"])


if __name__ == "__main__":
    main()
