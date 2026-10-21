"""SDXS-512-DreamShaper 模型准备脚本：PyTorch 导出 ONNX 与生成 tokenizer.json。

包含两个核心功能：
1. 构造与 CLIPTokenizer 行为完全一致的 tokenizer.json，并通过多组用例自检与对拍；
2. 加载 SDXS PyTorch 模型并导出 text_encoder、unet、vae_decoder 三个 ONNX，使用 onnxruntime 校验精度。

命令行接口：
    python -I sdxs_prepare.py <src目录(原版 HF 布局)> <out目录> [--golden <json路径>]
"""
import argparse
import json
import os
import sys

# 优先导入当前脚本所在目录，确保能够加载 common 模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import die, log, need_file

import numpy as np
import onnxruntime as ort
import torch
from diffusers import StableDiffusionPipeline
from tokenizers import (
    AddedToken,
    Regex,
    Tokenizer,
    decoders,
    models,
    normalizers,
    pre_tokenizers,
    processors,
)

# 常量定义：序列与张量维度配置
TOKENS_MAX_LEN = 77
TIMESTEP_VALUE = 999
TOKEN_START_ID = 49406
TOKEN_END_ID = 49407
BATCH_SIZE = 1
CHANNELS_LATENT = 4
HEIGHT_LATENT = 64
WIDTH_LATENT = 64
TEXT_HIDDEN_DIM = 768
ONNX_OPSET = 17

# 常量定义：特殊 Token 文本标记
TOKEN_START_TEXT = "<|startoftext|>"
TOKEN_END_TEXT = "<|endoftext|>"
SPECIAL_SUFFIX = "</w>"

# 常量定义：正则规则
REGEX_WHITESPACE = r"\s+"
REGEX_PUNCT_SPLIT = r"""'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+"""

# 常量定义：文件与目录名称
DIR_TOKENIZER = "tokenizer"
FILE_VOCAB = "vocab.json"
FILE_MERGES = "merges.txt"
FILE_TOKENIZER = "tokenizer.json"
FILE_TEXT_ENCODER = "text_encoder.onnx"
FILE_UNET = "unet.onnx"
FILE_VAE_DECODER = "vae_decoder.onnx"

# 常量定义：张量名称
NAME_INPUT_IDS = "input_ids"
NAME_LAST_HIDDEN_STATE = "last_hidden_state"
NAME_SAMPLE = "sample"
NAME_ENCODER_HIDDEN_STATES = "encoder_hidden_states"
NAME_OUT_SAMPLE = "out_sample"
NAME_LATENT_SAMPLE = "latent_sample"

# 常量定义：对拍精度容差阈值
TOL_TEXT_ENCODER = 1e-4
TOL_UNET = 1e-3
TOL_VAE_DECODER = 1e-3

# 常量定义：执行与编码配置
PROVIDER_CPU = "CPUExecutionProvider"
ENCODING_UTF8 = "utf-8"
NEWLINE_LF = "\n"

# 常量定义：分词自检用例列表
TEST_PROMPTS = [
    "flat pictogram glyph of a bubble tea cup with a straw, solid black emoji silhouette, bold simple shape, minimalist icon, white background",
    "A Bold Minimalist Icon of a Fast Rocket Flying in Sky",
    "bubble-tea, coffee & tea: hot/cold! (50% sugar? #1) [special-edition] ~5.0$",
    "12345 67890 2026",
    "",
    "word " * 100,
    "a cat",
]


class UNetOne(torch.nn.Module):
    """UNet 包装类：将时间步写死为 999 并折叠时间嵌入，输入潜空间样本与文本特征。

    属性：
        unet (torch.nn.Module): 底层 UNet 神经网络模块。
    """

    unet: torch.nn.Module

    def __init__(self, unet: torch.nn.Module) -> None:
        """初始化 UNet 包装模块。

        参数：
            unet (torch.nn.Module): 原始 UNet 神经网络模块。
        """
        super().__init__()
        self.unet = unet

    def forward(self, sample: torch.Tensor, encoder_hidden_states: torch.Tensor) -> torch.Tensor:
        """前向传播计算单步去噪输出。

        参数：
            sample (torch.Tensor): 潜空间样本张量，形状 [1, 4, 64, 64]，类型 float32。
            encoder_hidden_states (torch.Tensor): 文本条件编码，形状 [1, 77, 768]，类型 float32。

        返回值：
            torch.Tensor: 输出预测噪声张量 out_sample，形状 [1, 4, 64, 64]，类型 float32。

        示例：
            >>> unet_wrapper = UNetOne(pipe.unet)
            >>> out_sample = unet_wrapper(sample, encoder_hidden_states)
        """
        timestep = torch.full((BATCH_SIZE,), TIMESTEP_VALUE, dtype=torch.int64)
        return self.unet(sample, timestep, encoder_hidden_states, return_dict=False)[0]


