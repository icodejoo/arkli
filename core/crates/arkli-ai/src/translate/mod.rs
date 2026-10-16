//! 本地翻译（NLLB-200 distilled 600M）：进程内库，encoder + 带 KV cache 的解码器。
//!
//! 模型格式由 `model.json` 的 `format` 标明，目前只有 `mnn-split`（MNN 三图，需 feature `mnn-backend`，
//! 用 [`crate::mnn::MnnRuntime`] 加载）。编排逻辑（分句、束搜索、引号包裹法、后处理）在 `engine`，
//! 与后端无关，后端只实现 [`runner::Seq2SeqRunner`]。
//! 逻辑移植自 Cisox snow-translator（GPL-3.0-only，作者本人），只保留 m2m100 家族路径。
//!
//! ## 模块
//! - `manifest`：`model.json` 解析（格式、语言码映射、解码参数、执行参数）
//! - `engine`：与后端无关的引擎（分词、编码/解码循环、束搜索接线、语言码强制与后处理）
//! - `runner`：`Seq2SeqRunner` 抽象；`mnn_runner`（MNN 三图 + 图外嵌入表）、`embed`（int8 嵌入表）
//! - `beam`：束搜索纯逻辑；`text`：分句/切块/重复检测；`zh_punct`：中日文全角标点后处理；`wrap`：极短输入引号包裹法
//!
//! ## 示例
//! ```ignore
//! let rt = MnnRuntime::load("libarkli-mnn.so")?;
//! let mut t = Translator::load_mnn(&rt, Path::new("/data/.../nllb600m-un6-mnn-w6"), 4)?;
//! let out = t.translate("你好，世界。", "zh-CN", "en", None)?;
//! println!("{} ({} ms)", out.text, out.elapsed_ms);
//! t.unload();
//! ```

pub mod beam;
pub mod detect;
pub mod embed;
pub mod engine;
pub mod error;
pub mod manifest;
#[cfg(feature = "mnn-backend")]
pub mod mnn_runner;
pub mod runner;
pub mod text;
pub mod wrap;
pub mod zh_punct;

#[cfg(all(test, feature = "mnn-backend"))]
mod mnn_real_tests;

use std::path::Path;
use std::time::Instant;

#[cfg(feature = "mnn-backend")]
use crate::mnn::{MnnNet, MnnRuntime};
use crate::task::CancelToken;

pub use engine::TranslateOptions;
pub use error::{ErrorKind, TranslateError};
pub use manifest::ModelFormat;

/// 一次翻译的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslateOutput {
    /// 译文。
    pub text: String,
    /// 本次翻译耗时（毫秒，不含模型加载）。
    pub elapsed_ms: u64,
    /// 识别出的源语言（应用码，按出现顺序去重）；`src` 不是 auto 时恒为 `[src]`。
    pub detected: Vec<String>,
    /// 是否有句子因无法识别而原样放进译文；`src` 不是 auto 时恒为 false。
    pub unrecognized: bool,
}

/// 读取模型目录 `model.json` 的格式，宿主据此选加载方式（目前只有 MNN）。
///
/// # 参数
/// - `model_dir`：模型目录。
///
/// # 返回
/// [`ModelFormat`]；`format` 缺省或不认识的取值报 `ManifestInvalid`。目录或文件缺失 `ModelMissing`、清单非法 `ManifestInvalid`。
///
/// # 示例
/// ```ignore
/// match model_format(Path::new("/data/models/nllb"))? {
///     ModelFormat::MnnSplit => { /* Translator::load_mnn */ }
/// }
/// ```
pub fn model_format(model_dir: &Path) -> Result<ModelFormat, TranslateError> {
    Ok(manifest::Manifest::load(model_dir)?.model_format()?)
}

/// 已加载的引擎，按后端分派（会话类型不同，用枚举而非 trait 对象）。
enum Inner {
    /// MNN 引擎。
    #[cfg(feature = "mnn-backend")]
    Mnn(engine::Engine<mnn_runner::MnnRunner<MnnNet>>),
}

/// 对 `Inner` 的每个变体执行同一段代码（`$e` 绑定到引擎）。
macro_rules! dispatch {
    ($inner:expr, $e:ident => $body:expr) => {
        match $inner {
            #[cfg(feature = "mnn-backend")]
            Inner::Mnn($e) => $body,
        }
    };
}

/// 已加载的本地翻译器（持有编码器/解码器会话与分词器）。
pub struct Translator {
    /// 推理引擎。
    inner: Inner,
}

