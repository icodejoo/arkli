"""生成 Rust 真库 OCR 测试用例：把一张合成文字图转成原始 RGB 文件，并写出这张图里画的文字行（真值）。

Rust 没有 PNG 解码器，真库测试（`mnn::tests::真库跑通ocr管线`）读本脚本的输出：
  ARKLI_OCR_RGB    case.rgb      前 8 字节为小端 u32 宽、高，其后是行优先 RGB
  ARKLI_OCR_EXPECT expect.txt    每行一句真值（UTF-8）
合成图由 eval_ocr.gen_images 生成（种子固定，同一字体下可复现）。

用法：
  python -I ocr_case.py --out DIR [--index 0] [--images DIR] [--font FONT.ttc]
缺省图片目录与 eval_ocr.py 相同（工作目录下 ocr-eval-images，没有就生成）。
"""
import argparse
import glob
import json
import os
import struct
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import die, log, work_dir  # noqa: E402
import eval_ocr  # noqa: E402


def main():
    """命令行入口：输出 case.rgb 与 expect.txt。"""
    ap = argparse.ArgumentParser(description="生成 Rust 真库 OCR 测试用例")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--index", type=int, default=0, help="用第几张合成图")
    ap.add_argument("--images", default=os.path.join(work_dir(), "ocr-eval-images"))
    ap.add_argument("--font", default=eval_ocr.DEFAULT_FONT)
    a = ap.parse_args()
    if not glob.glob(os.path.join(a.images, "*.png")):
        eval_ocr.gen_images(a.images, a.font, 8)
    expect_path = os.path.join(a.images, eval_ocr.EXPECT_NAME)
    name = f"text{a.index}.png"
    if not os.path.isfile(expect_path):
        # 旧版本生成的图目录没有真值文件：同样种子重放到临时目录取真值
        tmp = os.path.join(a.out, "regen")
        eval_ocr.gen_images(tmp, a.font, 8)
        expect_path = os.path.join(tmp, eval_ocr.EXPECT_NAME)
    lines = json.load(open(expect_path, encoding="utf-8")).get(name)
    if not lines:
        die(f"真值里没有 {name}")
    im = Image.open(os.path.join(a.images, name)).convert("RGB")
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "case.rgb"), "wb") as f:
        f.write(struct.pack("<II", im.width, im.height))
        f.write(im.tobytes())
    with open(os.path.join(a.out, "expect.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    log(f"{name} {im.width}x{im.height}，真值 {len(lines)} 行 -> {a.out}")


if __name__ == "__main__":
    main()
