//! MNN 实现的 [`Seq2SeqRunner`]：encoder / cross_kv / decoder_step 三张图 + 图外 int8 嵌入表。
//!
//! 数据流（`scripts/mnn/nllb_prepare.py`、`nllb_crosskv.py`、`eval_nllb.py` 定义，本模块照做）：
//! 1. 编码：`embed(input_ids)` → 图 `encoder`（`input_ids` `attention_mask` `inputs_embeds` → `last_hidden_state`）；
//! 2. 交叉 KV：图 `cross_kv`（`encoder_hidden_states` → `past_key_values.{l}.encoder.{key|value}`）整句只跑一次，
//!    所有解码步与所有束共享这一份句柄；
//! 3. 每步：图 `decoder_step`（`input_ids` `inputs_embeds` `encoder_attention_mask` 与全部 `past_key_values.*` → `logits`
//!    与 `present.{l}.decoder.{key|value}`）。首步自注意力 past 长度为 0；本步 `present` 的句柄直接当下一步的 `past`（零拷贝）。
//!
//! **按行单独执行**：M6a 转出的三张 MNN 图把 batch 维固定成 1（实测 `cross_kv` 报“模型要 [1,-1,1024]，给了 [2,9,1024]”），
//! 所以束搜索的每条束各自跑一次 `decoder_step`（batch=1），每行持有自己的自注意力 KV 句柄。由此束搜索的“重排”不必读出再 gather：
//! 新第 `i` 行直接改拿旧第 `parents[i]` 行的 present 句柄（句柄不可变，行间共享安全，零拷贝）。
//! 输入完全相同的行（同 token、同 past 句柄，如束搜索首步与补齐行）只跑一次。代价：束宽 W 时每步约 W 倍解码器计算。
//! 若将来重转出动态 batch 的图，再换成批量实现（trait 接口不变）。
//!
//! 嵌入表在图外（[`EmbedTable`]，逐行 int8 + 每行 scale），缩放（×√d）仍在图里。
//! 所有 int64 输入按 C ABI 传 i32。三个 `.mnn` 的外置权重必须总传 `weight`：清单 `*_data` 优先，缺省再探测 `<model>.weight`。
//! 卸载时依次丢掉三个会话，最后归还内存（见 [`MnnRunner`] 的字段顺序）。

use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;

use tokenizers::Tokenizer;

use crate::backend::{GraphSession, GraphValue};
use crate::mnn::{external_weight_path, MnnConfig, MnnNet, MnnRuntime};

use super::embed::EmbedTable;
use super::engine::{decode_err, load_tokenizer, resolve_gen_params, Engine};
use super::error::{ErrorKind, TranslateError};
use super::manifest::{
    Manifest, ModelFormat, FILE_CROSS_KV, FILE_CROSS_KV_DATA, FILE_DECODER, FILE_DECODER_DATA, FILE_EMBED,
    FILE_EMBED_SCALE, FILE_ENCODER, FILE_ENCODER_DATA, FILE_TOKENIZER,
};
use super::runner::{last_position_logits, Seq2SeqRunner, StepLogits};

/// 图输入名：词 id。
const INPUT_IDS: &str = "input_ids";
/// 图输入名：注意力掩码（编码器）。
const ATTENTION_MASK: &str = "attention_mask";
/// 图输入名：图外查好的词嵌入。
const INPUTS_EMBEDS: &str = "inputs_embeds";
/// 图输入名：交叉注意力掩码（解码器）。
const ENCODER_ATTENTION_MASK: &str = "encoder_attention_mask";
/// 图输入名：编码器隐层（cross_kv 图）。
const ENCODER_HIDDEN_STATES: &str = "encoder_hidden_states";
/// 编码器输出名：隐层。
const LAST_HIDDEN_STATE: &str = "last_hidden_state";
/// 解码器输出名：词表 logits。
const LOGITS: &str = "logits";
/// KV 缓存输入名前缀。
const PAST_PREFIX: &str = "past_key_values.";
/// KV 缓存输出名前缀。
const PRESENT_PREFIX: &str = "present.";
/// KV 名里的自注意力标记。
const SELF_ATTN_MARK: &str = ".decoder.";
/// 一层的 KV 名后缀：键、值。
const KV_KINDS: [&str; 2] = ["key", "value"];

/// 解码器结构：层数与 KV 形状（空 KV、图张量名都由它生成）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecoderDims {
    /// 解码器层数。
    pub layers: usize,
    /// KV 头数。
    pub heads: usize,
    /// KV 每头维度。
    pub head_dim: usize,
}

/// 三张图的输入输出名（顺序即加载时传给 `load_net` 的顺序）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphNames {
    /// 编码器输入。
    pub encoder_in: Vec<String>,
    /// 编码器输出。
    pub encoder_out: Vec<String>,
    /// 交叉 KV 图输入。
    pub cross_in: Vec<String>,
    /// 交叉 KV 图输出。
    pub cross_out: Vec<String>,
    /// 解码步输入。
    pub decoder_in: Vec<String>,
    /// 解码步输出。
    pub decoder_out: Vec<String>,
}

