//! 极短输入的“引号包裹法”纯逻辑（不依赖模型，可单测）。
//!
//! 现象：NLLB int4 对极短输入译文不准（你好→"You're all right."）。
//! 做法：给短词加固定前缀并用直引号包住（`这个词是："你好"`），翻译后只取第一对引号里的内容。
//! 长句、含引号/换行、不支持的语言一律不启用，由引擎回退到不加前缀的原路径。
//! 规则、阈值与实验证据见 `docs/design/ai-protocol.md 的“翻译页：超短输入处理”`。

use super::text::{is_cjk_lang, split_sentences};

/// zh-CN 源语言的前缀（以“：”结尾，不会被切句）。
pub const PREFIX_ZH: &str = "这个词是：";
/// en 源语言的前缀。
pub const PREFIX_EN: &str = "The word is: ";
/// 包裹用的直引号（弯引号实验中不稳定）。
const WRAP_QUOTE: char = '"';
/// 提取时认的引号：直引号与后处理产生的全角弯引号。
const QUOTE_CHARS: [char; 3] = ['"', '\u{201c}', '\u{201d}'];
/// 中文源语言码。
const LANG_ZH: &str = "zh-CN";
/// 英文语言码。
const LANG_EN: &str = "en";
/// zh 源语言启用的最大字数。
pub const MAX_ZH_CHARS: usize = 6;
/// en 源语言启用的最大词数。
pub const MAX_EN_WORDS: usize = 3;
/// 译文词数（中文按字）上限的下限值。
const MIN_OUTPUT_UNITS: usize = 6;
/// 译文词数上限相对原文的倍数。
const OUTPUT_UNITS_RATIO: usize = 4;
/// 重复 n-gram 判定的出现次数阈值。
const REPEAT_LIMIT: usize = 3;
/// 重复检测的最大 n。
const REPEAT_MAX_N: usize = 3;
/// 句末标点（中英文，含 `…`）。
const END_PUNCT: [char; 7] = ['.', '?', '!', '。', '？', '！', '…'];

