//! 对联生成（uer/gpt2-chinese-couplet 的 MNN 版）：上联进、等长下联出。
//!
//! 模型是 GPT-2，字级分词（bert 词表，一行一个 token，行号即 id）；**无 KV cache，每生成一步整句重新前向**。
//! 序列 = `[CLS]` + 上联逐字 + `-`，末尾不加 `[SEP]`；输出只含最后一个位置的 logits（`[1, 1, vocab]`）。
//!
//! 等长约束：采样前逐位加掩码——上联该位是标点就只放行同一标点，否则只放行单个汉字（U+4E00..=U+9FFF），
//! 屏蔽 `[UNK]`、`[SEP]`、其他标点与英文数字；生成到与上联等长即停，不等 `[SEP]`。标点位直接填入，不跑前向。
//!
//! 纯逻辑（校验、分词、掩码、top-k 采样）与后端无关，可脱离模型单测；引擎 [`Couplet`] 只依赖 [`GraphSession`]。
//! 从目录加载（`model.mnn` + `vocab.txt` + `model.json`）见 [`crate::mnn::MnnRuntime::load_couplet`]。
//!
//! ```ignore
//! let rt = MnnRuntime::load("libarkli-mnn.so")?;
//! let mut c = rt.load_couplet(Path::new("/data/.../couplet-gpt2-mnn-w6"), 4)?;
//! let out = c.generate("春风送暖入屠苏", &CoupletOptions::default(), &CancelToken::new())?;
//! println!("{} ({} ms)", out.text, out.elapsed_ms);
//! ```

use std::collections::HashMap;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::backend::{GraphSession, GraphValue};
use crate::error::{AiError, Result};
use crate::task::CancelToken;

/// 上联最少字数（含标点）。
pub const MIN_UPPER_CHARS: usize = 1;
/// 上联最多字数（含标点）。
pub const MAX_UPPER_CHARS: usize = 14;
/// 允许在上联里出现、并要在下联同位照抄的标点。
pub const PUNCT: &str = "，。、；：！？,.;:!?";
/// 汉字范围（含两端）。
pub const HAN_RANGE: std::ops::RangeInclusive<char> = '\u{4E00}'..='\u{9FFF}';
/// 默认 top-k。
pub const DEFAULT_TOP_K: usize = 40;
/// top-k 上限。
pub const MAX_TOP_K: usize = 200;
/// 默认温度。
pub const DEFAULT_TEMPERATURE: f32 = 0.8;
/// 温度上限。
pub const MAX_TEMPERATURE: f32 = 2.0;
/// 模型输入名：词 id。
pub const INPUT_IDS: &str = "input_ids";
/// 模型输入名：位置 id。
pub const INPUT_POSITIONS: &str = "position_ids";
/// 模型输出名：最后位置的 logits。
pub const OUTPUT_LOGITS: &str = "logits";
/// 提示串里分隔上下联的字符。
pub const DASH: char = '-';
/// 取不到特殊 token 时的默认 id（bert 词表：`[UNK]`）。
pub const DEFAULT_UNK: u32 = 100;
/// 默认 `[CLS]` id。
pub const DEFAULT_CLS: u32 = 101;
/// 默认 `[SEP]` id（只用于屏蔽，不会生成）。
pub const DEFAULT_SEP: u32 = 102;
/// 默认分隔符 `-` 的 id。
pub const DEFAULT_DASH: u32 = 118;
/// 屏蔽用的负无穷。
const MASKED: f32 = f32::NEG_INFINITY;

/// 一次生成的采样参数。
///
/// ```
/// use arkli_ai::couplet::CoupletOptions;
/// let o = CoupletOptions { temperature: 0.0, ..Default::default() };
/// assert!(o.validate().is_ok());
/// ```
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CoupletOptions {
    /// 温度，0 表示贪心；范围 `0..=MAX_TEMPERATURE`
    pub temperature: f32,
    /// 只在概率最高的 k 个候选里采样；范围 `1..=MAX_TOP_K`
    pub top_k: usize,
    /// 随机种子；`None` 时取系统时间，给定则结果可复现
    pub seed: Option<u64>,
}

impl Default for CoupletOptions {
    /// 默认：top-k 40、温度 0.8、不定种子。
    fn default() -> Self {
        Self { temperature: DEFAULT_TEMPERATURE, top_k: DEFAULT_TOP_K, seed: None }
    }
}

impl CoupletOptions {
    /// 校验范围；越界返回 [`AiError::InvalidConfig`]。
    pub fn validate(&self) -> Result<()> {
        if !self.temperature.is_finite() || !(0.0..=MAX_TEMPERATURE).contains(&self.temperature) {
            return Err(AiError::InvalidConfig(format!("temperature 须在 0 到 {MAX_TEMPERATURE} 之间")));
        }
        if !(1..=MAX_TOP_K).contains(&self.top_k) {
            return Err(AiError::InvalidConfig(format!("topK 须在 1 到 {MAX_TOP_K} 之间")));
        }
        Ok(())
    }
}