/// 把 `&str` 列表转成 `String` 列表。
fn owned(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// 某层某类 KV 的名字：`{前缀}{层}.{decoder|encoder}.{key|value}`。
fn kv_name(prefix: &str, layer: usize, side: &str, kind: &str) -> String {
    format!("{prefix}{layer}.{side}.{kind}")
}

/// 按层数生成三张图的输入输出名。
///
/// # 参数
/// - `layers`：解码器层数。
///
/// # 返回
/// [`GraphNames`]：解码步输入含 `input_ids`、`inputs_embeds`、`encoder_attention_mask` 与每层的自/交叉注意力 past，
/// 输出为 `logits` 与每层自注意力的 `present`；交叉 KV 图输出为每层交叉注意力的 past。
///
/// # 示例
/// ```ignore
/// let n = graph_names(12);
/// assert_eq!(n.decoder_in.len(), 3 + 4 * 12);
/// ```
pub fn graph_names(layers: usize) -> GraphNames {
    let mut cross_out = Vec::new();
    let mut decoder_in = owned(&[INPUT_IDS, INPUTS_EMBEDS, ENCODER_ATTENTION_MASK]);
    let mut decoder_out = owned(&[LOGITS]);
    for l in 0..layers {
        for kind in KV_KINDS {
            decoder_in.push(kv_name(PAST_PREFIX, l, "decoder", kind));
            decoder_in.push(kv_name(PAST_PREFIX, l, "encoder", kind));
            cross_out.push(kv_name(PAST_PREFIX, l, "encoder", kind));
            decoder_out.push(kv_name(PRESENT_PREFIX, l, "decoder", kind));
        }
    }
    GraphNames {
        encoder_in: owned(&[INPUT_IDS, ATTENTION_MASK, INPUTS_EMBEDS]),
        encoder_out: owned(&[LAST_HIDDEN_STATE]),
        cross_in: owned(&[ENCODER_HIDDEN_STATES]),
        cross_out,
        decoder_in,
        decoder_out,
    }
}

/// 按图输入名的顺序挑出要喂的张量。
///
/// # 参数
/// - `names`：图的输入名（`GraphSession::input_names`）。
/// - `find`：按名字找张量，找不到返回 `None`。
///
/// # 返回
/// 与 `names` 等长的引用列表；任何名字没有对应张量返回 `DecodeFailed`。
fn pick_inputs<'a, V>(
    names: &[String],
    mut find: impl FnMut(&str) -> Option<&'a V>,
) -> Result<Vec<&'a V>, TranslateError> {
    names
        .iter()
        .map(|n| {
            find(n).ok_or_else(|| {
                TranslateError::new(ErrorKind::DecodeFailed, format!("graph input `{n}` has no value"))
            })
        })
        .collect()
}

/// 把图输出按输出名拆成 `(名字, 张量)`；个数不符返回 `DecodeFailed`。
fn name_outputs<V>(names: &[String], outs: Vec<V>) -> Result<Vec<(String, V)>, TranslateError> {
    if names.len() != outs.len() {
        return Err(TranslateError::new(
            ErrorKind::DecodeFailed,
            format!("graph returned {} outputs, expected {}", outs.len(), names.len()),
        ));
    }
    Ok(names.iter().cloned().zip(outs).collect())
}

/// 归还内存的守卫：Drop 时执行回调。放在 [`MnnRunner`] 最后一个字段，保证三张图都先释放。
struct ReleaseGuard(Option<Box<dyn FnOnce() + Send>>);

impl Drop for ReleaseGuard {
    /// 执行一次归还内存回调。
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

/// 一行（一条束）的自注意力 KV 状态。
struct Row<V> {
    /// 自注意力 KV，按解码器输入名索引；句柄可在行间共享。
    past: HashMap<String, Rc<V>>,
    /// 本步产生、等 `commit` 的自注意力 KV（已换成对应的 past 输入名）。
    pending: Vec<(String, Rc<V>)>,
}

/// 一行一次解码的结果：该行 logits（`want_logits` 为真时）与暂存的 present。
type RowResult<V> = (Option<Vec<f32>>, Vec<(String, Rc<V>)>);

/// MNN 的一次解码会话：共享的 mask 与交叉 KV，加每行各自的自注意力 KV。
pub struct MnnSession<V> {
    /// 交叉注意力 mask（i32，`[1, src_len]` 全 1），各行共享。
    mask: V,
    /// 交叉注意力 KV，按解码器输入名索引，整句不变，各行共享。
    cross: HashMap<String, V>,
    /// 各行（各条束）的自注意力 KV。
    rows: Vec<Row<V>>,
}

/// 两行是否输入完全相同：自注意力 KV 的每个句柄指向同一个张量。
fn same_past<V>(a: &Row<V>, b: &Row<V>) -> bool {
    a.past.len() == b.past.len()
        && a.past.iter().all(|(k, v)| b.past.get(k).is_some_and(|w| Rc::ptr_eq(v, w)))
}

/// MNN 后端：三张图 + 嵌入表。`G` 是图会话类型（生产为 `MnnNet`，测试用 mock）。
pub struct MnnRunner<G: GraphSession> {
    /// 编码器图。
    encoder: G,
    /// 交叉 KV 图。
    cross_kv: G,
    /// 单步解码图。
    decoder: G,
    /// 图外嵌入表（常驻内存）。
    embed: EmbedTable,
    /// 解码器结构。
    dims: DecoderDims,
    /// 归还内存的守卫；必须是最后一个字段，字段按声明顺序释放，三张图先于它释放。
    _release: ReleaseGuard,
}

impl<G: GraphSession> MnnRunner<G> {
    /// 由三个已加载的图会话与嵌入表构造。
    ///
    /// # 参数
    /// - `encoder`/`cross_kv`/`decoder`：三张图（输入输出名顺序以各自 `input_names()` 为准）。
    /// - `embed`：嵌入表。
    /// - `dims`：解码器结构。
    /// - `on_release`：三张图释放后调用（生产里归还 MNN 内存），可为 `None`。
    ///
    /// # 示例
    /// ```ignore
    /// let r = MnnRunner::new(enc, cross, dec, table, dims, Some(Box::new(move || rt.release_memory())));
    /// ```
    pub fn new(
        encoder: G,
        cross_kv: G,
        decoder: G,
        embed: EmbedTable,
        dims: DecoderDims,
        on_release: Option<Box<dyn FnOnce() + Send>>,
    ) -> Self {
        Self { encoder, cross_kv, decoder, embed, dims, _release: ReleaseGuard(on_release) }
    }

