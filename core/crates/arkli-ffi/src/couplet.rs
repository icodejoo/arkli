//! 对联生成（GPT-2 MNN 版）的 FFI 面：加载模型目录、按上联生成等长下联、取消、卸载。
//!
//! 业务逻辑都在 `arkli-ai` 的 `couplet` 模块，这里只管：进程内唯一的引擎（加锁串行，一次只跑一个推理）、
//! 取消令牌、类型转换、错误映射。模型目录含 `model.mnn`（+ `.weight`）、`vocab.txt`、`model.json`，
//! 运行库按调用方传入的库名动态加载（安卓传裸名 `libarkli-mnn.so`）。

use std::path::Path;
use std::sync::Mutex;

use arkli_ai::couplet::{Couplet, CoupletOptions};
use arkli_ai::mnn::{MnnNet, MnnRuntime};
use arkli_ai::task::CancelToken;
use arkli_ai::AiError;

/// 对联 FFI 错误，Kotlin 侧对应 `CoupletFfiException` 的各子类。
#[derive(Debug, uniffi::Error)]
pub enum CoupletFfiError {
    /// 模型还没加载
    NotLoaded { reason: String },
    /// 入参不合法（上联字数或字符、采样参数越界）
    InvalidInput { reason: String },
    /// 被取消
    Cancelled { reason: String },
    /// 推理后端出错（库或模型加载失败、清单词表损坏、推理失败）
    Backend { reason: String },
}

impl std::fmt::Display for CoupletFfiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoupletFfiError::NotLoaded { reason }
            | CoupletFfiError::InvalidInput { reason }
            | CoupletFfiError::Cancelled { reason }
            | CoupletFfiError::Backend { reason } => write!(f, "{reason}"),
        }
    }
}

/// 生成阶段的错误映射：配置类错误都是调用方入参问题。
fn map_err(e: AiError) -> CoupletFfiError {
    let reason = e.to_string();
    match e {
        AiError::InvalidConfig(_) | AiError::InvalidImage(_) => CoupletFfiError::InvalidInput { reason },
        AiError::Cancelled => CoupletFfiError::Cancelled { reason },
        _ => CoupletFfiError::Backend { reason },
    }
}

/// 加载阶段的错误映射：清单、词表、库、模型的问题一律算后端错误。
fn map_load_err(e: AiError) -> CoupletFfiError {
    CoupletFfiError::Backend { reason: e.to_string() }
}

/// 一次生成的结果。
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct CoupletResult {
    /// 下联（与上联等长，标点位与上联相同）
    pub text: String,
    /// 生成耗时（毫秒，不含模型加载）
    pub elapsed_ms: u64,
}

/// 进程内状态：MNN 运行时、当前引擎与它加载自哪个目录（用来判断是否要重载）。
#[derive(Default)]
struct State {
    /// MNN 运行时，首次加载时创建
    mnn: Option<MnnRuntime>,
    /// 当前模型目录
    model_dir: Option<String>,
    /// 引擎
    engine: Option<Couplet<MnnNet>>,
}

/// 全局状态；Mutex 同时保证“一次只跑一个推理”。
static STATE: Mutex<Option<State>> = Mutex::new(None);

/// 当前（或最近一次）生成的取消令牌；单独加锁，`couplet_cancel` 不必等推理结束。
static CANCEL: Mutex<Option<CancelToken>> = Mutex::new(None);

/// 取锁并确保状态已初始化后执行闭包（锁中毒时仍取出内部值继续用）。
fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(State::default))
}

/// 加载运行库与模型目录，已用同一目录加载过则直接返回。
///
/// 参数：
/// - `runtime_lib`：MNN 运行库名或路径，安卓传裸名 `libarkli-mnn.so`
/// - `model_dir`：模型目录绝对路径，含 `model.mnn`、`model.mnn.weight`、`vocab.txt`、`model.json`
/// - `threads`：算子线程数，0 视为默认 4
///
/// 错误：`Backend`（库、模型、清单或词表加载失败）。
///
/// 示例（Kotlin）：`coupletLoad("libarkli-mnn.so", "/data/.../couplet-gpt2-mnn-w6", 4u)`
#[uniffi::export]
pub fn couplet_load(runtime_lib: String, model_dir: String, threads: u32) -> Result<(), CoupletFfiError> {
    with_state(|s| {
        if s.engine.is_some() && s.model_dir.as_deref() == Some(model_dir.as_str()) {
            return Ok(());
        }
        // 先丢掉旧会话再建新的，避免两份模型同时占内存
        s.engine = None;
        s.model_dir = None;
        if s.mnn.is_none() {
            s.mnn = Some(MnnRuntime::load(&runtime_lib).map_err(map_load_err)?);
        }
        let rt = s.mnn.as_ref().expect(crate::ENSURED_ABOVE);
        let engine = rt.load_couplet(Path::new(&model_dir), threads).map_err(map_load_err)?;
        s.engine = Some(engine);
        s.model_dir = Some(model_dir);
        Ok(())
    })
}