class TextEnc(torch.nn.Module):
    """CLIP 文本编码器包装类：输入 token 序列，仅输出最后一层隐藏状态。

    属性：
        text_encoder (torch.nn.Module): 原始 CLIP 文本编码器模块。
    """

    text_encoder: torch.nn.Module

    def __init__(self, text_encoder: torch.nn.Module) -> None:
        """初始化文本编码器包装模块。

        参数：
            text_encoder (torch.nn.Module): 原始 CLIP 文本编码器模块。
        """
        super().__init__()
        self.text_encoder = text_encoder

    def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
        """前向传播计算文本语义特征。

        参数：
            input_ids (torch.Tensor): Token 序列，形状 [1, 77]，类型 int32。

        返回值：
            torch.Tensor: 最后一层隐藏状态 last_hidden_state，形状 [1, 77, 768]，类型 float32。

        示例：
            >>> text_wrapper = TextEnc(pipe.text_encoder)
            >>> hidden_state = text_wrapper(input_ids)
        """
        return self.text_encoder(input_ids)[0]


class VaeDec(torch.nn.Module):
    """TAESD 解码器包装类：输入潜空间表示，解码输出重建图像样本。

    属性：
        vae (torch.nn.Module): 原始 TAESD / VAE 解码器模块。
    """

    vae: torch.nn.Module

    def __init__(self, vae: torch.nn.Module) -> None:
        """初始化 TAESD 解码器包装模块。

        参数：
            vae (torch.nn.Module): 原始 TAESD 解码器模块。
        """
        super().__init__()
        self.vae = vae

    def forward(self, latent_sample: torch.Tensor) -> torch.Tensor:
        """前向传播执行潜空间图像解码。

        参数：
            latent_sample (torch.Tensor): 潜空间样本张量，形状 [1, 4, 64, 64]，类型 float32。

        返回值：
            torch.Tensor: 解码后的图像张量 sample，形状 [1, 3, 512, 512]，类型 float32。

        示例：
            >>> vae_wrapper = VaeDec(pipe.vae)
            >>> image_tensor = vae_wrapper(latent_sample)
        """
        return self.vae.decode(latent_sample, return_dict=False)[0]


def build_tokenizer(src: str) -> Tokenizer:
    """从源目录读取 vocab.json 和 merges.txt，构造与 CLIPTokenizer 行为一致的 Tokenizer。

    参数：
        src (str): 原始模型目录路径，要求包含 tokenizer/vocab.json 和 tokenizer/merges.txt。

    返回值：
        Tokenizer: 构造完成并配置好规范化、分词规则与模板处理的 Tokenizer 实例。

    示例：
        >>> tok = build_tokenizer("models/sdxs")
    """
    vocab_path = need_file(os.path.join(src, DIR_TOKENIZER, FILE_VOCAB), f"请确保 {src} 具备原版 HF 布局")
    merges_path = need_file(os.path.join(src, DIR_TOKENIZER, FILE_MERGES), f"请确保 {src} 具备原版 HF 布局")

    with open(vocab_path, "r", encoding=ENCODING_UTF8) as f:
        vocab = json.load(f)

    merges = []
    with open(merges_path, "r", encoding=ENCODING_UTF8) as f:
        for line in f:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            parts = stripped.split(" ")
            if len(parts) == 2:
                merges.append((parts[0], parts[1]))

    bpe = models.BPE(
        vocab=vocab,
        merges=merges,
        end_of_word_suffix=SPECIAL_SUFFIX,
        unk_token=TOKEN_END_TEXT,
        fuse_unk=False,
        dropout=None,
    )
    tok = Tokenizer(bpe)
    tok.normalizer = normalizers.Sequence([
        normalizers.NFC(),
        normalizers.Replace(Regex(REGEX_WHITESPACE), " "),
        normalizers.Lowercase(),
    ])
    tok.pre_tokenizer = pre_tokenizers.Sequence([
        pre_tokenizers.Split(
            Regex(REGEX_PUNCT_SPLIT),
            behavior="removed",
            invert=True,
        ),
        pre_tokenizers.ByteLevel(add_prefix_space=False),
    ])
    tok.post_processor = processors.TemplateProcessing(
        single=f"{TOKEN_START_TEXT} $A {TOKEN_END_TEXT}",
        special_tokens=[(TOKEN_START_TEXT, TOKEN_START_ID), (TOKEN_END_TEXT, TOKEN_END_ID)],
    )
    tok.decoder = decoders.ByteLevel()
    tok.add_special_tokens([
        AddedToken(TOKEN_START_TEXT, special=True),
        AddedToken(TOKEN_END_TEXT, special=True),
    ])
    tok.enable_truncation(max_length=TOKENS_MAX_LEN)
    tok.enable_padding(length=TOKENS_MAX_LEN, pad_id=TOKEN_END_ID, pad_token=TOKEN_END_TEXT)

    return tok


