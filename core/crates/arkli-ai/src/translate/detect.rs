//! 源语言自动检测：按句用 `whatlang` 识别，限定在当前模型支持的语言里。
//!
//! 识别不出（太短、没有字母、置信度不足、语言不在模型支持集）的句子由引擎原样放进输出。

use whatlang::{Detector, Info, Lang};

use super::text::Segment;

/// 源语言取此值表示自动检测（大小写不敏感）。
pub const AUTO_LANG: &str = "auto";

/// 判断源语言码是不是 `auto`。
///
/// # 示例
/// ```ignore
/// assert!(is_auto("AUTO"));
/// ```
pub fn is_auto(src: &str) -> bool {
    src.eq_ignore_ascii_case(AUTO_LANG)
}

/// 限定在模型支持语言内识别时的置信度下限。依据：对 2~3 词短句实测，whatlang 的置信度整体偏低
/// （英文 "Hello world." 0.07、"Thank you" 0.045，而单词/乱码如 "ok"、"Hola" 低于 0.01），
/// 取 0.04 能挡住单词级的随机结果，又保住常见短句；`is_reliable()`（>0.8）为真时无条件放行。
pub const MIN_CONFIDENCE: f64 = 0.04;
/// 不限语言先探一遍：若明显（置信度不低于此值）是模型不支持的语言（德/意/葡等），就判无法识别，
/// 而不是被硬塞成最像的支持语言。依据：德语长句 0.98、意大利语 0.20、葡萄牙语 0.5，
/// 而 "Hello world." 被误判成荷兰语时只有 0.009，取 0.1 在二者之间。
/// 局限：很短的非支持语言句（如 "Ich liebe dich." 0.06）可能漏过，此时靠 [`MIN_CONFIDENCE`] 兜底。
pub const FOREIGN_CONFIDENCE: f64 = 0.1;
/// 句子里至少要有几个字母（含汉字/假名/阿拉伯字母等 `char::is_alphabetic`），否则视为不可识别。
pub const MIN_LETTERS: usize = 2;
/// 汉字（Cmn）映射到的应用码。NLLB 包只有简体 token，繁体无法区分，统一当简体。
const CHINESE_APP_CODE: &str = "zh-CN";

/// whatlang 语言 → 应用语言码（目录见 `web/src/shared/languages.ts`）。
///
/// # 参数
/// - `lang`：whatlang 识别出的语言。
///
/// # 返回
/// 应用语言码；目录里没有的语言返回 `None`。`Cmn` 一律映射 `zh-CN`（模型只有简体 token，繁体无法区分）。
///
/// # 示例
/// ```ignore
/// assert_eq!(app_code_of(whatlang::Lang::Fra), Some("fr"));
/// ```
pub fn app_code_of(lang: Lang) -> Option<&'static str> {
    Some(match lang {
        Lang::Cmn => CHINESE_APP_CODE,
        Lang::Eng => "en",
        Lang::Jpn => "ja",
        Lang::Kor => "ko",
        Lang::Fra => "fr",
        Lang::Deu => "de",
        Lang::Spa => "es",
        Lang::Por => "pt",
        Lang::Rus => "ru",
        Lang::Ara => "ar",
        Lang::Ita => "it",
        Lang::Tur => "tr",
        Lang::Vie => "vi",
        Lang::Ind => "id",
        Lang::Tha => "th",
        Lang::Hin => "hi",
        Lang::Ben => "bn",
        Lang::Urd => "ur",
        Lang::Pes => "fa",
        Lang::Nld => "nl",
        Lang::Pol => "pl",
        Lang::Ukr => "uk",
        Lang::Ces => "cs",
        Lang::Swe => "sv",
        Lang::Dan => "da",
        Lang::Fin => "fi",
        Lang::Nob => "no",
        Lang::Ell => "el",
        Lang::Heb => "he",
        Lang::Hun => "hu",
        Lang::Ron => "ro",
        Lang::Bul => "bg",
        Lang::Tgl => "fil",
        Lang::Tam => "ta",
        Lang::Tel => "te",
        Lang::Mar => "mr",
        _ => return None,
    })
}