/// 一次生成的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoupletOutput {
    /// 下联（与上联等长，标点位与上联相同）
    pub text: String,
    /// 本次生成耗时（毫秒，不含模型加载）
    pub elapsed_ms: u64,
}

/// 是否允许出现的标点。
pub fn is_punct(c: char) -> bool {
    PUNCT.contains(c)
}

/// 校验并切分上联。
///
/// - `up`：上联原文
/// - 返回：逐字（char）的向量；字数须在 1..=14，只允许汉字与 [`PUNCT`] 里的标点，且至少含一个汉字；
///   英文字母、数字、括号、空白等一律拒绝，返回 [`AiError::InvalidConfig`]（上层映射为 BAD_PARAMS）
///
/// ```
/// use arkli_ai::couplet::validate_upper;
/// assert_eq!(validate_upper("春风，化雨").unwrap().len(), 5);
/// assert!(validate_upper("abc").is_err());
/// assert!(validate_upper("").is_err());
/// ```
pub fn validate_upper(up: &str) -> Result<Vec<char>> {
    let chars: Vec<char> = up.chars().collect();
    if !(MIN_UPPER_CHARS..=MAX_UPPER_CHARS).contains(&chars.len()) {
        return Err(AiError::InvalidConfig(format!("上联须为 {MIN_UPPER_CHARS} 到 {MAX_UPPER_CHARS} 个字")));
    }
    for &c in &chars {
        if !HAN_RANGE.contains(&c) && !is_punct(c) {
            let why = if c.is_ascii_alphabetic() {
                "不能含英文字母"
            } else if c.is_ascii_digit() || c.is_numeric() {
                "不能含数字"
            } else if "()[]{}（）［］｛｝【】《》<>「」『』".contains(c) {
                "不能含括号"
            } else {
                "含不支持的字符"
            };
            return Err(AiError::InvalidConfig(format!("上联{why}：{c:?}")));
        }
    }
    if !chars.iter().any(|c| HAN_RANGE.contains(c)) {
        return Err(AiError::InvalidConfig("上联至少要有一个汉字".into()));
    }
    Ok(chars)
}

/// 下联某一位的约束。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    /// 上联该位是标点：只放行这个 token（即照抄）
    Punct(u32),
    /// 其余：只放行单个汉字 token
    Han,
}

/// 词表：按行号取 id 的字级分词与掩码所需的信息。
#[derive(Debug, Clone)]
pub struct CoupletVocab {
    /// 词表大小（= logits 维度）
    size: usize,
    /// 单字 token 到 id（重复时取先出现的）
    by_char: HashMap<char, u32>,
    /// 全部汉字 token 的 id，升序
    han_ids: Vec<u32>,
    /// `[UNK]`
    unk: u32,
    /// `[CLS]`
    cls: u32,
    /// 分隔符 `-`
    dash: u32,
}

impl CoupletVocab {
    /// 从 `vocab.txt` 全文构造：一行一个 token，行号即 id。
    ///
    /// - `text`：词表全文
    /// - `cls` / `unk` / `dash`：特殊 token 的 id（取自 `model.json`），须小于词表大小
    ///
    /// ```
    /// use arkli_ai::couplet::CoupletVocab;
    /// let v = CoupletVocab::parse("a\n春\n风\n", 0, 0, 1).unwrap();
    /// assert_eq!(v.size(), 3);
    /// ```
    pub fn parse(text: &str, cls: u32, unk: u32, dash: u32) -> Result<Self> {
        let mut by_char = HashMap::new();
        let mut han_ids = Vec::new();
        let mut size = 0usize;
        for (i, tok) in text.lines().enumerate() {
            size = i + 1;
            let mut it = tok.chars();
            if let (Some(c), None) = (it.next(), it.next()) {
                by_char.entry(c).or_insert(i as u32);
                if HAN_RANGE.contains(&c) {
                    han_ids.push(i as u32);
                }
            }
        }
        for (name, id) in [("cls", cls), ("unk", unk), ("dash", dash)] {
            if id as usize >= size {
                return Err(AiError::InvalidConfig(format!("词表只有 {size} 行，放不下 {name}={id}")));
            }
        }
        if han_ids.is_empty() {
            return Err(AiError::InvalidConfig("词表里没有汉字 token".into()));
        }
        Ok(Self { size, by_char, han_ids, unk, cls, dash })
    }

    /// 词表大小。
    pub fn size(&self) -> usize {
        self.size
    }

    /// 单字转 id，查不到记 `[UNK]`。
    pub fn id_of(&self, c: char) -> u32 {
        self.by_char.get(&c).copied().unwrap_or(self.unk)
    }

