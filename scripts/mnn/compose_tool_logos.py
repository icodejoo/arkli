"""把 sdxs_glyph.py 产出的彩色图标去底后合成工具 logo（App 同款渐变底），并拼总览大图。

用法：
  python -I scripts/mnn/compose_tool_logos.py --glyphs <glyph 目录> --names <id|名称 清单> --out <logos 目录>
可选 `--pick id=seed` 手动指定某工具用哪个种子（可多次）。
"""
import argparse
import sys
from pathlib import Path
import json
import os
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

# 单个 logo 边长（像素）
LOGO_SIZE = 512
# 圆角占边长比例（与 App 图标 17/72 一致）
RADIUS_RATIO = 17 / 72
# 符号占容器边长比例
GLYPH_RATIO = 0.62
# App 图标的竖向三段渐变
GRADIENT = [(0.0, (0x3B, 0x6C, 0xF6)), (0.5, (0x8B, 0x5C, 0xF6)), (1.0, (0xD9, 0x46, 0xEF))]
# 总览大图：列数、格宽、格高、格内 logo 边长
SHEET_COLS, CELL_W, CELL_H, CELL_LOGO = 10, 220, 260, 180
# BiRefNet 模型目录、输入边长、ImageNet 均值方差
BIREFNET_DIR = Path(__file__).resolve().parents[2] / "native/mnn/.work/convert/out/matting-birefnet-lite512-mnn-w8"
BIREFNET_SIDE = 512
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
# 连通块保留阈值：面积不小于最大块的这个比例
KEEP_RATIO = 0.12
# 连通块分析用的降采样边长
CC_SIDE = 128
# 总览字体
FONT_PATH = r"C:\Windows\Fonts\msyh.ttc"


def gradient_bg(size: int) -> Image.Image:
    """生成竖向三段渐变底图。"""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        for (t0, c0), (t1, c1) in zip(GRADIENT, GRADIENT[1:]):
            if t0 <= t <= t1:
                k = (t - t0) / (t1 - t0)
                col = tuple(round(a + (b - a) * k) for a, b in zip(c0, c1))
                break
        for x in range(size):
            px[x, y] = col
    return img


class Matter:
    """BiRefNet-lite 512 抠图器（桌面 MNN），前后处理同 core 的 matting.rs。

    示例：Matter().alpha(Image.open("a.png").convert("RGB")) -> 512x512 的 L 模式 alpha
    """

    def __init__(self, threads: int = 4):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import sdxs_glyph as G
        self.lib = G.MnnLib(G.DEFAULT_RT_DIR)
        self.net = self.lib.load(BIREFNET_DIR / "birefnet_lite512_w8.mnn", BIREFNET_DIR / "birefnet_lite512_w8.mnn.weight",
                                 ["input_image"], ["output_image"], threads)

    def alpha(self, im: Image.Image) -> Image.Image:
        """输入 RGB 图，返回同尺寸 L 模式 alpha。"""
        a = np.asarray(im.resize((BIREFNET_SIDE, BIREFNET_SIDE), Image.BILINEAR), dtype=np.float32) / 255.0
        a = ((a - IMAGENET_MEAN) / IMAGENET_STD).transpose(2, 0, 1)[None].astype(np.float32)
        o = self.net.forward([np.ascontiguousarray(a)])[0].reshape(BIREFNET_SIDE, BIREFNET_SIDE)
        if o.min() < 0 or o.max() > 1:
            o = 1 / (1 + np.exp(-o))
        out = Image.fromarray((np.clip(o, 0, 1) * 255).astype("uint8"), "L")
        return out.resize(im.size, Image.BILINEAR)


_MATTER = None


def cutout_warmup(threads: int = 4):
    """提前加载抠图模型（常驻服务启动时调用）。"""
    global _MATTER
    if _MATTER is None:
        _MATTER = Matter(threads)


def cutout(rgb_path: str) -> Image.Image:
    """彩色原图抠出主体：BiRefNet 出 alpha，去零碎小块后返回 RGBA。"""
    global _MATTER
    if _MATTER is None:
        _MATTER = Matter()
    im = Image.open(rgb_path).convert("RGB")
    alpha = keep_big_blobs(_MATTER.alpha(im))
    out = im.convert("RGBA")
    out.putalpha(alpha)
    return out


def keep_big_blobs(alpha: Image.Image) -> Image.Image:
    """去掉零碎小块：在降采样图上标连通块，只留面积够大的，再放大成蒙版乘回 alpha。"""
    small = np.asarray(alpha.resize((CC_SIDE, CC_SIDE), Image.BILINEAR)) > 100
    lab = np.zeros(small.shape, dtype=np.int32)
    areas = []
    for y in range(CC_SIDE):
        for x in range(CC_SIDE):
            if small[y, x] and not lab[y, x]:
                areas.append(0)
                n = len(areas)
                stack = [(y, x)]
                lab[y, x] = n
                while stack:
                    cy, cx = stack.pop()
                    areas[-1] += 1
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            ny, nx = cy + dy, cx + dx
                            if 0 <= ny < CC_SIDE and 0 <= nx < CC_SIDE and small[ny, nx] and not lab[ny, nx]:
                                lab[ny, nx] = n
                                stack.append((ny, nx))
    if not areas:
        return alpha
    top = max(areas)
    keep = np.isin(lab, [i + 1 for i, a in enumerate(areas) if a >= top * KEEP_RATIO])
    m = Image.fromarray((keep * 255).astype("uint8"), "L").resize(alpha.size, Image.BILINEAR)
    m = m.filter(ImageFilter.MaxFilter(9))
    return ImageChops.multiply(alpha, m)