/// 应用语言码 → whatlang 语言（[`app_code_of`] 的反查，大小写不敏感）。
///
/// # 返回
/// 映射表里没有该码返回 `None`。
fn lang_of_app_code(code: &str) -> Option<Lang> {
    ALL_MAPPED.iter().copied().find(|l| app_code_of(*l).is_some_and(|c| c.eq_ignore_ascii_case(code)))
}

/// 映射表覆盖的全部 whatlang 语言（反查与单测用，须与 [`app_code_of`] 同步）。
const ALL_MAPPED: [Lang; 36] = [
    Lang::Cmn, Lang::Eng, Lang::Jpn, Lang::Kor, Lang::Fra, Lang::Deu, Lang::Spa, Lang::Por,
    Lang::Rus, Lang::Ara, Lang::Ita, Lang::Tur, Lang::Vie, Lang::Ind, Lang::Tha, Lang::Hin,
    Lang::Ben, Lang::Urd, Lang::Pes, Lang::Nld, Lang::Pol, Lang::Ukr, Lang::Ces, Lang::Swe,
    Lang::Dan, Lang::Fin, Lang::Nob, Lang::Ell, Lang::Heb, Lang::Hun, Lang::Ron, Lang::Bul,
    Lang::Tgl, Lang::Tam, Lang::Tel, Lang::Mar,
];

/// 句子里的字母个数。
fn letter_count(text: &str) -> usize {
    text.chars().filter(|c| c.is_alphabetic()).count()
}

/// 判断一个词是不是网址或邮箱（不参与语言识别）。
fn is_link_token(tok: &str) -> bool {
    let lower = tok.to_ascii_lowercase();
    lower.contains("://") || lower.starts_with("www.") || (lower.contains('@') && lower.contains('.'))
}

/// 去掉网址/邮箱后剩下的文本。
fn strip_links(text: &str) -> String {
    text.split_whitespace().filter(|t| !is_link_token(t)).collect::<Vec<_>>().join(" ")
}

/// 判断一次识别结果是否可信：置信度够高（或 whatlang 自己判为可靠）。
fn is_confident(info: &Info) -> bool {
    info.is_reliable() || info.confidence() >= MIN_CONFIDENCE
}

/// 识别一句话的语言，候选只限 `supported`（whatlang 允许列表，短句也不会被无关语言带偏）。
///
/// # 参数
/// - `text`：单句文本。
/// - `supported`：当前模型支持的应用语言码（大小写不敏感）。
///
/// # 返回
/// 识别出的应用语言码（取自 `supported` 里的原写法）；
/// 去掉网址后字母太少、候选为空、识别失败、置信度不足、明显是不支持的语言，一律 `None`。
///
/// # 示例
/// ```ignore
/// let langs = vec!["en".to_string(), "fr".to_string()];
/// assert_eq!(detect_app_lang("Bonjour le monde.", &langs), Some("fr".to_string()));
/// ```
pub fn detect_app_lang(text: &str, supported: &[String]) -> Option<String> {
    let body = strip_links(text);
    if letter_count(&body) < MIN_LETTERS {
        return None;
    }
    let allow: Vec<Lang> = supported.iter().filter_map(|c| lang_of_app_code(c)).collect();
    if allow.is_empty() {
        return None;
    }
    // 先不限语言：明显是模型不支持的语言就放弃
    if let Some(any) = whatlang::detect(&body) {
        let in_model = app_code_of(any.lang()).is_some_and(|c| supported.iter().any(|s| s.eq_ignore_ascii_case(c)));
        if !in_model && any.confidence() >= FOREIGN_CONFIDENCE {
            return None;
        }
    }
    let info = Detector::with_allowlist(allow).detect(&body)?;
    if !is_confident(&info) {
        return None;
    }
    let code = app_code_of(info.lang())?;
    supported.iter().find(|s| s.eq_ignore_ascii_case(code)).cloned()
}

