"""下载转换用的原版（fp32）模型：URL 与 sha256 写死在本文件里，aria2 多连接下载，校验不过就停。

下载物一律当作不可信数据：只落进 dl_dir（默认 native/mnn/.work/convert/dl，被 .gitignore 忽略），
本脚本绝不执行下载来的任何内容；解压 tar 用 tarfile 的 data 过滤器，拒绝越界路径。

用法：
  python -I fetch.py siglip2 nllb asr ocr sdxs 下载指定分组（sdxs 约 1.8GB）（缺省：转换用分组，不含 baseline 与 sdxs，这两个需显式指定）
  python -I fetch.py baseline                  评测对照用的现网模型（q4_half、NLLB int4、语音 int8），体积不小，按需
  python -I fetch.py --list                    只列出分组与文件，不下载
环境变量 ARKLI_MNN_DL 可改下载目录；已存在且校验通过的文件直接跳过（所以可以把旧下载物硬链接进来复用）。
"""
import argparse
import os
import shutil
import subprocess
import sys
import tarfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import die, dl_dir, fmt_bytes, log, sha256_file  # noqa: E402

# HF 镜像（国内更快）与官方站，互为备份
HF_MIRROR = "https://hf-mirror.com"
HF = "https://huggingface.co"
# ModelScope 上的 RapidOCR 仓库文件前缀
MS_OCR = "https://modelscope.cn/models/RapidAI/RapidOCR/resolve/master/onnx/PP-OCRv5"
# GitHub 上现网模型与语音模型的发布位置
GH_ASR = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
GH_CISOX = "https://github.com/icodejoo/Cisox/releases/download/models"
GH_ARKLI_SIGLIP = "https://github.com/icodejoo/arkli/releases/download/siglip2-q4half-v1"
# 对联模型（couplet-gpt2-v1）的 release 下载前缀
GH_COUPLET = "https://github.com/icodejoo/arkli/releases/download/couplet-gpt2-v1"
# 语音包文件名前缀
ASR_PREFIX = "sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct"


def hf(repo, path):
    """同一个 HF 文件的两个来源（先镜像后官方）。"""
    return [f"{HF_MIRROR}/{repo}/resolve/main/{path}", f"{HF}/{repo}/resolve/main/{path}"]


NLLB_REPO = "Xenova/nllb-200-distilled-600M"
SIGLIP_REPO = "onnx-community/siglip2-base-patch16-224-ONNX"
SDXS_REPO = "IDKiro/sdxs-512-dreamshaper"

