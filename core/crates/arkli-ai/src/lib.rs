//! # arkli-ai
//!
//! Arkli 的 AI 运行时核心：推理后端抽象、provider 探测、PP-OCR 管线。
//! 刻意与 `arkli-core`（零依赖）分开，ORT 依赖只会出现在本 crate 的 `ort-backend` feature 里。
//!
//! ## 模块
//! - [`backend`]：`InferenceBackend` / `Session` / `Tensor`，管线只认这几个 trait
//! - `ort_backend`（feature `ort-backend`）：基于 `ort` 的真实实现，动态加载 `libonnxruntime.so`
//! - [`provider`]：启动时 provider 探测式选择 + 线程数策略（纯函数）
//! - [`image`]：原始像素缓冲、自写双线性缩放、四边形裁剪
//! - [`preprocess`]：检测 / 识别 / 方向分类的预处理（缩放、归一化、NCHW）
//! - [`db`]：DB 检测后处理（连通域、最小外接矩形、unclip）
//! - [`ctc`]：CTC 贪心解码
//! - [`pipeline`]：`OcrPipeline::recognize`，支持取消令牌与进度回调
//! - [`clip`]：CLIP 类图像编码器（缩放、归一化、向量），用于 SigLIP2 识物
//! - [`classify`]：词表向量与零样本分类（top-k、按分类聚合的 softmax 概率、置信度）
//! - `translate`（feature `ort-backend`）：本地翻译（NLLB-200 int4 ONNX，分词、束搜索、标点后处理）
//!
//! ## 测试
//! 默认 `cargo test -p arkli-ai` 只用 mock 会话，不需要 ORT 动态库与模型文件。
//! 真实 ORT 的测试在 `ort-backend` feature 下并标了 `#[ignore]`，运行条件见 `ort_backend` 模块的测试注释。
//!
//! ## 已知约定（需真机复验）
//! - 通道顺序默认 BGR（对齐 PaddleOCR/RapidOCR 参考实现），见 [`preprocess::ChannelOrder`]
//! - 方向分类输入默认 48x192，类别下标 1 为"旋转 180 度"
//! - 识别字典默认追加空格字符（`use_space_char`），类别数 = 字典行数 + 2

pub mod backend;
pub mod classify;
pub mod clip;
pub mod ctc;
pub mod db;
pub mod error;
pub mod image;
pub mod pipeline;
pub mod preprocess;
pub mod provider;
pub mod task;

#[cfg(feature = "ort-backend")]
pub mod ort_backend;
#[cfg(feature = "ort-backend")]
pub mod translate;

pub use backend::{InferenceBackend, Session, Tensor};
pub use error::{AiError, Result};
pub use image::{PixelFormat, RawImage};
pub use pipeline::{OcrModelPaths, OcrOptions, OcrPipeline, TextLine};
pub use task::{CancelToken, Progress, Stage};
