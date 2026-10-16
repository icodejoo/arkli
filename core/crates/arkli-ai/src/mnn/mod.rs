//! MNN 推理后端（feature `mnn-backend`）：经 `libarkli-mnn` 的 C ABI 跑 `.mnn` 模型。
//!
//! 运行库路径由调用方传入（安卓传裸名 `libarkli-mnn.so`，宿主测试传 `arkli-mnn.dll`），不写死，
//! 与 ORT 的 load-dynamic 做法一致。内存模式固定为 low：配置里不暴露 normal（NLLB 会膨胀到 2.85GB）。
//!
//! - [`MnnRuntime`]：持有库句柄，负责加载模型与归还内存
//! - [`MnnNet`]：一个已加载的会话，实现 [`GraphSession`]；`Drop` 时释放
//! - [`MnnValue`]：张量句柄，实现 [`GraphValue`]；`Drop` 时释放，可比会话活得久
//!
//! ```no_run
//! use arkli_ai::backend::{GraphSession, GraphValue};
//! use arkli_ai::mnn::{MnnConfig, MnnRuntime};
//! use std::path::Path;
//!
//! let rt = MnnRuntime::load("libarkli-mnn.so").unwrap();
//! let mut net = rt
//!     .load_net(Path::new("model.mnn"), None, &["pixel_values"], &["pooler_output"], &MnnConfig::default())
//!     .unwrap();
//! let input = net.value_f32(&[1, 3, 224, 224], &vec![0.0; 3 * 224 * 224]).unwrap();
//! let out = net.run(&[&input]).unwrap();
//! println!("{:?}", out[0].shape());
//! ```

pub mod ffi;

use std::ffi::{c_char, c_int, CString};
use std::path::{Path, PathBuf};
use std::ptr::{self, NonNull};
use std::sync::{Arc, Mutex};

use crate::backend::{GraphSession, GraphTensorSession, GraphValue, Session};
use crate::clip::{ClipEncoder, INPUT_NAME, OUTPUT_NAME};
use crate::error::{AiError, Result};
use crate::pipeline::{OcrModelPaths, OcrOptions, OcrPipeline};
use ffi::{Api, RawNet, RawVal, DTYPE_F32, DTYPE_I32, ERR_BUF_LEN, MAX_NDIM};

/// 默认 CPU 线程数。
pub const DEFAULT_THREADS: i32 = 4;
/// 外置权重文件的后缀：`model.mnn` 的权重在 `model.mnn.weight`。
pub const WEIGHT_SUFFIX: &str = ".weight";

/// PP-OCR 三个图共同的输入名。
pub const OCR_INPUT_NAME: &str = "x";
/// PP-OCR 三个图共同的输出名。
pub const OCR_OUTPUT_NAME: &str = "fetch_name_0";

/// 跨会话串行锁：不同会话共用 MNN 全局执行器，而 MNN 内部没给它加锁，
/// 所以 forward、`release_memory`（`Executor::gc`）、`net_load`、`net_free` 都要持有它，互相串行。
/// 注意：它不可重入，持锁期间不得再调用上面任何一个入口（`run` 里只持锁调 forward，输出句柄的释放不取这把锁）。
static FORWARD_LOCK: Mutex<()> = Mutex::new(());

/// 持全局锁执行 `f`（中毒的锁照用：锁里只有 C 调用，没有需要保持的 Rust 不变量）。
fn serialized<R>(f: impl FnOnce() -> R) -> R {
    let _guard = FORWARD_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    f()
}

/// 加载配置，布局与 C 的 `arkli_mnn_config` 相同。内存模式固定 low，不对外暴露。
///
/// ```
/// use arkli_ai::mnn::MnnConfig;
/// let cfg = MnnConfig::default().with_threads(2);
/// assert_eq!(cfg.threads(), 2);
/// ```
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MnnConfig {
    /// CPU 线程数
    threads: c_int,
    /// 内存模式，恒为 low
    memory: c_int,
    /// 精度模式（0 normal / 1 high / 2 fp16 / 3 bf16）
    precision: c_int,
    /// 非 0 则加载时预重排权重
    rearrange: c_int,
}

impl Default for MnnConfig {
    /// 默认：4 线程、low 内存、normal 精度、预重排（与 C 侧 `arkli_mnn_config_default` 一致）。
    fn default() -> Self {
        Self { threads: DEFAULT_THREADS, memory: ffi::MEMORY_LOW, precision: 0, rearrange: 1 }
    }
}

impl MnnConfig {
    /// 设置线程数；0 视为默认值 4。
    pub fn with_threads(mut self, threads: u32) -> Self {
        self.threads = if threads == 0 { DEFAULT_THREADS } else { threads as c_int };
        self
    }