impl Translator {
    /// 加载模型目录里的 MNN 格式（`mnn-split`）NLLB 模型（需 feature `mnn-backend`）。
    ///
    /// # 参数
    /// - `rt`：已加载运行库的 [`MnnRuntime`]。
    /// - `model_dir`：模型目录，须含 `model.json`（`format: "mnn-split"`）、三张 `.mnn`（含外置权重）、`embed.i8`、`embed.scale`、`tokenizer.json`。
    /// - `threads`：算子线程数，0 取清单缺省（再为 0 取 4）。
    ///
    /// # 返回
    /// 就绪的 [`Translator`]；目录或文件缺失 `ModelMissing`、清单非法或嵌入行数与词表不符 `ManifestInvalid`、会话/分词器失败 `LoadFailed`、内存不足 `OutOfMemory`。
    ///
    /// # 示例
    /// ```ignore
    /// let rt = MnnRuntime::load("libarkli-mnn.so")?;
    /// let mut t = Translator::load_mnn(&rt, Path::new("/data/models/nllb-mnn"), 4)?;
    /// ```
    #[cfg(feature = "mnn-backend")]
    pub fn load_mnn(rt: &MnnRuntime, model_dir: &Path, threads: u32) -> Result<Self, TranslateError> {
        Ok(Self {
            inner: Inner::Mnn(engine::Engine::load_mnn(rt, model_dir, threads)?),
        })
    }

    /// 翻译一段文本（自动分句，保留原分隔符，中日文目标做全角标点后处理）。
    ///
    /// # 参数
    /// - `text`：原文，可含多句与换行；纯空白原样返回。
    /// - `src`/`tgt`：应用语言码（`zh-CN`/`en`/`fr`/`es`/`ru`/`ar`，大小写不敏感）；相同或不支持返回 `UnsupportedPair`。
    ///   `src` 可为 `auto`：按句识别源语言（限定在模型支持语言内），无法识别的句子原样放进译文。
    /// - `num_beams`：束宽 1..=8，`None` 取清单缺省（2）；越界返回 `BadRequest`。
    ///
    /// # 返回
    /// [`TranslateOutput`]（译文、耗时、识别出的语言、是否有无法识别的句子）；推理失败 `DecodeFailed`、内存不足 `OutOfMemory`。
    ///
    /// # 示例
    /// ```ignore
    /// let out = t.translate("Hello world.", "en", "zh-CN", Some(2))?;
    /// assert!(!out.text.is_empty());
    /// ```
    pub fn translate(
        &mut self,
        text: &str,
        src: &str,
        tgt: &str,
        num_beams: Option<usize>,
    ) -> Result<TranslateOutput, TranslateError> {
        self.translate_cancellable(text, src, tgt, num_beams, &CancelToken::new())
    }

    /// 同 [`Translator::translate`]，但可被打断：每个解码步与每个句子片段前检查令牌。
    ///
    /// # 参数
    /// - `text`/`src`/`tgt`/`num_beams`：同 [`Translator::translate`]。
    /// - `cancel`：取消令牌；触发后在下一个检查点返回 `ErrorKind::Cancelled`（最多等一次 decoder 调用）。
    ///
    /// # 返回
    /// 同 [`Translator::translate`]；被取消返回 `Cancelled`。
    ///
    /// # 示例
    /// ```ignore
    /// let token = CancelToken::new();
    /// let out = t.translate_cancellable("Hello world.", "en", "zh-CN", None, &token)?;
    /// ```
    pub fn translate_cancellable(
        &mut self,
        text: &str,
        src: &str,
        tgt: &str,
        num_beams: Option<usize>,
        cancel: &CancelToken,
    ) -> Result<TranslateOutput, TranslateError> {
        dispatch!(&mut self.inner, e => e.set_cancel(cancel.clone()));
        let started = Instant::now();
        let opts = TranslateOptions {
            max_len: None,
            num_beams,
        };
        let out = dispatch!(&mut self.inner, e => e.translate(text, src, tgt, &opts))?;
        Ok(TranslateOutput {
            text: out.text,
            elapsed_ms: started.elapsed().as_millis() as u64,
            detected: out.detected,
            unrecognized: out.unrecognized,
        })
    }

    /// 开关引号包裹法（仅测试用，对比启用前后的译文）。
    #[cfg(test)]
    fn set_short_phrase_wrap(&mut self, on: bool) {
        dispatch!(&mut self.inner, e => e.set_short_phrase_wrap(on));
    }

    /// 模型 ID（来自 `model.json` 的 `id`）。
    ///
    /// # 返回
    /// 形如 `nllb600m-un6-mnn-w6`。
    pub fn model_id(&self) -> &str {
        dispatch!(&self.inner, e => e.model_id())
    }

    /// 是否支持某个有向语言对（不区分大小写；相同语言不支持）。
    ///
    /// # 参数
    /// - `src`/`tgt`：应用语言码。
    ///
    /// # 返回
    /// 支持返回 `true`。
    pub fn supports_pair(&self, src: &str, tgt: &str) -> bool {
        dispatch!(&self.inner, e => e.supports_pair(src, tgt))
    }

    /// 卸载模型，释放会话与分词器占用的内存（MNN 格式还会在三张图释放后归还 MNN 内存）。
    ///
    /// # 示例
    /// ```ignore
    /// t.unload();
    /// ```
    pub fn unload(self) {
        drop(self);
    }
}
