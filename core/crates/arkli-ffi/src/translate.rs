//! 本地翻译（NLLB-200 600M）的 FFI 面：加载模型目录、翻译一段文本、卸载。
//!
//! 业务逻辑都在 `arkli-ai::translate`，这里只管：进程内唯一的翻译器（加锁串行，一次只跑一个推理）、
//! 类型转换、错误映射。模型只认 `model.json` 里 `format` 为 `mnn-split` 的 MNN 格式（运行库按传入的库名动态加载；本模块自己持有一个 `MnnRuntime`，与识物、OCR 各自 `load`，
//! 底层是同一个 dlopen 句柄，全局执行器的串行由 `arkli-ai::mnn` 内的全局锁保证）。

use std::path::Path;
use std::sync::Mutex;

use arkli_ai::mnn::MnnRuntime;
use arkli_ai::CancelToken;
use arkli_ai::translate::{model_format, ErrorKind, ModelFormat, TranslateError, Translator};

/// 默认算子线程数（`threads` 传 0 时使用）。
const DEFAULT_TRANSLATE_THREADS: u32 = 4;

/// 翻译 FFI 错误，Kotlin 侧对应 `TranslateFfiException` 的各子类。
#[derive(Debug, uniffi::Error)]
pub enum TranslateFfiError {
    /// 模型还没加载
    NotLoaded { reason: String },
    /// 入参不合法（束宽越界、语言对不支持等）
    InvalidInput { reason: String },
    /// 被取消（期间调用了 `translate_cancel`）
    Cancelled { reason: String },
    /// 后端出错（找不到 MNN 库、模型缺失或损坏、推理失败、内存不足）
    Backend { reason: String },
}

impl std::fmt::Display for TranslateFfiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TranslateFfiError::NotLoaded { reason }
            | TranslateFfiError::InvalidInput { reason }
            | TranslateFfiError::Cancelled { reason }
            | TranslateFfiError::Backend { reason } => write!(f, "{reason}"),
        }
    }
}

/// 把翻译错误映射到 FFI 错误：请求类问题归 `InvalidInput`，其余归 `Backend`。
fn map_translate_err(e: TranslateError) -> TranslateFfiError {
    let reason = e.to_string();
    match e.kind {
        ErrorKind::BadRequest | ErrorKind::UnsupportedPair => TranslateFfiError::InvalidInput { reason },
        ErrorKind::Cancelled => TranslateFfiError::Cancelled { reason },
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
    /// MNN 运行时，首次加载 MNN 格式模型时创建
    mnn: Option<MnnRuntime>,
    /// 当前模型目录
    model_dir: Option<String>,
    /// 翻译器
    translator: Option<Translator>,
}

/// 全局状态；Mutex 同时保证“一次只跑一个推理”。
static STATE: Mutex<Option<State>> = Mutex::new(None);

/// 当前（或最近一次）翻译的取消令牌；单独加锁，`translate_cancel` 不必等推理结束。
static CANCEL: Mutex<Option<CancelToken>> = Mutex::new(None);

/// 取锁并确保状态已初始化后执行闭包（锁中毒时仍取出内部值继续用）。
fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(State::default))
}

/// 加载运行库与翻译模型，已用同一目录加载过则直接返回。
///
/// 参数：
/// - `runtime_lib`：MNN 运行库名或路径，传 `libarkli-mnn.so`（APK 内用裸名）
/// - `model_dir`：模型目录绝对路径（含 `model.json` 及其 `files` 列出的文件；MNN 格式的三张图自带 `.mnn.weight` 外置权重）
/// - `threads`：算子线程数，0 视为默认 4
///
/// 错误：`Backend`（库、模型或词表加载失败，清单不是 `mnn-split`）。
///
/// 示例（Kotlin）：`translateLoad("libarkli-mnn.so", "/data/.../nllb600m-un6-mnn-w6", 4u)`
#[uniffi::export]
pub fn translate_load(runtime_lib: String, model_dir: String, threads: u32) -> Result<(), TranslateFfiError> {
    with_state(|s| {
        if s.translator.is_some() && s.model_dir.as_deref() == Some(model_dir.as_str()) {
            return Ok(());
        }
        // 先丢掉旧会话再建新的，避免两份模型同时占内存
        s.translator = None;
        s.model_dir = None;
        let dir = Path::new(&model_dir);
        let threads = if threads == 0 { DEFAULT_TRANSLATE_THREADS } else { threads };
        let t = match model_format(dir).map_err(map_translate_err)? {
            ModelFormat::MnnSplit => load_mnn(s, &runtime_lib, dir, threads)?,
        };
        s.translator = Some(t);
        s.model_dir = Some(model_dir);
        Ok(())
    })
}

