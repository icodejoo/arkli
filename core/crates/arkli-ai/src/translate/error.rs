// 移植自 Cisox snow-translator（GPL-3.0-only，作者本人）。
//! 翻译模块的错误类型。

use std::fmt;

/// 错误类别，宿主据此决定提示或降级。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// 请求参数不合法（如束宽越界）。
    BadRequest,
    /// 模型目录、清单或模型文件缺失。
    ModelMissing,
    /// 清单存在但内容非法。
    ManifestInvalid,
    /// 模型不支持请求的语言对。
    UnsupportedPair,
    /// 模型加载失败（文件损坏、算子不支持等）。
    LoadFailed,
    /// 内存不足。
    OutOfMemory,
    /// 推理或解码失败。
    DecodeFailed,
    /// 调用方通过取消令牌打断了翻译。
    Cancelled,
}

/// 翻译错误：类别 + 说明。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslateError {
    /// 错误类别。
    pub kind: ErrorKind,
    /// 人类可读原因。
    pub message: String,
}

impl TranslateError {
    /// 构造错误。
    pub(crate) fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl fmt::Display for TranslateError {
    /// 输出 `类别: 说明`。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for TranslateError {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Display 带类别与说明。
    #[test]
    fn display_has_kind_and_message() {
        let e = TranslateError::new(ErrorKind::BadRequest, "束宽越界");
        assert_eq!(e.to_string(), "BadRequest: 束宽越界");
    }
}
