//! Arkli 的 UniFFI 桥接层，只做转调，不放业务逻辑。

// 用 proc-macro 方式生成脚手架，不使用 .udl
uniffi::setup_scaffolding!();

pub mod clip;
pub mod couplet;
pub mod matting;
pub mod mem;
pub mod ocr;
pub mod translate;

/// `expect` 的说明：调用前已经把运行时 / 后端建好（clip / ocr / translate / matting 共用）。
pub(crate) const ENSURED_ABOVE: &str = "上面已确保存在";

/// 返回核心库版本号。
///
/// 返回值：形如 `0.1.0` 的版本字符串，直接取自 arkli-core。
///
/// 示例（Kotlin）：`val v = uniffi.arkli_ffi.coreVersion()`
#[uniffi::export]
pub fn core_version() -> String {
    arkli_core::core_version().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 转调结果应与 arkli-core 一致且非空。
    #[test]
    fn core_version_matches_core() {
        let v = core_version();
        assert!(!v.is_empty());
        assert_eq!(v, arkli_core::core_version().to_string());
    }
}