def score(rgba: Image.Image) -> float:
    """候选打分，越小越好：前景占比接近 0.3、不贴边、居中。"""
    a = np.asarray(rgba.split()[3]) > 128
    box = rgba.split()[3].point(lambda v: 255 if v > 128 else 0).getbbox()
    if not box:
        return 9.0
    h, w = a.shape
    ratio = a.mean()
    touch = (box[0] <= 2) + (box[1] <= 2) + (box[2] >= w - 2) + (box[3] >= h - 2)
    cx = abs((box[0] + box[2]) / 2 - w / 2) / w
    cy = abs((box[1] + box[3]) / 2 - h / 2) / h
    return abs(ratio - 0.3) * 2 + touch * 0.5 + cx + cy


def compose(rgba: Image.Image, bg: Image.Image, round_mask: Image.Image) -> Image.Image:
    """把去底后的图标裁到外框、缩放后放到渐变底中央，带一点柔和投影。"""
    rgba = rgba.crop(rgba.split()[3].point(lambda v: 255 if v > 24 else 0).getbbox())
    s = LOGO_SIZE * GLYPH_RATIO / max(rgba.size)
    rgba = rgba.resize((max(1, round(rgba.width * s)), max(1, round(rgba.height * s))), Image.LANCZOS)
    out = bg.convert("RGBA")
    pos = ((LOGO_SIZE - rgba.width) // 2, (LOGO_SIZE - rgba.height) // 2)
    sh = Image.new("RGBA", out.size, (0, 0, 0, 0))
    shadow = Image.new("RGBA", rgba.size, (40, 20, 100, 90))
    shadow.putalpha(rgba.split()[3].point(lambda v: v * 90 // 255))
    sh.paste(shadow, (pos[0], pos[1] + 8), shadow)
    out = Image.alpha_composite(out, sh.filter(ImageFilter.GaussianBlur(8)))
    out.alpha_composite(rgba, pos)
    out.putalpha(round_mask)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--glyphs", required=True)
    ap.add_argument("--names", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--pick", action="append", default=[])
    a = ap.parse_args()
    forced = {p.split("=")[0]: int(p.split("=")[1]) for p in a.pick}
    names = [l.strip().split("|") for l in open(a.names, encoding="utf-8") if l.strip()]
    results = json.load(open(os.path.join(a.glyphs, "results.json"), encoding="utf-8"))
    os.makedirs(a.out, exist_ok=True)
    bg = gradient_bg(LOGO_SIZE)
    rm = Image.new("L", (LOGO_SIZE * 4,) * 2, 0)
    ImageDraw.Draw(rm).rounded_rectangle((0, 0, LOGO_SIZE * 4 - 1, LOGO_SIZE * 4 - 1), int(LOGO_SIZE * 4 * RADIUS_RATIO), fill=255)
    rm = rm.resize((LOGO_SIZE, LOGO_SIZE), Image.LANCZOS)
    logos = []
    for tid, cn in names:
        items = [r for r in results if r["name"] == tid]
        if not items:
            print("缺", tid)
            continue
        cands = {i["seed"]: cutout(os.path.join(a.glyphs, i["image"].replace(".png", "_rgb.png"))) for i in items}
        seed = forced.get(tid) or min(cands, key=lambda k: score(cands[k]))
        c = next(i for i in items if i["seed"] == seed)
        img = compose(cands[seed], bg, rm)
        img.save(os.path.join(a.out, f"{tid}.png"))
        logos.append((tid, cn, img, c))
        print(tid, "seed", c["seed"])
    rows = (len(logos) + SHEET_COLS - 1) // SHEET_COLS
    sheet = Image.new("RGB", (SHEET_COLS * CELL_W, rows * CELL_H), "white")
    d = ImageDraw.Draw(sheet)
    font = ImageFont.truetype(FONT_PATH, 24)
    for n, (tid, cn, img, _) in enumerate(logos):
        x, y = (n % SHEET_COLS) * CELL_W, (n // SHEET_COLS) * CELL_H
        t = img.resize((CELL_LOGO, CELL_LOGO), Image.LANCZOS)
        sheet.paste(t, (x + (CELL_W - CELL_LOGO) // 2, y + 20), t)
        w = d.textlength(cn, font=font)
        d.text((x + (CELL_W - w) / 2, y + 20 + CELL_LOGO + 14), cn, fill="#222222", font=font)
    sheet.save(os.path.join(a.out, "_all.png"))


if __name__ == "__main__":
    main()
