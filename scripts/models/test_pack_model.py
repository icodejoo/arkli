"""pack_model 的单测：打包可复现、回读校验能抓到篡改、pack 条目去掉 urls 且不改入参。"""
import hashlib
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import pack_model as pm  # noqa: E402


def make_files(root: Path) -> list[dict]:
    """在目录里造两个文件并返回清单 files 项。"""
    items = []
    for name, data in (("a.bin", b"hello" * 1000), ("b.txt", b"world")):
        (root / name).write_bytes(data)
        items.append({"name": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "urls": ["http://x/" + name]})
    return items


class PackModelTest(unittest.TestCase):
    def test_zip_is_stored_and_reproducible(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            items = make_files(root)
            files = [(f["name"], root / f["name"]) for f in items]
            pm.build_zip(files, root / "1.zip")
            pm.build_zip(files, root / "2.zip")
            self.assertEqual((root / "1.zip").read_bytes(), (root / "2.zip").read_bytes())
            with zipfile.ZipFile(root / "1.zip") as z:
                self.assertTrue(all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist()))
            pm.verify_zip(root / "1.zip", items)

    def test_verify_catches_wrong_hash_and_wrong_entries(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            items = make_files(root)
            pm.build_zip([(f["name"], root / f["name"]) for f in items], root / "z.zip")
            bad = [dict(items[0], sha256="0" * 64), items[1]]
            with self.assertRaises(ValueError):
                pm.verify_zip(root / "z.zip", bad)
            with self.assertRaises(ValueError):
                pm.verify_zip(root / "z.zip", items[:1])

    def test_pack_entry_drops_urls_without_mutating_input(self):
        model = {"id": "m", "files": [{"name": "a", "bytes": 1, "sha256": "x", "urls": ["u"]}]}
        archive = {"name": "m.zip", "bytes": 2, "sha256": "y", "role": "archive", "urls": []}
        out = pm.pack_entry(model, archive)
        self.assertEqual(out["kind"], "pack")
        self.assertEqual(out["archive"], archive)
        self.assertNotIn("urls", out["files"][0])
        self.assertIn("urls", model["files"][0])


if __name__ == "__main__":
    unittest.main()