# 分组 -> [(相对 dl_dir 的路径, 字节数, sha256, [url...])]
FILES = {
    "siglip2": [
        ("siglip2/vision_model.onnx", 371807752, "c0573e3f4140c3a7c4e9cc5912bd6b26a033b46a6a8e8af26cbea262b163bcad",
         hf(SIGLIP_REPO, "onnx/vision_model.onnx")),
    ],
    "nllb": [
        ("nllb-fp32/encoder_model.onnx", 1658468942, "d3d9f99355917d6cce7423456645e13a3a2a9f1301bfc000548d5c8960407714",
         hf(NLLB_REPO, "onnx/encoder_model.onnx")),
        ("nllb-fp32/decoder_model_merged.onnx", 1865158686, "004adde69878c3ef0a3fdeea9d4972d901deebeb8f45373f8b2f9abcd15204e9",
         hf(NLLB_REPO, "onnx/decoder_model_merged.onnx")),
        # 原版全词表 tokenizer（词表裁剪时按 token 字符串映射回原 id 用）
        ("nllb-fp32/tokenizer.json", 17331224, "8ac789ad7dabea44d41537822d48c516ba358374c51813e2cba78c006e150c94",
         hf(NLLB_REPO, "tokenizer.json")),
        # 随包的裁剪词表（61,795 词），产物沿用它
        ("nllb-tok/tokenizer.json", 2979534, "d7c3b1f913f4af10503b41202e36623c997aca6480a97643a6105d364000bebb",
         [f"{GH_CISOX}/tokenizer.json"]),
    ],
    "asr": [
        (f"asr/asr-fp32.tar.bz2", 584120230, "7e82f0a26f2bf8630141ebec658760b0fa585575fea2fee3d8edc4d3cb637b88",
         [f"{GH_ASR}/{ASR_PREFIX}-2026-06-05.tar.bz2"]),
    ],
    "ocr": [
        ("ocr/ch_PP-OCRv5_det_mobile.onnx", 4819576, "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae",
         [f"{MS_OCR}/det/ch_PP-OCRv5_det_mobile.onnx"]),
        ("ocr/ch_PP-OCRv5_rec_mobile.onnx", 16631306, "5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5",
         [f"{MS_OCR}/rec/ch_PP-OCRv5_rec_mobile.onnx"]),
        ("ocr/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx", 1018508, "54379ae5174d026780215fc748a7f31910dee36818e63d49e17dc598ecc82df7",
         [f"{MS_OCR}/cls/ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx"]),
    ],
    # PP-OCRv6 small（官方 HF 仓库，Apache-2.0）：det / rec 的 ONNX 与 rec 的 inference.yml（字典在里面）；cls 沿用 ocr 组的 v5 方向分类
    "ocr6": [
        ("ocr6/det/inference.onnx", 9880512, "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e",
         hf("PaddlePaddle/PP-OCRv6_small_det_onnx", "inference.onnx")),
        ("ocr6/det/inference.yml", 885, "193f435274bf9f0b5f71a929bbfbcf148282df7e633b34e7c373e8f44741b516",
         hf("PaddlePaddle/PP-OCRv6_small_det_onnx", "inference.yml")),
        ("ocr6/rec/inference.onnx", 21159378, "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
         hf("PaddlePaddle/PP-OCRv6_small_rec_onnx", "inference.onnx")),
        ("ocr6/rec/inference.yml", 150579, "ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1",
         hf("PaddlePaddle/PP-OCRv6_small_rec_onnx", "inference.yml")),
    ],
    # 对联 GPT-2（uer/gpt2-chinese-couplet，导出的 fp32 ONNX，带 past 输入，couplet_prepare.py 会去掉）、词表与两份许可证文件（随包带上，如实写来源）
    "couplet": [
        ("couplet/couplet-gpt2-fp32.onnx", 408379974, "afa4a249f5e73826a5722204a89b089802624161f94caf5f02521bf84591561f",
         [f"{GH_COUPLET}/couplet-gpt2-fp32.onnx"]),
        ("couplet/vocab.txt", 109516, "3db3f345cf52a1102831aa1fe7ddeb031dd5f117412f91ad11645c4e71fc8f4b", [f"{GH_COUPLET}/vocab.txt"]),
        ("couplet/UER-py_LICENSE_Apache-2.0.txt", 11357, "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
         [f"{GH_COUPLET}/UER-py_LICENSE_Apache-2.0.txt"]),
        ("couplet/couplet-clean-dataset_LICENSE_MIT.txt", 1068, "e5ba66a650e1701d75ba5706af41b6dfaca7297c97ae8c93d7458db9c90d1e05",
         [f"{GH_COUPLET}/couplet-clean-dataset_LICENSE_MIT.txt"]),
    ],
    # SDXS-512 DreamShaper（文生图/符号生成，1 步推理）：模型索引、调度器、文本编码器、分词器、UNet 与 TAESD VAE
    "sdxs": [
        ("sdxs/model_index.json", 523, "4d18feafb537f185598af080e8894d99a00425e9ab7861d31c832043c68c840c",
         hf(SDXS_REPO, "model_index.json")),
        ("sdxs/scheduler/scheduler_config.json", 480, "91d57030b1a965f4878c952acaaa84d6956b640697b69fc642a13d3bf83e5e9c",
         hf(SDXS_REPO, "scheduler/scheduler_config.json")),
        ("sdxs/text_encoder/config.json", 724, "52e29b35e93261515dc07bf248ec8398a729e54f1886e946f8c095ede26be29b",
         hf(SDXS_REPO, "text_encoder/config.json")),
        ("sdxs/text_encoder/model.safetensors", 492265168, "5cd76eb3ed326974cfd66795384e890742dfdb5a80f5f4e4cb1547d51ec75d86",
         hf(SDXS_REPO, "text_encoder/model.safetensors")),
        ("sdxs/tokenizer/merges.txt", 524619, "9fd691f7c8039210e0fced15865466c65820d09b63988b0174bfe25de299051a",
         hf(SDXS_REPO, "tokenizer/merges.txt")),
        ("sdxs/tokenizer/special_tokens_map.json", 472, "c4864a9376a8401918425bed71fc14fc0e81f9b59ec45c1cf96cccb2df508eac",
         hf(SDXS_REPO, "tokenizer/special_tokens_map.json")),
        ("sdxs/tokenizer/tokenizer_config.json", 737, "19d7b034cb0cc3ce9766c2231373ab8aa8991fc72e2c8f76558bfaae3de0d563",
         hf(SDXS_REPO, "tokenizer/tokenizer_config.json")),
        ("sdxs/tokenizer/vocab.json", 1059962, "e089ad92ba36837a0d31433e555c8f45fe601ab5c221d4f607ded32d9f7a4349",
         hf(SDXS_REPO, "tokenizer/vocab.json")),
        ("sdxs/unet/config.json", 1725, "cd3c93365b0b198163761cc39e1949412b96be7cd200bc17ae25fd16a1f976b1",
         hf(SDXS_REPO, "unet/config.json")),
        ("sdxs/unet/diffusion_pytorch_model.safetensors", 1263018648, "a9cb7932239b22d318f20d80c0062be5f06c9e96b620d3719db49b31f23927cf",
         hf(SDXS_REPO, "unet/diffusion_pytorch_model.safetensors")),
        ("sdxs/vae/config.json", 635, "ad96f19ac8241278e5a472fe8bfec939bc80addea71c17f2501019b712cda23d",
         hf(SDXS_REPO, "vae/config.json")),
        ("sdxs/vae/diffusion_pytorch_model.safetensors", 9793292, "d7956d561b1efbd861ad9b03fd8f01510f9e87eddc07bdfd20837009433f6ee5",
         hf(SDXS_REPO, "vae/diffusion_pytorch_model.safetensors")),
    ],
    # 评测对照用：现网 ORT 版 SigLIP2 q4_half、NLLB int4、语音 int8
    "baseline": [
        ("siglip2/q4_half.onnx", 54662805, "6b4ea1ecba627b754df325d86cc971620ac961b47d81310a3c0659827dff217a",
         [f"{GH_ARKLI_SIGLIP}/q4_half.onnx"]),
        ("nllb-int4/encoder.onnx", 4440868, "68308e2858410378fb208625d80fb11c6801a96c0e8dcc57301838c1b25f4bc2", [f"{GH_CISOX}/encoder.onnx"]),
        ("nllb-int4/encoder.onnx_data", 158297088, "9c8ad41d3ba3bc1cf7f0b37820fcc32f121703e1734c8d5ee1d77df7a0b17e49", [f"{GH_CISOX}/encoder.onnx_data"]),
        ("nllb-int4/decoder.onnx", 9185018, "05687c19b11c4ff6ffa1c3a03c22d8936716c23f043e1626e3908d03a352073d", [f"{GH_CISOX}/decoder.onnx"]),
        ("nllb-int4/decoder.onnx_data", 229598080, "d0f06b5c89c80eb657efa961418e8568d62d7e250e7517180cb91ec548619549", [f"{GH_CISOX}/decoder.onnx_data"]),
        ("asr/asr-int8.tar.bz2", 133895136, "fa5f63d618e5a01526e275a358bb7772e403f84808a4769fba52cffd8160bf74",
         [f"{GH_ASR}/{ASR_PREFIX}-int8-2026-06-05.tar.bz2"]),
    ],
}
# 缺省下载的分组（baseline 体积大且只用于对照、sdxs 约 1.8GB 且只给 logo 工具用，都需显式指定）
DEFAULT_GROUPS = ["siglip2", "nllb", "asr", "ocr", "ocr6", "couplet"]
# 要解压的包：tar 相对路径 -> 解压目录
EXTRACT = {"asr/asr-fp32.tar.bz2": "asr/fp32", "asr/asr-int8.tar.bz2": "asr/int8"}