/// 用 MNN 加载翻译器（首次创建运行时）。
fn load_mnn(s: &mut State, lib: &str, dir: &Path, threads: u32) -> Result<Translator, TranslateFfiError> {
    if s.mnn.is_none() {
        s.mnn = Some(MnnRuntime::load(lib).map_err(|e| TranslateFfiError::Backend { reason: e.to_string() })?);
    }
    let rt = s.mnn.as_ref().expect(crate::ENSURED_ABOVE);
    Translator::load_mnn(rt, dir, threads).map_err(map_translate_err)
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
/// 错误：`NotLoaded`（没调用过 `translate_load`）、`InvalidInput`（束宽越界、语言对不支持）、`Cancelled`（期间调用了 `translate_cancel`）、`Backend`。
#[uniffi::export]
pub fn translate_run(text: String, src: String, tgt: String, num_beams: u32) -> Result<TranslateResult, TranslateFfiError> {
    // 每次调用换新令牌（上一次的取消不会残留）；先登记再等状态锁，排队期间取消也能让本次一开始就取消
    let token = CancelToken::new();
    *CANCEL.lock().unwrap_or_else(|p| p.into_inner()) = Some(token.clone());
    with_state(|s| {
        let t = s
            .translator
            .as_mut()
            .ok_or_else(|| TranslateFfiError::NotLoaded { reason: "翻译模型未加载".into() })?;
        let beams = (num_beams > 0).then_some(num_beams as usize);
        let out = t.translate_cancellable(&text, &src, &tgt, beams, &token).map_err(map_translate_err)?;
        Ok(TranslateResult {
            text: out.text,
            elapsed_ms: out.elapsed_ms,
            detected: out.detected,
            unrecognized: out.unrecognized,
        })
    })
}

/// 取消正在进行（或排队中）的翻译，在下一个解码步前返回 `Cancelled`。可在任意线程调用，没有翻译在跑时无副作用。
///
/// 示例（Kotlin）：协程被取消时在 watcher 里调用 `translateCancel()`。
#[uniffi::export]
pub fn translate_cancel() {
    if let Some(t) = CANCEL.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        t.cancel();
    }
}

/// 释放翻译模型（约数百 MB 内存），ORT 环境与 MNN 运行库保留（MNN 格式在三张图释放后自动归还 MNN 内存）。下次翻译前需重新 `translate_load`。
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

    /// 在临时目录写一份最小 model.json（可选格式）与占位文件。
    fn temp_model(tag: &str, format: Option<&str>) -> String {
        let dir = std::env::temp_dir().join(format!("arkli-ffi-translate-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (files, extra) = match format {
            Some("mnn-split") => (
                r#"{"encoder":"e.mnn","cross_kv":"c.mnn","decoder":"d.mnn","embed":"embed.i8","embed_scale":"embed.scale","tokenizer":"t.json"}"#,
                r#""format":"mnn-split","#,
            ),
            _ => (r#"{"encoder":"e.mnn","decoder":"d.mnn","tokenizer":"t.json"}"#, ""),
        };
        let manifest = format!(
            r#"{{"schema_version":1,"id":"m","family":"m2m100",{extra}"files":{files},"languages":["en","fr"],"lang_tokens":{{"en":"eng_Latn","fr":"fra_Latn"}}}}"#
        );
        std::fs::write(dir.join("model.json"), manifest).unwrap();
        for f in ["e.mnn", "c.mnn", "d.mnn", "t.json"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        std::fs::write(dir.join("embed.i8"), [0u8; 8]).unwrap();
        std::fs::write(dir.join("embed.scale"), [0u8; 8]).unwrap();
        dir.to_string_lossy().into_owned()
    }

    /// 清单 format：mnn-split 是 MNN（不加载任何库，只读清单）；缺省（旧 ONNX）报清单非法。
    #[test]
    fn 清单格式只认mnn() {
        assert!(model_format(Path::new(&temp_model("fmt-old", None))).is_err());
        assert_eq!(model_format(Path::new(&temp_model("fmt-mnn", Some("mnn-split")))).unwrap(), ModelFormat::MnnSplit);
    }

    #[test]
    fn mnn格式找不到mnn库报后端错误() {
        translate_unload();
        let dir = temp_model("mnn", Some("mnn-split"));
        let r = translate_load("definitely-not-exist-libarkli-mnn.so".into(), dir, 4);
        assert!(matches!(&r, Err(TranslateFfiError::Backend { .. })), "{r:?}");
    }

    #[test]
    fn 模型目录不存在报后端错误() {
        translate_unload();
        let r = translate_load("x.so".into(), "Z:/definitely/not/here".into(), 4);
        assert!(matches!(r, Err(TranslateFfiError::Backend { .. })));
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

    #[test]
    fn 取消错误映射为取消() {
        let c = TranslateError { kind: ErrorKind::Cancelled, message: "x".into() };
        assert!(matches!(map_translate_err(c), TranslateFfiError::Cancelled { .. }));
    }

    /// 取消入口没有翻译在跑也无副作用；新一次调用换新令牌，不带上次的取消。
    #[test]
    fn 取消令牌每次调用重置() {
        translate_unload();
        translate_cancel();
        let _ = translate_run("hi".into(), "en".into(), "fr".into(), 0);
        let fresh = CANCEL.lock().unwrap().clone().unwrap();
        assert!(!fresh.is_cancelled());
        translate_cancel();
        assert!(fresh.is_cancelled());
    }
}
