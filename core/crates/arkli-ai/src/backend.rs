//! 推理后端抽象。管线只依赖这里的 trait，真实 ORT 实现见 `ort_backend`（feature `ort-backend`）。

use std::path::Path;

use crate::error::{AiError, Result};
use crate::provider::SessionOptions;

/// 张量：行优先的 f32 数据 + 形状。PP-OCR 的输入输出都是 f32，足够用。
#[derive(Debug, Clone, PartialEq)]
pub struct Tensor {
    /// 各维大小，如 `[1, 3, 48, 320]`
    pub shape: Vec<i64>,
    /// 行优先数据，长度等于各维乘积
    pub data: Vec<f32>,
}

impl Tensor {
    /// 构造张量，校验数据长度与形状一致。
    ///
    /// ```
    /// use arkli_ai::Tensor;
    /// assert!(Tensor::new(vec![1, 2], vec![0.0; 2]).is_ok());
    /// assert!(Tensor::new(vec![1, 2], vec![0.0; 3]).is_err());
    /// ```
    pub fn new(shape: Vec<i64>, data: Vec<f32>) -> Result<Self> {
        let expect: i64 = shape.iter().product();
        if shape.iter().any(|&d| d <= 0) || expect as usize != data.len() {
            return Err(AiError::BadModelOutput(format!(
                "张量形状 {shape:?} 与数据长度 {} 不符",
                data.len()
            )));
        }
        Ok(Self { shape, data })
    }
}

/// 一个已加载的模型会话（单输入单输出，PP-OCR 三个模型都满足）。
pub trait Session: Send {
    /// 运行一次推理。
    ///
    /// - `input`：输入张量
    /// - 返回：第一个输出张量
    fn run(&mut self, input: Tensor) -> Result<Tensor>;

    /// 运行一次推理并按名字取输出（多输出模型用，如 SigLIP2 的 `pooler_output`）。
    ///
    /// - `input`：输入张量
    /// - `output`：输出名
    /// - 返回：该名字对应的输出张量；默认实现不支持，返回 [`AiError::Unsupported`]
    fn run_named(&mut self, input: Tensor, output: &str) -> Result<Tensor> {
        let _ = input;
        Err(AiError::Unsupported(format!("该会话不支持按名取输出：{output}")))
    }
}

/// 推理后端：能列出可用 provider、能加载模型。
pub trait InferenceBackend {
    /// 后端当前可用的 provider 名称（生产环境来自 ORT 的 `GetAvailableProviders`）。
    fn available_providers(&self) -> Result<Vec<String>>;

    /// 加载模型文件并按选项创建会话。
    ///
    /// - `model_path`：onnx 文件路径
    /// - `options`：provider 与线程数，通常由 [`crate::provider::resolve_options`] 得出
    fn load_model(&self, model_path: &Path, options: &SessionOptions) -> Result<Box<dyn Session>>;
}

/// 图推理里的不透明张量句柄：输出可原样作为下一步输入（如 KV 缓存，零拷贝）。
pub trait GraphValue: Send {
    /// 张量各维大小。
    fn shape(&self) -> Vec<i64>;

    /// 读出 f32 数据（行优先）；不是 f32 张量时报 [`AiError::BadModelOutput`]。
    fn to_f32(&self) -> Result<Vec<f32>>;

    /// 读出 i32 数据（行优先）；不是 i32 张量时报 [`AiError::BadModelOutput`]。
    fn to_i32(&self) -> Result<Vec<i32>>;
}

/// 多输入多输出的图推理会话，ORT 与 MNN 都可实现；上层引擎（识物、翻译）只依赖它，便于 mock 单测。
///
/// 调用方负责串行（`run` 要 `&mut self`，跨会话的串行由上层的锁保证）。
pub trait GraphSession: Send {
    /// 本会话产生并消费的张量类型。
    type Value: GraphValue;

    /// 输入名，决定 [`GraphSession::run`] 里 `inputs` 的顺序。
    fn input_names(&self) -> &[String];

    /// 输出名，决定 [`GraphSession::run`] 返回值的顺序。
    fn output_names(&self) -> &[String];

    /// 新建 f32 张量（拷贝 `data`）。
    ///
    /// - `shape`：各维大小，各维乘积必须等于 `data.len()`
    fn value_f32(&self, shape: &[i64], data: &[f32]) -> Result<Self::Value>;

