"""抠图桌面对拍：同一张图，ORT 参考 alpha 对 Rust(MNN) 真库输出的 alpha。

用法：python eval_matting.py <matting-src 目录> <MNN 产物根目录> <arkli-mnn.dll> [最长边，默认 1024]
- matting-src：含 modnet512.onnx、u2netp.onnx 与 img/*.jpg
- 产物根目录：含 matting-modnet/modnet512_fp32.mnn、matting-u2netp/u2netp_f16.mnn
依赖：onnxruntime、numpy、pillow（开发机工具，不进 APK）。需要先 cargo 能编译 arkli-ffi。
输出每张图的 max / mean / >0.05 的像素占比；参考实现与 `matting-tools/eval.py` 的前后处理一致。
"""
import glob
import os
import subprocess
import sys
import tempfile

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

CFG = {
    "portrait": dict(onnx="modnet512.onnx", size=512, mnn="matting-modnet/modnet512_fp32.mnn"),
    "general": dict(onnx="u2netp.onnx", size=320, mnn="matting-u2netp/u2netp_f16.mnn"),
}
THRESH = 0.05


def pre(mode, img, s):
    a = np.asarray(img.resize((s, s), Image.BILINEAR), dtype=np.float32)
    if mode == "general":
        a = a / max(a.max(), 1e-6)
        a = (a - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
    else:
        a = (a - 127.5) / 127.5
    return a.transpose(2, 0, 1)[None].astype(np.float32)


def post(mode, o):
    o = o.reshape(o.shape[-2:])
    if mode == "general":
        o = (o - o.min()) / max(o.max() - o.min(), 1e-6)
    return np.clip(o, 0, 1)


def main():
    src, mnn_root, dll = (os.path.abspath(a) for a in sys.argv[1:4])
    edge = int(sys.argv[4]) if len(sys.argv) > 4 else 1024
    core = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "core")
    tmp = tempfile.mkdtemp(prefix="matting-eval-")
    for mode, c in CFG.items():
        sess = ort.InferenceSession(os.path.join(src, c["onnx"]), providers=["CPUExecutionProvider"])
        name = sess.get_inputs()[0].name
        for p in sorted(glob.glob(os.path.join(src, "img", "*.jpg"))):
            stem = os.path.splitext(os.path.basename(p))[0]
            img = ImageOps.exif_transpose(Image.open(p)).convert("RGB")
            if max(img.size) > edge:
                k = edge / max(img.size)
                img = img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS)
            w, h = img.size
            rgb = os.path.join(tmp, f"{stem}.rgb")
            with open(rgb, "wb") as f:
                f.write(np.array([w, h], dtype="<u4").tobytes() + np.asarray(img, dtype=np.uint8).tobytes())
            ref = post(mode, sess.run(None, {name: pre(mode, img, c["size"])})[0])
            ref_full = np.asarray(Image.fromarray(np.rint(ref * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR), dtype=np.float32) / 255
            out = os.path.join(tmp, f"{mode}_{stem}.alpha")
            env = dict(os.environ, ARKLI_MNN_DYLIB=os.path.abspath(dll), ARKLI_MATTING_MODEL=os.path.join(mnn_root, c["mnn"]),
                       ARKLI_MATTING_MODE=mode, ARKLI_MATTING_RGB=rgb, ARKLI_MATTING_OUT=out)
            r = subprocess.run(["cargo", "test", "-q", "-p", "arkli-ffi", "matting", "--", "--ignored", "--nocapture"],
                               cwd=core, env=env, capture_output=True, text=True)
            if r.returncode != 0:
                print(r.stdout[-2000:], r.stderr[-2000:])
                sys.exit(1)
            got = np.fromfile(out, dtype=np.uint8).reshape(h, w).astype(np.float32) / 255
            d = np.abs(got - ref_full)
            print(f"{mode:8s} {stem:14s} {w}x{h} max={d.max():.4f} mean={d.mean():.5f} >{THRESH}: {(d > THRESH).mean() * 100:.3f}%", flush=True)


if __name__ == "__main__":
    main()
