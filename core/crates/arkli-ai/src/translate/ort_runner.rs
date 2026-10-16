//! ORT 实现的 [`Seq2SeqRunner`]：encoder + merged decoder（带 KV 分支）。
//!
//! 输入输出名以运行时 `session.inputs()/outputs()` 探测为准，不硬编码层数。
//! 张量名（optimum 导出的 merged decoder）：编码器 `input_ids`/`attention_mask` → `last_hidden_state`；
//! 解码器输入 `input_ids`、`encoder_attention_mask`、`encoder_hidden_states`、`use_cache_branch`
//! 与 `past_key_values.{层}.{decoder|encoder}.{key|value}`（形状 `[批, 16, 序列, 64]`），输出 `logits` 与 `present.*`。
//! 交叉注意力 KV 只在首步产生并采用，自注意力 KV 每步采用（束搜索先按父束重排）。

use std::borrow::Cow;
use std::fmt;
use std::path::Path;

use ort::environment::Environment;
use ort::ep;
use ort::session::{
    builder::GraphOptimizationLevel, RunOptions, Session, SessionInputValue, SessionOutputs,
};
use ort::value::{DynValue, Tensor, TensorRef, ValueType};
use tokenizers::Tokenizer;

use super::beam::gather_rows;
use super::engine::{classify_error, decode_err, load_tokenizer, resolve_gen_params, Engine};
use super::error::{ErrorKind, TranslateError};
use super::manifest::{
    ExecutionOptions, Manifest, ModelFormat, FILE_DECODER, FILE_ENCODER, FILE_TOKENIZER,
};
use super::runner::{last_position_logits, Seq2SeqRunner, StepLogits};

/// 解码器必需的输入名。
const DECODER_REQUIRED_INPUTS: [&str; 3] = ["input_ids", "encoder_hidden_states", "use_cache_branch"];
/// 解码器 KV 缓存输入名前缀。
const PAST_PREFIX: &str = "past_key_values.";
/// 解码器 KV 缓存输出名前缀。
const PRESENT_PREFIX: &str = "present.";
/// 解码器 KV 缓存名里的交叉注意力标记。
const CROSS_ATTN_MARK: &str = ".encoder.";
/// 编码器输入名：词 id。
const INPUT_IDS: &str = "input_ids";
/// 编码器输入名：注意力掩码。
const ATTENTION_MASK: &str = "attention_mask";
/// 解码器输入名：交叉注意力掩码。
const ENCODER_ATTENTION_MASK: &str = "encoder_attention_mask";
/// 解码器输入名：编码器隐层。
const ENCODER_HIDDEN_STATES: &str = "encoder_hidden_states";
/// 解码器输入名：是否走 KV 缓存分支。
const USE_CACHE_BRANCH: &str = "use_cache_branch";
/// 解码器输出名：词表 logits。
const LOGITS: &str = "logits";
/// ORT 运行选项：让本次 Run 结束时收缩 CPU arena。
const ARENA_SHRINK_KEY: &str = "memory.enable_memory_arena_shrinkage";
/// 收缩的设备与 ID（`cpu:0`）。
const ARENA_SHRINK_VALUE: &str = "cpu:0";

/// 取 KV 输入的头数与每头维度（形如 `[-1, 16, -1, 64]`）。
fn kv_dims(shape: &[i64]) -> Option<(i64, i64)> {
    if shape.len() == 4 && shape[1] > 0 && shape[3] > 0 {
        Some((shape[1], shape[3]))
    } else {
        None
    }
}

/// 序列维为 0 的空 KV 张量（新一轮解码的初始 past）。
///
/// # 参数
/// - `batch`：batch 维（束宽）。
/// - `heads`/`head_dim`：KV 头数与每头维度。
///
/// # 返回
/// 形状 `[batch, heads, 0, head_dim]` 的 f32 张量；创建失败返回 ORT 错误。
fn empty_kv(batch: usize, heads: usize, head_dim: usize) -> Result<DynValue, ort::Error> {
    Tensor::<f32>::from_array(([batch, heads, 0, head_dim], Vec::<f32>::new()))
        .map(Tensor::into_dyn)
}

