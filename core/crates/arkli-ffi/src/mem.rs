//! 堆内存归还：卸载模型后让分配器把空闲页还给系统，进程 RSS 才会真正回落。
//!
//! 只在安卓（bionic）上生效；其他平台是空操作，宿主机单测不受影响。

/// bionic `malloc.h` 里的 `M_PURGE`：让分配器（scudo）把空闲内存页释放回系统，API 28+ 可用。
#[cfg(target_os = "android")]
const M_PURGE: i32 = -101;

#[cfg(target_os = "android")]
extern "C" {
    /// bionic 的 `mallopt`，成功返回 1。
    fn mallopt(param: i32, value: i32) -> i32;
}

/// 请求分配器归还空闲堆页。
///
/// 返回：确实向分配器发出请求返回 `true`（安卓且调用成功），其余情况 `false`。
///
/// 示例：`let _ = arkli_ffi::mem::purge_heap();`
pub fn purge_heap() -> bool {
    #[cfg(target_os = "android")]
    {
        // SAFETY：mallopt 是线程安全的 libc 调用，M_PURGE 不读取 value。
        unsafe { mallopt(M_PURGE, 0) == 1 }
    }
    #[cfg(not(target_os = "android"))]
    {
        false
    }
}

/// 给 Kotlin 用：请求分配器归还空闲堆页。
///
/// 用于不经过本库的原生模型（如 sherpa-mnn 语音识别器）释放之后：它们整块 malloc 的内存释放后会留在分配器里、
/// 不还给系统，进程占用降不下来。
///
/// 返回：确实向分配器发出请求返回 `true`（安卓且调用成功），其余情况 `false`。
///
/// 示例（Kotlin）：`uniffi.arkli_ffi.purgeNativeHeap()`
#[uniffi::export]
pub fn purge_native_heap() -> bool {
    purge_heap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 导出函数与内部实现一致() {
        assert_eq!(purge_native_heap(), purge_heap());
    }

    #[test]
    fn 宿主机上归还堆是空操作() {
        // 非安卓平台不应报告“已归还”，也不应崩溃
        if !cfg!(target_os = "android") {
            assert!(!purge_heap());
        }
    }
}