    /// 编码提示串：`[CLS]` + 上联逐字 + `-`，不加 `[SEP]`。
    ///
    /// ```
    /// use arkli_ai::couplet::CoupletVocab;
    /// let v = CoupletVocab::parse("[CLS]\n[UNK]\n春\n-\n", 0, 1, 3).unwrap();
    /// assert_eq!(v.encode_prompt(&['春', '龘']), vec![0, 2, 1, 3]);
    /// ```
    pub fn encode_prompt(&self, up: &[char]) -> Vec<u32> {
        let mut ids = Vec::with_capacity(up.len() + 2);
        ids.push(self.cls);
        ids.extend(up.iter().map(|&c| self.id_of(c)));
        ids.push(self.dash);
        ids
    }

    /// 按上联给下联逐位约束：标点位照抄，其余只放汉字。
    pub fn slots(&self, up: &[char]) -> Vec<Slot> {
        up.iter().map(|&c| if is_punct(c) { Slot::Punct(self.id_of(c)) } else { Slot::Han }).collect()
    }

    /// 对一位的 logits 应用掩码：不在放行集合里的全部置 `-inf`（原地）。
    ///
    /// - `logits`：长度须等于词表大小
    /// - `slot`：这一位的约束
    pub fn mask(&self, logits: &mut [f32], slot: Slot) {
        match slot {
            Slot::Punct(id) => {
                let keep = logits[id as usize];
                logits.fill(MASKED);
                logits[id as usize] = keep;
            }
            Slot::Han => {
                let mut out = vec![MASKED; logits.len()];
                for &i in &self.han_ids {
                    out[i as usize] = logits[i as usize];
                }
                logits.copy_from_slice(&out);
            }
        }
    }
}

/// 小型 xorshift64* 随机数，只用于采样；同种子序列一致。
///
/// ```
/// use arkli_ai::couplet::Rng;
/// let (mut a, mut b) = (Rng::new(7), Rng::new(7));
/// assert_eq!(a.next_f32(), b.next_f32());
/// ```
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    /// 用种子构造（0 会被换成固定非零常数，xorshift 不能为 0）。
    pub fn new(seed: u64) -> Self {
        Self(if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed })
    }

    /// 取系统时间做种子。
    pub fn from_time() -> Self {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
        Self::new(n)
    }

    /// 下一个 `[0, 1)` 的 f32。
    pub fn next_f32(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        let r = x.wrapping_mul(0x2545_F491_4F6C_DD1D);
        // 取高 24 位，恰好是 f32 的尾数精度
        (r >> 40) as f32 / (1u64 << 24) as f32
    }
}

/// 从（已掩码的）logits 里采一个 token。
///
/// - `logits`：被掩码的位置为 `-inf`，会被忽略
/// - `temperature`：0 为贪心（取最大，并列取 id 小的）
/// - `top_k`：只在 logit 最高的 k 个里按温度 softmax 抽样
/// - `rng`：随机源；贪心时不消耗
/// - 返回：选中的 id；没有任何可选项（全被屏蔽）返回 [`AiError::BadModelOutput`]
///
/// ```
/// use arkli_ai::couplet::{sample, Rng};
/// let l = [f32::NEG_INFINITY, 1.0, 3.0, 2.0];
/// assert_eq!(sample(&l, 0.0, 40, &mut Rng::new(1)).unwrap(), 2);
/// ```
pub fn sample(logits: &[f32], temperature: f32, top_k: usize, rng: &mut Rng) -> Result<u32> {
    let mut cand: Vec<(u32, f32)> = logits
        .iter()
        .enumerate()
        .filter(|(_, l)| l.is_finite())
        .map(|(i, &l)| (i as u32, l))
        .collect();
    if cand.is_empty() {
        return Err(AiError::BadModelOutput("掩码后没有可选 token".into()));
    }
    // 按 logit 降序，并列时 id 小的在前，贪心结果因此稳定
    cand.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    if temperature <= 0.0 || top_k <= 1 || cand.len() == 1 {
        return Ok(cand[0].0);
    }
    cand.truncate(top_k);
    let max = cand[0].1;
    let weights: Vec<f32> = cand.iter().map(|&(_, l)| ((l - max) / temperature).exp()).collect();
    let total: f32 = weights.iter().sum();
    let mut r = rng.next_f32() * total;
    for (&(id, _), w) in cand.iter().zip(&weights) {
        if r < *w {
            return Ok(id);
        }
        r -= w;
    }
    Ok(cand[cand.len() - 1].0)
}

/// 对联引擎：持有图会话与词表，可反复生成（会话复用）。
pub struct Couplet<G: GraphSession> {
    /// 图会话，输入 `input_ids` / `position_ids`，输出 `logits`
    graph: G,
    /// 词表
    vocab: CoupletVocab,
    /// id 到单字（汉字）的反查表，拼下联用
    rev: HashMap<u32, char>,
}