/// 解码器一次运行的输入表（名字 + 张量，借用或持有）。
type DecoderInputs<'a> = Vec<(Cow<'a, str>, SessionInputValue<'a>)>;

/// 编码器侧的借用视图：解码循环里每步不变的 mask 与隐层。
struct EncoderView<'a> {
    /// 交叉注意力 mask，`[rows, src_len]` 全 1。
    mask: &'a [i64],
    /// 展平的编码器隐层，`[rows, src_len, hidden_dim]`。
    hidden: &'a [f32],
    /// batch 行数（贪心 1，束搜索为束宽）。
    rows: usize,
    /// 源序列长度。
    src_len: usize,
    /// 隐层维度。
    hidden_dim: usize,
}

/// 把 `past` 清空并重新填成 `count` 个序列维为 0 的空 KV 张量。
fn fill_empty_past(
    past: &mut Vec<DynValue>,
    count: usize,
    batch: usize,
    heads: usize,
    head_dim: usize,
) -> Result<(), TranslateError> {
    past.clear();
    past.reserve(count);
    for _ in 0..count {
        past.push(empty_kv(batch, heads, head_dim).map_err(|e| decode_err(&e))?);
    }
    Ok(())
}

/// 组装一步解码器输入：当前 token、交叉注意力 mask/隐层（借用）、cache 开关与全部 past。
fn decoder_inputs<'a>(
    cur: &[i64],
    enc: &EncoderView<'a>,
    use_cache: bool,
    past_names: &'a [String],
    past: &'a [DynValue],
) -> Result<DecoderInputs<'a>, TranslateError> {
    let cur_ids =
        Tensor::from_array(([enc.rows, 1usize], cur.to_vec())).map_err(|e| decode_err(&e))?;
    let enc_mask = TensorRef::from_array_view(([enc.rows, enc.src_len], enc.mask))
        .map_err(|e| decode_err(&e))?;
    let flag = Tensor::from_array(([1usize], vec![use_cache])).map_err(|e| decode_err(&e))?;
    let hidden_view =
        TensorRef::from_array_view(([enc.rows, enc.src_len, enc.hidden_dim], enc.hidden))
            .map_err(|e| decode_err(&e))?;
    let mut inputs: DecoderInputs<'a> = vec![
        (INPUT_IDS.into(), cur_ids.into()),
        (ENCODER_ATTENTION_MASK.into(), enc_mask.into()),
        (ENCODER_HIDDEN_STATES.into(), hidden_view.into()),
        (USE_CACHE_BRANCH.into(), flag.into()),
    ];
    for (name, value) in past_names.iter().zip(past.iter()) {
        inputs.push((name.as_str().into(), value.into()));
    }
    Ok(inputs)
}

/// 取 `logits` 输出：校验非空且至少含 `rows` 行，返回每行最后一个位置的 logits。
fn step_logits(outputs: &SessionOutputs<'_>, rows: usize) -> Result<StepLogits, TranslateError> {
    let (shape, logits) = outputs[LOGITS]
        .try_extract_tensor::<f32>()
        .map_err(|e| decode_err(&e))?;
    let vocab = shape.last().copied().unwrap_or(0).max(0) as usize;
    last_position_logits(logits, vocab, rows).ok_or_else(|| {
        TranslateError::new(ErrorKind::DecodeFailed, "decoder returned empty logits")
    })
}

