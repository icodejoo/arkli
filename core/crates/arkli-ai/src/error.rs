//! 统一错误类型。不引 thiserror，手写 Display。

use std::fmt;

/// AI 运行时的错误。
#[derive(Debug, Clone, PartialEq)]
pub enum AiError {
    /// 调用方被取消（令牌被触发）。
    Cancelled,
    /// 输入图像不合法（尺寸为 0、缓冲长度对不上、通道数不支持等）。
    InvalidImage(String),
    /// 配置或参数不合法。
    InvalidConfig(String),
    /// 模型输出的形状或内容与预期不符。
    BadModelOutput(String),
    /// 推理后端报错（加载动态库、创建会话、运行失败等）。
    Backend(String),
    /// 功能暂未实现。
    Unsupported(String),
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AiError::Cancelled => write!(f, "已取消"),
            AiError::InvalidImage(m) => write!(f, "图像不合法：{m}"),
            AiError::InvalidConfig(m) => write!(f, "配置不合法：{m}"),
            AiError::BadModelOutput(m) => write!(f, "模型输出异常：{m}"),
            AiError::Backend(m) => write!(f, "推理后端错误：{m}"),
            AiError::Unsupported(m) => write!(f, "暂不支持：{m}"),
        }
    }
}

impl std::error::Error for AiError {}

/// 本 crate 通用的 Result 别名。
pub type Result<T> = std::result::Result<T, AiError>;