    /// 设置是否预重排权重（稳态内存回到权重体积，生产建议开）。
    pub fn with_rearrange(mut self, on: bool) -> Self {
        self.rearrange = on as c_int;
        self
    }

    /// 当前线程数。
    pub fn threads(&self) -> i32 {
        self.threads
    }

    /// 转成 C 结构（布局相同）。
    fn raw(&self) -> ffi::RawConfig {
        ffi::RawConfig {
            threads: self.threads,
            memory: self.memory,
            precision: self.precision,
            rearrange: self.rearrange,
        }
    }
}

/// 外置权重的约定位置：`<model>.weight`，存在才返回。
///
/// 外置权重模型必须总传 `weight`：缺文件时 MNN 只打日志，到 forward 才报错。
///
/// ```
/// use arkli_ai::mnn::external_weight_path;
/// assert!(external_weight_path(std::path::Path::new("no/such/model.mnn")).is_none());
/// ```
pub fn external_weight_path(model: &Path) -> Option<PathBuf> {
    let mut name = model.as_os_str().to_os_string();
    name.push(WEIGHT_SUFFIX);
    let p = PathBuf::from(name);
    p.is_file().then_some(p)
}

/// 路径转 UTF-8 的 C 字符串。
fn path_cstr(p: &Path) -> Result<CString> {
    let s = p
        .to_str()
        .ok_or_else(|| AiError::InvalidConfig(format!("路径不是合法 UTF-8：{}", p.display())))?;
    cstr(s)
}

/// 字符串转 C 字符串，含 NUL 报错。
fn cstr(s: &str) -> Result<CString> {
    CString::new(s).map_err(|_| AiError::InvalidConfig(format!("字符串含 NUL：{s:?}")))
}

/// 取 C 侧最近错误码与描述，拼成统一错误。
fn api_error(api: &Api, op: &str, code: c_int, err_buf: &[u8]) -> AiError {
    // SAFETY：纯读取线程局部错误码。
    let code = if code == 0 { unsafe { (api.last_error_code)() } } else { code };
    AiError::Backend(ffi::describe_error(op, code, &ffi::buf_to_string(err_buf), &api.last_error_text()))
}

/// 校验形状与数据长度，并把形状转成 C 用的 i32。
fn check_shape(shape: &[i64], len: usize) -> Result<Vec<i32>> {
    if shape.len() > MAX_NDIM {
        return Err(AiError::InvalidConfig(format!("维数 {} 超过上限 {MAX_NDIM}", shape.len())));
    }
    let mut dims = Vec::with_capacity(shape.len());
    let mut total: i64 = 1;
    for &d in shape {
        let d32 = i32::try_from(d)
            .ok()
            .filter(|&v| v >= 0)
            .ok_or_else(|| AiError::InvalidConfig(format!("形状 {shape:?} 含非法维度 {d}")))?;
        total = total.saturating_mul(d);
        dims.push(d32);
    }
    if total != len as i64 {
        return Err(AiError::InvalidConfig(format!("形状 {shape:?} 与数据长度 {len} 不符")));
    }
    Ok(dims)
}

/// MNN 运行时：持有已加载的动态库，可克隆（引用计数），会话与张量都会保活它。
#[derive(Clone)]
pub struct MnnRuntime {
    /// 已解析的 C ABI
    api: Arc<Api>,
}