/// 并行加载分词器、编码器会话与解码器会话（ORT 建会话是单线程逐节点处理，两个会话互不依赖）。
///
/// 编码器、解码器各占一个子线程，分词器在调用线程；报错优先级：分词器 > 编码器 > 解码器。
/// 子线程 panic 原样重抛。
///
/// # 参数
/// - `manifest`：已加载的清单。
/// - `dir`：模型目录。
/// - `env`：共享的 ORT 环境。
/// - `threads`：算子线程数，0 取清单值。
///
/// # 返回
/// `(分词器, 编码器会话, 解码器会话)`。
fn load_parts(
    manifest: &Manifest,
    dir: &Path,
    env: &Environment,
    threads: u32,
) -> Result<(Tokenizer, Session, Session), TranslateError> {
    let (tokenizer, encoder, decoder) = std::thread::scope(|s| {
        let spawn_session = |key: &'static str| {
            s.spawn(move || -> Result<Session, TranslateError> {
                build_session(env, &manifest.resolve_file(dir, key)?, &manifest.execution, threads)
            })
        };
        let encoder = spawn_session(FILE_ENCODER);
        let decoder = spawn_session(FILE_DECODER);
        let tokenizer = manifest
            .resolve_file(dir, FILE_TOKENIZER)
            .map_err(TranslateError::from)
            .and_then(|p| load_tokenizer(&p));
        let join = |h: std::thread::ScopedJoinHandle<'_, Result<Session, TranslateError>>| {
            h.join().unwrap_or_else(|p| std::panic::resume_unwind(p))
        };
        (tokenizer, join(encoder), join(decoder))
    });
    Ok((tokenizer?, encoder?, decoder?))
}

/// ORT 的一次解码会话：编码器输出、全部 past，以及本步暂存的 present。
pub struct OrtSession {
    /// 交叉注意力 mask，`[rows, src_len]` 全 1。
    mask: Vec<i64>,
    /// 展平的编码器隐层，`[rows, src_len, hidden_dim]`。
    hidden: Vec<f32>,
    /// batch 行数。
    rows: usize,
    /// 源序列长度。
    src_len: usize,
    /// 隐层维度。
    hidden_dim: usize,
    /// 与 `past_names` 对齐的 KV 缓存。
    past: Vec<DynValue>,
    /// 本步产生、等 `commit` 的 present（与 `past_names` 对齐，缺失为 `None`）。
    pending: Vec<Option<DynValue>>,
}

/// ORT 后端：持有编码器与合并解码器会话。
pub struct OrtRunner {
    /// 编码器会话。
    encoder: Session,
    /// 合并解码器会话。
    decoder: Session,
    /// 解码器的 `past_key_values.*` 输入名（保持模型顺序）。
    past_names: Vec<String>,
    /// KV 头数。
    kv_heads: i64,
    /// KV 每头维度。
    kv_head_dim: i64,
    /// 编码器是否接受 `attention_mask`。
    encoder_takes_mask: bool,
    /// 解码起始 token（空跑收缩内存用）。
    start_token: i64,
    /// 编码器隐层维度（从解码器输入形状读出，用于收缩内存的空跑）。
    hidden_dim: Option<usize>,
    /// 每个请求结束后是否收缩 arena。
    trim_after_request: bool,
}

impl OrtRunner {
    /// 由两个已建好的会话探测解码器结构并构造。
    ///
    /// # 参数
    /// - `encoder`/`decoder`：编码器与合并解码器会话。
    /// - `manifest`：清单（取 `trim_after_request`）。
    /// - `start_token`：解码起始 token。
    ///
    /// # 返回
    /// 就绪的 runner；解码器缺必需输入或推不出 KV 维度返回 `LoadFailed`。
    fn new(
        encoder: Session,
        decoder: Session,
        manifest: &Manifest,
        start_token: i64,
    ) -> Result<Self, TranslateError> {
        let dec_names: Vec<&str> = decoder.inputs().iter().map(|o| o.name()).collect();
        for required in DECODER_REQUIRED_INPUTS {
            if !dec_names.contains(&required) {
                return Err(TranslateError::new(
                    ErrorKind::LoadFailed,
                    format!(
                        "decoder has no `{required}` input; a merged decoder (with KV cache) is required"
                    ),
                ));
            }
        }
        let past_names: Vec<String> = dec_names
            .iter()
            .filter(|n| n.starts_with(PAST_PREFIX))
            .map(|n| n.to_string())
            .collect();
        let dims = decoder
            .inputs()
            .iter()
            .find(|o| o.name().starts_with(PAST_PREFIX))
            .and_then(|o| match o.dtype() {
                ValueType::Tensor { shape, .. } => kv_dims(shape),
                _ => None,
            });
        let (kv_heads, kv_head_dim) = dims.ok_or_else(|| {
            TranslateError::new(
                ErrorKind::LoadFailed,
                "cannot infer KV cache head dimensions from decoder inputs",
            )
        })?;
        let hidden_dim = decoder
            .inputs()
            .iter()
            .find(|o| o.name() == ENCODER_HIDDEN_STATES)
            .and_then(|o| match o.dtype() {
                ValueType::Tensor { shape, .. } => shape.get(2).copied(),
                _ => None,
            })
            .filter(|&d| d > 0)
            .map(|d| d as usize);
        let encoder_takes_mask = encoder.inputs().iter().any(|o| o.name() == ATTENTION_MASK);
        Ok(Self {
            encoder,
            decoder,
            past_names,
            kv_heads,
            kv_head_dim,
            encoder_takes_mask,
            start_token,
            hidden_dim,
            trim_after_request: manifest.execution.trim_after_request,
        })
    }

