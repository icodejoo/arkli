//! 本地翻译（NLLB-200 600M int4）的 FFI 面：加载模型目录、翻译一段文本、卸载。
//!
//! 业务逻辑都在 `arkli-ai::translate`，这里只管：进程内唯一的翻译器（加锁串行，一次只跑一个推理）、
//! 类型转换、错误映射。ORT 环境与识物共用（`OrtBackend::load` 幂等）。

use std::path::Path;
use std::sync::Mutex;

use arkli_ai::ort_backend::OrtBackend;
use arkli_ai::translate::{ErrorKind, TranslateError, Translator};

/// 默认算子线程数（`threads` 传 0 时使用）。
const DEFAULT_TRANSLATE_THREADS: u32 = 4;

/// 翻译 FFI 错误，Kotlin 侧对应 `TranslateFfiException` 的各子类。
#[derive(Debug, uniffi::Error)]
pub enum TranslateFfiError {
    /// 模型还没加载
    NotLoaded { reason: String },
    /// 入参不合法（束宽越界、语言对不支持等）
    InvalidInput { reason: String },
    /// 后端出错（找不到 ORT 库、模型缺失或损坏、推理失败、内存不足）
    Backend { reason: String },
}

impl std::fmt::Display for TranslateFfiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TranslateFfiError::NotLoaded { reason }
            | TranslateFfiError::InvalidInput { reason }
            | TranslateFfiError::Backend { reason } => write!(f, "{reason}"),
        }
    }
}

/// 把翻译错误映射到 FFI 错误：请求类问题归 `InvalidInput`，其余归 `Backend`。
fn map_translate_err(e: TranslateError) -> TranslateFfiError {
    let reason = e.to_string();
    match e.kind {
        ErrorKind::BadRequest | ErrorKind::UnsupportedPair => TranslateFfiError::InvalidInput { reason },
        _ => TranslateFfiError::Backend { reason },
    }
}

/// 翻译结果。
#[derive(Debug, Clone, uniffi::Record)]
pub struct TranslateResult {
    /// 译文
    pub text: String,
    /// 本次翻译耗时（毫秒，不含模型加载）
    pub elapsed_ms: u64,
    /// 识别出的源语言（应用码，按出现顺序去重）；`src` 不是 auto 时为 `[src]`
    pub detected: Vec<String>,
    /// 是否有句子因无法识别而原样放进译文；`src` 不是 auto 时恒为 false
    pub unrecognized: bool,
}

/// 进程内状态：当前翻译器与它加载自哪个目录（用来判断是否要重载）。
#[derive(Default)]
struct State {
    /// 当前模型目录
    model_dir: Option<String>,
    /// 翻译器
    translator: Option<Translator>,
}

/// 全局状态；Mutex 同时保证“一次只跑一个推理”。
static STATE: Mutex<Option<State>> = Mutex::new(None);

/// 取锁并确保状态已初始化后执行闭包（锁中毒时仍取出内部值继续用）。
fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(State::default))
}

/// 加载 ORT 与翻译模型，已用同一目录加载过则直接返回。
///
/// 参数：
/// - `ort_lib`：ORT 动态库名或路径，APK 内传裸名 `libonnxruntime.so`
/// - `model_dir`：模型目录绝对路径（含 `model.json`、encoder/decoder 及其 `.onnx_data`、`tokenizer.json`）
/// - `threads`：算子线程数，0 视为默认 4
///
/// 错误：`Backend`（库、模型或词表加载失败）。
///
/// 示例（Kotlin）：`translateLoad("libonnxruntime.so", "/data/.../nllb600m-un6-ccm-int4", 4u)`
#[uniffi::export]
pub fn translate_load(ort_lib: String, model_dir: String, threads: u32) -> Result<(), TranslateFfiError> {
    with_state(|s| {
        if s.translator.is_some() && s.model_dir.as_deref() == Some(model_dir.as_str()) {
            return Ok(());
        }
        // 先丢掉旧会话再建新的，避免两份模型同时占内存
        s.translator = None;
        s.model_dir = None;
        OrtBackend::load(&ort_lib).map_err(|e| TranslateFfiError::Backend { reason: e.to_string() })?;
        let threads = if threads == 0 { DEFAULT_TRANSLATE_THREADS } else { threads };
        let t = Translator::load(Path::new(&model_dir), threads).map_err(map_translate_err)?;
        s.translator = Some(t);
        s.model_dir = Some(model_dir);
        Ok(())
    })
}

/// 翻译一段文本。
///
/// 参数：
/// - `text`：原文，可含多句与换行（自动分句）
/// - `src`/`tgt`：应用语言码 `zh-CN`/`en`/`fr`/`es`/`ru`/`ar`；`src` 可为 `auto`（按句识别，无法识别的句子原样输出）
/// - `num_beams`：束宽，0 取模型缺省（2），其余须在 1..=8
///
/// 返回：译文、耗时、识别出的语言与是否有无法识别的句子。
///
/// 错误：`NotLoaded`（没调用过 `translate_load`）、`InvalidInput`（束宽越界、语言对不支持）、`Backend`。
#[uniffi::export]
pub fn translate_run(text: String, src: String, tgt: String, num_beams: u32) -> Result<TranslateResult, TranslateFfiError> {
    with_state(|s| {
        let t = s
            .translator
            .as_mut()
            .ok_or_else(|| TranslateFfiError::NotLoaded { reason: "翻译模型未加载".into() })?;
        let beams = (num_beams > 0).then_some(num_beams as usize);
        let out = t.translate(&text, &src, &tgt, beams).map_err(map_translate_err)?;
        Ok(TranslateResult {
            text: out.text,
            elapsed_ms: out.elapsed_ms,
            detected: out.detected,
            unrecognized: out.unrecognized,
        })
    })
}

/// 释放翻译模型（约数百 MB 内存），ORT 环境保留。下次翻译前需重新 `translate_load`。
#[uniffi::export]
pub fn translate_unload() {
    with_state(|s| {
        s.translator = None;
        s.model_dir = None;
    });
    // 会话释放后让分配器归还空闲页
    crate::mem::purge_heap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 未加载模型时翻译报未就绪() {
        translate_unload();
        let r = translate_run("hi".into(), "en".into(), "fr".into(), 0);
        assert!(matches!(r, Err(TranslateFfiError::NotLoaded { .. })));
    }

    #[test]
    fn 请求类错误映射为入参错误() {
        let bad = TranslateError { kind: ErrorKind::BadRequest, message: "束宽".into() };
        assert!(matches!(map_translate_err(bad), TranslateFfiError::InvalidInput { .. }));
        let unsupported = TranslateError { kind: ErrorKind::UnsupportedPair, message: "x".into() };
        assert!(matches!(map_translate_err(unsupported), TranslateFfiError::InvalidInput { .. }));
        let oom = TranslateError { kind: ErrorKind::OutOfMemory, message: "x".into() };
        assert!(matches!(map_translate_err(oom), TranslateFfiError::Backend { .. }));
    }
}