    /// 新建 i32 张量，底层错误归为解码失败。
    fn i32_value(&self, shape: &[i64], data: &[i32]) -> Result<G::Value, TranslateError> {
        self.decoder.value_i32(shape, data).map_err(|e| decode_err(&e))
    }

    /// 新建 f32 张量，底层错误归为解码失败。
    fn f32_value(&self, shape: &[i64], data: &[f32]) -> Result<G::Value, TranslateError> {
        self.decoder.value_f32(shape, data).map_err(|e| decode_err(&e))
    }

    /// 查嵌入并造成 `[1, seq, dim]` 的张量。
    fn embed_value(&self, ids: &[i64]) -> Result<G::Value, TranslateError> {
        let data = self.embed.lookup(ids).map_err(|m| TranslateError::new(ErrorKind::DecodeFailed, m))?;
        self.f32_value(&[1, ids.len() as i64, self.embed.dim() as i64], &data)
    }

    /// 对一行跑一次单步解码图（batch=1）：喂该行 token 的嵌入、共享 mask/交叉 KV 与该行 past。
    fn run_row(
        &mut self,
        s: &MnnSession<G::Value>,
        row: &Row<G::Value>,
        token: i64,
        want_logits: bool,
    ) -> Result<RowResult<G::Value>, TranslateError> {
        let ids_v = self.i32_value(&[1, 1], &[token as i32])?;
        let emb = self.embed_value(&[token])?;
        let inputs = pick_inputs(self.decoder.input_names(), |name| match name {
            INPUT_IDS => Some(&ids_v),
            INPUTS_EMBEDS => Some(&emb),
            ENCODER_ATTENTION_MASK => Some(&s.mask),
            other => row.past.get(other).map(|v| &**v).or_else(|| s.cross.get(other)),
        })?;
        let outs = self.decoder.run(&inputs).map_err(|e| decode_err(&e))?;
        let (mut logits, mut pending) = (None, Vec::new());
        for (name, v) in name_outputs(self.decoder.output_names(), outs)? {
            if name == LOGITS {
                if want_logits {
                    let vocab = v.shape().last().copied().unwrap_or(0).max(0) as usize;
                    let data = v.to_f32().map_err(|e| decode_err(&e))?;
                    let l = last_position_logits(&data, vocab, 1).ok_or_else(|| {
                        TranslateError::new(ErrorKind::DecodeFailed, "decoder returned empty logits")
                    })?;
                    logits = Some(l.data);
                }
            } else if let Some(rest) = name.strip_prefix(PRESENT_PREFIX) {
                pending.push((format!("{PAST_PREFIX}{rest}"), Rc::new(v)));
            }
        }
        Ok((logits, pending))
    }
}

impl<G: GraphSession> Seq2SeqRunner for MnnRunner<G> {
    type Session = MnnSession<G::Value>;

    /// 编码一次、算一次交叉 KV（各行共享）；每行的自注意力 past 置为长度 0（空张量只造一份，行间共享）。
    fn begin(&mut self, input_ids: &[u32], rows: usize) -> Result<Self::Session, TranslateError> {
        let n = input_ids.len() as i64;
        let ids_i64: Vec<i64> = input_ids.iter().map(|&x| i64::from(x)).collect();
        let ids: Vec<i32> = input_ids.iter().map(|&x| x as i32).collect();
        let ids_v = self.i32_value(&[1, n], &ids)?;
        let mask = self.i32_value(&[1, n], &vec![1; ids.len()])?;
        let emb = self.embed_value(&ids_i64)?;
        let enc_in = pick_inputs(self.encoder.input_names(), |name| match name {
            INPUT_IDS => Some(&ids_v),
            ATTENTION_MASK => Some(&mask),
            INPUTS_EMBEDS => Some(&emb),
            _ => None,
        })?;
        let outs = self.encoder.run(&enc_in).map_err(|e| decode_err(&e))?;
        let hidden = name_outputs(self.encoder.output_names(), outs)?
            .into_iter()
            .find(|(name, _)| name == LAST_HIDDEN_STATE)
            .map(|(_, v)| v)
            .ok_or_else(|| TranslateError::new(ErrorKind::DecodeFailed, "encoder has no last_hidden_state output"))?;

        let cross_in = pick_inputs(self.cross_kv.input_names(), |name| (name == ENCODER_HIDDEN_STATES).then_some(&hidden))?;
        let outs = self.cross_kv.run(&cross_in).map_err(|e| decode_err(&e))?;
        let cross: HashMap<String, G::Value> = name_outputs(self.cross_kv.output_names(), outs)?.into_iter().collect();

        let (heads, head_dim) = (self.dims.heads as i64, self.dims.head_dim as i64);
        let mut empty: HashMap<String, Rc<G::Value>> = HashMap::new();
        for name in self.decoder.input_names() {
            if name.starts_with(PAST_PREFIX) && name.contains(SELF_ATTN_MARK) {
                empty.insert(name.clone(), Rc::new(self.f32_value(&[1, heads, 0, head_dim], &[])?));
            }
        }
        let rows = (0..rows).map(|_| Row { past: empty.clone(), pending: Vec::new() }).collect();
        Ok(MnnSession { mask, cross, rows })
    }

