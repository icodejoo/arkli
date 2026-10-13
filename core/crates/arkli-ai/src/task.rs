//! 取消令牌与进度回调，自写，不引依赖。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::error::{AiError, Result};

/// 取消令牌。克隆后共享同一个标志，任意一份调用 [`CancelToken::cancel`] 都会让所有副本看到。
///
/// ```
/// use arkli_ai::CancelToken;
/// let token = CancelToken::new();
/// let other = token.clone();
/// assert!(!token.is_cancelled());
/// other.cancel();
/// assert!(token.is_cancelled());
/// assert!(token.check().is_err());
/// ```
#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    /// 共享的取消标志
    flag: Arc<AtomicBool>,
}

impl CancelToken {
    /// 新建一个未取消的令牌。
    pub fn new() -> Self {
        Self::default()
    }

    /// 触发取消。可在任意线程调用，幂等。
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Relaxed);
    }

    /// 是否已被取消。
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }

    /// 已取消则返回 [`AiError::Cancelled`]，方便在流程里用 `?` 提前退出。
    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(AiError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// OCR 管线所处阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// 文本检测（整图一次）
    Detect,
    /// 逐行方向分类 + 识别
    Recognize,
}

/// 进度事件。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Progress {
    /// 当前阶段
    pub stage: Stage,
    /// 当前阶段已完成的步数
    pub current: u32,
    /// 当前阶段总步数
    pub total: u32,
}

impl Progress {
    /// 当前阶段的完成比例，范围 0.0..=1.0；总数为 0 时视为 1.0。
    pub fn fraction(&self) -> f32 {
        if self.total == 0 {
            1.0
        } else {
            (self.current as f32 / self.total as f32).min(1.0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 令牌克隆后共享状态() {
        let a = CancelToken::new();
        let b = a.clone();
        assert!(a.check().is_ok());
        b.cancel();
        assert!(a.is_cancelled());
        assert_eq!(a.check(), Err(AiError::Cancelled));
    }

    #[test]
    fn 进度比例() {
        let p = |c, t| {
            Progress {
                stage: Stage::Detect,
                current: c,
                total: t,
            }
            .fraction()
        };
        assert_eq!(p(1, 4), 0.25);
        assert_eq!(p(0, 0), 1.0);
        assert_eq!(p(9, 4), 1.0);
    }
}