impl<G: GraphSession> Couplet<G> {
    /// 构造引擎。
    ///
    /// - `graph`：输入名须依次为 [`INPUT_IDS`]、[`INPUT_POSITIONS`]，输出里有 [`OUTPUT_LOGITS`]
    /// - `vocab`：词表
    pub fn new(graph: G, vocab: CoupletVocab) -> Result<Self> {
        let ins = graph.input_names();
        if ins.len() != 2 || ins[0] != INPUT_IDS || ins[1] != INPUT_POSITIONS {
            return Err(AiError::InvalidConfig(format!("对联图的输入应为 [{INPUT_IDS}, {INPUT_POSITIONS}]，实际 {ins:?}")));
        }
        if !graph.output_names().iter().any(|n| n == OUTPUT_LOGITS) {
            return Err(AiError::InvalidConfig(format!("对联图缺少输出 {OUTPUT_LOGITS}")));
        }
        let rev = vocab.by_char.iter().map(|(&c, &i)| (i, c)).collect();
        Ok(Self { graph, vocab, rev })
    }

    /// 取词表（测试与诊断用）。
    pub fn vocab(&self) -> &CoupletVocab {
        &self.vocab
    }

    /// 整句前向一次，返回最后位置的 logits（长度 = 词表大小）。
    fn forward(&mut self, ids: &[u32]) -> Result<Vec<f32>> {
        let n = ids.len() as i64;
        let id32: Vec<i32> = ids.iter().map(|&i| i as i32).collect();
        let pos: Vec<i32> = (0..ids.len() as i32).collect();
        let a = self.graph.value_i32(&[1, n], &id32)?;
        let b = self.graph.value_i32(&[1, n], &pos)?;
        let idx = self.graph.output_names().iter().position(|n| n == OUTPUT_LOGITS).unwrap_or(0);
        let outs = self.graph.run(&[&a, &b])?;
        let logits = outs
            .get(idx)
            .ok_or_else(|| AiError::BadModelOutput("没有 logits 输出".into()))?
            .to_f32()?;
        if logits.len() != self.vocab.size() {
            return Err(AiError::BadModelOutput(format!("logits 长度 {} 与词表 {} 不符", logits.len(), self.vocab.size())));
        }
        Ok(logits)
    }

    /// 生成下联。
    ///
    /// - `up`：上联（1~14 字，只含汉字与允许的标点，见 [`validate_upper`]）
    /// - `options`：采样参数
    /// - `cancel`：取消令牌，每一步前检查，已取消返回 [`AiError::Cancelled`]
    /// - 返回：与上联等长的下联（标点位与上联相同）与耗时；输入不合法返回 [`AiError::InvalidConfig`]
    ///
    /// ```ignore
    /// let out = engine.generate("春风送暖入屠苏", &CoupletOptions { temperature: 0.0, ..Default::default() }, &CancelToken::new())?;
    /// ```
    pub fn generate(&mut self, up: &str, options: &CoupletOptions, cancel: &CancelToken) -> Result<CoupletOutput> {
        options.validate()?;
        let chars = validate_upper(up)?;
        let t0 = Instant::now();
        let slots = self.vocab.slots(&chars);
        let mut ids = self.vocab.encode_prompt(&chars);
        let mut rng = options.seed.map_or_else(Rng::from_time, Rng::new);
        let mut text = String::new();
        for (&slot, &orig) in slots.iter().zip(&chars) {
            cancel.check()?;
            let id = match slot {
                // 标点位不用跑前向，直接照抄
                Slot::Punct(id) => id,
                Slot::Han => {
                    let mut logits = self.forward(&ids)?;
                    self.vocab.mask(&mut logits, slot);
                    sample(&logits, options.temperature, options.top_k, &mut rng)?
                }
            };
            ids.push(id);
            match slot {
                Slot::Punct(_) => text.push(orig),
                Slot::Han => text.push(
                    *self.rev.get(&id).ok_or_else(|| AiError::BadModelOutput(format!("token {id} 不是单字")))?,
                ),
            }
        }
        Ok(CoupletOutput { text, elapsed_ms: t0.elapsed().as_millis() as u64 })
    }
}

#[cfg(feature = "mnn-backend")]
pub use loader::{load_couplet_dir, CoupletManifest, FILE_MANIFEST};

/// 目录加载（依赖 serde_json，故放在 `mnn-backend` feature 下）。
#[cfg(feature = "mnn-backend")]
mod loader {
    use std::path::Path;

    use serde_json::Value;

    use super::*;
    use crate::mnn::{external_weight_path, MnnConfig, MnnNet, MnnRuntime};

