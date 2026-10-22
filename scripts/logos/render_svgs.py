"""把一个目录里的 SVG 用 Chrome 无头模式渲染成透明背景 PNG（512x512）。

用法：python -I scripts/logos/render_svgs.py <svg 目录> <输出目录>
同名替换扩展名：cand_1.svg -> cand_1.png
"""
import subprocess
import sys
from pathlib import Path

# Chrome 路径、输出边长
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
SIZE = 512


def render(svg: Path, png: Path) -> None:
    """渲染单个 SVG。"""
    html = png.with_suffix(".tmp.html")
    html.write_text(
        f'<!doctype html><meta charset="utf-8"><style>html,body{{margin:0;background:transparent}}</style>'
        f'<img src="{svg.resolve().as_uri()}" width="{SIZE}" height="{SIZE}" style="display:block">',
        encoding="utf-8")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--default-background-color=00000000", f"--window-size={SIZE},{SIZE}",
                    f"--screenshot={png.resolve()}", html.resolve().as_uri()],
                   check=True, capture_output=True, timeout=60)
    html.unlink()


if __name__ == "__main__":
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    dst.mkdir(parents=True, exist_ok=True)
    for f in sorted(src.glob("*.svg")):
        render(f, dst / (f.stem + ".png"))
        print(f.stem)