    /// 带收缩标记的最小解码器空跑。
    fn trim_run(&mut self, dim: usize) -> Result<(), ort::Error> {
        let mut opts = RunOptions::new()?;
        opts.set(ARENA_SHRINK_KEY, ARENA_SHRINK_VALUE)?;
        let hidden = vec![0f32; dim];
        let mut inputs: DecoderInputs<'_> = vec![
            (
                INPUT_IDS.into(),
                Tensor::from_array(([1usize, 1], vec![self.start_token]))?.into(),
            ),
            (
                ENCODER_ATTENTION_MASK.into(),
                Tensor::from_array(([1usize, 1], vec![1i64]))?.into(),
            ),
            (
                ENCODER_HIDDEN_STATES.into(),
                Tensor::from_array(([1usize, 1, dim], hidden))?.into(),
            ),
            (
                USE_CACHE_BRANCH.into(),
                Tensor::from_array(([1usize], vec![false]))?.into(),
            ),
        ];
        for name in &self.past_names {
            let empty = empty_kv(1, self.kv_heads as usize, self.kv_head_dim as usize)?;
            inputs.push((name.as_str().into(), empty.into()));
        }
        self.decoder.run_with_options(inputs, &opts)?;
        Ok(())
    }

    /// 运行编码器，返回展平的 `hidden[src_len * hidden_dim]` 与隐层维度。
    fn run_encoder(&mut self, input_ids: &[u32]) -> Result<(Vec<f32>, usize), TranslateError> {
        let src_len = input_ids.len();
        let ids_i64: Vec<i64> = input_ids.iter().map(|&x| x as i64).collect();
        let mut enc_inputs: Vec<(&str, DynValue)> = vec![(
            INPUT_IDS,
            Tensor::from_array(([1usize, src_len], ids_i64))
                .map_err(|e| decode_err(&e))?
                .into_dyn(),
        )];
        if self.encoder_takes_mask {
            enc_inputs.push((
                ATTENTION_MASK,
                Tensor::from_array(([1usize, src_len], vec![1i64; src_len]))
                    .map_err(|e| decode_err(&e))?
                    .into_dyn(),
            ));
        }
        let hidden: Vec<f32> = {
            let outputs = self.encoder.run(enc_inputs).map_err(|e| decode_err(&e))?;
            let (_, data) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| decode_err(&e))?;
            data.to_vec()
        };
        let hidden_dim = hidden.len() / src_len.max(1);
        Ok((hidden, hidden_dim))
    }
}

impl Seq2SeqRunner for OrtRunner {
    type Session = OrtSession;