    /// 每行各跑一次单步解码图；输入相同的行（同 token、同 past 句柄）只跑一次、结果共享。
    fn step(
        &mut self,
        s: &mut Self::Session,
        _step: usize,
        tokens: &[i64],
        want_logits: bool,
    ) -> Result<Option<StepLogits>, TranslateError> {
        if tokens.len() != s.rows.len() {
            return Err(TranslateError::new(
                ErrorKind::DecodeFailed,
                format!("step got {} tokens for {} rows", tokens.len(), s.rows.len()),
            ));
        }
        let mut results: Vec<RowResult<G::Value>> = Vec::with_capacity(tokens.len());
        for r in 0..tokens.len() {
            let dup = (0..r).find(|&q| tokens[q] == tokens[r] && same_past(&s.rows[q], &s.rows[r]));
            let res = match dup {
                Some(q) => results[q].clone(),
                None => self.run_row(s, &s.rows[r], tokens[r], want_logits)?,
            };
            results.push(res);
        }
        let mut data = Vec::new();
        let mut vocab = 0;
        for (row, (logits, pending)) in s.rows.iter_mut().zip(results) {
            row.pending = pending;
            if let Some(l) = logits {
                vocab = l.len();
                data.extend(l);
            }
        }
        Ok(want_logits.then_some(StepLogits { data, vocab }))
    }

