//! 序列到序列推理后端抽象：编码一次、逐步解码、KV 缓存管理与束重排。
//!
//! 引擎（`engine`）的编排——分句、分块、贪心/束搜索、语言码强制、引号包裹法、后处理——只依赖这个 trait，
//! 不碰任何具体推理库。ORT 的 merged decoder 与 MNN 的三图拆分各是一个实现。
//!
//! 一次解码的调用顺序：`begin`（编码 + 准备 KV）→ 反复 `step`（跑解码器一步）→ `commit`（把本步产生的 KV 并入状态，
//! 束搜索在此按父束重排）。贪心遇到结束符时不必 `commit`，直接丢弃会话。

use super::error::TranslateError;

/// 一步解码的 logits：每行（每条束）取最后一个位置，行主序。
#[derive(Debug, Clone, PartialEq)]
pub struct StepLogits {
    /// 展平的 `[行数, vocab]`。
    pub data: Vec<f32>,
    /// 词表大小（每行长度）。
    pub vocab: usize,
}

impl StepLogits {
    /// 取第 `i` 行（第 `i` 条束）的词表 logits。
    ///
    /// # 参数
    /// - `i`：行下标，需小于行数。
    ///
    /// # 返回
    /// 长度为 `vocab` 的切片。
    ///
    /// # 示例
    /// ```ignore
    /// let best = argmax_masked(logits.row(0), &banned);
    /// ```
    pub fn row(&self, i: usize) -> &[f32] {
        &self.data[i * self.vocab..(i + 1) * self.vocab]
    }
}

/// 从解码器的 logits 输出里取每行最后一个位置，拼成 [`StepLogits`]。
///
/// # 参数
/// - `data`：展平的 logits，形如 `[rows, seq, vocab]`（解码一步时 `seq` 为 1）。
/// - `vocab`：词表大小（最后一维）。
/// - `rows`：batch 行数。
///
/// # 返回
/// `vocab` 为 0 或数据不足 `rows × vocab` 个时返回 `None`。
///
/// # 示例
/// ```ignore
/// let l = last_position_logits(&data, 61796, 2).unwrap();
/// ```
pub fn last_position_logits(data: &[f32], vocab: usize, rows: usize) -> Option<StepLogits> {
    if vocab == 0 || rows == 0 || data.len() < vocab * rows {
        return None;
    }
    let stride = data.len() / rows;
    let mut out = Vec::with_capacity(rows * vocab);
    for b in 0..rows {
        let row = &data[b * stride..(b + 1) * stride];
        out.extend_from_slice(&row[row.len() - vocab..]);
    }
    Some(StepLogits { data: out, vocab })
}

/// 序列到序列推理后端。
///
/// 实现需保证：`step` 的 `tokens` 行数等于 `begin` 的 `rows`；首步（`step == 0`）自注意力 KV 为空，
/// 交叉注意力 KV 在首步（ORT）或 `begin`（MNN）产生后整句不变；`commit` 的 `reorder[i]` 表示新第 `i` 行来自旧第 `reorder[i]` 行。
pub trait Seq2SeqRunner {
    /// 一次解码的会话状态（编码器输出、KV 缓存等），一句话一个。
    type Session;

    /// 编码一段输入并准备解码状态。
    ///
    /// # 参数
    /// - `input_ids`：编码器输入 id（含源语言码与结束符）。
    /// - `rows`：解码 batch 行数（贪心 1，束搜索为束宽）。
    ///
    /// # 返回
    /// 新的会话；推理失败返回 `DecodeFailed`/`OutOfMemory`。
    fn begin(&mut self, input_ids: &[u32], rows: usize) -> Result<Self::Session, TranslateError>;

    /// 解码一步。
    ///
    /// # 参数
    /// - `session`：[`Seq2SeqRunner::begin`] 返回的会话。
    /// - `step`：从 0 起的步序号（0 为强制语言码的那一步）。
    /// - `tokens`：每行当前输入 token（长度等于 `rows`）。
    /// - `want_logits`：为 `false` 时可不取 logits（强制步用不到）。
    ///
    /// # 返回
    /// `want_logits` 为真时返回每行最后位置的 logits；本步产生的 KV 暂存在会话里，等 [`Seq2SeqRunner::commit`]。
    fn step(
        &mut self,
        session: &mut Self::Session,
        step: usize,
        tokens: &[i64],
        want_logits: bool,
    ) -> Result<Option<StepLogits>, TranslateError>;

    /// 把本步暂存的 KV 并入会话；束搜索传 `reorder` 按父束重排 batch 维。
    ///
    /// # 参数
    /// - `session`：会话。
    /// - `step`：刚跑完的步序号（与 `step` 调用一致）。
    /// - `reorder`：`Some(父束下标)` 时重排自注意力 KV；`None` 原样采用。
    fn commit(
        &mut self,
        session: &mut Self::Session,
        step: usize,
        reorder: Option<&[usize]>,
    ) -> Result<(), TranslateError>;

    /// 一次翻译请求结束后的内存收缩；缺省什么都不做。
    fn trim_memory(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 行切片按词表大小分块。
    #[test]
    fn step_logits_rows() {
        let l = StepLogits { data: vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0], vocab: 3 };
        assert_eq!(l.row(0), &[1.0, 2.0, 3.0]);
        assert_eq!(l.row(1), &[4.0, 5.0, 6.0]);
    }

    /// 每行取最后一个位置：序列长 2、词表 2、两行。
    #[test]
    fn last_position_takes_tail_of_each_row() {
        let data = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        let l = last_position_logits(&data, 2, 2).unwrap();
        assert_eq!(l, StepLogits { data: vec![3.0, 4.0, 7.0, 8.0], vocab: 2 });
        // 数据不足 / 词表为 0 / 行数为 0
        assert!(last_position_logits(&data[..3], 2, 2).is_none());
        assert!(last_position_logits(&data, 0, 2).is_none());
        assert!(last_position_logits(&data, 2, 0).is_none());
    }
}
