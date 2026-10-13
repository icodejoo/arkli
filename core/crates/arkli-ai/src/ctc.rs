//! CTC 贪心解码 + 字典映射。

use crate::error::{AiError, Result};

/// blank 的类别下标（PP-OCR 约定为 0）。
pub const CTC_BLANK_INDEX: usize = 0;
/// 开启 `use_space` 时追加到字典末尾的空格字符。
pub const SPACE_CHAR: &str = " ";

/// CTC 解码器。类别下标 0 是 blank，其后依次是字典每一行，可选末尾再加一个空格。
#[derive(Debug, Clone, PartialEq)]
pub struct CtcDecoder {
    /// 下标 -> 字符；下标 0 为 blank，占位用空串
    chars: Vec<String>,
}

impl CtcDecoder {
    /// 从字典文本构建（一行一个字符，如 `ppocrv5_dict.txt`）。
    ///
    /// - `dict_text`：字典全文
    /// - `use_space`：是否在末尾追加空格字符（PP-OCR 的 `use_space_char`）
    ///
    /// ```
    /// use arkli_ai::ctc::CtcDecoder;
    /// let d = CtcDecoder::from_dict_text("a\nb\nc\n", false).unwrap();
    /// assert_eq!(d.num_classes(), 4);
    /// ```
    pub fn from_dict_text(dict_text: &str, use_space: bool) -> Result<Self> {
        let mut chars = vec![String::new()];
        chars.extend(dict_text.lines().map(str::to_string));
        if chars.len() == 1 {
            return Err(AiError::InvalidConfig("字典为空".into()));
        }
        if use_space {
            chars.push(SPACE_CHAR.to_string());
        }
        Ok(Self { chars })
    }

    /// 类别总数（含 blank），应等于识别模型输出的最后一维。
    pub fn num_classes(&self) -> usize {
        self.chars.len()
    }

    /// 贪心解码：每个时间步取概率最大的类别，合并相邻重复，去掉 blank。
    ///
    /// - `probs`：行优先 `[steps, classes]`
    /// - `steps` / `classes`：时间步数、类别数，`classes` 必须等于 [`CtcDecoder::num_classes`]
    /// - 返回：（文本，置信度）；置信度是被保留时间步最大概率的平均值，无字符时为 0
    ///
    /// 重复规则：连续相同类别只算一次，中间隔了 blank 才算两个，例如 `a a blank a` -> `aa`。
    ///
    /// ```
    /// use arkli_ai::ctc::CtcDecoder;
    /// let d = CtcDecoder::from_dict_text("a\nb", false).unwrap();
    /// // 3 类（blank, a, b），4 步：a a blank b
    /// let p = [
    ///     0.0, 1.0, 0.0,
    ///     0.0, 1.0, 0.0,
    ///     1.0, 0.0, 0.0,
    ///     0.0, 0.0, 1.0,
    /// ];
    /// let (text, score) = d.decode(&p, 4, 3).unwrap();
    /// assert_eq!(text, "ab");
    /// assert_eq!(score, 1.0);
    /// ```
    pub fn decode(&self, probs: &[f32], steps: usize, classes: usize) -> Result<(String, f32)> {
        if classes != self.chars.len() {
            return Err(AiError::BadModelOutput(format!(
                "识别输出类别数 {classes} 与字典（含 blank）{} 不符",
                self.chars.len()
            )));
        }
        if probs.len() != steps * classes {
            return Err(AiError::BadModelOutput(format!(
                "识别输出长度 {} 与 {steps}x{classes} 不符",
                probs.len()
            )));
        }
        let mut text = String::new();
        let (mut sum, mut kept) = (0.0f32, 0u32);
        let mut prev = CTC_BLANK_INDEX;
        for row in probs.chunks_exact(classes) {
            let (idx, p) = row
                .iter()
                .enumerate()
                .fold(
                    (0usize, f32::MIN),
                    |best, (i, &v)| if v > best.1 { (i, v) } else { best },
                );
            if idx != CTC_BLANK_INDEX && idx != prev {
                text.push_str(&self.chars[idx]);
                sum += p;
                kept += 1;
            }
            prev = idx;
        }
        let score = if kept == 0 { 0.0 } else { sum / kept as f32 };
        Ok((text, score))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把类别序列变成 one-hot 概率矩阵（峰值概率可指定）。
    fn onehot(seq: &[usize], classes: usize, peak: f32) -> Vec<f32> {
        let mut v = vec![0.0; seq.len() * classes];
        for (t, &c) in seq.iter().enumerate() {
            v[t * classes + c] = peak;
        }
        v
    }

    fn dec() -> CtcDecoder {
        CtcDecoder::from_dict_text("a\nb\nc\r\n", false).unwrap()
    }

    #[test]
    fn 相邻重复合并() {
        let p = onehot(&[1, 1, 1, 2, 2], 4, 0.9);
        let (t, s) = dec().decode(&p, 5, 4).unwrap();
        assert_eq!(t, "ab");
        assert!((s - 0.9).abs() < 1e-6);
    }

    #[test]
    fn blank隔开的重复保留() {
        let p = onehot(&[1, 0, 1, 3], 4, 0.8);
        assert_eq!(dec().decode(&p, 4, 4).unwrap().0, "aac");
    }

    #[test]
    fn 全是blank得空串和零分() {
        let p = onehot(&[0, 0, 0], 4, 1.0);
        assert_eq!(dec().decode(&p, 3, 4).unwrap(), (String::new(), 0.0));
    }

    #[test]
    fn 置信度取保留步平均() {
        let mut p = onehot(&[1, 2], 4, 0.0);
        p[1] = 0.6;
        p[4 + 2] = 0.8;
        let (t, s) = dec().decode(&p, 2, 4).unwrap();
        assert_eq!(t, "ab");
        assert!((s - 0.7).abs() < 1e-6);
    }

    #[test]
    fn 空格字符追加在末尾() {
        let d = CtcDecoder::from_dict_text("a\nb", true).unwrap();
        assert_eq!(d.num_classes(), 4);
        let p = onehot(&[1, 3, 2], 4, 1.0);
        assert_eq!(d.decode(&p, 3, 4).unwrap().0, "a b");
    }

    #[test]
    fn 字典与输出不匹配报错() {
        assert!(dec().decode(&[0.0; 10], 2, 5).is_err());
        assert!(dec().decode(&[0.0; 7], 2, 4).is_err());
        assert!(CtcDecoder::from_dict_text("", true).is_err());
    }
}
