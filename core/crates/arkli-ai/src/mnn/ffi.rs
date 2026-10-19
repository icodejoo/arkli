//! `libarkli-mnn` C ABI 的原始绑定：用 `libloading` 动态加载、校验 ABI 版本、解析符号。
//!
//! 接口以 `native/mnn/arkli_mnn_capi.h` 为准。本模块只做“打开库 + 取函数指针 + 错误文本拼装”，
//! 安全封装（所有权、Drop、串行）在上层 `mnn` 模块。
//! 刻意不绑定 `arkli_mnn_test_allow_normal`：它只给 C++ 测试用，生产代码不得调用。

use std::ffi::{c_char, c_int, c_void};
use std::path::Path;

use libloading::Library;

use crate::error::{AiError, Result};

/// 本绑定对应的 C ABI 版本（须与头文件 `ARKLI_MNN_ABI` 相等）。
pub const ABI_VERSION: c_int = 2;
/// 张量类型：float32。
pub const DTYPE_F32: c_int = 0;
/// 张量类型：int32（承接 ONNX 的 int64 输入）。
pub const DTYPE_I32: c_int = 1;
/// 内存模式 low：生产唯一可用的模式。
pub const MEMORY_LOW: c_int = 2;
/// 错误描述缓冲的字节数（C 侧超长会截断）。
pub const ERR_BUF_LEN: usize = 1024;
/// 张量最大维数（C ABI 限制 0..8）。
pub const MAX_NDIM: usize = 8;

/// 不透明会话类型（只用指针）。
#[repr(C)]
pub struct RawNet {
    /// 占位，防止被构造
    _private: [u8; 0],
}

/// 不透明张量类型（只用指针）。
#[repr(C)]
pub struct RawVal {
    /// 占位，防止被构造
    _private: [u8; 0],
}

/// C 侧 `arkli_mnn_config`：五个 int，布局必须与头文件一致。
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawConfig {
    /// CPU 线程数
    pub threads: c_int,
    /// 内存模式（只会是 [`MEMORY_LOW`]）
    pub memory: c_int,
    /// 精度模式
    pub precision: c_int,
    /// 性能模式（0 normal / 1 high / 2 low）
    pub power: c_int,
    /// 非 0 则加载时预重排权重
    pub rearrange: c_int,
}

/// 各 C 函数的指针类型别名。
type FnAbiVersion = unsafe extern "C" fn() -> c_int;
/// `arkli_mnn_net_load`
type FnNetLoad = unsafe extern "C" fn(
    *const c_char,
    *const c_char,
    *const *const c_char,
    c_int,
    *const *const c_char,
    c_int,
    *const RawConfig,
    *mut c_char,
    c_int,
) -> *mut RawNet;
/// `arkli_mnn_val_new`
type FnValNew = unsafe extern "C" fn(c_int, *const i32, c_int, *const c_void) -> *mut RawVal;
/// `arkli_mnn_val_shape`
type FnValShape = unsafe extern "C" fn(*const RawVal, *mut i32, c_int) -> c_int;
/// `arkli_mnn_val_dtype`
type FnValDtype = unsafe extern "C" fn(*const RawVal) -> c_int;
/// `arkli_mnn_val_read`
type FnValRead = unsafe extern "C" fn(*mut RawVal) -> *const c_void;
/// `arkli_mnn_net_forward`
type FnForward = unsafe extern "C" fn(
    *mut RawNet,
    *const *mut RawVal,
    c_int,
    *mut *mut RawVal,
    c_int,
    *mut c_char,
    c_int,
) -> c_int;
/// `arkli_mnn_val_free`
type FnValFree = unsafe extern "C" fn(*mut RawVal);
/// `arkli_mnn_net_free`
type FnNetFree = unsafe extern "C" fn(*mut RawNet);
/// `arkli_mnn_release_memory`
type FnReleaseMemory = unsafe extern "C" fn();
/// `arkli_mnn_last_error`
type FnLastError = unsafe extern "C" fn(*mut c_char, c_int) -> c_int;
/// `arkli_mnn_last_error_code`
type FnLastErrorCode = unsafe extern "C" fn() -> c_int;
/// `arkli_mnn_config_default`
type FnConfigDefault = unsafe extern "C" fn(*mut RawConfig);