impl MnnRuntime {
    /// 动态加载运行库并校验 ABI 版本。
    ///
    /// - `lib_path`：`libarkli-mnn.so`（安卓裸名）或宿主上的 `arkli-mnn.dll` 路径；
    ///   Windows 下给绝对路径时同目录的 `MNN.dll` 会被一并找到
    /// - 失败（找不到库、缺符号、ABI 不符）返回 [`AiError::Backend`]
    pub fn load(lib_path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self { api: Arc::new(Api::open(lib_path.as_ref())?) })
    }

    /// 加载模型并创建会话。
    ///
    /// - `model`：`.mnn` 路径
    /// - `weight`：外置权重路径；外置权重模型必须传（可用 [`external_weight_path`] 探测）
    /// - `in_names` / `out_names`：输入输出名，决定 `run` 时张量的顺序，必须存在于图里
    /// - `cfg`：加载配置
    /// - 失败返回 [`AiError::Backend`]，带 C 侧的错误描述
    pub fn load_net(
        &self,
        model: &Path,
        weight: Option<&Path>,
        in_names: &[&str],
        out_names: &[&str],
        cfg: &MnnConfig,
    ) -> Result<MnnNet> {
        let model_c = path_cstr(model)?;
        let weight_c = weight.map(path_cstr).transpose()?;
        let ins: Vec<CString> = in_names.iter().map(|s| cstr(s)).collect::<Result<_>>()?;
        let outs: Vec<CString> = out_names.iter().map(|s| cstr(s)).collect::<Result<_>>()?;
        let in_ptrs: Vec<*const c_char> = ins.iter().map(|c| c.as_ptr()).collect();
        let out_ptrs: Vec<*const c_char> = outs.iter().map(|c| c.as_ptr()).collect();
        let raw_cfg = cfg.raw();
        let mut err = [0u8; ERR_BUF_LEN];
        // SAFETY：所有指针在调用期间有效；名字数组长度如实传入；err 缓冲长度如实传入。
        let net = serialized(|| unsafe {
            (self.api.net_load)(
                model_c.as_ptr(),
                weight_c.as_ref().map_or(ptr::null(), |c| c.as_ptr()),
                in_ptrs.as_ptr(),
                in_ptrs.len() as c_int,
                out_ptrs.as_ptr(),
                out_ptrs.len() as c_int,
                &raw_cfg,
                err.as_mut_ptr().cast(),
                ERR_BUF_LEN as c_int,
            )
        });
        let net = NonNull::new(net).ok_or_else(|| api_error(&self.api, "net_load", 0, &err))?;
        Ok(MnnNet {
            api: self.api.clone(),
            net,
            in_names: in_names.iter().map(|s| s.to_string()).collect(),
            out_names: out_names.iter().map(|s| s.to_string()).collect(),
        })
    }

    /// 归还内存：让 MNN 丢掉缓存缓冲、分配器退还空闲页。会话卸载后调用，无会话时也无副作用。
    pub fn release_memory(&self) {
        // SAFETY：无参数、任何时候都可调用；与 forward / load / free 共用全局锁串行（gc 动的是全局执行器）。
        serialized(|| unsafe { (self.api.release_memory)() })
    }

    /// 新建张量（拷贝数据），类型由 `dtype` 决定。
    fn new_value(&self, dtype: c_int, shape: &[i64], len: usize, data: *const std::ffi::c_void) -> Result<MnnValue> {
        let dims = check_shape(shape, len)?;
        let data = if len == 0 { ptr::null() } else { data };
        // SAFETY：dims 长度即 ndim；data 指向 len 个元素（或为空）；C 侧会拷贝。
        let v = unsafe { (self.api.val_new)(dtype, dims.as_ptr(), dims.len() as c_int, data) };
        let v = NonNull::new(v).ok_or_else(|| api_error(&self.api, "val_new", 0, &[]))?;
        Ok(MnnValue { api: self.api.clone(), val: v })
    }

    /// 新建 f32 张量。
    pub fn value_f32(&self, shape: &[i64], data: &[f32]) -> Result<MnnValue> {
        self.new_value(DTYPE_F32, shape, data.len(), data.as_ptr().cast())
    }

    /// 新建 i32 张量。
    pub fn value_i32(&self, shape: &[i64], data: &[i32]) -> Result<MnnValue> {
        self.new_value(DTYPE_I32, shape, data.len(), data.as_ptr().cast())
    }

    /// 为识物（SigLIP2）加载编码器：输入 `pixel_values`，只取 `pooler_output`，low 内存。
    ///
    /// - `model`：`model.mnn`；旁边有 `model.mnn.weight` 时自动作为外置权重传入
    /// - `threads`：线程数，0 视为默认 4
    pub fn load_clip_encoder(&self, model: &Path, threads: u32) -> Result<ClipEncoder> {
        let weight = external_weight_path(model);
        let cfg = MnnConfig::default().with_threads(threads);
        let net = self.load_net(model, weight.as_deref(), &[INPUT_NAME], &[OUTPUT_NAME], &cfg)?;
        Ok(ClipEncoder::from_graph(net))
    }

    /// 加载 PP-OCR 管线（v5 或 v6 small）：模型目录里的 `det.mnn` / `rec.mnn` / `cls.mnn` 与字典 `ppocr_keys.txt`。
    /// 按字典项数自动选参数（见 [`OcrOptions::for_dict_len`]）：18,708 项用 v6 的 det 后处理，其余按 v5。
    ///
    /// - `dir`：模型目录
    /// - `threads`：线程数，0 视为默认 4
    /// - 返回：可直接 `recognize` 的管线；三个图的输入输出名固定为 `x` / `fetch_name_0`（PaddleOCR 导出的名字）
    pub fn load_ocr_pipeline(&self, dir: &Path, threads: u32) -> Result<OcrPipeline> {
        let paths = OcrModelPaths::in_dir(dir);
        let dict_len = std::fs::read_to_string(&paths.dict)
            .map_err(|e| AiError::InvalidConfig(format!("读取字典失败：{e}")))?
            .lines()
            .count();
        self.load_ocr_pipeline_with(dir, threads, OcrOptions::for_dict_len(dict_len))
    }

    /// 同 [`Self::load_ocr_pipeline`]，但由调用方指定管线参数（对比实验、自定义阈值用）。
    ///
    /// - `dir`：模型目录
    /// - `threads`：线程数，0 视为默认 4
    /// - `options`：管线参数
    pub fn load_ocr_pipeline_with(&self, dir: &Path, threads: u32, options: OcrOptions) -> Result<OcrPipeline> {
        let cfg = MnnConfig::default().with_threads(threads);
        let mut loader = |p: &Path| -> Result<Box<dyn Session>> {
            let net = self.load_net(p, external_weight_path(p).as_deref(), &[OCR_INPUT_NAME], &[OCR_OUTPUT_NAME], &cfg)?;
            Ok(Box::new(GraphTensorSession::new(net)))
        };
        OcrPipeline::load_with(&OcrModelPaths::in_dir(dir), &mut loader, options)
    }
}