/// 是否汉字（基本区）。
fn is_han(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

/// 去掉末尾的句末标点，返回主体。
fn strip_end_punct(s: &str) -> &str {
    s.trim_end_matches(|c| END_PUNCT.contains(&c))
}

/// 是否应对该片段走引号包裹路径。
///
/// # 参数
/// - `text`：单个片段原文（切句后恰为一段才可能启用）。
/// - `src_lang`：已确定的源语言（auto 时传该段识别结果）；只认 `zh-CN`/`en`。
/// - `tgt_lang`：目标语言，不能与源语言相同。
///
/// # 返回
/// 全部条件满足返回 `true`：单段、无引号/换行、主体无句内句末标点、长度在阈值内。
///
/// # 示例
/// ```ignore
/// assert!(should_wrap("你好！", "zh-CN", "en"));
/// assert!(!should_wrap("你好。再见", "zh-CN", "en"));
/// ```
pub fn should_wrap(text: &str, src_lang: &str, tgt_lang: &str) -> bool {
    let zh = src_lang.eq_ignore_ascii_case(LANG_ZH);
    if !(zh || src_lang.eq_ignore_ascii_case(LANG_EN)) || src_lang.eq_ignore_ascii_case(tgt_lang) {
        return false;
    }
    let text = text.trim();
    if text.is_empty()
        || text.contains(['\n', '\r'])
        || text.contains(QUOTE_CHARS)
        || split_sentences(text).len() != 1
    {
        return false;
    }
    let body = strip_end_punct(text);
    if body.is_empty() || body.contains(END_PUNCT) {
        return false;
    }
    if zh {
        body.chars().filter(|c| !c.is_whitespace()).count() <= MAX_ZH_CHARS
    } else {
        body.split_whitespace().count() <= MAX_EN_WORDS
    }
}

/// 给片段加前缀并用直引号包住。
///
/// # 参数
/// - `text`：片段原文。
/// - `src_lang`：源语言；非 zh-CN 时按 en 前缀。
///
/// # 返回
/// 形如 `这个词是："你好"`。
///
/// # 示例
/// ```ignore
/// assert_eq!(wrap("你好", "zh-CN"), "这个词是：\"你好\"");
/// ```
pub fn wrap(text: &str, src_lang: &str) -> String {
    let prefix = if src_lang.eq_ignore_ascii_case(LANG_ZH) { PREFIX_ZH } else { PREFIX_EN };
    format!("{prefix}{WRAP_QUOTE}{}{WRAP_QUOTE}", text.trim())
}

/// 一段文本的“单位数”：含汉字按字数，否则按词数。
fn units(s: &str, by_char: bool) -> usize {
    if by_char {
        s.chars().filter(|c| c.is_alphanumeric()).count()
    } else {
        s.split_whitespace().count()
    }
}

/// 序列里是否有出现次数达到阈值的 n-gram（n 取 `min_n..=REPEAT_MAX_N`）。
fn has_repeat<T: PartialEq>(items: &[T], min_n: usize) -> bool {
    (min_n..=REPEAT_MAX_N).any(|n| {
        items.windows(n).enumerate().any(|(i, w)| {
            items.windows(n).skip(i).filter(|v| *v == w).count() >= REPEAT_LIMIT
        })
    })
}

/// 从包裹后的译文里取出第一对引号中的内容，并做可信度检查。
///
/// # 参数
/// - `output`：对 `wrap()` 结果的译文（已做标点后处理，引号可能是直引号或全角弯引号）。
/// - `tgt_lang`：目标语言；`en` 时首字母大写。
/// - `x`：包裹前的原文，用来估算长度上限。
///
/// # 返回
/// 通过检查返回内容；无闭合引号、空内容、非中文目标仍含汉字、重复 n-gram 达 3 次、
/// 词数（中文按字）超过 `max(6, 4 × 原文单位数)` 时返回 `None`，调用方应回退到不加前缀的翻译。
///
/// # 示例
/// ```ignore
/// assert_eq!(extract_wrapped("This word is: \"hello\"", "en", "你好"), Some("Hello".into()));
/// ```
pub fn extract_wrapped(output: &str, tgt_lang: &str, x: &str) -> Option<String> {
    let mut quotes = output.char_indices().filter(|(_, c)| QUOTE_CHARS.contains(c));
    let (open, oc) = quotes.next()?;
    let (close, _) = quotes.next()?;
    let content = output[open + oc.len_utf8()..close].trim();
    if content.is_empty() {
        return None;
    }
    let cjk_target = is_cjk_lang(tgt_lang);
    if !cjk_target && content.chars().any(is_han) {
        return None;
    }
    let tokens: Vec<String> = if cjk_target {
        content.chars().filter(|c| c.is_alphanumeric()).map(String::from).collect()
    } else {
        content
            .split_whitespace()
            .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
            .filter(|w| !w.is_empty())
            .collect()
    };
    // 中文逐字时单字连写（谢谢）很常见，只查 2~3 字的重复
    if has_repeat(&tokens, if cjk_target { 2 } else { 1 }) {
        return None;
    }
    let x_units = units(x, x.chars().any(is_han)).max(1);
    if units(content, cjk_target) > MIN_OUTPUT_UNITS.max(OUTPUT_UNITS_RATIO * x_units) {
        return None;
    }
    if tgt_lang.eq_ignore_ascii_case(LANG_EN) {
        let mut cs = content.chars();
        let first = cs.next()?;
        return Some(first.to_uppercase().chain(cs).collect());
    }
    Some(content.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前缀常量内容固定（验证过的写法，不可随意改动）。
    #[test]
    fn prefix_constants_are_fixed() {
        assert_eq!(PREFIX_ZH, "这个词是：");
        assert_eq!(PREFIX_EN, "The word is: ");
        assert_eq!(wrap("你好", "zh-CN"), "这个词是：\"你好\"");
        assert_eq!(wrap("Thank you", "en"), "The word is: \"Thank you\"");
        assert_eq!(wrap("你好！", "ZH-cn"), "这个词是：\"你好！\"");
    }

    /// 前缀以“：”结尾，包裹后仍是单段。
    #[test]
    fn wrapped_text_is_single_segment() {
        for (t, l) in [("你好！", "zh-CN"), ("Hello", "en"), ("好吗？", "zh-CN")] {
            assert_eq!(split_sentences(&wrap(t, l)).len(), 1, "{t}");
        }
    }

    /// 适用条件：通过的情形。
    #[test]
    fn should_wrap_accepts_short_phrases() {
        assert!(should_wrap("你好", "zh-CN", "en"));
        assert!(should_wrap("你好！", "zh-CN", "en"));
        assert!(should_wrap("好吗？", "zh-CN", "en"));
        assert!(should_wrap("你好世界啊啊", "zh-CN", "en")); // 恰 6 字
        assert!(should_wrap("Hello", "en", "zh-CN"));
        assert!(should_wrap("Thank you very", "EN", "zh-cn")); // 恰 3 词
        assert!(should_wrap("你好", "zh-CN", "fr"));
    }

    /// 适用条件：各个不通过的分支。
    #[test]
    fn should_wrap_rejects_other_cases() {
        assert!(!should_wrap("你好。再见", "zh-CN", "en"), "切句多段");
        assert!(!should_wrap("Hi. Bye", "en", "zh-CN"), "切句多段(en)");
        assert!(!should_wrap("他说\"你好\"", "zh-CN", "en"), "直引号");
        assert!(!should_wrap("“你好”", "zh-CN", "en"), "弯引号");
        assert!(!should_wrap("你\n好", "zh-CN", "en"), "换行");
        assert!(!should_wrap("你好世界啊啊啊", "zh-CN", "en"), "7 字过长");
        assert!(!should_wrap("one two three four", "en", "zh-CN"), "4 词过长");
        assert!(!should_wrap("Bonjour", "fr", "en"), "不支持的源语言");
        assert!(!should_wrap("Hola", "es", "zh-CN"), "不支持的源语言");
        assert!(!should_wrap("你好", "zh-CN", "zh-CN"), "目标等于源");
        assert!(!should_wrap("Hello", "en", "EN"), "目标等于源(大小写)");
        assert!(!should_wrap("", "en", "zh-CN"), "空");
        assert!(!should_wrap("！！", "zh-CN", "en"), "只有标点");
        assert!(!should_wrap("a? b", "en", "zh-CN"), "句内句末标点");
    }

    /// 提取：直引号、全角弯引号、首字母大写、中文目标不动。
    #[test]
    fn extract_basic() {
        assert_eq!(extract_wrapped("This word is: \"hello\"", "en", "你好"), Some("Hello".into()));
        assert_eq!(extract_wrapped("这个词是：“你好”", "zh-CN", "Hello"), Some("你好".into()));
        assert_eq!(extract_wrapped("这个词是：”你好“", "zh-CN", "Hello"), Some("你好".into()));
        assert_eq!(extract_wrapped("The word is \"  hello! \"", "en", "你好！"), Some("Hello!".into()));
        assert_eq!(extract_wrapped("Le mot est \"bonjour\"", "fr", "你好"), Some("bonjour".into()));
    }

    /// 提取：引号后还有尾巴先接受；多对引号只取第一对。
    #[test]
    fn extract_trailing_and_first_pair() {
        assert_eq!(extract_wrapped("The word is \"hello\" in English.", "en", "你好"), Some("Hello".into()));
        assert_eq!(extract_wrapped("a \"hi\" b \"there\"", "en", "你好"), Some("Hi".into()));
    }

    /// 回退：只开不闭、没有引号、空内容。
    #[test]
    fn extract_rejects_malformed() {
        assert_eq!(extract_wrapped("This word is: \"hello", "en", "你好"), None);
        assert_eq!(extract_wrapped("This word is hello", "en", "你好"), None);
        assert_eq!(extract_wrapped("This word is: \"\"", "en", "你好"), None);
        assert_eq!(extract_wrapped("This word is: \"  \"", "en", "你好"), None);
    }

    /// 回退：目标非中文却含汉字。
    #[test]
    fn extract_rejects_han_in_en() {
        assert_eq!(extract_wrapped("The word is: \"你好\"", "en", "你好"), None);
        // 中文目标含汉字是正常的
        assert_eq!(extract_wrapped("这个词是：“你好”", "zh-CN", "Hello"), Some("你好".into()));
    }

    /// 回退：重复 n-gram 达 3 次。
    #[test]
    fn extract_rejects_repeats() {
        assert_eq!(extract_wrapped("\"Hello, hello, hello\"", "en", "你好"), None);
        assert_eq!(extract_wrapped("\"a b a b a b\"", "en", "你好"), None);
        // 只出现 2 次可以
        assert_eq!(extract_wrapped("\"hello hello\"", "en", "你好"), Some("Hello hello".into()));
        assert_eq!(extract_wrapped("“哈哈哈哈哈”", "zh-CN", "Ha"), None);
        assert_eq!(extract_wrapped("“谢谢”", "zh-CN", "Thanks"), Some("谢谢".into()));
    }

    /// 回退：词数超过 max(6, 4×原文单位数)。
    #[test]
    fn extract_rejects_too_long() {
        // 原文 1 个汉字：上限 max(6, 4)=6
        assert_eq!(extract_wrapped("\"a b c d e f\"", "en", "好"), Some("A b c d e f".into()));
        assert_eq!(extract_wrapped("\"a b c d e f g\"", "en", "好"), None);
        // 原文 3 个汉字：上限 12
        let twelve = (1..=12).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ");
        assert!(extract_wrapped(&format!("\"{twelve}\""), "en", "你好吗").is_some());
        assert_eq!(extract_wrapped(&format!("\"{twelve} w13\""), "en", "你好吗"), None);
        // 中文目标按字：1 个英文词上限 6 字
        assert_eq!(extract_wrapped("“一二三四五六”", "zh-CN", "Hi"), Some("一二三四五六".into()));
        assert_eq!(extract_wrapped("“一二三四五六七”", "zh-CN", "Hi"), None);
    }
}