/// 已加载的 MNN C ABI：持有库句柄与全部函数指针（库句柄放在结构里，保证指针有效）。
pub struct Api {
    /// 库句柄；只要 Api 活着库就不会卸载，函数指针才有效
    _lib: Library,
    /// `arkli_mnn_config_default`
    pub config_default: FnConfigDefault,
    /// `arkli_mnn_net_load`
    pub net_load: FnNetLoad,
    /// `arkli_mnn_val_new`
    pub val_new: FnValNew,
    /// `arkli_mnn_val_shape`
    pub val_shape: FnValShape,
    /// `arkli_mnn_val_dtype`
    pub val_dtype: FnValDtype,
    /// `arkli_mnn_val_read`
    pub val_read: FnValRead,
    /// `arkli_mnn_net_forward`
    pub net_forward: FnForward,
    /// `arkli_mnn_val_free`
    pub val_free: FnValFree,
    /// `arkli_mnn_net_free`
    pub net_free: FnNetFree,
    /// `arkli_mnn_release_memory`
    pub release_memory: FnReleaseMemory,
    /// `arkli_mnn_last_error`
    pub last_error: FnLastError,
    /// `arkli_mnn_last_error_code`
    pub last_error_code: FnLastErrorCode,
}

/// 校验库报告的 ABI 版本。
///
/// - `found`：库里 `arkli_mnn_abi_version()` 的返回值
/// - 不等于 [`ABI_VERSION`] 时返回 [`AiError::Backend`]，提示两边需要同时更新
pub fn check_abi(found: c_int) -> Result<()> {
    if found == ABI_VERSION {
        Ok(())
    } else {
        Err(AiError::Backend(format!(
            "MNN 运行库 ABI 版本不符：库为 {found}，本程序需要 {ABI_VERSION}"
        )))
    }
}

/// 打开动态库。Windows 上给绝对路径加 `LOAD_WITH_ALTERED_SEARCH_PATH`，
/// 这样同目录下的依赖（`MNN.dll`）能被找到；其他平台（含安卓裸名 dlopen）走默认搜索。
fn open_library(path: &Path) -> Result<Library> {
    let open_err = |e: libloading::Error| {
        AiError::Backend(format!("无法加载 MNN 运行库 {}：{e}", path.display()))
    };
    #[cfg(windows)]
    {
        if path.is_absolute() {
            use libloading::os::windows::{Library as WinLibrary, LOAD_WITH_ALTERED_SEARCH_PATH};
            // SAFETY：加载动态库会执行其初始化代码，路径由调用方指定，属于信任边界内。
            let lib = unsafe { WinLibrary::load_with_flags(path, LOAD_WITH_ALTERED_SEARCH_PATH) };
            return lib.map(Library::from).map_err(open_err);
        }
    }
    // SAFETY：同上。
    unsafe { Library::new(path) }.map_err(open_err)
}

/// 解析一个符号为函数指针，缺失时报清晰错误。
///
/// # Safety
/// `T` 必须是与 C 声明一致的函数指针类型。
unsafe fn sym<T: Copy>(lib: &Library, name: &'static str) -> Result<T> {
    lib.get::<T>(name.as_bytes())
        .map(|s| *s)
        .map_err(|e| AiError::Backend(format!("MNN 运行库缺少符号 {name}：{e}")))
}

impl Api {
    /// 动态加载运行库、校验 ABI 版本并解析全部符号。
    ///
    /// - `path`：`libarkli-mnn.so`（安卓用裸名）或宿主测试用的 `arkli-mnn.dll` 路径
    /// - 失败（找不到库、缺符号、ABI 不符）返回 [`AiError::Backend`]
    pub fn open(path: &Path) -> Result<Self> {
        let lib = open_library(path)?;
        // SAFETY：下面每个类型别名都与 arkli_mnn_capi.h 的声明逐一对应。
        unsafe {
            // 先查版本再取别的符号：版本不符时其余符号可能根本不同
            let abi: FnAbiVersion = sym(&lib, "arkli_mnn_abi_version")?;
            check_abi(abi())?;
            Ok(Self {
                config_default: sym(&lib, "arkli_mnn_config_default")?,
                net_load: sym(&lib, "arkli_mnn_net_load")?,
                val_new: sym(&lib, "arkli_mnn_val_new")?,
                val_shape: sym(&lib, "arkli_mnn_val_shape")?,
                val_dtype: sym(&lib, "arkli_mnn_val_dtype")?,
                val_read: sym(&lib, "arkli_mnn_val_read")?,
                net_forward: sym(&lib, "arkli_mnn_net_forward")?,
                val_free: sym(&lib, "arkli_mnn_val_free")?,
                net_free: sym(&lib, "arkli_mnn_net_free")?,
                release_memory: sym(&lib, "arkli_mnn_release_memory")?,
                last_error: sym(&lib, "arkli_mnn_last_error")?,
                last_error_code: sym(&lib, "arkli_mnn_last_error_code")?,
                _lib: lib,
            })
        }
    }