    /// 新建 i32 张量（拷贝 `data`；ONNX 的 int64 输入在 MNN 里也是 i32）。
    fn value_i32(&self, shape: &[i64], data: &[i32]) -> Result<Self::Value>;

    /// 运行一次前向。
    ///
    /// - `inputs`：按 [`GraphSession::input_names`] 顺序的输入（只借用）
    /// - 返回：按 [`GraphSession::output_names`] 顺序的输出
    fn run(&mut self, inputs: &[&Self::Value]) -> Result<Vec<Self::Value>>;
}

/// 把单输入的 [`GraphSession`] 适配成 [`Session`]，让 `ClipEncoder`、OCR 管线直接用 MNN 等图后端。
///
/// ```
/// # use arkli_ai::backend::{GraphSession, GraphTensorSession, Session};
/// # fn demo<G: GraphSession + 'static>(g: G) {
/// let session: Box<dyn Session> = Box::new(GraphTensorSession::new(g));
/// # }
/// ```
pub struct GraphTensorSession<G: GraphSession> {
    /// 被适配的图会话
    inner: G,
}

impl<G: GraphSession> GraphTensorSession<G> {
    /// 包装一个图会话。
    pub fn new(inner: G) -> Self {
        Self { inner }
    }

    /// 单输入推理并取下标 `idx` 的输出。
    fn run_at(&mut self, input: Tensor, idx: usize) -> Result<Tensor> {
        if self.inner.input_names().len() != 1 {
            return Err(AiError::Unsupported(format!(
                "单输入适配器要求会话恰有 1 个输入，实际 {}",
                self.inner.input_names().len()
            )));
        }
        let v = self.inner.value_f32(&input.shape, &input.data)?;
        let outs = self.inner.run(&[&v])?;
        let out = outs.get(idx).ok_or_else(|| {
            AiError::BadModelOutput(format!("输出个数 {} 不足以取下标 {idx}", outs.len()))
        })?;
        Tensor::new(out.shape(), out.to_f32()?)
    }
}

impl<G: GraphSession> Session for GraphTensorSession<G> {
    fn run(&mut self, input: Tensor) -> Result<Tensor> {
        self.run_at(input, 0)
    }

    fn run_named(&mut self, input: Tensor, output: &str) -> Result<Tensor> {
        let idx = self
            .inner
            .output_names()
            .iter()
            .position(|n| n == output)
            .ok_or_else(|| AiError::BadModelOutput(format!("会话没有名为 {output} 的输出")))?;
        self.run_at(input, idx)
    }
}

/// 模型文件对应的推理后端种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    /// ONNX Runtime（`.onnx` 等）
    Ort,
    /// MNN（`.mnn`）
    Mnn,
}

/// MNN 模型的文件扩展名（不含点，比较时忽略大小写）。
pub const MNN_EXTENSION: &str = "mnn";

/// 按模型文件扩展名选后端：`.mnn` 走 MNN，其余一律走 ORT（保持旧行为）。
///
/// ```
/// use arkli_ai::backend::{backend_for_model, BackendKind};
/// use std::path::Path;
/// assert_eq!(backend_for_model(Path::new("a/model.mnn")), BackendKind::Mnn);
/// assert_eq!(backend_for_model(Path::new("a/q4_half.onnx")), BackendKind::Ort);
/// ```
pub fn backend_for_model(model_path: &Path) -> BackendKind {
    let is_mnn = model_path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(MNN_EXTENSION));
    if is_mnn {
        BackendKind::Mnn
    } else {
        BackendKind::Ort
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 按扩展名选后端() {
        assert_eq!(backend_for_model(Path::new("m/model.mnn")), BackendKind::Mnn);
        assert_eq!(backend_for_model(Path::new("M/MODEL.MNN")), BackendKind::Mnn);
        assert_eq!(backend_for_model(Path::new("m/q4_half.onnx")), BackendKind::Ort);
        // 外置权重文件与无扩展名都不算 MNN 模型
        assert_eq!(backend_for_model(Path::new("m/model.mnn.weight")), BackendKind::Ort);
        assert_eq!(backend_for_model(Path::new("m/model")), BackendKind::Ort);
    }

    #[test]
    fn 张量形状校验() {
        assert!(Tensor::new(vec![2, 3], vec![0.0; 6]).is_ok());
        assert!(Tensor::new(vec![2, 3], vec![0.0; 5]).is_err());
        assert!(Tensor::new(vec![0, 3], vec![]).is_err());
    }
}