def verified(path, size, sha):
    """文件存在且字节数与 sha256 都对。"""
    return os.path.isfile(path) and os.path.getsize(path) == size and sha256_file(path) == sha


def download(path, urls):
    """用 aria2 多连接下载到 path（断点续传，多镜像互为备份）。"""
    if not shutil.which("aria2c"):
        die("找不到 aria2c（下载一律用 aria2，E:\\software\\aria2 应已在 PATH）")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cmd = ["aria2c", "-x16", "-s16", "-k8M", "--continue=true", "--max-tries=0", "--retry-wait=3",
           "--auto-file-renaming=false", "--allow-overwrite=true",
           "--async-dns=false",  # Windows 上 aria2 自带的异步 DNS 会解析超时
           "-d", os.path.dirname(path), "-o", os.path.basename(path), *urls]
    if subprocess.run(cmd).returncode != 0:
        die(f"aria2 下载失败：{path}")


def fetch_one(rel, size, sha, urls):
    """确保一个文件已下载并校验通过；校验失败直接停（不自动重下，避免掩盖上游被改）。"""
    path = os.path.join(dl_dir(), rel)
    if verified(path, size, sha):
        log(f"已有，校验通过：{rel}")
        return path
    log(f"下载 {rel}（{fmt_bytes(size)}）")
    download(path, urls)
    if os.path.getsize(path) != size:
        die(f"{rel} 字节数不对：{os.path.getsize(path)}，期望 {size}")
    got = sha256_file(path)
    if got != sha:
        die(f"{rel} sha256 不对：{got}，期望 {sha}。文件留在原处供排查，不要使用")
    log(f"校验通过：{rel}")
    return path