    /// 把本步 present 并入 past：不重排则每行换成自己的 present；重排则新第 `i` 行改拿旧第 `parents[i]` 行的句柄（零拷贝）。
    fn commit(
        &mut self,
        s: &mut Self::Session,
        _step: usize,
        reorder: Option<&[usize]>,
    ) -> Result<(), TranslateError> {
        let pendings: Vec<Vec<(String, Rc<G::Value>)>> =
            s.rows.iter_mut().map(|r| std::mem::take(&mut r.pending)).collect();
        let parents: Vec<usize> = match reorder {
            None => (0..pendings.len()).collect(),
            Some(p) => p.to_vec(),
        };
        if parents.len() != s.rows.len() || parents.iter().any(|&p| p >= pendings.len()) {
            return Err(TranslateError::new(ErrorKind::DecodeFailed, "KV gather index out of range"));
        }
        for (row, &p) in s.rows.iter_mut().zip(&parents) {
            for (name, v) in &pendings[p] {
                row.past.insert(name.clone(), Rc::clone(v));
            }
        }
        Ok(())
    }
}

/// 外置权重路径：清单 `data_key` 优先，缺省探测 `<model>.weight`（外置权重必须总传，MNN 缺文件只打日志不报错）。
fn weight_for(manifest: &Manifest, dir: &Path, data_key: &str, model: &Path) -> Result<Option<std::path::PathBuf>, TranslateError> {
    if manifest.files.contains_key(data_key) {
        return Ok(Some(manifest.resolve_file(dir, data_key)?));
    }
    Ok(external_weight_path(model))
}

impl Engine<MnnRunner<MnnNet>> {
    /// 加载 MNN 三图格式模型并做自检；三张图顺序加载以压低峰值，卸载（Drop）时依次释放并归还内存。
    ///
    /// # 参数
    /// - `rt`：已加载运行库的 MNN 运行时。
    /// - `dir`：模型目录（`model.json` 的 `format` 须为 `mnn-split`）。
    /// - `threads`：算子线程数，0 取清单值（再为 0 取默认 4）。
    ///
    /// # 返回
    /// 就绪的引擎；清单 `format` 不符返回 `LoadFailed`；嵌入行数与分词器词数不符返回 `ManifestInvalid`；
    /// 缺文件 `ModelMissing`；加载失败 `LoadFailed`，内存不足 `OutOfMemory`。
    ///
    /// # 示例
    /// ```ignore
    /// let rt = MnnRuntime::load("libarkli-mnn.so")?;
    /// let mut engine = Engine::load_mnn(&rt, Path::new("/data/models/nllb-mnn"), 4)?;
    /// ```
    pub fn load_mnn(rt: &MnnRuntime, dir: &Path, threads: u32) -> Result<Self, TranslateError> {
        let manifest = Manifest::load(dir)?;
        if manifest.model_format()? != ModelFormat::MnnSplit {
            return Err(TranslateError::new(
                ErrorKind::LoadFailed,
                "model.json format is not `mnn-split`; load it with the ORT backend",
            ));
        }
        let gen_params = resolve_gen_params(&manifest, dir)?;
        let tokenizer = load_tokenizer(&manifest.resolve_file(dir, FILE_TOKENIZER)?)?;
        let embed = EmbedTable::load(
            &manifest.resolve_file(dir, FILE_EMBED)?,
            &manifest.resolve_file(dir, FILE_EMBED_SCALE)?,
        )
        .map_err(|m| TranslateError::new(ErrorKind::ManifestInvalid, m))?;
        check_vocab_matches(&embed, &tokenizer)?;

        let (layers, heads, head_dim) = manifest.decoder_dims();
        let names = graph_names(layers);
        let intra = if threads > 0 { threads } else { manifest.execution.intra_threads as u32 };
        let cfg = MnnConfig::runtime().with_threads(intra);
        let load = |key: &str, data_key: &str, ins: &[String], outs: &[String]| -> Result<MnnNet, TranslateError> {
            let model = manifest.resolve_file(dir, key)?;
            let weight = weight_for(&manifest, dir, data_key, &model)?;
            let ins: Vec<&str> = ins.iter().map(String::as_str).collect();
            let outs: Vec<&str> = outs.iter().map(String::as_str).collect();
            rt.load_net(&model, weight.as_deref(), &ins, &outs, &cfg).map_err(|e| {
                super::engine::classify_error(&format!("{}: {e}", model.display()), ErrorKind::LoadFailed)
            })
        };
        // 顺序加载：每张图的权重在 rearrange 时有瞬时峰值，别叠在一起
        let encoder = load(FILE_ENCODER, FILE_ENCODER_DATA, &names.encoder_in, &names.encoder_out)?;
        let cross_kv = load(FILE_CROSS_KV, FILE_CROSS_KV_DATA, &names.cross_in, &names.cross_out)?;
        let decoder = load(FILE_DECODER, FILE_DECODER_DATA, &names.decoder_in, &names.decoder_out)?;
        let rt = rt.clone();
        let runner = MnnRunner::new(
            encoder,
            cross_kv,
            decoder,
            embed,
            DecoderDims { layers, heads, head_dim },
            Some(Box::new(move || rt.release_memory())),
        );
        Engine::new(manifest, gen_params, tokenizer, runner)
    }
}

/// 嵌入表行数必须等于分词器词数（含特殊 token 与语言码），否则 id 会对不上或越界。
///
/// # 参数
/// - `embed`：嵌入表。
/// - `tokenizer`：分词器。
///
/// # 返回
/// 相等返回 `Ok`；不符返回 `ManifestInvalid`。
fn check_vocab_matches(embed: &EmbedTable, tokenizer: &Tokenizer) -> Result<(), TranslateError> {
    let vocab = tokenizer.get_vocab_size(true);
    if embed.rows() != vocab {
        return Err(TranslateError::new(
            ErrorKind::ManifestInvalid,
            format!("embedding rows {} do not match tokenizer vocabulary size {vocab}", embed.rows()),
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::error::{AiError, Result as AiResult};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// 假张量：形状 + f32 或 i32 数据。
    #[derive(Debug, Clone, PartialEq)]
    pub enum MockData {
        /// f32 数据
        F32(Vec<f32>),
        /// i32 数据
        I32(Vec<i32>),
    }

    /// 假张量句柄。
    #[derive(Debug, Clone, PartialEq)]
    pub struct MockVal {
        /// 形状
        pub shape: Vec<i64>,
        /// 数据
        pub data: MockData,
    }

    impl GraphValue for MockVal {
        fn shape(&self) -> Vec<i64> {
            self.shape.clone()
        }
        fn to_f32(&self) -> AiResult<Vec<f32>> {
            match &self.data {
                MockData::F32(v) => Ok(v.clone()),
                MockData::I32(_) => Err(AiError::BadModelOutput("not f32".into())),
            }
        }
        fn to_i32(&self) -> AiResult<Vec<i32>> {
            match &self.data {
                MockData::I32(v) => Ok(v.clone()),
                MockData::F32(_) => Err(AiError::BadModelOutput("not i32".into())),
            }
        }
    }

    /// 假图的前向：收到按输入名配好对的张量，返回按输出名顺序的张量。
    pub type MockFn = Box<dyn FnMut(&[(&str, &MockVal)]) -> Vec<MockVal> + Send>;

    /// 假图会话。
    pub struct MockGraph {
        /// 输入名
        pub ins: Vec<String>,
        /// 输出名
        pub outs: Vec<String>,
        /// 前向实现
        pub f: MockFn,
    }

    impl GraphSession for MockGraph {
        type Value = MockVal;
        fn input_names(&self) -> &[String] {
            &self.ins
        }
        fn output_names(&self) -> &[String] {
            &self.outs
        }
        fn value_f32(&self, shape: &[i64], data: &[f32]) -> AiResult<MockVal> {
            assert_eq!(shape.iter().product::<i64>() as usize, data.len(), "形状与数据长度不符");
            Ok(MockVal { shape: shape.to_vec(), data: MockData::F32(data.to_vec()) })
        }
        fn value_i32(&self, shape: &[i64], data: &[i32]) -> AiResult<MockVal> {
            assert_eq!(shape.iter().product::<i64>() as usize, data.len(), "形状与数据长度不符");
            Ok(MockVal { shape: shape.to_vec(), data: MockData::I32(data.to_vec()) })
        }
        fn run(&mut self, inputs: &[&MockVal]) -> AiResult<Vec<MockVal>> {
            assert_eq!(inputs.len(), self.ins.len());
            let named: Vec<(&str, &MockVal)> = self.ins.iter().map(String::as_str).zip(inputs.iter().copied()).collect();
            Ok((self.f)(&named))
        }
    }

    /// 假模型的结构：1 层、1 头、每头 2 维，词表 6、隐层 2。
    pub const DIMS: DecoderDims = DecoderDims { layers: 1, heads: 1, head_dim: 2 };
    /// 假词表大小（嵌入表行数、logits 长度）。
    pub const VOCAB: usize = 6;
    /// 假隐层/嵌入维度。
    pub const DIM: usize = 2;
    /// 假模型的结束符 id。
    pub const EOS: usize = 2;

    /// 按名取输入。
    fn get<'a>(named: &[(&str, &'a MockVal)], name: &str) -> &'a MockVal {
        named.iter().find(|(n, _)| *n == name).map(|(_, v)| *v).unwrap_or_else(|| panic!("缺输入 {name}"))
    }