    /// 读取当前线程最近一次失败的描述；没有错误时返回空串。
    pub fn last_error_text(&self) -> String {
        let mut buf = [0u8; ERR_BUF_LEN];
        // SAFETY：缓冲有效且长度如实传入，C 侧保证带结尾 0 并截断。
        unsafe { (self.last_error)(buf.as_mut_ptr().cast(), ERR_BUF_LEN as c_int) };
        buf_to_string(&buf)
    }
}

/// 把 C 写入的缓冲转成字符串：取到第一个 0 为止，非法 UTF-8 用替换符。
pub fn buf_to_string(buf: &[u8]) -> String {
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

/// 错误码的可读名字（对应头文件的 `ARKLI_MNN_ERR_*`）。
pub fn code_name(code: c_int) -> &'static str {
    match code {
        0 => "OK",
        -1 => "ARG",
        -2 => "LOAD",
        -3 => "INPUT",
        -4 => "RUN",
        -5 => "UNSUPPORTED",
        -6 => "INTERNAL",
        _ => "UNKNOWN",
    }
}

/// 拼装统一的错误信息：`MNN <操作> 失败（<码名> <码>）：<描述>`。
///
/// - `op`：操作名，如 `net_load`
/// - `code`：错误码（取不到时传 0 也可）
/// - `err_buf`：调用时传给 C 的错误缓冲内容
/// - `last`：`last_error` 的文本；`err_buf` 为空时用它兜底
pub fn describe_error(op: &str, code: c_int, err_buf: &str, last: &str) -> String {
    let detail = if err_buf.is_empty() { last } else { err_buf };
    let detail = if detail.is_empty() { "（无描述）" } else { detail };
    format!("MNN {op} 失败（{} {code}）：{detail}", code_name(code))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 配置结构体布局与c一致() {
        // 五个 int，无填充
        assert_eq!(std::mem::size_of::<RawConfig>(), 5 * std::mem::size_of::<c_int>());
        assert_eq!(std::mem::align_of::<RawConfig>(), std::mem::align_of::<c_int>());
    }

    #[test]
    fn abi版本不符报错() {
        assert!(check_abi(ABI_VERSION).is_ok());
        let e = check_abi(ABI_VERSION + 1).unwrap_err();
        assert!(matches!(&e, AiError::Backend(m) if m.contains("ABI")), "{e}");
    }

    #[test]
    fn 缓冲转字符串在结尾零处截断() {
        assert_eq!(buf_to_string(b"abc\0def"), "abc");
        assert_eq!(buf_to_string(b"abc"), "abc");
        assert_eq!(buf_to_string(b"\0"), "");
        assert_eq!(buf_to_string("中文\0x".as_bytes()), "中文");
    }

    #[test]
    fn 错误码名字与描述拼装() {
        assert_eq!(code_name(-3), "INPUT");
        assert_eq!(code_name(-99), "UNKNOWN");
        let m = describe_error("forward", -4, "boom", "late");
        assert!(m.contains("forward") && m.contains("RUN") && m.contains("-4") && m.contains("boom"));
        // 缓冲为空时用 last_error 兜底；都为空则给占位
        assert!(describe_error("x", -2, "", "late").contains("late"));
        assert!(describe_error("x", -2, "", "").contains("无描述"));
    }

    #[test]
    fn 库不存在报清晰错误() {
        let e = Api::open(Path::new("definitely-not-exist-libarkli-mnn.so"))
            .err()
            .expect("应当失败");
        assert!(matches!(&e, AiError::Backend(m) if m.contains("无法加载")), "{e}");
    }

    /// 系统里一定存在、但没有 arkli_mnn_* 符号的库：用来覆盖“缺符号”路径。
    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn 缺符号的库报清晰错误() {
        let lib = if cfg!(windows) { "kernel32.dll" } else { "libc.so.6" };
        let e = Api::open(Path::new(lib)).err().expect("应当失败");
        assert!(matches!(&e, AiError::Backend(m) if m.contains("缺少符号")), "{e}");
    }
}