def verify_and_save_tokenizer(
    tok: Tokenizer,
    src: str,
    out_dir: str,
    golden_path: str | None = None,
) -> None:
    """自检分词器行为，按需与 Hugging Face CLIPTokenizer 对拍，并保存 tokenizer.json。

    参数：
        tok (Tokenizer): 构造完成的 tokenizers 分词器实例。
        src (str): 原始模型目录路径，用于读取 HF 分词器做基准对拍。
        out_dir (str): 分词器保存的目标输出目录。
        golden_path (str | None): 可选的 golden 测试用例 JSON 导出路径。

    返回值：
        None

    示例：
        >>> verify_and_save_tokenizer(tok, "models/sdxs", "out/sdxs", "out/golden.json")
    """
    try:
        from transformers import CLIPTokenizer

        has_transformers = True
    except ImportError:
        has_transformers = False

    if has_transformers:
        tok_dir = os.path.join(src, DIR_TOKENIZER)
        clip_tok = CLIPTokenizer.from_pretrained(tok_dir)
        golden_cases = []
        for prompt in TEST_PROMPTS:
            enc = tok.encode(prompt)
            clip_res = clip_tok(prompt, padding="max_length", max_length=TOKENS_MAX_LEN, truncation=True)
            expected_ids = clip_res[NAME_INPUT_IDS]
            if enc.ids != expected_ids:
                die(
                    f"分词器自检对拍失败！提示词: {prompt!r}\n"
                    f"tokenizers 产物: {enc.ids}\n"
                    f"CLIPTokenizer 产物: {expected_ids}"
                )
            golden_cases.append({"text": prompt, "ids": enc.ids})
        log(f"分词器自检完成：全部 {len(TEST_PROMPTS)} 组提示词与 CLIPTokenizer 产物完全一致")

        if golden_path:
            golden_data = {"cases": golden_cases}
            golden_parent = os.path.dirname(os.path.abspath(golden_path))
            if golden_parent:
                os.makedirs(golden_parent, exist_ok=True)
            with open(golden_path, "w", encoding=ENCODING_UTF8, newline=NEWLINE_LF) as f:
                json.dump(golden_data, f, ensure_ascii=False, indent=2)
                f.write(NEWLINE_LF)
            log(f"已生成 golden 对拍用例文件：{golden_path}")
    else:
        if golden_path:
            die("指定了 --golden 参数，但当前环境未安装 transformers，无法生成对拍基准数据")
        log("当前环境未安装 transformers，跳过与 CLIPTokenizer 的严格对拍，仅执行基础规则校验")
        for prompt in TEST_PROMPTS:
            enc = tok.encode(prompt)
            if len(enc.ids) != TOKENS_MAX_LEN:
                die(f"分词器长度异常：期望 {TOKENS_MAX_LEN}，实际得到 {len(enc.ids)}")
            if enc.ids[0] != TOKEN_START_ID:
                die(f"分词器起始 token 异常：期望 {TOKEN_START_ID}，实际得到 {enc.ids[0]}")
            log(f"自检样例 [{prompt[:30]!r}...] -> 长度: {len(enc.ids)}, 首尾: [{enc.ids[0]}, ..., {enc.ids[-1]}]")

    out_tok_path = os.path.join(out_dir, FILE_TOKENIZER)
    tok.save(out_tok_path)
    # 统一使用 LF 格式写回，确保换行符符合仓库规范
    with open(out_tok_path, "r", encoding=ENCODING_UTF8) as f:
        tok_text = f.read()
    with open(out_tok_path, "w", encoding=ENCODING_UTF8, newline=NEWLINE_LF) as f:
        f.write(tok_text)
    log(f"已成功保存分词器文件：{out_tok_path}")


