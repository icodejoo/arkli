"""语料包打包脚本的单测：偏移、位图、池成员、zip 往返。"""
import json
import os
import struct
import tempfile
import sys
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_pack as bp  # noqa: E402

# 四行样例：覆盖单类、多类、挽联置首、挽联附加
SAMPLE = [
    "春风送暖\t瑞雪兆丰\t万象更新\t春节:1.00",
    "山高水长\t云淡风轻\t山河入画\t山水:0.90,文墨:0.70",
    "音容宛在\t哀思长存\t音容永存\t挽联:1.00",
    "志在千里\t心系万家\t鹏程万里\t事业:0.80,挽联:0.55",
]


def u32(path):
    """读小端 u32 列表。"""
    data = open(path, "rb").read()
    return list(struct.unpack("<%dI" % (len(data) // 4), data))


class PackTest(unittest.TestCase):
    """打包产物与格式约定。"""

    def setUp(self):
        """写样例 tsv 并打包。"""
        self.tmp = tempfile.TemporaryDirectory()
        self.src = os.path.join(self.tmp.name, "d.tsv")
        with open(self.src, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(SAMPLE) + "\n")
        self.work = os.path.join(self.tmp.name, "w")
        self.meta = bp.build(self.src, self.work)

    def tearDown(self):
        """清理。"""
        self.tmp.cleanup()

    def test_parse_cats(self):
        """首选取第一个，未知分类回落通用。"""
        mask, primary = bp.parse_cats("山水:0.9,文墨:0.7")
        self.assertEqual(bp.CATS[primary], "山水")
        self.assertEqual(mask, (1 << bp.CATS.index("山水")) | (1 << bp.CATS.index("文墨")))
        self.assertEqual(bp.CATS[bp.parse_cats("奇怪:1")[1]], "通用")

    def test_offsets_slice_lines(self):
        """偏移区间正好切出每一行。"""
        off = u32(os.path.join(self.work, "offsets.u32"))
        raw = open(os.path.join(self.work, "lines.txt"), "rb").read()
        self.assertEqual(len(off), len(SAMPLE) + 1)
        for i, s in enumerate(SAMPLE):
            self.assertEqual(raw[off[i]:off[i + 1]].decode("utf-8"), "\t".join(s.split("\t")[:3]) + "\n")

    def test_pools(self):
        """池 0 不含挽联；挽联池含置首与附加两种；多类对联进多个池。"""
        flat = u32(os.path.join(self.work, "pools.u32"))
        pools = {p["name"]: flat[p["offset"]:p["offset"] + p["count"]] for p in self.meta["pools"]}
        self.assertEqual(pools[bp.ALL_POOL_NAME], [0, 1])
        self.assertEqual(pools["挽联"], [2, 3])
        self.assertEqual(pools["山水"], [1])
        self.assertEqual(pools["文墨"], [1])
        self.assertEqual(pools["事业"], [3])

    def test_flags(self):
        """首选分类在高位。"""
        flags = u32(os.path.join(self.work, "flags.u32"))
        self.assertEqual(bp.CATS[flags[3] >> bp.PRIMARY_SHIFT], "事业")
        self.assertTrue(flags[3] & (1 << bp.MOURN))

    def test_zip_roundtrip_and_deflate(self):
        """zip 用 deflate，内容往返一致，清单片段与文件一致。"""
        zp = os.path.join(self.tmp.name, bp.ZIP_NAME)
        bp.make_zip(self.work, zp)
        with zipfile.ZipFile(zp) as z:
            self.assertEqual([i.filename for i in z.infolist()], bp.PACK_FILES)
            for i in z.infolist():
                self.assertEqual(i.compress_type, zipfile.ZIP_DEFLATED)
                self.assertEqual(z.read(i.filename), open(os.path.join(self.work, i.filename), "rb").read())
        frag = bp.manifest_fragment(self.work, zp)
        self.assertEqual(frag["archive"]["bytes"], os.path.getsize(zp))
        self.assertEqual(frag["totalBytes"], sum(f["bytes"] for f in frag["files"]))

    def test_meta_json(self):
        """meta 记录条数与池数量。"""
        meta = json.load(open(os.path.join(self.work, "meta.json"), encoding="utf-8"))
        self.assertEqual(meta["count"], len(SAMPLE))
        self.assertEqual(len(meta["pools"]), len(bp.CATS) + 1)


if __name__ == "__main__":
    unittest.main()
