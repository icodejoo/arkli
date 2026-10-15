//! 本地翻译（NLLB-200 distilled 600M，int4 ONNX）：进程内库，encoder + 带 KV cache 的 merged decoder。
//!
//! 仅在 feature `ort-backend` 下编译。使用前须先 [`crate::ort_backend::OrtBackend::load`] 初始化共享 ORT 环境。
//! 逻辑移植自 Cisox snow-translator（GPL-3.0-only，作者本人），只保留 m2m100 家族路径。
//!
//! ## 模块
//! - `manifest`：`model.json` 解析（语言码映射、解码参数、执行参数）
//! - `engine`：会话加载、分词、编码/解码循环、束搜索接线、语言码强制与后处理
//! - `beam`：束搜索纯逻辑；`text`：分句/切块/重复检测；`zh_punct`：中日文全角标点后处理
//!
//! ## 示例
//! ```ignore
//! OrtBackend::load("libonnxruntime.so")?;
//! let mut t = Translator::load(Path::new("/data/.../nllb600m-un6-ccm-int4"), 4)?;
//! let out = t.translate("你好，世界。", "zh-CN", "en", None)?;
//! println!("{} ({} ms)", out.text, out.elapsed_ms);
//! t.unload();
//! ```

pub mod beam;
pub mod detect;
pub mod engine;
pub mod error;
pub mod manifest;
pub mod text;
pub mod zh_punct;

use std::path::Path;
use std::time::Instant;

use crate::ort_backend::shared_environment;

pub use engine::TranslateOptions;
pub use error::{ErrorKind, TranslateError};

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

/// 已加载的本地翻译器（持有编码器/解码器会话与分词器）。
pub struct Translator {
    /// 推理引擎。
    engine: engine::Engine,
}