    /// 要求张量的第 0 维（batch）为 1：模拟真实 MNN 图把 batch 固定成 1。
    fn assert_batch1(v: &MockVal, what: &str) {
        assert_eq!(v.shape[0], 1, "{what} 的 batch 必须为 1，实际 {:?}", v.shape);
    }

    /// 解码步一次调用的记录。
    #[derive(Debug, Clone, PartialEq)]
    pub struct StepRecord {
        /// 输入 token（来自 input_ids）
        pub token: i32,
        /// 自注意力 key 的形状
        pub past_shape: Vec<i64>,
        /// 自注意力 key 数据
        pub past_key: Vec<f32>,
        /// 交叉 key 数据
        pub cross_key: Vec<f32>,
        /// mask 形状
        pub mask_shape: Vec<i64>,
    }

    /// 脚本化的解码策略：给定本次输入 token 与调用序号（从 0 起），返回 logits 里最高分的 token。
    pub type Policy = Box<dyn FnMut(i32, usize) -> usize + Send>;

    /// 造一套假三图 runner（所有图只接受 batch=1）：
    /// - 编码器：隐层 = `inputs_embeds`；
    /// - 交叉 KV：key = 隐层本身 `[1,1,S,2]`，value = 隐层 ×10；
    /// - 解码步：自注意力 key 在 past 后追加本步 `[token, 0]`，value 追加 `[token*10, 0]`；logits 的最高分由 `policy(token, 调用序号)` 决定。
    ///
    /// 嵌入表第 `i` 行 = `[i, 2i]`（scale 1）。
    pub fn mock_runner(policy: Policy, log: Arc<Mutex<Vec<StepRecord>>>) -> MnnRunner<MockGraph> {
        let q: Vec<u8> = (0..VOCAB).flat_map(|i| [i as u8, (2 * i) as u8]).collect();
        let scale: Vec<u8> = (0..VOCAB).flat_map(|_| 1.0f32.to_le_bytes()).collect();
        let embed = EmbedTable::from_bytes(q, &scale).unwrap();
        let names = graph_names(DIMS.layers);

        let encoder = MockGraph {
            ins: names.encoder_in,
            outs: names.encoder_out,
            f: Box::new(|named| {
                let emb = get(named, INPUTS_EMBEDS);
                assert_batch1(emb, "encoder");
                // 输入校验：id 与 mask 都是 i32、形状一致
                assert!(matches!(get(named, INPUT_IDS).data, MockData::I32(_)));
                assert_eq!(get(named, ATTENTION_MASK).shape, get(named, INPUT_IDS).shape);
                vec![emb.clone()]
            }),
        };
        let cross_kv = MockGraph {
            ins: names.cross_in,
            outs: names.cross_out,
            f: Box::new(|named| {
                let h = get(named, ENCODER_HIDDEN_STATES);
                assert_batch1(h, "cross_kv");
                let data = h.to_f32().unwrap();
                let shape = vec![1, 1, h.shape[1], DIM as i64];
                let value: Vec<f32> = data.iter().map(|x| x * 10.0).collect();
                vec![
                    MockVal { shape: shape.clone(), data: MockData::F32(data) },
                    MockVal { shape, data: MockData::F32(value) },
                ]
            }),
        };
        let mut calls = 0usize;
        let mut policy = policy;
        let decoder = MockGraph {
            ins: names.decoder_in,
            outs: names.decoder_out,
            f: Box::new(move |named| {
                let ids = get(named, INPUT_IDS);
                assert_batch1(ids, "decoder input_ids");
                let token = ids.to_i32().unwrap()[0];
                let past_k = get(named, "past_key_values.0.decoder.key");
                let past_v = get(named, "past_key_values.0.decoder.value");
                let cross_k = get(named, "past_key_values.0.encoder.key");
                assert_batch1(past_k, "past key");
                assert_batch1(cross_k, "cross key");
                // 输入嵌入必须是 token 对应的嵌入表行
                let emb = get(named, INPUTS_EMBEDS).to_f32().unwrap();
                assert_eq!(emb, vec![token as f32, 2.0 * token as f32], "嵌入行不符");
                log.lock().unwrap().push(StepRecord {
                    token,
                    past_shape: past_k.shape.clone(),
                    past_key: past_k.to_f32().unwrap(),
                    cross_key: cross_k.to_f32().unwrap(),
                    mask_shape: get(named, ENCODER_ATTENTION_MASK).shape.clone(),
                });
                // present = past 拼上本步 [token, 0]
                let t = past_k.shape[2];
                let mut nk = past_k.to_f32().unwrap();
                nk.extend_from_slice(&[token as f32, 0.0]);
                let mut nv = past_v.to_f32().unwrap();
                nv.extend_from_slice(&[token as f32 * 10.0, 0.0]);
                let shape = vec![1, 1, t + 1, 2];
                let mut logits = vec![0.0f32; VOCAB];
                logits[policy(token, calls)] = 10.0;
                calls += 1;
                vec![
                    MockVal { shape: vec![1, 1, VOCAB as i64], data: MockData::F32(logits) },
                    MockVal { shape: shape.clone(), data: MockData::F32(nk) },
                    MockVal { shape, data: MockData::F32(nv) },
                ]
            }),
        };
        MnnRunner::new(encoder, cross_kv, decoder, embed, DIMS, None)
    }

