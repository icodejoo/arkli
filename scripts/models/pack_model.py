#!/usr/bin/env python3
"""把清单里「多文件」的模型打成一个仅存储（不压缩）的 zip，并生成改成 `kind: "pack"` 的清单条目。

用法：
    python scripts/models/pack_model.py <模型id> [<模型id> ...] --out <输出目录> [--cache <文件缓存目录>]
        [--url-base https://github.com/icodejoo/arkli/releases/download/<tag>/]

流程：按 models.json 取该模型各文件（缓存里已有且 sha256 对得上就复用，否则用 aria2c 多连接下载首个地址）
→ 逐文件校验 sha256 → 打 zip（STORED、固定时间戳，同样输入产出同样字节）→ 回读 zip 再校验一遍
→ 在输出目录写 `<id>.zip` 与 `<id>.manifest.json`（新条目，可直接替换 models.json 里的对应项）。
不会改 models.json，也不会上传任何东西：zip 上传到 release 后，再用新条目替换清单。
"""
import argparse
import copy
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

# 清单路径（相对仓库根）
MANIFEST = Path(__file__).resolve().parents[2] / "app/src/main/assets/ai/models.json"
# zip 内固定时间戳，保证可复现
ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)
# 读文件的块大小
CHUNK = 1 << 20
# aria2c 连接数（菲律宾单连接慢，多连接叠加）
ARIA_CONNS = "16"


def sha256_of(path: Path) -> str:
    """计算文件 sha256。

    参数: path 文件路径
    返回: 小写十六进制摘要
    """
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


def build_zip(files: list[tuple[str, Path]], dest: Path) -> None:
    """按给定顺序把文件写进仅存储的 zip，时间戳固定。

    参数: files (zip 内名字, 本地路径) 列表；dest 输出 zip 路径
    示例: build_zip([("a.bin", Path("a.bin"))], Path("a.zip"))
    """
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as z:
        for name, path in files:
            info = zipfile.ZipInfo(name, date_time=ZIP_EPOCH)
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o644 << 16
            with path.open("rb") as src, z.open(info, "w", force_zip64=path.stat().st_size >= (1 << 31)) as out:
                shutil.copyfileobj(src, out, CHUNK)


def verify_zip(zip_path: Path, files: list[dict]) -> None:
    """回读 zip，逐条核对条目名、大小与 sha256，对不上就抛 ValueError。

    参数: zip_path zip 路径；files 清单里的 files 数组（含 name/bytes/sha256）
    """
    with zipfile.ZipFile(zip_path) as z:
        names = [i.filename for i in z.infolist()]
        want = [f["name"] for f in files]
        if names != want:
            raise ValueError(f"zip 条目与清单不一致：{names} != {want}")
        for f in files:
            h, n = hashlib.sha256(), 0
            with z.open(f["name"]) as src:
                while chunk := src.read(CHUNK):
                    h.update(chunk)
                    n += len(chunk)
            if n != f["bytes"] or h.hexdigest() != f["sha256"]:
                raise ValueError(f"zip 内 {f['name']} 校验失败")


def pack_entry(model: dict, archive: dict) -> dict:
    """由原多文件条目生成 pack 条目：去掉文件的 urls，加 kind 与 archive。

    参数: model 原清单条目；archive 压缩包信息（name/bytes/sha256/role/urls）
    返回: 新条目（不改入参）
    """
    out = copy.deepcopy(model)
    out["kind"] = "pack"
    out["archive"] = archive
    for f in out["files"]:
        f.pop("urls", None)
    return out


def fetch(file: dict, cache: Path) -> Path:
    """取得一个清单文件：缓存里有且校验通过就复用，否则用 aria2c 下载首个地址并校验。

    参数: file 清单里的文件项；cache 缓存目录
    返回: 本地路径
    """
    target = cache / file["name"]
    if target.is_file() and sha256_of(target) == file["sha256"]:
        return target
    if not shutil.which("aria2c"):
        raise SystemExit("找不到 aria2c（应在 PATH 里）：大文件按约定一律用 aria2 下载")
    cache.mkdir(parents=True, exist_ok=True)
    cmd = ["aria2c", f"-x{ARIA_CONNS}", f"-s{ARIA_CONNS}", "-k8M", "--continue=true", "--max-tries=0", "--retry-wait=3",
           "--async-dns=false", "-d", str(cache), "-o", file["name"], *file["urls"]]
    subprocess.run(cmd, check=True)
    if sha256_of(target) != file["sha256"]:
        raise SystemExit(f"{file['name']} 下载后 sha256 与清单不符")
    return target


def main() -> None:
    """入口：解析参数并逐个模型打包。"""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="+", help="模型 id")
    ap.add_argument("--out", required=True, type=Path, help="输出目录")
    ap.add_argument("--cache", type=Path, help="文件缓存目录，默认 <out>/_cache")
    ap.add_argument("--url-base", default="", help="zip 上传后的下载地址前缀（以 / 结尾）；不给则 archive.urls 为空，上传后再补")
    args = ap.parse_args()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    by_id = {m["id"]: m for m in manifest["models"]}
    args.out.mkdir(parents=True, exist_ok=True)
    cache = args.cache or args.out / "_cache"
    for mid in args.ids:
        model = by_id.get(mid)
        if not model:
            sys.exit(f"清单里没有 {mid}")
        if model.get("kind") == "pack" or len(model["files"]) < 2:
            sys.exit(f"{mid} 不是多文件模型（已是 pack 或只有一个文件），不用打包")
        files = [(f["name"], fetch(f, cache / mid)) for f in model["files"]]
        zip_path = args.out / f"{mid}.zip"
        build_zip(files, zip_path)
        verify_zip(zip_path, model["files"])
        archive = {"name": zip_path.name, "bytes": zip_path.stat().st_size, "sha256": sha256_of(zip_path), "role": "archive",
                   "urls": [args.url_base + zip_path.name] if args.url_base else []}
        entry = pack_entry(model, archive)
        (args.out / f"{mid}.manifest.json").write_text(json.dumps(entry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{mid}: {zip_path} {archive['bytes']} 字节 sha256 {archive['sha256']}")


if __name__ == "__main__":
    main()