impl Translator {
    /// 加载模型目录里的 NLLB 模型。
    ///
    /// # 参数
    /// - `model_dir`：模型目录，须含 `model.json`、`encoder.onnx(+_data)`、`decoder.onnx(+_data)`、`tokenizer.json`；
    ///   外部数据文件必须与 `.onnx` 同目录（ORT 内存映射加载）。
    /// - `threads`：算子线程数，0 取清单缺省（再为 0 则 ORT 自动）。
    ///
    /// # 返回
    /// 就绪的 [`Translator`]；目录或文件缺失 `ModelMissing`、清单非法 `ManifestInvalid`、
    /// ORT 环境未初始化 `LoadFailed`、会话/分词器失败 `LoadFailed`、内存不足 `OutOfMemory`。
    ///
    /// # 示例
    /// ```ignore
    /// let mut t = Translator::load(Path::new("/data/models/nllb"), 4)?;
    /// ```
    pub fn load(model_dir: &Path, threads: u32) -> Result<Self, TranslateError> {
        // 先校验清单（缺文件早失败），再要 ORT 环境
        manifest::Manifest::load(model_dir)?;
        let env = shared_environment().ok_or_else(|| {
            TranslateError::new(
                ErrorKind::LoadFailed,
                "ORT 环境未初始化：请先调用 OrtBackend::load",
            )
        })?;
        Ok(Self {
            engine: engine::Engine::load(model_dir, &env, threads)?,
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
        let started = Instant::now();
        let opts = TranslateOptions {
            max_len: None,
            num_beams,
        };
        let out = self.engine.translate(text, src, tgt, &opts)?;
        Ok(TranslateOutput {
            text: out.text,
            elapsed_ms: started.elapsed().as_millis() as u64,
            detected: out.detected,
            unrecognized: out.unrecognized,
        })
    }

    /// 模型 ID（来自 `model.json` 的 `id`）。
    ///
    /// # 返回
    /// 形如 `nllb600m-un6-ccm-int4`。
    pub fn model_id(&self) -> &str {
        self.engine.model_id()
    }

    /// 是否支持某个有向语言对（不区分大小写；相同语言不支持）。
    ///
    /// # 参数
    /// - `src`/`tgt`：应用语言码。
    ///
    /// # 返回
    /// 支持返回 `true`。
    pub fn supports_pair(&self, src: &str, tgt: &str) -> bool {
        self.engine.supports_pair(src, tgt)
    }

    /// 卸载模型，释放会话与分词器占用的内存。
    ///
    /// # 示例
    /// ```ignore
    /// t.unload();
    /// ```
    pub fn unload(self) {
        drop(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::PathBuf;

    /// 环境变量：模型目录。
    const ENV_NLLB_DIR: &str = "ARKLI_NLLB_DIR";
    /// 环境变量：宿主机 onnxruntime 动态库。
    const ENV_ORT_DYLIB: &str = "ORT_DYLIB_PATH";
    /// 与 Cisox 对拍用的夹具。
    const PARITY_JSON: &str = include_str!("../../tests/fixtures/translate/nllb_parity.json");
    /// 对拍涉及的语言对数量下限（防夹具被改空）。
    const PARITY_MIN_CASES: usize = 5;

    /// 读环境变量，缺失时让测试失败并说明。
    fn env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("未设置 {name}"))
    }

    /// 初始化 ORT 并加载翻译器（线程 4）。
    fn load_real() -> Translator {
        crate::ort_backend::OrtBackend::load(env(ENV_ORT_DYLIB)).unwrap();
        Translator::load(&PathBuf::from(env(ENV_NLLB_DIR)), 4).unwrap()
    }

    /// 缺失目录先报 ModelMissing（不需要 ORT）。
    #[test]
    fn load_reports_missing_model_dir() {
        let e = Translator::load(Path::new("Z:/definitely/not/here"), 2)
            .err()
            .unwrap();
        assert_eq!(e.kind, ErrorKind::ModelMissing);
    }

    /// 夹具可解析且各语言对都有用例。
    #[test]
    fn parity_fixture_is_well_formed() {
        let v: Value = serde_json::from_str(PARITY_JSON).unwrap();
        let total: usize = v["pairs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["cases"].as_array().unwrap().len())
            .sum();
        assert!(total >= PARITY_MIN_CASES, "{total}");
    }

    /// 真实模型：zh-CN→en、en→zh-CN、en→fr，非空且含合理内容；错误路径可用。
    /// 运行：`ARKLI_NLLB_DIR=模型目录 ORT_DYLIB_PATH=onnxruntime 动态库 cargo test -p arkli-ai --features ort-backend -- --ignored --nocapture translate`
    #[test]
    #[ignore = "需要 ARKLI_NLLB_DIR 与 ORT_DYLIB_PATH"]
    fn 真实模型翻译三个方向() {
        let mut t = load_real();
        let cases = [
            ("你好，世界。我今天很高兴。", "zh-CN", "en"),
            ("Where is the nearest train station?", "en", "zh-CN"),
            ("Good morning, how are you today?", "en", "fr"),
        ];
        // 长句只打印不断言：用来对比宿主机与真机的译文是否一致（词表裁剪可能丢生僻字）
        let long = "The quick brown fox jumps over the lazy dog. It was a sunny day in the city, and everyone was walking along the river.";
        for beams in [2, 4] {
            let o = t.translate(long, "en", "zh-CN", Some(beams)).unwrap();
            println!("[long beams={beams}] {} ({} ms)", o.text, o.elapsed_ms);
        }
        let mut outs = Vec::new();
        for (text, src, tgt) in cases {
            let o = t.translate(text, src, tgt, None).unwrap();
            println!("[{src}->{tgt}] {text} => {} ({} ms)", o.text, o.elapsed_ms);
            assert!(!o.text.trim().is_empty());
            outs.push(o.text);
        }
        assert!(outs[0].to_lowercase().contains("world"), "{}", outs[0]);
        assert!(outs[1].chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)), "{}", outs[1]);
        assert!(
            outs[2].to_lowercase().contains("bonjour") || outs[2].to_lowercase().contains("matin"),
            "{}",
            outs[2]
        );
        // 空白原样返回；越界束宽、相同语言、不支持语言分别报错；出错后仍可继续翻译
        assert_eq!(t.translate("   ", "en", "fr", None).unwrap().text, "   ");
        assert_eq!(t.translate("Hi.", "en", "fr", Some(99)).unwrap_err().kind, ErrorKind::BadRequest);
        assert_eq!(t.translate("Hi.", "en", "en", None).unwrap_err().kind, ErrorKind::UnsupportedPair);
        assert_eq!(t.translate("Hi.", "en", "de", None).unwrap_err().kind, ErrorKind::UnsupportedPair);
        assert!(t.translate("Hi.", "en", "fr", Some(1)).is_ok());
        t.unload();
    }

    /// 真实模型：源语言 auto——法语、中文、中英混排（两句分别识别）、纯表情/网址/数字（原样 + 无法识别）。
    #[test]
    #[ignore = "需要 ARKLI_NLLB_DIR 与 ORT_DYLIB_PATH"]
    fn 真实模型自动识别源语言() {
        let mut t = load_real();
        let o = t.translate("Bonjour le monde. Comment ça va ?", "auto", "en", None).unwrap();
        println!("[auto 法语->en] {} {:?} {} ({} ms)", o.text, o.detected, o.unrecognized, o.elapsed_ms);
        assert_eq!(o.detected, vec!["fr".to_string()]);
        assert!(!o.unrecognized);
        let o = t.translate("你好，世界。", "auto", "en", None).unwrap();
        println!("[auto 中文->en] {} {:?} {} ({} ms)", o.text, o.detected, o.unrecognized, o.elapsed_ms);
        assert_eq!(o.detected, vec!["zh-CN".to_string()]);
        let o = t.translate("Hello world. 你好世界。", "auto", "fr", None).unwrap();
        println!("[auto 混排->fr] {} {:?} {} ({} ms)", o.text, o.detected, o.unrecognized, o.elapsed_ms);
        assert_eq!(o.detected, vec!["en".to_string(), "zh-CN".to_string()]);
        assert!(!o.unrecognized);
        for junk in ["😀😀😀", "https://example.com/a?b=1", "12345 67890"] {
            let o = t.translate(junk, "auto", "en", None).unwrap();
            println!("[auto 无法识别] {junk} => {} {:?} {}", o.text, o.detected, o.unrecognized);
            assert_eq!(o.text, junk);
            assert!(o.detected.is_empty() && o.unrecognized);
        }
        // 识别出的语言与目标相同：原样保留且不算无法识别
        let o = t.translate("Bonjour le monde.", "auto", "fr", None).unwrap();
        assert_eq!((o.text.as_str(), o.unrecognized), ("Bonjour le monde.", false));
        // 空白原样；目标不支持仍报错
        assert_eq!(t.translate("  ", "auto", "en", None).unwrap().text, "  ");
        assert_eq!(t.translate("Hi.", "auto", "de", None).unwrap_err().kind, ErrorKind::UnsupportedPair);
        // 非 auto：detected = [src]
        let o = t.translate("Hello world.", "en", "fr", None).unwrap();
        assert_eq!((o.detected, o.unrecognized), (vec!["en".to_string()], false));
        t.unload();
    }

    /// 真实模型：与 Cisox 夹具（FLORES，beam=2、lp=2.0、min_ratio=0.7）逐条对拍，打印一致数量。
    /// 夹具来自另一个裁剪包（main14），译文允许有个别差异，这里只要求非空，并打印不一致项供人工查看。
    #[test]
    #[ignore = "需要 ARKLI_NLLB_DIR 与 ORT_DYLIB_PATH"]
    fn 真实模型与cisox夹具对拍() {
        let mut t = load_real();
        let v: Value = serde_json::from_str(PARITY_JSON).unwrap();
        let (mut same, mut total) = (0, 0);
        for pair in v["pairs"].as_array().unwrap() {
            let (src, tgt) = (pair["src"].as_str().unwrap(), pair["tgt"].as_str().unwrap());
            if !t.supports_pair(src, tgt) {
                continue;
            }
            for case in pair["cases"].as_array().unwrap() {
                let text = case["text"].as_str().unwrap();
                let want = case["reseg_text"].as_str().unwrap();
                let got = t.translate(text, src, tgt, Some(2)).unwrap();
                assert!(!got.text.trim().is_empty());
                total += 1;
                if got.text == want {
                    same += 1;
                } else {
                    println!("[{src}->{tgt}] 不一致\n  期望: {want}\n  实际: {}", got.text);
                }
            }
        }
        println!("对拍一致 {same}/{total}");
        assert!(total > 0);
    }
}