/// 一个已加载的 MNN 会话。`Drop` 时释放；同一会话由 `&mut self` 保证串行。
pub struct MnnNet {
    /// 保活运行库
    api: Arc<Api>,
    /// 会话指针
    net: NonNull<RawNet>,
    /// 输入名（加载时给定的顺序）
    in_names: Vec<String>,
    /// 输出名（加载时给定的顺序）
    out_names: Vec<String>,
}

// SAFETY：会话只经 `&mut self` 使用，且 forward 受全局锁串行；指针不与别的线程共享。
unsafe impl Send for MnnNet {}

impl Drop for MnnNet {
    fn drop(&mut self) {
        // SAFETY：指针来自 net_load 且只释放一次；已取出的输出 val 不受影响；释放会话也动全局执行器，持全局锁。
        serialized(|| unsafe { (self.api.net_free)(self.net.as_ptr()) })
    }
}

impl MnnNet {
    /// 借同一运行库新建张量（拷贝数据）。
    fn runtime(&self) -> MnnRuntime {
        MnnRuntime { api: self.api.clone() }
    }

    /// 归还内存，等价于 [`MnnRuntime::release_memory`]。
    pub fn release_memory(&self) {
        self.runtime().release_memory()
    }
}

impl GraphSession for MnnNet {
    type Value = MnnValue;

    fn input_names(&self) -> &[String] {
        &self.in_names
    }

    fn output_names(&self) -> &[String] {
        &self.out_names
    }

    fn value_f32(&self, shape: &[i64], data: &[f32]) -> Result<MnnValue> {
        self.runtime().value_f32(shape, data)
    }

    fn value_i32(&self, shape: &[i64], data: &[i32]) -> Result<MnnValue> {
        self.runtime().value_i32(shape, data)
    }

    fn run(&mut self, inputs: &[&MnnValue]) -> Result<Vec<MnnValue>> {
        if inputs.len() != self.in_names.len() {
            return Err(AiError::InvalidConfig(format!(
                "输入个数 {} 与模型的 {} 不符",
                inputs.len(),
                self.in_names.len()
            )));
        }
        let ins: Vec<*mut RawVal> = inputs.iter().map(|v| v.val.as_ptr()).collect();
        let mut outs: Vec<*mut RawVal> = vec![ptr::null_mut(); self.out_names.len()];
        let mut err = [0u8; ERR_BUF_LEN];
        // SAFETY：数组长度与加载时的个数一致；输入只被借用；err 缓冲长度如实传入。
        let rc = serialized(|| unsafe {
            (self.api.net_forward)(
                self.net.as_ptr(),
                ins.as_ptr(),
                ins.len() as c_int,
                outs.as_mut_ptr(),
                outs.len() as c_int,
                err.as_mut_ptr().cast(),
                ERR_BUF_LEN as c_int,
            )
        });
        if rc < 0 {
            return Err(api_error(&self.api, "forward", rc, &err));
        }
        // 先全部包成 MnnValue，中途出错也能靠 Drop 释放已有的输出
        outs.into_iter()
            .map(|p| {
                NonNull::new(p)
                    .map(|val| MnnValue { api: self.api.clone(), val })
                    .ok_or_else(|| AiError::Backend("MNN forward 返回了空输出句柄".into()))
            })
            .collect()
    }
}

/// 一个 MNN 张量句柄。`Drop` 时释放；输出句柄可原样作为下一次输入，也可比会话活得久。
pub struct MnnValue {
    /// 保活运行库
    api: Arc<Api>,
    /// 张量指针
    val: NonNull<RawVal>,
}

// SAFETY：句柄只引用 C 侧自己持有的内存，不绑定线程；读写由调用方串行。
unsafe impl Send for MnnValue {}

impl Drop for MnnValue {
    fn drop(&mut self) {
        // SAFETY：指针来自 val_new / forward 且只释放一次。
        unsafe { (self.api.val_free)(self.val.as_ptr()) }
    }
}