    /// 清单文件名。
    pub const FILE_MANIFEST: &str = "model.json";
    /// 模型图文件名（旁边的 `.mnn.weight` 自动作为外置权重）。
    const FILE_MODEL: &str = "model.mnn";
    /// 词表文件名。
    const FILE_VOCAB: &str = "vocab.txt";
    /// 当前支持的清单版本。
    const SCHEMA_VERSION: u64 = 1;

    /// `model.json` 里引擎用得到的部分。
    #[derive(Debug, Clone, PartialEq)]
    pub struct CoupletManifest {
        /// 词表大小
        pub vocab_size: usize,
        /// `[CLS]` id
        pub cls: u32,
        /// `[UNK]` id
        pub unk: u32,
        /// `-` 的 id
        pub dash: u32,
    }

    /// 清单里取一个整数字段。
    fn num(v: &Value, path: &[&str]) -> Result<u64> {
        let mut cur = v;
        for k in path {
            cur = cur.get(*k).ok_or_else(|| AiError::InvalidConfig(format!("model.json 缺少 {}", path.join("."))))?;
        }
        cur.as_u64().ok_or_else(|| AiError::InvalidConfig(format!("model.json 的 {} 不是整数", path.join("."))))
    }

    impl CoupletManifest {
        /// 解析清单文本；`schema_version` 不符、字段缺失都返回 [`AiError::InvalidConfig`]。
        ///
        /// ```
        /// # #[cfg(feature = "mnn-backend")] {
        /// use arkli_ai::couplet::CoupletManifest;
        /// let m = CoupletManifest::parse(r#"{"schema_version":1,"tokenizer":{"vocab_size":5,"cls":1,"unk":2,"dash":3}}"#).unwrap();
        /// assert_eq!(m.vocab_size, 5);
        /// # }
        /// ```
        pub fn parse(text: &str) -> Result<Self> {
            let v: Value = serde_json::from_str(text).map_err(|e| AiError::InvalidConfig(format!("model.json 解析失败：{e}")))?;
            if num(&v, &["schema_version"])? != SCHEMA_VERSION {
                return Err(AiError::InvalidConfig("model.json 的 schema_version 不受支持".into()));
            }
            Ok(Self {
                vocab_size: num(&v, &["tokenizer", "vocab_size"])? as usize,
                cls: num(&v, &["tokenizer", "cls"])? as u32,
                unk: num(&v, &["tokenizer", "unk"])? as u32,
                dash: num(&v, &["tokenizer", "dash"])? as u32,
            })
        }
    }