    /// 造一个空调用记录。
    fn new_log() -> Arc<Mutex<Vec<StepRecord>>> {
        Arc::new(Mutex::new(Vec::new()))
    }

    /// 三张图的命名：层数决定个数，解码步输入含自/交叉 past、输出只含自注意力 present。
    #[test]
    fn graph_names_follow_layers() {
        let n = graph_names(12);
        assert_eq!(n.encoder_in, vec!["input_ids", "attention_mask", "inputs_embeds"]);
        assert_eq!(n.cross_in, vec!["encoder_hidden_states"]);
        assert_eq!(n.cross_out.len(), 24);
        assert_eq!(n.cross_out[0], "past_key_values.0.encoder.key");
        assert_eq!(n.decoder_in.len(), 3 + 48);
        assert!(n.decoder_in.contains(&"past_key_values.11.decoder.value".to_string()));
        assert!(n.decoder_in.contains(&"past_key_values.11.encoder.key".to_string()));
        assert_eq!(n.decoder_out.len(), 1 + 24);
        assert_eq!(n.decoder_out[0], "logits");
        assert_eq!(n.decoder_out[1], "present.0.decoder.key");
        assert!(n.decoder_out.iter().all(|o| !o.contains(".encoder.")));
    }

    /// 首步：自注意力 past 长度为 0，交叉 KV 是编码器隐层（= 嵌入）；want_logits 为假时不取 logits。
    #[test]
    fn first_step_has_empty_self_past_and_cross_kv() {
        let log = new_log();
        let mut r = mock_runner(Box::new(|_, _| 3), log.clone());
        // 输入 [4, 1, 2]：嵌入 [[4,8],[1,2],[2,4]]
        let mut s = r.begin(&[4, 1, 2], 1).unwrap();
        let l = r.step(&mut s, 0, &[2], false).unwrap();
        assert!(l.is_none());
        let rec = log.lock().unwrap()[0].clone();
        assert_eq!(rec.token, 2);
        assert_eq!(rec.past_shape, vec![1, 1, 0, 2]);
        assert!(rec.past_key.is_empty());
        assert_eq!(rec.cross_key, vec![4.0, 8.0, 1.0, 2.0, 2.0, 4.0]);
        assert_eq!(rec.mask_shape, vec![1, 3]);
    }

    /// 连续两步：KV 句柄直接传给下一步（长度 +1、内容是上一步追加的），交叉 KV 不变；logits 取每行最高分。
    #[test]
    fn kv_flows_between_steps() {
        let log = new_log();
        let mut r = mock_runner(Box::new(|_, _| 4), log.clone());
        let mut s = r.begin(&[3, 2], 1).unwrap();
        r.step(&mut s, 0, &[2], false).unwrap();
        r.commit(&mut s, 0, None).unwrap();
        let l = r.step(&mut s, 1, &[5], true).unwrap().unwrap();
        assert_eq!(l.vocab, VOCAB);
        assert_eq!(l.row(0)[4], 10.0);
        let recs = log.lock().unwrap();
        assert_eq!(recs[1].past_shape, vec![1, 1, 1, 2]);
        assert_eq!(recs[1].past_key, vec![2.0, 0.0]);
        assert_eq!(recs[1].cross_key, recs[0].cross_key);
    }