impl MnnValue {
    /// 元素个数（各维乘积）。
    fn len(&self) -> usize {
        self.shape().iter().product::<i64>() as usize
    }

    /// 读数据并拷贝成 Vec；类型不符或读不到时报错。
    fn read<T: Copy>(&self, dtype: c_int, name: &str) -> Result<Vec<T>> {
        // SAFETY：只读查询。
        let got = unsafe { (self.api.val_dtype)(self.val.as_ptr()) };
        if got != dtype {
            return Err(AiError::BadModelOutput(format!("张量不是 {name}（dtype={got}）")));
        }
        let n = self.len();
        if n == 0 {
            return Ok(Vec::new());
        }
        // SAFETY：指针由句柄持有、元素数为各维乘积、类型已校验；立即拷贝出来。
        let p = unsafe { (self.api.val_read)(self.val.as_ptr()) }.cast::<T>();
        if p.is_null() {
            return Err(AiError::BadModelOutput("读取张量数据得到空指针".into()));
        }
        Ok(unsafe { std::slice::from_raw_parts(p, n) }.to_vec())
    }
}

impl GraphValue for MnnValue {
    fn shape(&self) -> Vec<i64> {
        let p = self.val.as_ptr();
        // SAFETY：先查维数，再按维数取形状。
        let ndim = unsafe { (self.api.val_shape)(p, ptr::null_mut(), 0) };
        if ndim <= 0 {
            return Vec::new();
        }
        let mut dims = vec![0i32; ndim as usize];
        unsafe { (self.api.val_shape)(p, dims.as_mut_ptr(), ndim) };
        dims.into_iter().map(i64::from).collect()
    }

    fn to_f32(&self) -> Result<Vec<f32>> {
        self.read(DTYPE_F32, "f32")
    }

    fn to_i32(&self) -> Result<Vec<i32>> {
        self.read(DTYPE_I32, "i32")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn 全局锁让持锁区间互斥() {
        // load / free / gc / forward 都经 serialized：甲持锁期间乙必须等，乙进入时甲一定已做完
        let done = Arc::new(AtomicBool::new(false));
        let (entered_tx, entered_rx) = mpsc::channel();
        let d = done.clone();
        let a = std::thread::spawn(move || {
            serialized(|| {
                entered_tx.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(150));
                d.store(true, Ordering::SeqCst);
            })
        });
        entered_rx.recv().unwrap();
        let seen = serialized(|| done.load(Ordering::SeqCst));
        a.join().unwrap();
        assert!(seen, "乙在甲持锁期间进入了临界区");
    }

    #[test]
    fn 全局锁中毒后仍可用() {
        let r = std::thread::spawn(|| serialized(|| panic!("故意中毒"))).join();
        assert!(r.is_err());
        assert_eq!(serialized(|| 7), 7);
    }

    #[test]
    fn 默认配置是low加预重排() {
        let c = MnnConfig::default();
        assert_eq!(c.raw(), ffi::RawConfig { threads: 4, memory: 2, precision: 0, rearrange: 1 });
        assert_eq!(std::mem::size_of::<MnnConfig>(), std::mem::size_of::<ffi::RawConfig>());
    }

    #[test]
    fn 线程数为零取默认且内存模式不可改() {
        assert_eq!(MnnConfig::default().with_threads(0).threads(), DEFAULT_THREADS);
        assert_eq!(MnnConfig::default().with_threads(2).with_rearrange(false).raw().rearrange, 0);
        // 任何组合下 memory 都是 low
        assert_eq!(MnnConfig::default().with_threads(8).raw().memory, ffi::MEMORY_LOW);
    }

    #[test]
    fn 形状校验() {
        assert_eq!(check_shape(&[1, 3], 3).unwrap(), vec![1, 3]);
        assert_eq!(check_shape(&[1, 0, 4], 0).unwrap(), vec![1, 0, 4]);
        assert_eq!(check_shape(&[], 1).unwrap(), Vec::<i32>::new());
        assert!(check_shape(&[2, 2], 3).is_err());
        assert!(check_shape(&[-1, 2], 2).is_err());
        assert!(check_shape(&[i64::from(i32::MAX) + 1], 1).is_err());
        assert!(check_shape(&[1; 9], 1).is_err());
    }

