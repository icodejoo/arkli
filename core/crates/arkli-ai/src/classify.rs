//! 零样本分类：图像向量与词表向量做余弦相似度，给出 top-k 物品与按分类聚合的概率。全是纯函数。
//!
//! ## 词表向量文件格式（`garbage_vocab.f16`）
//! - 小端 fp16，行优先，`count x dim`，无文件头；每行已 L2 归一化（加载时会再归一化一次，容忍 fp16 误差）。
//! - 条目元数据（id、中英文名、分类）在同名 JSON 里，由原生侧解析后连同字节一起传入，Rust 不解析 JSON。
//! - 生成方式见仓库 `tools/ai-vocab/`。
//!
//! ## 算法
//! 1. 每个条目的得分 = 图像向量与词表向量的余弦（两边都已归一化，即点积）。
//! 2. 物品 top-k 按余弦从大到小。
//! 3. 分类概率 = 对所有条目做 `softmax(温度 * 余弦)`，再按分类求和；置信度 = 最大的分类概率。
//! 4. 置信度低于阈值视为“拿不准”。

use crate::clip::{l2_normalize, ClipEncoder};
use crate::error::{AiError, Result};
use crate::image::RawImage;

/// softmax 温度（CLIP 类模型的 logit scale 约 100）。
pub const DEFAULT_TEMPERATURE: f32 = 100.0;
/// 聚合置信度低于该值视为“拿不准”。
pub const DEFAULT_UNCERTAIN_THRESHOLD: f32 = 0.8;
/// 默认返回的物品数。
pub const DEFAULT_TOP_K: usize = 3;

/// 词表条目的元数据。
#[derive(Debug, Clone, PartialEq)]
pub struct VocabEntry {
    /// 稳定 id，如 `milk_carton`
    pub id: String,
    /// 中文名
    pub name_zh: String,
    /// 英文名
    pub name_en: String,
    /// 分类代码（不透明字符串，如 `R`）
    pub category: String,
}

/// 词表：条目元数据 + 已归一化的向量矩阵。
#[derive(Debug, Clone)]
pub struct Vocab {
    /// 条目，与向量行一一对应
    entries: Vec<VocabEntry>,
    /// 向量维度
    dim: usize,
    /// `entries.len() x dim` 行优先
    vectors: Vec<f32>,
    /// 去重后的分类，按首次出现顺序
    categories: Vec<String>,
}

/// fp16（IEEE 754 半精度）位模式转 f32，含次正规数、无穷与 NaN。
///
/// ```
/// use arkli_ai::classify::f16_to_f32;
/// assert_eq!(f16_to_f32(0x3C00), 1.0);
/// assert_eq!(f16_to_f32(0xC000), -2.0);
/// ```
pub fn f16_to_f32(h: u16) -> f32 {
    let sign = ((h >> 15) & 1) as u32;
    let exp = ((h >> 10) & 0x1F) as u32;
    let man = (h & 0x3FF) as u32;
    let bits = if exp == 0 {
        if man == 0 {
            sign << 31
        } else {
            // 次正规数：规格化
            let mut e = 127 - 15 + 1;
            let mut m = man;
            while m & 0x400 == 0 {
                m <<= 1;
                e -= 1;
            }
            (sign << 31) | (e << 23) | ((m & 0x3FF) << 13)
        }
    } else if exp == 0x1F {
        (sign << 31) | (0xFF << 23) | (man << 13)
    } else {
        (sign << 31) | ((exp + 127 - 15) << 23) | (man << 13)
    };
    f32::from_bits(bits)
}

impl Vocab {
    /// 从条目与 fp16 小端字节构造词表。
    ///
    /// - `entries`：条目元数据，不能为空
    /// - `dim`：向量维度，大于 0
    /// - `f16le`：长度必须是 `entries.len() * dim * 2`
    /// - 出错：长度对不上、含 NaN/Inf 或零向量时返回 [`AiError::InvalidConfig`]
    pub fn from_f16le(entries: Vec<VocabEntry>, dim: usize, f16le: &[u8]) -> Result<Self> {
        if entries.is_empty() || dim == 0 {
            return Err(AiError::InvalidConfig("词表为空或维度为 0".into()));
        }
        let expect = entries.len() * dim * 2;
        if f16le.len() != expect {
            return Err(AiError::InvalidConfig(format!(
                "词表向量字节数 {} 与 {} 条 x {dim} 维不符，应为 {expect}",
                f16le.len(),
                entries.len()
            )));
        }
        let mut vectors: Vec<f32> = f16le
            .chunks_exact(2)
            .map(|b| f16_to_f32(u16::from_le_bytes([b[0], b[1]])))
            .collect();
        for (i, row) in vectors.chunks_exact_mut(dim).enumerate() {
            l2_normalize(row)
                .map_err(|e| AiError::InvalidConfig(format!("词表第 {i} 行向量不合法：{e}")))?;
        }
        let mut categories: Vec<String> = Vec::new();
        for e in &entries {
            if !categories.contains(&e.category) {
                categories.push(e.category.clone());
            }
        }
        Ok(Self {
            entries,
            dim,
            vectors,
            categories,
        })
    }