    /// 编码一次；束搜索时把隐层按行复制 `rows` 份；past 全部置为序列维 0 的空张量。
    fn begin(&mut self, input_ids: &[u32], rows: usize) -> Result<OrtSession, TranslateError> {
        let src_len = input_ids.len();
        let (hidden1, hidden_dim) = self.run_encoder(input_ids)?;
        let hidden = if rows > 1 { hidden1.repeat(rows) } else { hidden1 };
        let mut past: Vec<DynValue> = Vec::new();
        fill_empty_past(
            &mut past,
            self.past_names.len(),
            rows,
            self.kv_heads as usize,
            self.kv_head_dim as usize,
        )?;
        Ok(OrtSession {
            mask: vec![1i64; src_len * rows],
            hidden,
            rows,
            src_len,
            hidden_dim,
            past,
            pending: Vec::new(),
        })
    }

    /// 跑一步合并解码器，取走 `present.*` 暂存；首步 `use_cache_branch` 为假。
    fn step(
        &mut self,
        s: &mut OrtSession,
        step: usize,
        tokens: &[i64],
        want_logits: bool,
    ) -> Result<Option<StepLogits>, TranslateError> {
        let enc = EncoderView {
            mask: &s.mask,
            hidden: &s.hidden,
            rows: s.rows,
            src_len: s.src_len,
            hidden_dim: s.hidden_dim,
        };
        let inputs = decoder_inputs(tokens, &enc, step > 0, &self.past_names, &s.past)?;
        let mut outputs = self.decoder.run(inputs).map_err(|e| decode_err(&e))?;
        let logits = if want_logits { Some(step_logits(&outputs, s.rows)?) } else { None };
        s.pending = self
            .past_names
            .iter()
            .map(|name| outputs.remove(name.replacen(PAST_PREFIX, PRESENT_PREFIX, 1)))
            .collect();
        Ok(logits)
    }

    /// 并入暂存的 present：交叉注意力 KV 只在首步采用；自注意力 KV 直接采用，给了 `reorder` 先按父束重排 batch 维。
    fn commit(
        &mut self,
        s: &mut OrtSession,
        step: usize,
        reorder: Option<&[usize]>,
    ) -> Result<(), TranslateError> {
        let pending = std::mem::take(&mut s.pending);
        for ((name, slot), present) in self.past_names.iter().zip(s.past.iter_mut()).zip(pending) {
            let Some(v) = present else {
                continue;
            };
            if name.contains(CROSS_ATTN_MARK) {
                if step == 0 {
                    *slot = v;
                }
                continue;
            }
            *slot = match reorder {
                None => v,
                Some(parents) => reorder_kv(&v, parents).map_err(|m| decode_err(&m))?,
            };
        }
        Ok(())
    }

    /// 未开启 `trim_after_request`、无法确定隐层维度或空跑失败时静默跳过（仅影响内存，不影响结果）。
    fn trim_memory(&mut self) {
        let Some(dim) = self.hidden_dim.filter(|_| self.trim_after_request) else {
            return;
        };
        let _ = self.trim_run(dim);
    }
}

impl Engine<OrtRunner> {
    /// 加载 ORT 格式模型并做自检；会话只建一次，之后任意语言对都用同一个引擎。
    ///
    /// # 参数
    /// - `dir`：模型目录（含 `model.json`）。
    /// - `env`：共享的 ORT 环境。
    /// - `threads`：算子线程数，0 取清单值（清单也为 0 则交给 ORT 自动）。
    ///
    /// # 返回
    /// 就绪的引擎；缺文件/清单非法/ORT 失败/OOM 均返回带类别的错误；清单 `format` 不是 ORT 格式返回 `LoadFailed`。
    ///
    /// # 示例
    /// ```ignore
    /// let mut engine = Engine::load(Path::new("/data/models/nllb"), &env, 4)?;
    /// ```
    pub fn load(dir: &Path, env: &Environment, threads: u32) -> Result<Self, TranslateError> {
        let manifest = Manifest::load(dir)?;
        if manifest.model_format()? != ModelFormat::OnnxMerged {
            return Err(TranslateError::new(
                ErrorKind::LoadFailed,
                "model.json format is not `onnx-merged`; load it with the MNN backend",
            ));
        }
        let gen_params = resolve_gen_params(&manifest, dir)?;
        let (tokenizer, encoder, decoder) = load_parts(&manifest, dir, env, threads)?;
        let runner = OrtRunner::new(encoder, decoder, &manifest, gen_params.start)?;
        Engine::new(manifest, gen_params, tokenizer, runner)
    }
}

