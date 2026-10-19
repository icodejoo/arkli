//! # arkli-ai
//!
//! Arkli 的 AI 运行时核心：推理后端抽象、provider 探测、PP-OCR 管线。
//! 刻意与 `arkli-core`（零依赖）分开，MNN 动态加载与翻译依赖只出现在本 crate 的 `mnn-backend` feature 里。
//!
//! ## 模块
//! - [`backend`]：`InferenceBackend` / `Session` / `Tensor`，管线只认这几个 trait
//! - [`backend`] 里的 `GraphSession` / `GraphValue`：多输入多输出图推理抽象，MNN 实现，也便于 mock；
//!   `is_mnn_model` 按扩展名判断是否 MNN 模型
//! - `mnn`（feature `mnn-backend`）：基于 `libloading` 的 MNN 实现，动态加载 `libarkli-mnn.so`（C ABI 见 `native/mnn/arkli_mnn_capi.h`）
//! - [`provider`]：启动时 provider 探测式选择 + 线程数策略（纯函数）
//! - [`image`]：原始像素缓冲、自写双线性缩放、四边形裁剪
//! - [`preprocess`]：检测 / 识别 / 方向分类的预处理（缩放、归一化、NCHW）
//! - [`db`]：DB 检测后处理（连通域、最小外接矩形、unclip）
//! - [`ctc`]：CTC 贪心解码
//! - [`pipeline`]：`OcrPipeline::recognize`，支持取消令牌与进度回调
//! - [`clip`]：CLIP 类图像编码器（缩放、归一化、向量），用于 SigLIP2 识物
//! - [`classify`]：词表向量与零样本分类（top-k、按分类聚合的 softmax 概率、置信度）
//! - [`matting`]：抠图（MODNet 人像 / U2Net-p 通用；缩放、归一化、单次前向、alpha 缩回原图尺寸）
//! - [`matting_refine`]：抠图边缘细化（引导滤波收紧 alpha、Blur-Fusion 估计去污染前景色）
//! - [`couplet`]：对联生成（GPT-2 字级模型；等长掩码、top-k 采样；目录加载在 feature `mnn-backend` 下）
//! - `translate`（feature `mnn-backend`）：本地翻译（NLLB-200；MNN 三图后端，分词、束搜索、标点后处理）
//!
//! ## 测试
//! 默认 `cargo test -p arkli-ai` 只用 mock 会话，不需要 MNN 动态库与模型文件。
//! 真实 MNN 的测试在 `mnn-backend` feature 下并标了 `#[ignore]`，需要 `ARKLI_MNN_DYLIB` / `ARKLI_MNN_CASE` / `ARKLI_MNN_MODEL`。
//!
//! ## 已知约定（需真机复验）
//! - 通道顺序默认 BGR（对齐 PaddleOCR/RapidOCR 参考实现），见 [`preprocess::ChannelOrder`]
//! - 方向分类输入默认 48x192，类别下标 1 为"旋转 180 度"
//! - 识别字典默认追加空格字符（`use_space_char`），类别数 = 字典行数 + 2

pub mod backend;
pub mod classify;
pub mod clip;
pub mod couplet;
pub mod ctc;
pub mod db;
pub mod error;
pub mod image;
pub mod matting;
pub mod matting_refine;
pub mod pipeline;
pub mod preprocess;
pub mod provider;
pub mod task;

#[cfg(feature = "mnn-backend")]
pub mod mnn;
#[cfg(feature = "mnn-backend")]
pub mod translate;

pub use backend::{
    is_mnn_model, GraphSession, GraphTensorSession, GraphValue, InferenceBackend, Session, Tensor,
};
pub use error::{AiError, Result};
pub use image::{PixelFormat, RawImage};
pub use pipeline::{OcrModelPaths, OcrOptions, OcrPipeline, TextLine};
pub use task::{CancelToken, Progress, Stage};