    /// 条目数。
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 是否为空（构造时已禁止，保留给 clippy 惯例）。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 向量维度。
    pub fn dim(&self) -> usize {
        self.dim
    }

    /// 取第 `i` 个条目。
    pub fn entry(&self, i: usize) -> &VocabEntry {
        &self.entries[i]
    }

    /// 全部分类代码，按首次出现顺序。
    pub fn categories(&self) -> &[String] {
        &self.categories
    }
}

/// 分类参数。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClassifyOptions {
    /// 返回的物品数，至少 1
    pub top_k: usize,
    /// softmax 温度
    pub temperature: f32,
    /// 聚合置信度低于它视为“拿不准”
    pub uncertain_threshold: f32,
}

impl Default for ClassifyOptions {
    fn default() -> Self {
        Self {
            top_k: DEFAULT_TOP_K,
            temperature: DEFAULT_TEMPERATURE,
            uncertain_threshold: DEFAULT_UNCERTAIN_THRESHOLD,
        }
    }
}

/// 一个命中的物品。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ItemHit {
    /// 词表下标
    pub index: usize,
    /// 图像与该条目的余弦相似度
    pub score: f32,
}

/// 一个分类的聚合概率。
#[derive(Debug, Clone, PartialEq)]
pub struct CategoryProb {
    /// 分类代码
    pub category: String,
    /// 概率，所有分类之和为 1
    pub prob: f32,
}

/// 分类结果。
#[derive(Debug, Clone, PartialEq)]
pub struct Classification {
    /// top-k 物品，按余弦从大到小
    pub items: Vec<ItemHit>,
    /// 全部分类的概率，从大到小
    pub categories: Vec<CategoryProb>,
    /// 最大的分类概率
    pub confidence: f32,
    /// 置信度低于阈值
    pub uncertain: bool,
}

/// 对一个图像向量做分类。
///
/// - `image`：图像向量，维度必须等于词表维度；内部会再归一化（不修改入参）
/// - `vocab`：词表
/// - `opts`：top-k、温度、阈值
/// - 出错：维度不符或向量不合法
///
/// ```
/// use arkli_ai::classify::*;
/// let e = |id: &str, c: &str| VocabEntry { id: id.into(), name_zh: id.into(), name_en: id.into(), category: c.into() };
/// // 两个正交条目，各存成 fp16：1.0 = 0x3C00
/// let one = 0x3C00u16.to_le_bytes();
/// let zero = 0u16.to_le_bytes();
/// let bytes = [one, zero, zero, one].concat();
/// let vocab = Vocab::from_f16le(vec![e("a", "R"), e("b", "D")], 2, &bytes).unwrap();
/// let r = classify(&[1.0, 0.0], &vocab, ClassifyOptions::default()).unwrap();
/// assert_eq!(r.items[0].index, 0);
/// assert_eq!(r.categories[0].category, "R");
/// ```
pub fn classify(image: &[f32], vocab: &Vocab, opts: ClassifyOptions) -> Result<Classification> {
    if image.len() != vocab.dim {
        return Err(AiError::InvalidConfig(format!(
            "图像向量维度 {} 与词表维度 {} 不符",
            image.len(),
            vocab.dim
        )));
    }
    let mut img = image.to_vec();
    l2_normalize(&mut img)?;
    let scores: Vec<f32> = vocab
        .vectors
        .chunks_exact(vocab.dim)
        .map(|row| row.iter().zip(&img).map(|(a, b)| a * b).sum())
        .collect();

    // top-k：按分数降序，同分按下标升序，结果稳定
    let mut order: Vec<usize> = (0..scores.len()).collect();
    order.sort_by(|&a, &b| scores[b].total_cmp(&scores[a]).then(a.cmp(&b)));
    let items = order
        .iter()
        .take(opts.top_k.max(1))
        .map(|&index| ItemHit {
            index,
            score: scores[index],
        })
        .collect();

    // softmax(温度 * 余弦)，减最大值保证数值稳定
    let max = scores.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let exps: Vec<f32> = scores
        .iter()
        .map(|s| ((s - max) * opts.temperature).exp())
        .collect();
    let total: f32 = exps.iter().sum();
    let mut categories: Vec<CategoryProb> = vocab
        .categories
        .iter()
        .map(|c| CategoryProb {
            category: c.clone(),
            prob: 0.0,
        })
        .collect();
    for (i, e) in exps.iter().enumerate() {
        let cat = &vocab.entries[i].category;
        if let Some(slot) = categories.iter_mut().find(|p| &p.category == cat) {
            slot.prob += e / total;
        }
    }
    // 稳定排序：同概率保持首次出现顺序
    categories.sort_by(|a, b| b.prob.total_cmp(&a.prob));
    let confidence = categories.first().map(|c| c.prob).unwrap_or(0.0);
    Ok(Classification {
        items,
        categories,
        confidence,
        uncertain: confidence < opts.uncertain_threshold,
    })
}