    #[test]
    fn 外置权重探测() {
        let dir = std::env::temp_dir().join(format!("arkli-mnn-weight-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let model = dir.join("m.mnn");
        assert!(external_weight_path(&model).is_none());
        std::fs::write(dir.join("m.mnn.weight"), b"x").unwrap();
        assert_eq!(external_weight_path(&model), Some(dir.join("m.mnn.weight")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 字符串含nul报错() {
        assert!(cstr("a\0b").is_err());
        assert!(cstr("ok").is_ok());
    }

    #[test]
    fn 运行库不存在时加载失败() {
        assert!(matches!(MnnRuntime::load("no-such-libarkli-mnn.so"), Err(AiError::Backend(_))));
    }
}

/// 真库测试：需要 `arkli-mnn.dll` + `MNN.dll`（`native/mnn/build-tools.ps1 -HostDll` 产出）与 M1 的用例。
#[cfg(test)]
mod real_tests {
    use super::*;

    /// 运行库路径的环境变量名。
    const ENV_DYLIB: &str = "ARKLI_MNN_DYLIB";
    /// M1 用例目录（`make_case.py` 生成）的环境变量名。
    const ENV_CASE: &str = "ARKLI_MNN_CASE";
    /// SigLIP2 fp32 `model.mnn` 的环境变量名。
    const ENV_MODEL: &str = "ARKLI_MNN_MODEL";
    /// 外置权重版 `model.mnn`（旁边有 `.weight`）的环境变量名，可选。
    const ENV_MODEL_EXT: &str = "ARKLI_MNN_MODEL_EXT";
    /// 用例里的输出名（顺序即 `out_names` 顺序）。
    const OUTPUTS: [&str; 2] = ["last_hidden_state", OUTPUT_NAME];
    /// 误差率门槛：max|差| / max|期望|，与 ModuleBasic 一致。
    const MAX_DIFF_RATE: f32 = 0.01;

    /// 取必需的环境变量。
    fn env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("未设置 {name}"))
    }

    /// 读文本用例里的一维数据（每行一个数）。
    fn read_txt(dir: &Path, name: &str) -> Vec<f32> {
        std::fs::read_to_string(dir.join(format!("{name}.txt")))
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.trim().parse().unwrap())
            .collect()
    }

    /// 误差率：最大绝对差 / 期望的最大绝对值。
    fn diff_rate(got: &[f32], want: &[f32]) -> f32 {
        assert_eq!(got.len(), want.len(), "元素个数不同");
        let diff = got.iter().zip(want).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
        let peak = want.iter().map(|v| v.abs()).fold(0.0, f32::max);
        diff / peak
    }

    /// 加载运行库、SigLIP2 会话与用例输入。
    fn setup(model_env: &str) -> (MnnRuntime, MnnNet, Vec<f32>, PathBuf) {
        let rt = MnnRuntime::load(env(ENV_DYLIB)).unwrap();
        let case = PathBuf::from(env(ENV_CASE));
        let meta = std::fs::read_to_string(case.join("input.json")).unwrap();
        assert!(meta.contains(INPUT_NAME) && meta.contains("last_hidden_state"), "不是 SigLIP2 用例");
        let model = PathBuf::from(env(model_env));
        let weight = external_weight_path(&model);
        let net = rt
            .load_net(&model, weight.as_deref(), &[INPUT_NAME], &OUTPUTS, &MnnConfig::default())
            .unwrap();
        let input = read_txt(&case, INPUT_NAME);
        (rt, net, input, case)
    }

    /// 跑一次并逐个输出比对，返回各输出误差率。
    fn run_and_compare(net: &mut MnnNet, input: &[f32], case: &Path) -> Vec<f32> {
        let v = net.value_f32(&[1, 3, 224, 224], input).unwrap();
        let outs = net.run(&[&v]).unwrap();
        assert_eq!(outs.len(), OUTPUTS.len());
        OUTPUTS
            .iter()
            .zip(&outs)
            .map(|(name, out)| {
                let rate = diff_rate(&out.to_f32().unwrap(), &read_txt(case, name));
                println!("mnn 输出 {name} 形状 {:?} 误差率 {rate:e}", out.shape());
                rate
            })
            .collect()
    }

    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_MNN_CASE / ARKLI_MNN_MODEL"]
    fn mnn真库_siglip2输出与期望一致() {
        let (rt, mut net, input, case) = setup(ENV_MODEL);
        for rate in run_and_compare(&mut net, &input, &case) {
            assert!(rate <= MAX_DIFF_RATE, "误差率 {rate}");
        }
        // 重复跑一次结果应稳定
        run_and_compare(&mut net, &input, &case);
        drop(net);
        rt.release_memory();
    }

    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_MNN_CASE / ARKLI_MNN_MODEL"]
    fn mnn真库_forward与归还内存并发不崩() {
        // gc 与 forward 共用全局锁：一个线程反复 forward，另一个线程反复 release_memory，都应正常返回
        let (rt, mut net, input, _case) = setup(ENV_MODEL);
        let gc = std::thread::spawn(move || {
            for _ in 0..20 {
                rt.release_memory();
            }
        });
        let v = net.value_f32(&[1, 3, 224, 224], &input).unwrap();
        for _ in 0..5 {
            assert!(net.run(&[&v]).is_ok());
        }
        gc.join().unwrap();
    }

    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_MNN_CASE / ARKLI_MNN_MODEL"]
    fn mnn真库_输出可比会话活得久() {
        let (rt, mut net, input, _case) = setup(ENV_MODEL);
        let v = net.value_f32(&[1, 3, 224, 224], &input).unwrap();
        let outs = net.run(&[&v]).unwrap();
        drop(net);
        rt.release_memory();
        assert_eq!(outs[1].shape().len(), 2);
        assert!(!outs[1].to_f32().unwrap().is_empty());
    }

    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_MNN_CASE / ARKLI_MNN_MODEL_EXT"]
    fn mnn真库_外置权重版数值一致() {
        let (_rt, mut net, input, case) = setup(ENV_MODEL_EXT);
        for rate in run_and_compare(&mut net, &input, &case) {
            assert!(rate <= MAX_DIFF_RATE, "误差率 {rate}");
        }
    }

    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_MNN_CASE / ARKLI_MNN_MODEL"]
    fn mnn真库_错误路径() {
        let (rt, mut net, input, _case) = setup(ENV_MODEL);
        let model = PathBuf::from(env(ENV_MODEL));
        let cfg = MnnConfig::default();

        // 模型文件不存在
        let e = rt.load_net(Path::new("no/such/model.mnn"), None, &[INPUT_NAME], &[OUTPUT_NAME], &cfg);
        assert!(matches!(&e, Err(AiError::Backend(m)) if m.contains("LOAD")), "{:?}", e.err());
        // 输入名 / 输出名不在图里
        let e = rt.load_net(&model, None, &["no_such_input"], &[OUTPUT_NAME], &cfg);
        assert!(matches!(&e, Err(AiError::Backend(m)) if m.contains("LOAD")), "{:?}", e.err());
        let e = rt.load_net(&model, None, &[INPUT_NAME], &["no_such_output"], &cfg);
        assert!(e.is_err());
        // 外置权重路径不存在
        let e = rt.load_net(&model, Some(Path::new("no/such.weight")), &[INPUT_NAME], &[OUTPUT_NAME], &cfg);
        assert!(e.is_err());

        // 输入维数错
        let bad = net.value_f32(&[3, 224, 224], &input).unwrap();
        let e = net.run(&[&bad]).err().expect("维数错应失败");
        println!("维数错：{e}");
        // 输入形状错（动态维，由推理阶段报错，不能崩）
        let bad = net.value_f32(&[1, 3, 100, 100], &vec![0.0; 3 * 100 * 100]).unwrap();
        let e = net.run(&[&bad]).err().expect("形状错应失败");
        println!("形状错：{e}");
        // 类型错：i32 喂给 f32 输入
        let bad = net.value_i32(&[1, 3, 224, 224], &vec![0; 3 * 224 * 224]).unwrap();
        let e = net.run(&[&bad]).err().expect("类型错应失败");
        assert!(matches!(&e, AiError::Backend(m) if m.contains("INPUT")), "{e}");
        // 个数错（本地拦截）
        assert!(matches!(net.run(&[]), Err(AiError::InvalidConfig(_))));
        // 读错类型
        let ok = net.value_f32(&[1, 3, 224, 224], &input).unwrap();
        let outs = net.run(&[&ok]).unwrap();
        assert!(matches!(outs[0].to_i32(), Err(AiError::BadModelOutput(_))));
        // 出错之后会话仍可用
        assert!(net.run(&[&ok]).is_ok());
    }

    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_MNN_CASE / ARKLI_MNN_MODEL"]
    fn mnn真库_clip编码器跑通() {
        let rt = MnnRuntime::load(env(ENV_DYLIB)).unwrap();
        let mut enc = rt.load_clip_encoder(Path::new(&env(ENV_MODEL)), 4).unwrap();
        let img = crate::image::RawImage::new(64, 48, crate::image::PixelFormat::Rgb, vec![128; 64 * 48 * 3]).unwrap();
        let v = enc.embed(&img).unwrap();
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        println!("clip 向量维度 {}，范数 {norm}", v.len());
        assert_eq!(v.len(), 768);
        assert!((norm - 1.0).abs() < 1e-4);
    }

    /// 模型目录的环境变量名（`ppocrv6-small-mnn-fp16` 或 `ppocrv5-mnn-fp16` 产物目录）。
    const ENV_OCR_DIR: &str = "ARKLI_OCR_DIR";
    /// 测试图（`ocr_case.py` 生成的 `case.rgb`：前 8 字节为小端 u32 宽高，其后 RGB）的环境变量名。
    const ENV_OCR_RGB: &str = "ARKLI_OCR_RGB";
    /// 真值文件（`ocr_case.py` 生成的 `expect.txt`，一行一句）的环境变量名。
    const ENV_OCR_EXPECT: &str = "ARKLI_OCR_EXPECT";

    /// 只留字母数字与汉字，去掉空白与中英文标点差异（全角半角、引号等），用来比对识别文本。
    fn plain(s: &str) -> String {
        s.chars().filter(|c| c.is_alphanumeric()).collect()
    }

    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_OCR_DIR / ARKLI_OCR_RGB / ARKLI_OCR_EXPECT"]
    fn 真库跑通ocr管线() {
        use crate::task::CancelToken;
        let rt = MnnRuntime::load(env(ENV_DYLIB)).unwrap();
        let t0 = std::time::Instant::now();
        let mut p = rt.load_ocr_pipeline(Path::new(&env(ENV_OCR_DIR)), 4).unwrap();
        println!("加载 {:?}", t0.elapsed());
        let raw = std::fs::read(env(ENV_OCR_RGB)).unwrap();
        let w = u32::from_le_bytes(raw[0..4].try_into().unwrap());
        let h = u32::from_le_bytes(raw[4..8].try_into().unwrap());
        let img = crate::image::RawImage::new(w, h, crate::image::PixelFormat::Rgb, raw[8..].to_vec()).unwrap();
        let expect: Vec<String> =
            std::fs::read_to_string(env(ENV_OCR_EXPECT)).unwrap().lines().map(str::to_string).collect();
        let t1 = std::time::Instant::now();
        let lines = p.recognize(&img, &CancelToken::new(), &mut |_| {}).unwrap();
        println!("识别 {}x{} 用时 {:?}，{} 行", w, h, t1.elapsed(), lines.len());
        for l in &lines {
            println!("  [{:.3}] {}  @({:.0},{:.0})", l.score, l.text, l.quad[0].0, l.quad[0].1);
        }
        let got: Vec<String> = lines.iter().map(|l| plain(&l.text)).collect();
        let hit = expect.iter().filter(|e| got.contains(&plain(e))).count();
        println!("真值 {} 行，逐字命中 {hit} 行", expect.len());
        assert_eq!(lines.len(), expect.len(), "行数应与真值一致");
        assert_eq!(hit, expect.len(), "每行文字都应与真值一致（忽略标点差异）");
    }

    /// 批量图目录（内含 `*.rgb`，格式同 `case.rgb`）的环境变量名。
    const ENV_OCR_BATCH: &str = "ARKLI_OCR_BATCH";
    /// 计时重复次数的环境变量名（默认 3）。
    const ENV_OCR_REPEAT: &str = "ARKLI_OCR_REPEAT";
    /// 线程数的环境变量名（默认 4）。
    const ENV_OCR_THREADS: &str = "ARKLI_OCR_THREADS";

    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_OCR_DIR / ARKLI_OCR_BATCH，输出逐图文字与耗时供对比脚本使用"]
    fn 真库批量ocr输出() {
        use crate::task::CancelToken;
        let threads: u32 = std::env::var(ENV_OCR_THREADS).ok().and_then(|v| v.parse().ok()).unwrap_or(4);
        let repeat: usize = std::env::var(ENV_OCR_REPEAT).ok().and_then(|v| v.parse().ok()).unwrap_or(3);
        let rt = MnnRuntime::load(env(ENV_DYLIB)).unwrap();
        let mut p = rt.load_ocr_pipeline(Path::new(&env(ENV_OCR_DIR)), threads).unwrap();
        let mut files: Vec<_> = std::fs::read_dir(env(ENV_OCR_BATCH))
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "rgb"))
            .collect();
        files.sort();
        for f in files {
            let raw = std::fs::read(&f).unwrap();
            let w = u32::from_le_bytes(raw[0..4].try_into().unwrap());
            let h = u32::from_le_bytes(raw[4..8].try_into().unwrap());
            let img = crate::image::RawImage::new(w, h, crate::image::PixelFormat::Rgb, raw[8..].to_vec()).unwrap();
            let mut best = u128::MAX;
            let mut lines = Vec::new();
            for _ in 0..repeat.max(1) {
                let t = std::time::Instant::now();
                lines = p.recognize(&img, &CancelToken::new(), &mut |_| {}).unwrap();
                best = best.min(t.elapsed().as_millis());
            }
            println!("OCRFILE	{}	{best}", f.file_name().unwrap().to_string_lossy());
            for l in &lines {
                let q: Vec<String> = l.quad.iter().map(|pt| format!("{:.1},{:.1}", pt.0, pt.1)).collect();
                println!("OCRLINE	{:.3}	{}	{}", l.score, q.join(";"), l.text);
            }
        }
    }
}
