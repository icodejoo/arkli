//! Arkli 核心计算库。
//!
//! 只负责重计算并返回数据，不碰 UI，也不依赖安卓类型。
//! 对外接口由上层绑定 crate（计划为 `arkli-ffi`，基于 UniFFI）暴露给 Kotlin。

/// 当前核心库的版本号，取自 Cargo 包版本。
///
/// 用于原生壳启动时确认 `.so` 与壳版本匹配，也是打通 Kotlin → Rust 链路的最小探针。
///
/// # 返回值
/// 形如 `"0.1.0"` 的版本字符串。
///
/// # 示例
/// ```
/// assert!(!arkli_core::core_version().is_empty());
/// ```
pub fn core_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 版本号应是 `主.次.补丁` 三段数字，避免每次升版都要改测试。
    #[test]
    fn version_is_semver_triplet() {
        let parts: Vec<&str> = core_version().split('.').collect();
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|p| p.parse::<u32>().is_ok()));
    }
}