/// 端到端：一张图 -> 向量 -> 分类。编码器与词表由调用方持有并复用。
///
/// - `encoder`：已加载模型的编码器
/// - `vocab`：词表，维度必须与模型输出一致
/// - `img`：已解码像素（任意尺寸）
/// - `opts`：分类参数
pub fn classify_image(
    encoder: &mut ClipEncoder,
    vocab: &Vocab,
    img: &RawImage,
    opts: ClassifyOptions,
) -> Result<Classification> {
    let v = encoder.embed(img)?;
    classify(&v, vocab, opts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{Session, Tensor};
    use crate::image::PixelFormat;

    /// 返回固定向量的假会话。
    struct Fixed(Vec<f32>);

    impl Session for Fixed {
        fn run(&mut self, _i: Tensor) -> Result<Tensor> {
            unreachable!()
        }
        fn run_named(&mut self, _i: Tensor, _o: &str) -> Result<Tensor> {
            Tensor::new(vec![1, self.0.len() as i64], self.0.clone())
        }
    }

    #[test]
    fn 端到端串起编码与分类() {
        let v = vocab_of(&[("a", "R", [1.0, 0.0]), ("b", "D", [0.0, 1.0])]);
        let mut enc = ClipEncoder::new(Box::new(Fixed(vec![0.1, 2.0])));
        let img = RawImage::new(2, 2, PixelFormat::Rgb, vec![5; 12]).unwrap();
        let r = classify_image(&mut enc, &v, &img, ClassifyOptions::default()).unwrap();
        assert_eq!(v.entry(r.items[0].index).id, "b");
        assert_eq!(r.categories[0].category, "D");
        // 模型维度与词表不一致时报错
        let mut bad = ClipEncoder::new(Box::new(Fixed(vec![1.0, 2.0, 3.0])));
        assert!(classify_image(&mut bad, &v, &img, ClassifyOptions::default()).is_err());
    }

    /// f32 转 fp16 位模式（仅测试用，向零截断，足够造小整数与简单小数）。
    fn f32_to_f16(v: f32) -> u16 {
        let b = v.to_bits();
        let sign = ((b >> 16) & 0x8000) as u16;
        let exp = ((b >> 23) & 0xFF) as i32 - 127 + 15;
        let man = ((b >> 13) & 0x3FF) as u16;
        if v == 0.0 {
            return sign;
        }
        assert!(exp > 0 && exp < 31, "测试只造正规数");
        sign | ((exp as u16) << 10) | man
    }

    fn entry(id: &str, cat: &str) -> VocabEntry {
        VocabEntry {
            id: id.into(),
            name_zh: format!("{id}中"),
            name_en: id.into(),
            category: cat.into(),
        }
    }

    /// 由 f32 行构造词表字节。
    fn vocab_of(rows: &[(&str, &str, [f32; 2])]) -> Vocab {
        let mut bytes = Vec::new();
        let mut entries = Vec::new();
        for (id, cat, v) in rows {
            entries.push(entry(id, cat));
            for x in v {
                bytes.extend_from_slice(&f32_to_f16(*x).to_le_bytes());
            }
        }
        Vocab::from_f16le(entries, 2, &bytes).unwrap()
    }

    #[test]
    fn fp16转换覆盖特殊值() {
        assert_eq!(f16_to_f32(0x0000), 0.0);
        assert_eq!(f16_to_f32(0x3C00), 1.0);
        assert_eq!(f16_to_f32(0xBC00), -1.0);
        assert_eq!(f16_to_f32(0x3800), 0.5);
        assert_eq!(f16_to_f32(0x7BFF), 65504.0);
        assert_eq!(f16_to_f32(0x7C00), f32::INFINITY);
        assert!(f16_to_f32(0x7E00).is_nan());
        // 最小次正规数 2^-24
        assert_eq!(f16_to_f32(0x0001), 2f32.powi(-24));
        assert_eq!(f16_to_f32(0x8000).to_bits(), (-0.0f32).to_bits());
    }

    #[test]
    fn 词表校验长度与数值() {
        let e = vec![entry("a", "R")];
        assert!(Vocab::from_f16le(e.clone(), 2, &[0; 3]).is_err());
        assert!(Vocab::from_f16le(vec![], 2, &[]).is_err());
        assert!(Vocab::from_f16le(e.clone(), 0, &[]).is_err());
        // 零向量
        assert!(Vocab::from_f16le(e.clone(), 2, &[0; 4]).is_err());
        // NaN
        let nan = 0x7E00u16.to_le_bytes();
        let one = 0x3C00u16.to_le_bytes();
        assert!(Vocab::from_f16le(e, 2, &[nan, one].concat()).is_err());
    }

    #[test]
    fn 词表分类按首次出现去重() {
        let v = vocab_of(&[
            ("a", "R", [1.0, 0.0]),
            ("b", "D", [0.0, 1.0]),
            ("c", "R", [1.0, 1.0]),
        ]);
        assert_eq!(v.categories(), &["R".to_string(), "D".to_string()]);
        assert_eq!(v.len(), 3);
        assert_eq!(v.dim(), 2);
    }

    #[test]
    fn top_k按余弦降序且同分按下标() {
        let v = vocab_of(&[
            ("a", "R", [1.0, 0.0]),
            ("b", "D", [0.0, 1.0]),
            ("c", "R", [1.0, 1.0]),
            ("d", "D", [1.0, 0.0]),
        ]);
        let r = classify(&[1.0, 0.1], &v, ClassifyOptions::default()).unwrap();
        let idx: Vec<usize> = r.items.iter().map(|h| h.index).collect();
        // a 与 d 同向同分，下标小的在前；c 次之
        assert_eq!(idx, vec![0, 3, 2]);
        assert!(r.items[0].score >= r.items[1].score && r.items[1].score >= r.items[2].score);
        let one = classify(&[1.0, 0.1], &v, ClassifyOptions { top_k: 1, ..Default::default() }).unwrap();
        assert_eq!(one.items.len(), 1);
        // top_k 为 0 当作 1；超过条目数则全返回
        let zero = classify(&[1.0, 0.1], &v, ClassifyOptions { top_k: 0, ..Default::default() }).unwrap();
        assert_eq!(zero.items.len(), 1);
        let big = classify(&[1.0, 0.1], &v, ClassifyOptions { top_k: 99, ..Default::default() }).unwrap();
        assert_eq!(big.items.len(), 4);
    }

    #[test]
    fn 分类概率之和为一且按分类聚合() {
        let v = vocab_of(&[
            ("a", "R", [1.0, 0.0]),
            ("b", "R", [0.9, 0.1]),
            ("c", "D", [0.0, 1.0]),
        ]);
        let r = classify(&[1.0, 0.0], &v, ClassifyOptions::default()).unwrap();
        let sum: f32 = r.categories.iter().map(|c| c.prob).sum();
        assert!((sum - 1.0).abs() < 1e-5);
        assert_eq!(r.categories[0].category, "R");
        assert_eq!(r.confidence, r.categories[0].prob);
        assert!(r.confidence > 0.99);
        assert!(!r.uncertain);
    }

    #[test]
    fn 聚合优于单条目最大值() {
        // 两个 R 条目各自略低于 D 条目，但加起来胜出
        let v = vocab_of(&[
            ("r1", "R", [0.95, 0.31]),
            ("r2", "R", [0.95, -0.31]),
            ("d1", "D", [1.0, 0.0]),
        ]);
        let r = classify(&[1.0, 0.0], &v, ClassifyOptions { temperature: 10.0, ..Default::default() }).unwrap();
        assert_eq!(v.entry(r.items[0].index).id, "d1");
        assert_eq!(r.categories[0].category, "R");
    }

    #[test]
    fn 置信度阈值边界() {
        // 与两类条目等距：概率各 0.5
        let v = vocab_of(&[("a", "R", [1.0, 0.0]), ("b", "D", [0.0, 1.0])]);
        let img = [1.0, 1.0];
        let r = classify(&img, &v, ClassifyOptions::default()).unwrap();
        assert!((r.confidence - 0.5).abs() < 1e-3);
        assert!(r.uncertain);
        // 阈值降到 0.5 以下就不再拿不准
        let r2 = classify(&img, &v, ClassifyOptions { uncertain_threshold: 0.4, ..Default::default() }).unwrap();
        assert!(!r2.uncertain);
    }

    #[test]
    fn 图像向量会被归一化且维度必须匹配() {
        let v = vocab_of(&[("a", "R", [1.0, 0.0]), ("b", "D", [0.0, 1.0])]);
        let r = classify(&[10.0, 0.0], &v, ClassifyOptions::default()).unwrap();
        assert!((r.items[0].score - 1.0).abs() < 1e-3);
        assert!(classify(&[1.0], &v, ClassifyOptions::default()).is_err());
        assert!(classify(&[0.0, 0.0], &v, ClassifyOptions::default()).is_err());
    }
}