    /// 束搜索首步两行输入完全相同：只跑一次；之后两行 token 不同：各跑一次；
    /// 重排 [1, 1] 后两行都拿旧第 1 行的 KV，再输入相同 token 时又只跑一次。
    #[test]
    fn identical_rows_share_one_run_and_reorder_duplicates() {
        let log = new_log();
        let mut r = mock_runner(Box::new(|_, _| 3), log.clone());
        let mut s = r.begin(&[3, 2], 2).unwrap();
        let l = r.step(&mut s, 0, &[2, 2], true).unwrap().unwrap();
        assert_eq!(log.lock().unwrap().len(), 1, "首步两行相同只应跑一次");
        assert_eq!(l.data.len(), 2 * VOCAB);
        assert_eq!(l.row(0), l.row(1));
        r.commit(&mut s, 0, None).unwrap();
        // 两行 token 不同：各跑一次，且都从同一份首步 KV 出发
        r.step(&mut s, 1, &[3, 5], true).unwrap();
        assert_eq!(log.lock().unwrap().len(), 3);
        {
            let recs = log.lock().unwrap();
            assert_eq!((recs[1].token, recs[2].token), (3, 5));
            assert_eq!(recs[1].past_key, vec![2.0, 0.0]);
            assert_eq!(recs[2].past_key, vec![2.0, 0.0]);
        }
        r.commit(&mut s, 1, Some(&[1, 1])).unwrap();
        r.step(&mut s, 2, &[4, 4], true).unwrap();
        let recs = log.lock().unwrap();
        assert_eq!(recs.len(), 4, "重排成两行同源后相同 token 只应跑一次");
        // 两行都来自旧第 1 行（token 5）
        assert_eq!(recs[3].past_shape, vec![1, 1, 2, 2]);
        assert_eq!(recs[3].past_key, vec![2.0, 0.0, 5.0, 0.0]);
        assert_eq!(recs[3].mask_shape, vec![1, 2]);
    }

    /// 重排成交换 [1, 0]：行内容互换，key 与 value 同步。
    #[test]
    fn reorder_swaps_rows() {
        let log = new_log();
        let mut r = mock_runner(Box::new(|_, _| 3), log.clone());
        let mut s = r.begin(&[3, 2], 2).unwrap();
        r.step(&mut s, 0, &[2, 2], false).unwrap();
        r.commit(&mut s, 0, None).unwrap();
        r.step(&mut s, 1, &[3, 5], true).unwrap();
        r.commit(&mut s, 1, Some(&[1, 0])).unwrap();
        // 两行 token 相同但 KV 不同：各跑一次，先行 0（原第 1 行，含 5），再行 1（原第 0 行，含 3）
        r.step(&mut s, 2, &[4, 4], true).unwrap();
        let recs = log.lock().unwrap();
        assert_eq!(recs.len(), 5);
        assert_eq!(recs[3].past_key, vec![2.0, 0.0, 5.0, 0.0]);
        assert_eq!(recs[4].past_key, vec![2.0, 0.0, 3.0, 0.0]);
        // value 与 key 同步重排（本步追加后的 present）
        drop(recs);
        r.commit(&mut s, 2, None).unwrap();
        let row0_v = s.rows[0].past["past_key_values.0.decoder.value"].to_f32().unwrap();
        let row1_v = s.rows[1].past["past_key_values.0.decoder.value"].to_f32().unwrap();
        assert_eq!(row0_v, vec![20.0, 0.0, 50.0, 0.0, 40.0, 0.0]);
        assert_eq!(row1_v, vec![20.0, 0.0, 30.0, 0.0, 40.0, 0.0]);
    }

    /// 重排下标越界、重排长度不符、tokens 行数不符都返回 DecodeFailed 而不是 panic。
    #[test]
    fn bad_reorder_and_rows_are_errors() {
        let mut r = mock_runner(Box::new(|_, _| 3), new_log());
        let mut s = r.begin(&[3, 2], 2).unwrap();
        let e = r.step(&mut s, 0, &[2], false).err().unwrap();
        assert_eq!(e.kind, ErrorKind::DecodeFailed);
        r.step(&mut s, 0, &[2, 2], false).unwrap();
        let e = r.commit(&mut s, 0, Some(&[0, 5])).unwrap_err();
        assert_eq!(e.kind, ErrorKind::DecodeFailed);
        r.step(&mut s, 0, &[2, 2], false).unwrap();
        let e = r.commit(&mut s, 0, Some(&[0])).unwrap_err();
        assert_eq!(e.kind, ErrorKind::DecodeFailed);
    }

    /// 嵌入越界的 token 报 DecodeFailed。
    #[test]
    fn token_outside_embedding_is_error() {
        let mut r = mock_runner(Box::new(|_, _| 3), new_log());
        let mut s = r.begin(&[3, 2], 1).unwrap();
        let e = r.step(&mut s, 0, &[VOCAB as i64], false).err().unwrap();
        assert_eq!(e.kind, ErrorKind::DecodeFailed);
        assert!(r.begin(&[99], 1).is_err());
    }

    /// 释放守卫：runner 被丢掉时回调恰好执行一次。
    #[test]
    fn release_callback_runs_on_drop() {
        let hit = Arc::new(AtomicUsize::new(0));
        let h = hit.clone();
        let mut r = mock_runner(Box::new(|_, _| 3), new_log());
        r._release = ReleaseGuard(Some(Box::new(move || {
            h.fetch_add(1, Ordering::SeqCst);
        })));
        assert_eq!(hit.load(Ordering::SeqCst), 0);
        drop(r);
        assert_eq!(hit.load(Ordering::SeqCst), 1);
    }
}
