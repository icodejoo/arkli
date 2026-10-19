//! MNN 运行时选项：性能模式，进程级设置，之后新加载的模型生效。

/// 设置 MNN 的性能模式（进程级），须在各 `*_load` 之前调用；已加载的模型不受影响。
///
/// 参数：
/// - `power`：0 均衡 / 1 性能 / 2 省电；其他值按均衡处理
///
/// 示例（Kotlin）：`uniffi.arkli_ffi.mnnSetRuntimeOptions(1)`
#[uniffi::export]
pub fn mnn_set_runtime_options(power: i32) {
    arkli_ai::mnn::set_runtime_options(power);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 转调不崩且可重复设置() {
        mnn_set_runtime_options(1);
        mnn_set_runtime_options(0);
    }
}