def extract(rel_tar, rel_dir):
    """把校验过的 tar.bz2 解压到 rel_dir（已解压过就跳过）；过滤器拒绝越界路径与特殊文件。"""
    dst = os.path.join(dl_dir(), rel_dir)
    mark = os.path.join(dst, ".extracted")
    if os.path.isfile(mark):
        return
    os.makedirs(dst, exist_ok=True)
    log(f"解压 {rel_tar} -> {rel_dir}")
    with tarfile.open(os.path.join(dl_dir(), rel_tar), "r:bz2") as t:
        t.extractall(dst, filter="data")
    open(mark, "w").close()


def main():
    """入口：解析分组、下载、校验、解压。"""
    ap = argparse.ArgumentParser(description="下载并校验转换用的原版模型")
    ap.add_argument("groups", nargs="*", help=f"分组，可选 {', '.join(FILES)}；缺省 {' '.join(DEFAULT_GROUPS)}")
    ap.add_argument("--list", action="store_true", help="只列出，不下载")
    a = ap.parse_args()
    groups = a.groups or DEFAULT_GROUPS
    for g in groups:
        if g not in FILES:
            die(f"未知分组 {g}，可选：{', '.join(FILES)}")
    for g in groups:
        for rel, size, sha, urls in FILES[g]:
            if a.list:
                print(f"{g}\t{rel}\t{size}\t{sha}\t{urls[0]}")
                continue
            fetch_one(rel, size, sha, urls)
            if rel in EXTRACT:
                extract(rel, EXTRACT[rel])
    if not a.list:
        log("完成")


if __name__ == "__main__":
    main()