def export_onnx_models(src: str, out_dir: str) -> None:
    """加载 PyTorch 模型，导出 text_encoder、unet 和 vae_decoder 三个 ONNX 模型并对拍验证精度。

    参数：
        src (str): 原始 Hugging Face 模型目录路径。
        out_dir (str): ONNX 模型导出的目标输出目录。

    返回值：
        None

    示例：
        >>> export_onnx_models("models/sdxs", "out/sdxs")
    """
    log(f"正在从 {src} 加载 StableDiffusionPipeline...")
    pipe = StableDiffusionPipeline.from_pretrained(
        src,
        torch_dtype=torch.float32,
        safety_checker=None,
        feature_extractor=None,
    )

    jobs = [
        (
            FILE_TEXT_ENCODER,
            TextEnc(pipe.text_encoder).eval(),
            (torch.zeros((BATCH_SIZE, TOKENS_MAX_LEN), dtype=torch.int32),),
            [NAME_INPUT_IDS],
            [NAME_LAST_HIDDEN_STATE],
            TOL_TEXT_ENCODER,
        ),
        (
            FILE_UNET,
            UNetOne(pipe.unet).eval(),
            (
                torch.randn((BATCH_SIZE, CHANNELS_LATENT, HEIGHT_LATENT, WIDTH_LATENT), dtype=torch.float32),
                torch.randn((BATCH_SIZE, TOKENS_MAX_LEN, TEXT_HIDDEN_DIM), dtype=torch.float32),
            ),
            [NAME_SAMPLE, NAME_ENCODER_HIDDEN_STATES],
            [NAME_OUT_SAMPLE],
            TOL_UNET,
        ),
        (
            FILE_VAE_DECODER,
            VaeDec(pipe.vae).eval(),
            (torch.randn((BATCH_SIZE, CHANNELS_LATENT, HEIGHT_LATENT, WIDTH_LATENT), dtype=torch.float32),),
            [NAME_LATENT_SAMPLE],
            [NAME_SAMPLE],
            TOL_VAE_DECODER,
        ),
    ]

    for filename, module, args, input_names, output_names, tol in jobs:
        onnx_path = os.path.join(out_dir, filename)
        log(f"正在导出 {filename} 到 {onnx_path}...")
        with torch.no_grad():
            torch.onnx.export(
                module,
                args,
                onnx_path,
                input_names=input_names,
                output_names=output_names,
                opset_version=ONNX_OPSET,
                dynamo=False,
                do_constant_folding=True,
            )
            ref_out = module(*args)
            if isinstance(ref_out, torch.Tensor):
                ref_np = ref_out.detach().cpu().numpy()
            elif isinstance(ref_out, (tuple, list)):
                ref_np = ref_out[0].detach().cpu().numpy()
            else:
                ref_np = np.asarray(ref_out)

        log(f"使用 onnxruntime 验证 {filename} 精度...")
        sess = ort.InferenceSession(onnx_path, providers=[PROVIDER_CPU])
        ort_inputs = {k: v.detach().cpu().numpy() for k, v in zip(input_names, args)}
        got_np = sess.run(None, ort_inputs)[0]

        max_diff = float(np.abs(ref_np - got_np).max())
        log(f"[{filename}] ONNX 对拍最大绝对差: {max_diff:.6e} (容差阈值: {tol:.6e})")
        if max_diff > tol:
            die(f"[{filename}] 精度对拍失败，最大差 {max_diff:.6e} 超过容差阈值 {tol:.6e}")


def parse_args() -> argparse.Namespace:
    """解析命令行参数。

    返回值：
        argparse.Namespace: 包含 src、out 和 golden 属性的参数命名空间。

    示例：
        >>> args = parse_args()
    """
    parser = argparse.ArgumentParser(description="SDXS-512-DreamShaper 模型准备：ONNX 导出与分词器生成")
    parser.add_argument("src", help="原始 Hugging Face 布局模型目录路径")
    parser.add_argument("out", help="导出产物输出目录路径")
    parser.add_argument("--golden", default=None, help="可选：输出分词器对拍 golden 用例 JSON 路径")
    return parser.parse_args()


def main() -> None:
    """主程序入口：解析命令行参数并执行分词器构建与 ONNX 导出。

    返回值：
        None

    示例：
        >>> main()
    """
    args = parse_args()
    if not os.path.isdir(args.src):
        die(f"源模型目录不存在或不是有效目录：{args.src}")

    os.makedirs(args.out, exist_ok=True)
    log(f"开始准备 SDXS 模型，源目录: {args.src}，输出目录: {args.out}")

    # 第一步：构建分词器并自检
    log("=== 第一步：构建 tokenizer.json 并进行自检 ===")
    tok = build_tokenizer(args.src)
    verify_and_save_tokenizer(tok, args.src, args.out, args.golden)

    # 第二步：导出 ONNX 模型并对拍验证
    log("=== 第二步：导出 ONNX 模型并进行精度对拍 ===")
    export_onnx_models(args.src, args.out)

    log("SDXS 模型准备流程全部顺利完成！")


if __name__ == "__main__":
    main()