/// 按父束下标重排一个 KV 张量的 batch 维（`[batch, heads, seq, dim]`）。
fn reorder_kv(value: &DynValue, parents: &[usize]) -> Result<DynValue, String> {
    let (shape, data) = value
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;
    let dims: Vec<usize> = shape.iter().map(|&d| d.max(0) as usize).collect();
    let batch = dims.first().copied().unwrap_or(0);
    if batch == 0 {
        return Err("KV tensor has an empty batch dimension".into());
    }
    let gathered = gather_rows(data, data.len() / batch, parents)
        .ok_or_else(|| "KV gather index out of range".to_string())?;
    let mut new_dims = dims;
    new_dims[0] = parents.len();
    Tensor::from_array((new_dims, gathered))
        .map(Tensor::into_dyn)
        .map_err(|e| e.to_string())
}

/// 清单的优化级别数字 → ORT 枚举（越界按最高级）。
fn opt_level(level: u8) -> GraphOptimizationLevel {
    match level {
        0 => GraphOptimizationLevel::Disable,
        1 => GraphOptimizationLevel::Level1,
        2 => GraphOptimizationLevel::Level2,
        _ => GraphOptimizationLevel::Level3,
    }
}

/// 构建 ORT 会话（CPU，优化级别/预打包/arena/内存模式按清单，线程数 `threads` 优先）。
///
/// 外部数据权重（`.onnx_data`）由 ORT 按 ONNX 里记录的 location 在同目录加载并内存映射。
fn build_session(
    env: &Environment,
    path: &Path,
    exec: &ExecutionOptions,
    threads: u32,
) -> Result<Session, TranslateError> {
    let fail = |e: &dyn fmt::Display| classify_error(&e.to_string(), ErrorKind::LoadFailed);
    let mut builder = Session::builder(env)
        .map_err(|e| fail(&e))?
        .with_optimization_level(opt_level(exec.opt_level))
        .map_err(|e| fail(&e))?;
    if !exec.prepacking {
        builder = builder.with_prepacking(false).map_err(|e| fail(&e))?;
    }
    let intra = if threads > 0 { threads as usize } else { exec.intra_threads };
    if intra > 0 {
        builder = builder.with_intra_threads(intra).map_err(|e| fail(&e))?;
    }
    if !exec.mem_pattern {
        builder = builder.with_memory_pattern(false).map_err(|e| fail(&e))?;
    }
    if !exec.cpu_arena {
        builder = builder
            .with_execution_providers([ep::CPU::default().with_arena_allocator(false).build()])
            .map_err(|e| fail(&e))?;
    }
    builder
        .commit_from_file(path)
        .map_err(|e| classify_error(&format!("{}: {e}", path.display()), ErrorKind::LoadFailed))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 优化级别映射：0..=3 对应，越界按最高级。
    #[test]
    fn opt_level_mapping() {
        assert!(matches!(opt_level(0), GraphOptimizationLevel::Disable));
        assert!(matches!(opt_level(1), GraphOptimizationLevel::Level1));
        assert!(matches!(opt_level(2), GraphOptimizationLevel::Level2));
        assert!(matches!(opt_level(3), GraphOptimizationLevel::Level3));
        assert!(matches!(opt_level(9), GraphOptimizationLevel::Level3));
    }

    /// KV 维度推断：正常 4 维取头数与维度，动态维返回 None。
    #[test]
    fn kv_dims_inference() {
        assert_eq!(kv_dims(&[-1, 16, -1, 64]), Some((16, 64)));
        assert_eq!(kv_dims(&[-1, -1, -1, 64]), None);
        assert_eq!(kv_dims(&[1, 2]), None);
    }
}