/// 按上联生成等长下联。
///
/// 参数：
/// - `text`：上联，1~14 字，只允许汉字与 `，。、；：！？,.;:!?`（标点原位照抄），拒绝字母、数字、括号
/// - `temperature`：温度，`None` 取 0.8，0 为贪心，上限 2
/// - `top_k`：top-k，`None` 取 40，范围 1~200
/// - `seed`：随机种子，`None` 取系统时间，给定则可复现
///
/// 返回：下联与耗时。
///
/// 错误：`NotLoaded`（没调用过 `couplet_load`）、`InvalidInput`、`Cancelled`（期间调用了 `couplet_cancel`）、`Backend`。
///
/// 示例（Kotlin）：`val r = coupletGenerate("春风送暖入屠苏", null, null, null)`
#[uniffi::export]
pub fn couplet_generate(
    text: String,
    temperature: Option<f32>,
    top_k: Option<u32>,
    seed: Option<u64>,
) -> Result<CoupletResult, CoupletFfiError> {
    let mut opts = CoupletOptions::default();
    if let Some(t) = temperature {
        opts.temperature = t;
    }
    if let Some(k) = top_k {
        opts.top_k = k as usize;
    }
    opts.seed = seed;
    // 先登记令牌再等状态锁：排队期间调用 couplet_cancel 也能让本次一开始就取消
    let token = CancelToken::new();
    *CANCEL.lock().unwrap_or_else(|p| p.into_inner()) = Some(token.clone());
    with_state(|s| {
        let e = s.engine.as_mut().ok_or_else(|| CoupletFfiError::NotLoaded { reason: "对联模型未加载".into() })?;
        let out = e.generate(&text, &opts, &token).map_err(map_err)?;
        Ok(CoupletResult { text: out.text, elapsed_ms: out.elapsed_ms })
    })
}

/// 取消正在进行（或排队中）的生成，在下一个字之前返回 `Cancelled`。可在任意线程调用，没有生成在跑时无副作用。
#[uniffi::export]
pub fn couplet_cancel() {
    if let Some(t) = CANCEL.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        t.cancel();
    }
}

/// 释放对联模型（约 100MB 内存），运行库保留。下次生成前需重新 `couplet_load`。
#[uniffi::export]
pub fn couplet_unload() {
    with_state(|s| {
        s.engine = None;
        s.model_dir = None;
        // MNN：先让它丢缓存缓冲、退还空闲页
        if let Some(rt) = &s.mnn {
            rt.release_memory();
        }
    });
    // 再让进程分配器归还
    crate::mem::purge_heap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 未加载模型时生成报未就绪() {
        couplet_unload();
        let r = couplet_generate("春风".into(), None, None, None);
        assert!(matches!(r, Err(CoupletFfiError::NotLoaded { .. })));
    }

    #[test]
    fn 找不到mnn库报后端错误() {
        let r = couplet_load("definitely-not-exist-libarkli-mnn.so".into(), "x".into(), 4);
        assert!(matches!(r, Err(CoupletFfiError::Backend { .. })));
    }

    #[test]
    fn 错误映射() {
        assert!(matches!(map_err(AiError::InvalidConfig("x".into())), CoupletFfiError::InvalidInput { .. }));
        assert!(matches!(map_err(AiError::Cancelled), CoupletFfiError::Cancelled { .. }));
        assert!(matches!(map_err(AiError::Backend("x".into())), CoupletFfiError::Backend { .. }));
        assert!(matches!(map_load_err(AiError::InvalidConfig("x".into())), CoupletFfiError::Backend { .. }));
    }
}