/// 一个句子在 auto 模式下的处理方式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SegLang {
    /// 识别出源语言（应用码），按它翻译。
    Translate(String),
    /// 识别出的语言就是目标语言，原样保留（不算无法识别）。
    Keep(String),
    /// 无法识别，原样放进输出。
    Unknown,
}

/// 给每个句子判定处理方式。
///
/// # 参数
/// - `segments`：分句结果。
/// - `supported`：模型支持的应用语言码。
/// - `tgt`：目标语言码（识别结果与之相同的句子原样保留）。
///
/// # 返回
/// 与 `segments` 等长的处理方式列表。
///
/// # 示例
/// ```ignore
/// let kinds = classify_segments(&split_sentences("Hello world. 你好世界。"), &langs, "fr");
/// ```
pub fn classify_segments(segments: &[Segment], supported: &[String], tgt: &str) -> Vec<SegLang> {
    segments
        .iter()
        .map(|seg| match detect_app_lang(&seg.text, supported) {
            None => SegLang::Unknown,
            Some(l) if l.eq_ignore_ascii_case(tgt) => SegLang::Keep(l),
            Some(l) => SegLang::Translate(l),
        })
        .collect()
}

/// 汇总识别结果。
///
/// # 返回
/// `(按出现顺序去重的语言码, 是否有句子无法识别)`。
///
/// # 示例
/// ```ignore
/// let (detected, unrecognized) = summarize(&kinds);
/// ```
pub fn summarize(kinds: &[SegLang]) -> (Vec<String>, bool) {
    let mut detected: Vec<String> = Vec::new();
    let mut unrecognized = false;
    for k in kinds {
        match k {
            SegLang::Translate(l) | SegLang::Keep(l) => {
                if !detected.iter().any(|d| d.eq_ignore_ascii_case(l)) {
                    detected.push(l.clone());
                }
            }
            SegLang::Unknown => unrecognized = true,
        }
    }
    (detected, unrecognized)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实模型的 6 种语言。
    fn six() -> Vec<String> {
        ["zh-CN", "en", "fr", "es", "ru", "ar"].iter().map(|s| s.to_string()).collect()
    }

    /// 映射表：关键语言与简体兜底。
    #[test]
    fn mapping_table() {
        assert_eq!(app_code_of(Lang::Cmn), Some("zh-CN"));
        assert_eq!(app_code_of(Lang::Eng), Some("en"));
        assert_eq!(app_code_of(Lang::Fra), Some("fr"));
        assert_eq!(app_code_of(Lang::Spa), Some("es"));
        assert_eq!(app_code_of(Lang::Rus), Some("ru"));
        assert_eq!(app_code_of(Lang::Ara), Some("ar"));
        assert_eq!(app_code_of(Lang::Pes), Some("fa"));
        assert_eq!(app_code_of(Lang::Nob), Some("no"));
        // 目录里没有的语言
        assert_eq!(app_code_of(Lang::Epo), None);
        assert_eq!(app_code_of(Lang::Lat), None);
    }

    /// 映射出的码都必须是前端目录里的合法码，且互不重复。
    #[test]
    fn mapped_codes_unique() {
        let all = ALL_MAPPED;
        let mut codes: Vec<&str> = all.iter().map(|l| app_code_of(*l).unwrap()).collect();
        let n = codes.len();
        codes.sort();
        codes.dedup();
        assert_eq!(codes.len(), n);
    }

    /// Latin 字母的 en/fr/es 易混语言要能分开。
    #[test]
    fn latin_languages_distinguished() {
        let s = six();
        assert_eq!(detect_app_lang("Good morning, everyone.", &s).as_deref(), Some("en"));
        assert_eq!(detect_app_lang("Thank you very much.", &s).as_deref(), Some("en"));
        assert_eq!(detect_app_lang("Je t'aime.", &s).as_deref(), Some("fr"));
        assert_eq!(detect_app_lang("Te quiero mucho.", &s).as_deref(), Some("es"));
        assert_eq!(detect_app_lang("Bonjour le monde, comment allez-vous aujourd'hui ?", &s).as_deref(), Some("fr"));
        assert_eq!(detect_app_lang("Hola mundo, ¿cómo estás hoy?", &s).as_deref(), Some("es"));
        assert_eq!(detect_app_lang("Hello world.", &s).as_deref(), Some("en"));
        assert_eq!(detect_app_lang("Bonjour le monde.", &s).as_deref(), Some("fr"));
    }

    /// 其他文字：中文、俄文、阿拉伯文。
    #[test]
    fn non_latin_scripts() {
        let s = six();
        assert_eq!(detect_app_lang("你好，世界。", &s).as_deref(), Some("zh-CN"));
        assert_eq!(detect_app_lang("你好世界。", &s).as_deref(), Some("zh-CN"));
        assert_eq!(detect_app_lang("Привет, мир! Как дела?", &s).as_deref(), Some("ru"));
        assert_eq!(detect_app_lang("مرحبا بالعالم، كيف حالك؟", &s).as_deref(), Some("ar"));
    }

    /// 繁体按简体处理（模型只有简体 token）。
    #[test]
    fn traditional_chinese_is_zh_cn() {
        assert_eq!(detect_app_lang("你好，歡迎來到這個世界。", &six()).as_deref(), Some("zh-CN"));
    }

    /// 不在支持集内的语言（如德语、日语）视为无法识别。
    #[test]
    fn unsupported_language_is_none() {
        let s = six();
        assert_eq!(detect_app_lang("Das ist ein sehr schönes Haus, das wir gestern gesehen haben.", &s), None);
        assert_eq!(detect_app_lang("Obrigado pela ajuda de ontem.", &s), None);
        assert_eq!(detect_app_lang("こんにちは、世界。今日はいい天気ですね。", &s), None);
    }

    /// 太短、符号、数字、表情、网址：无法识别。
    #[test]
    fn junk_is_none() {
        let s = six();
        for t in ["", "   ", "12345", "!!!", "😀😀😀", "?!", "3.14159", "a", "ok", "https://example.com/a/b?c=1", "$100 + $200 = $300"] {
            assert_eq!(detect_app_lang(t, &s), None, "输入 {t:?}");
        }
    }

    /// 支持集大小写不敏感，返回支持集里的原写法。
    #[test]
    fn supported_is_case_insensitive() {
        let s = vec!["ZH-cn".to_string()];
        assert_eq!(detect_app_lang("你好，世界。", &s).as_deref(), Some("ZH-cn"));
    }

    /// 混排分句后各自识别；与目标同语言的句子保留；汇总去重并标记无法识别。
    #[test]
    fn classify_mixed_and_summarize() {
        use super::super::text::split_sentences;
        let s = six();
        let segs = split_sentences("Good morning, everyone. 你好世界。 😀😀! 你好，世界。");
        let kinds = classify_segments(&segs, &s, "fr");
        assert_eq!(kinds[0], SegLang::Translate("en".into()));
        assert_eq!(kinds[1], SegLang::Translate("zh-CN".into()));
        assert_eq!(kinds[2], SegLang::Unknown);
        let (detected, unrecognized) = summarize(&kinds);
        assert_eq!(detected, vec!["en".to_string(), "zh-CN".to_string()]);
        assert!(unrecognized);
        // 目标与识别结果相同：保留，不算无法识别
        let kinds = classify_segments(&split_sentences("Bonjour le monde."), &s, "fr");
        assert_eq!(kinds, vec![SegLang::Keep("fr".into())]);
        assert_eq!(summarize(&kinds), (vec!["fr".to_string()], false));
        // 全部无法识别
        let kinds = classify_segments(&split_sentences("😀😀😀"), &s, "en");
        assert_eq!(summarize(&kinds), (vec![], true));
    }

    /// is_auto 大小写不敏感。
    #[test]
    fn auto_flag() {
        assert!(is_auto("auto") && is_auto("AUTO"));
        assert!(!is_auto("en"));
    }
}
