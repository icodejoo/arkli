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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 张量形状校验() {
        assert!(Tensor::new(vec![2, 3], vec![0.0; 6]).is_ok());
        assert!(Tensor::new(vec![2, 3], vec![0.0; 5]).is_err());
        assert!(Tensor::new(vec![0, 3], vec![]).is_err());
    }
}
