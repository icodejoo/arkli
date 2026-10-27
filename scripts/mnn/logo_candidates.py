"""单个工具出 4 张 logo 候选：SDXS 出彩色图标 -> BiRefNet 抠图 -> 贴到 App 渐变底，存进该工具的文件夹。

常驻服务（模型只加载一次，之后每轮出 4 张只要十几秒）：
  python -I scripts/mnn/logo_candidates.py --serve            # 监听 127.0.0.1:8765
出图（客户端）：
  curl -s "http://127.0.0.1:8765/gen" -d '{"id":"money-upper","concept":"golden chinese numerals","seed_start":1}'
候选写到 <logos 目录>/<id>/cand_<种子>.png，并拼一张预览放在 --raw 目录。
换概念词或想要新的 4 张时，改 seed_start（如 5、9）避免覆盖。
"""
import argparse
import json
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compose_tool_logos as C
import sdxs_glyph as G

# 默认输出根目录
LOGOS_DIR = Path(__file__).resolve().parents[2] / "web/src/assets/logos"
# 彩色图标提示词模板（3D emoji 风格，单个物体居中）
COLOR_TEMPLATE = "3d emoji icon of {}, one object only, centered, bright colors, clean, white background"
# 服务端口、预览缩略边长、预览间距
PORT, THUMB, GAP = 8765, 240, 20


class Worker:
    """持有模型与渐变底，按请求出候选。"""

    def __init__(self, out_root, raw_root, threads):
        self.out_root, self.raw_root = Path(out_root), Path(raw_root)
        self.bg = C.gradient_bg(C.LOGO_SIZE)
        rm = Image.new("L", (2048, 2048), 0)
        ImageDraw.Draw(rm).rounded_rectangle((0, 0, 2047, 2047), int(2048 * C.RADIUS_RATIO), fill=255)
        self.rm = rm.resize((C.LOGO_SIZE, C.LOGO_SIZE), Image.LANCZOS)
        self.eng = G.GlyphEngine(threads=threads)
        C.cutout_warmup(threads)

    def gen(self, tid, concept, seed_start=1, count=4, template=COLOR_TEMPLATE):
        """出 count 张候选，返回预览图路径。"""
        out, raw = self.out_root / tid, self.raw_root / tid
        out.mkdir(parents=True, exist_ok=True)
        raw.mkdir(parents=True, exist_ok=True)
        seeds = range(seed_start, seed_start + count)
        for s in seeds:
            r = self.eng.generate(concept, s, template=template)
            p = raw / f"s{s}.png"
            Image.fromarray(r.rgb, "RGB").save(p)
            C.compose(C.cutout(str(p)), self.bg, self.rm).save(out / f"cand_{s}.png")
        sheet = Image.new("RGB", (count * (THUMB + GAP) + GAP, THUMB + 2 * GAP), "white")
        for i, s in enumerate(seeds):
            t = Image.open(out / f"cand_{s}.png").resize((THUMB, THUMB), Image.LANCZOS)
            sheet.paste(t, (GAP + i * (THUMB + GAP), GAP), t)
        pv = raw / f"preview_{seed_start}.png"
        sheet.save(pv)
        return str(pv)


def serve(args):
    """起 HTTP 服务：POST /gen，JSON 体 {id, concept, seed_start?, count?, template?}。"""
    w = Worker(args.out, args.raw, args.threads)

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            try:
                msg = w.gen(body["id"], body["concept"], body.get("seed_start", 1), body.get("count", 4),
                            body.get("template", COLOR_TEMPLATE))
                code = 200
            except Exception as e:  # 出错也回给客户端
                msg, code = repr(e), 500
            self.send_response(code)
            self.end_headers()
            self.wfile.write(msg.encode())

        def log_message(self, *a):
            pass

    print("就绪", PORT, flush=True)
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--out", default=str(LOGOS_DIR))
    ap.add_argument("--raw", default=os.path.join(tempfile.gettempdir(), "arkli-logo-raw"))
    ap.add_argument("--threads", type=int, default=8)
    a = ap.parse_args()
    if not a.serve:
        ap.error("请用 --serve 启动服务")
    serve(a)