    /// 从模型目录加载引擎：读清单与词表，MNN 加载 `model.mnn`（外置权重自动带上，memory=low）。
    ///
    /// - `rt`：MNN 运行时
    /// - `dir`：含 `model.mnn`、`model.mnn.weight`、`vocab.txt`、`model.json`
    /// - `threads`：线程数，0 视为默认 4
    pub fn load_couplet_dir(rt: &MnnRuntime, dir: &Path, threads: u32) -> Result<Couplet<MnnNet>> {
        let read = |name: &str| {
            std::fs::read_to_string(dir.join(name)).map_err(|e| AiError::InvalidConfig(format!("读取 {name} 失败：{e}")))
        };
        let manifest = CoupletManifest::parse(&read(FILE_MANIFEST)?)?;
        let vocab = CoupletVocab::parse(&read(FILE_VOCAB)?, manifest.cls, manifest.unk, manifest.dash)?;
        if vocab.size() != manifest.vocab_size {
            return Err(AiError::InvalidConfig(format!("词表 {} 行与清单 {} 不符", vocab.size(), manifest.vocab_size)));
        }
        let model = dir.join(FILE_MODEL);
        let weight = external_weight_path(&model);
        let cfg = MnnConfig::default().with_threads(threads);
        let net = rt.load_net(&model, weight.as_deref(), &[INPUT_IDS, INPUT_POSITIONS], &[OUTPUT_LOGITS], &cfg)?;
        Couplet::new(net, vocab)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 假值：只存 i32 或 f32 数据。
    struct Val {
        /// 形状
        shape: Vec<i64>,
        /// 数据
        data: Vec<f32>,
    }

    impl GraphValue for Val {
        fn shape(&self) -> Vec<i64> {
            self.shape.clone()
        }
        fn to_f32(&self) -> Result<Vec<f32>> {
            Ok(self.data.clone())
        }
        fn to_i32(&self) -> Result<Vec<i32>> {
            Ok(self.data.iter().map(|&x| x as i32).collect())
        }
    }

    /// 假图：logits 恒偏向“下一个 id = 当前序列长度对应的字”，并记录每次前向的序列长度。
    struct Fake {
        /// 输入名
        ins: Vec<String>,
        /// 输出名
        outs: Vec<String>,
        /// 词表大小
        size: usize,
        /// 每次前向收到的序列长度
        seen: Vec<usize>,
    }

    impl Fake {
        fn new(size: usize) -> Self {
            Self { ins: vec![INPUT_IDS.into(), INPUT_POSITIONS.into()], outs: vec![OUTPUT_LOGITS.into()], size, seen: vec![] }
        }
    }

    impl GraphSession for Fake {
        type Value = Val;
        fn input_names(&self) -> &[String] {
            &self.ins
        }
        fn output_names(&self) -> &[String] {
            &self.outs
        }
        fn value_f32(&self, shape: &[i64], data: &[f32]) -> Result<Val> {
            Ok(Val { shape: shape.to_vec(), data: data.to_vec() })
        }
        fn value_i32(&self, shape: &[i64], data: &[i32]) -> Result<Val> {
            Ok(Val { shape: shape.to_vec(), data: data.iter().map(|&x| x as f32).collect() })
        }
        fn run(&mut self, inputs: &[&Val]) -> Result<Vec<Val>> {
            let n = inputs[0].data.len();
            self.seen.push(n);
            // 序列越长，越偏向更靠后的汉字（词表里汉字从 id 5 起）；同时给标点与 [UNK] 一个最高分，检验掩码
            let mut l = vec![0.0f32; self.size];
            let favored = 5 + n;
            l[favored % self.size] = 5.0;
            l[1] = 100.0; // [UNK]
            l[4] = 100.0; // 标点 "，"，非标点位必须被屏蔽
            Ok(vec![Val { shape: vec![1, 1, self.size as i64], data: l }])
        }
    }

    /// 测试用词表：0 [PAD]、1 [UNK]、2 [CLS]、3 -、4 ，、5.. 汉字。
    fn vocab() -> CoupletVocab {
        let mut t = String::from("[PAD]\n[UNK]\n[CLS]\n-\n，\n");
        for c in "春风送暖入屠苏花开富贵人间好景".chars() {
            t.push(c);
            t.push('\n');
        }
        CoupletVocab::parse(&t, 2, 1, 3).unwrap()
    }

    #[test]
    fn 校验上联() {
        assert_eq!(validate_upper("春风送暖入屠苏").unwrap().len(), 7);
        assert!(validate_upper("春风，化雨。").is_ok());
        assert!(validate_upper("").is_err());
        assert!(validate_upper(&"春".repeat(15)).is_err());
        assert!(validate_upper(&"春".repeat(14)).is_ok());
        for bad in ["春abc", "春风2024", "春风（送暖）", "春风(送暖)", "春 风", "，。"] {
            assert!(validate_upper(bad).is_err(), "{bad}");
        }
        // 标点计入字数
        assert!(validate_upper(&format!("{}，", "春".repeat(14))).is_err());
    }

    #[test]
    fn 校验错误带原因() {
        assert!(validate_upper("春a").unwrap_err().to_string().contains("英文字母"));
        assert!(validate_upper("春1").unwrap_err().to_string().contains("数字"));
        assert!(validate_upper("春(").unwrap_err().to_string().contains("括号"));
    }

    #[test]
    fn 采样参数校验() {
        assert!(CoupletOptions::default().validate().is_ok());
        assert!(CoupletOptions { temperature: -0.1, ..Default::default() }.validate().is_err());
        assert!(CoupletOptions { temperature: f32::NAN, ..Default::default() }.validate().is_err());
        assert!(CoupletOptions { temperature: 2.5, ..Default::default() }.validate().is_err());
        assert!(CoupletOptions { top_k: 0, ..Default::default() }.validate().is_err());
        assert!(CoupletOptions { top_k: MAX_TOP_K + 1, ..Default::default() }.validate().is_err());
    }

    #[test]
    fn 分词按字查表且未知记unk() {
        let v = vocab();
        assert_eq!(v.encode_prompt(&['春', '龘']), vec![2, 5, 1, 3]);
        assert!(CoupletVocab::parse("a\nb\n", 0, 0, 5).is_err());
        assert!(CoupletVocab::parse("a\nb\n", 0, 0, 1).is_err(), "没有汉字");
    }

    #[test]
    fn 槽位标点照抄其余汉字() {
        let v = vocab();
        let s = v.slots(&['春', '，', '风']);
        assert_eq!(s, vec![Slot::Han, Slot::Punct(4), Slot::Han]);
    }

    #[test]
    fn 掩码只放行汉字或同一标点() {
        let v = vocab();
        let mut l = vec![1.0f32; v.size()];
        v.mask(&mut l, Slot::Han);
        // 特殊 token、标点被屏蔽，汉字保留
        assert!(l[..5].iter().all(|x| *x == f32::NEG_INFINITY));
        assert!(l[5..].iter().all(|x| *x == 1.0));
        let mut l = vec![1.0f32; v.size()];
        v.mask(&mut l, Slot::Punct(4));
        assert_eq!(l.iter().filter(|x| x.is_finite()).count(), 1);
        assert_eq!(l[4], 1.0);
    }

    #[test]
    fn 贪心取最大并列取小id() {
        let l = [f32::NEG_INFINITY, 2.0, 2.0, 1.0];
        assert_eq!(sample(&l, 0.0, 40, &mut Rng::new(1)).unwrap(), 1);
        assert!(sample(&[f32::NEG_INFINITY; 3], 0.0, 40, &mut Rng::new(1)).is_err());
    }

    #[test]
    fn topk限制候选范围() {
        let l = [10.0, 9.0, 8.0, 7.0];
        let mut rng = Rng::new(42);
        for _ in 0..200 {
            assert!(sample(&l, 1.5, 2, &mut rng).unwrap() < 2);
        }
        // top_k = 1 等价贪心
        assert_eq!(sample(&l, 1.5, 1, &mut Rng::new(3)).unwrap(), 0);
    }

    #[test]
    fn 同种子可复现且种子影响结果() {
        let l: Vec<f32> = (0..50).map(|i| (i % 7) as f32 * 0.1).collect();
        let run = |seed| {
            let mut r = Rng::new(seed);
            (0..20).map(|_| sample(&l, 1.0, 40, &mut r).unwrap()).collect::<Vec<_>>()
        };
        assert_eq!(run(5), run(5));
        assert_ne!(run(5), run(6));
        // 种子 0 不会卡死
        assert!(Rng::new(0).next_f32() < 1.0);
    }

    #[test]
    fn 引擎等长且标点位照抄且被屏蔽的id不会出现() {
        let mut c = Couplet::new(Fake::new(20), vocab()).unwrap();
        let opt = CoupletOptions { temperature: 0.0, ..Default::default() };
        let out = c.generate("春风，送暖。", &opt, &CancelToken::new()).unwrap();
        let chars: Vec<char> = out.text.chars().collect();
        assert_eq!(chars.len(), 6);
        assert_eq!(chars[2], '，');
        assert_eq!(chars[5], '。');
        // 非标点位都是汉字，没有选到分数最高的 [UNK] 与标点
        assert!(chars.iter().enumerate().filter(|(i, _)| *i != 2 && *i != 5).all(|(_, c)| HAN_RANGE.contains(c)));
    }

    #[test]
    fn 标点位不跑前向() {
        let mut c = Couplet::new(Fake::new(20), vocab()).unwrap();
        let opt = CoupletOptions { temperature: 0.0, ..Default::default() };
        c.generate("春，风。", &opt, &CancelToken::new()).unwrap();
        // 4 位里 2 个标点，只前向 2 次；序列长度 = [CLS] + 4 + '-' + 已生成数
        assert_eq!(c.graph.seen, vec![6, 8]);
    }

    #[test]
    fn 引擎同种子结果一致() {
        let opt = CoupletOptions { seed: Some(9), ..Default::default() };
        let run = || Couplet::new(Fake::new(20), vocab()).unwrap().generate("春风送暖", &opt, &CancelToken::new()).unwrap().text;
        assert_eq!(run(), run());
    }

    #[test]
    fn 取消与非法输入() {
        let mut c = Couplet::new(Fake::new(20), vocab()).unwrap();
        let t = CancelToken::new();
        t.cancel();
        assert_eq!(c.generate("春风", &CoupletOptions::default(), &t), Err(AiError::Cancelled));
        assert!(matches!(c.generate("abc", &CoupletOptions::default(), &CancelToken::new()), Err(AiError::InvalidConfig(_))));
        let bad = CoupletOptions { top_k: 0, ..Default::default() };
        assert!(matches!(c.generate("春风", &bad, &CancelToken::new()), Err(AiError::InvalidConfig(_))));
    }

    #[test]
    fn 引擎校验输入输出名与logits长度() {
        let mut f = Fake::new(20);
        f.ins = vec!["x".into()];
        assert!(Couplet::new(f, vocab()).is_err());
        // logits 长度与词表不符
        let mut c = Couplet::new(Fake::new(30), vocab()).unwrap();
        let r = c.generate("春", &CoupletOptions::default(), &CancelToken::new());
        assert!(matches!(r, Err(AiError::BadModelOutput(_))));
    }

    #[cfg(feature = "mnn-backend")]
    #[test]
    fn 清单解析() {
        let ok = r#"{"schema_version":1,"tokenizer":{"vocab_size":21128,"cls":101,"unk":100,"dash":118}}"#;
        let m = CoupletManifest::parse(ok).unwrap();
        assert_eq!((m.vocab_size, m.cls, m.unk, m.dash), (21128, 101, 100, 118));
        assert!(CoupletManifest::parse(r#"{"schema_version":2}"#).is_err());
        assert!(CoupletManifest::parse(r#"{"schema_version":1}"#).is_err());
        assert!(CoupletManifest::parse("not json").is_err());
    }
}

/// MNN 真库测试（全部 `#[ignore]`）：真 `arkli-mnn.dll` + 对联 w6 产物目录。
///
/// ```text
/// ARKLI_MNN_DYLIB=<arkli-mnn.dll>   （同目录要有 MNN.dll）
/// ARKLI_COUPLET_DIR=<couplet-gpt2-mnn>   （缺省 E:\workspaces\arkli-models\couplet-gpt2-mnn）
/// cargo test -p arkli-ai --features mnn-backend -- --ignored --nocapture couplet
/// ```
#[cfg(all(test, feature = "mnn-backend"))]
mod mnn_real_tests {
    use std::path::PathBuf;
    use std::time::Instant;

    use super::*;
    use crate::mnn::MnnRuntime;

    /// 环境变量：MNN 运行库。
    const ENV_DYLIB: &str = "ARKLI_MNN_DYLIB";
    /// 环境变量：模型目录。
    const ENV_DIR: &str = "ARKLI_COUPLET_DIR";
    /// 模型目录缺省值。
    const DEFAULT_DIR: &str = r"E:\workspaces\arkli-models\couplet-gpt2-mnn";
    /// 桌面线程数。
    const THREADS: u32 = 4;
    /// 贪心参考：`eval_couplet.py` 同一份产物、同一套等长约束的贪心结果（Python 逐步 argmax 得到）。
    const GREEDY_REF: [(&str, &str); 6] = [
        ("春风送暖入屠苏", "旭日生辉照山川"),
        ("山清水秀，人杰地灵", "柳绿桃红，物阜民康"),
        ("海内存知己，天涯若比邻", "人间重晚晴，诗意不输真"),
        ("天增岁月人增寿", "春满乾坤福满门"),
        ("一帆风顺吉星高照！", "万事如意福星高照！"),
        ("爆竹声中一岁除", "梅花香里两天开"),
    ];

    /// 加载运行库与对联引擎。
    fn load() -> (MnnRuntime, Couplet<crate::mnn::MnnNet>) {
        let lib = std::env::var(ENV_DYLIB).unwrap_or_else(|_| panic!("未设置 {ENV_DYLIB}"));
        let dir = PathBuf::from(std::env::var(ENV_DIR).unwrap_or_else(|_| DEFAULT_DIR.into()));
        let rt = MnnRuntime::load(lib).unwrap();
        let c = rt.load_couplet(&dir, THREADS).unwrap();
        (rt, c)
    }

    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB 与对联模型目录"]
    fn 对联真库_贪心与eval一致_等长_标点对位() {
        let (_rt, mut c) = load();
        let greedy = CoupletOptions { temperature: 0.0, ..Default::default() };
        for (up, want) in GREEDY_REF {
            let t = Instant::now();
            let out = c.generate(up, &greedy, &CancelToken::new()).unwrap();
            println!("{up} => {}  ({} ms，墙钟 {} ms)", out.text, out.elapsed_ms, t.elapsed().as_millis());
            assert_eq!(out.text, want, "与 eval 贪心不一致");
            let (u, d): (Vec<char>, Vec<char>) = (up.chars().collect(), out.text.chars().collect());
            assert_eq!(u.len(), d.len());
            for (a, b) in u.iter().zip(&d) {
                assert_eq!(is_punct(*a), is_punct(*b));
                if is_punct(*a) {
                    assert_eq!(a, b);
                } else {
                    assert!(HAN_RANGE.contains(b));
                }
            }
        }
    }

    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB 与对联模型目录"]
    fn 对联真库_采样同种子可复现且等长() {
        let (_rt, mut c) = load();
        let opt = CoupletOptions { seed: Some(2024), ..Default::default() };
        let up = "海内存知己，天涯若比邻";
        let a = c.generate(up, &opt, &CancelToken::new()).unwrap();
        let b = c.generate(up, &opt, &CancelToken::new()).unwrap();
        println!("采样 seed=2024 => {} ({} ms)", a.text, a.elapsed_ms);
        assert_eq!(a.text, b.text);
        assert_eq!(a.text.chars().count(), up.chars().count());
        assert_eq!(a.text.chars().nth(5), Some('，'));
    }

    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB 与对联模型目录"]
    fn 对联真库_取消与14字上限() {
        let (_rt, mut c) = load();
        let t = CancelToken::new();
        t.cancel();
        assert_eq!(c.generate("春风送暖", &CoupletOptions::default(), &t), Err(AiError::Cancelled));
        let up = "春风送暖入屠苏迎新年旭日东升";
        assert_eq!(up.chars().count(), 14);
        let out = c.generate(up, &CoupletOptions { temperature: 0.0, ..Default::default() }, &CancelToken::new()).unwrap();
        println!("14 字：{up} => {} ({} ms)", out.text, out.elapsed_ms);
        assert_eq!(out.text.chars().count(), 14);
    }
}
