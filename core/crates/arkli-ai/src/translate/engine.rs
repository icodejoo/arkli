// 移植自 Cisox snow-translator（GPL-3.0-only，作者本人）。
//! M2M100（NLLB）ONNX 推理引擎：encoder 一次 + merged decoder（KV cache）解码。
//!
//! 输入输出名以运行时 `session.inputs()/outputs()` 探测为准，不硬编码层数。
//! 束宽 1 走贪心；大于 1 走束搜索（batch 维 = 束宽，自注意力 KV 每步按父束重排，交叉注意力 KV 只在首步产生）。
//!
//! 张量名（optimum 导出的 merged decoder）：编码器 `input_ids`/`attention_mask` → `last_hidden_state`；
//! 解码器输入 `input_ids`、`encoder_attention_mask`、`encoder_hidden_states`、`use_cache_branch`
//! 与 `past_key_values.{层}.{decoder|encoder}.{key|value}`（形状 `[批, 16, 序列, 64]`），输出 `logits` 与 `present.*`。
//! 流程：编码器输入为 `[源语言码] + 词 + </s>`；解码器以 `</s>`（id 2）起步，第一个生成的 token 强制为目标语言码；
//! 译文解码前剔除特殊符号与语言码。

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::Arc;

use ort::environment::Environment;
use ort::ep;
use ort::session::{
    builder::GraphOptimizationLevel, RunOptions, Session, SessionInputValue, SessionOutputs,
};
use ort::value::{DynValue, Tensor, TensorRef, ValueType};
use serde_json::Value;
use tokenizers::Tokenizer;

use super::beam::{gather_rows, top_k_log_softmax, Advance, BeamSearch, Candidate};
use super::detect::{classify_segments, is_auto, summarize, SegLang};
use super::error::{ErrorKind, TranslateError};
use super::manifest::{
    ExecutionOptions, Manifest, ManifestError, DEFAULT_LENGTH_PENALTY, DEFAULT_MAX_NEW_TOKENS,
    DEFAULT_MIN_LENGTH_RATIO, DEFAULT_NO_REPEAT_NGRAM, DEFAULT_NUM_BEAMS, FILE_DECODER,
    FILE_ENCODER, FILE_TOKENIZER, MAX_BEAMS,
};
use super::text::{
    argmax_masked, chunk_ids, fill_empty_separators, is_cjk_lang, join_translated, output_token_budget, split_sentences,
    trim_tail_repeat,
};
use super::zh_punct::to_fullwidth_stateful;

/// Metaspace 词首标记。
const WORD_START_MARK: char = '\u{2581}';
/// 自检用的样例句。
const SELF_CHECK_TEXT: &str = "Hello world";
/// 判定内存不足的错误信息关键词（小写比较）。
const OOM_MARKERS: [&str; 6] = [
    "bad_alloc",
    "failed to allocate",
    "out of memory",
    "not enough memory",
    "os error 1455",
    "paging file",
];
/// 判定内存不足的中文关键词（Windows 中文系统错误信息）。
const OOM_MARKERS_ZH: [&str; 2] = ["页面文件", "内存不足"];
/// ORT 运行选项：让本次 Run 结束时收缩 CPU arena。
const ARENA_SHRINK_KEY: &str = "memory.enable_memory_arena_shrinkage";
/// 收缩的设备与 ID（`cpu:0`）。
const ARENA_SHRINK_VALUE: &str = "cpu:0";
/// M2M100 词表里的四个基础特殊符号。
const M2M_SPECIAL_TOKENS: [&str; 4] = ["<s>", "<pad>", "</s>", "<unk>"];
/// 束搜索每束取的候选数倍率（HF 取 2×束宽）。
const BEAM_CANDIDATE_FACTOR: usize = 2;
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

/// 按错误文本归类：内存不足优先，否则用调用方给的默认类别。
///
/// # 参数
/// - `message`：底层错误文本。
/// - `default`：非 OOM 时使用的类别。
///
/// # 返回
/// 归类后的 [`TranslateError`]。
///
/// # 示例
/// ```ignore
/// let e = classify_error("std::bad_alloc", ErrorKind::LoadFailed);
/// assert_eq!(e.kind, ErrorKind::OutOfMemory);
/// ```
pub fn classify_error(message: &str, default: ErrorKind) -> TranslateError {
    let lower = message.to_lowercase();
    let oom = OOM_MARKERS.iter().any(|m| lower.contains(m))
        || OOM_MARKERS_ZH.iter().any(|m| message.contains(m));
    let kind = if oom { ErrorKind::OutOfMemory } else { default };
    TranslateError::new(kind, message)
}

impl From<ManifestError> for TranslateError {
    /// 清单错误映射：缺失 → ModelMissing，非法 → ManifestInvalid。
    fn from(e: ManifestError) -> Self {
        match e {
            ManifestError::Missing(m) => Self::new(ErrorKind::ModelMissing, m),
            ManifestError::Invalid(m) => Self::new(ErrorKind::ManifestInvalid, m),
        }
    }
}

/// 修补 tokenizer.json：把 `precompiled_charsmap` 为 null 的 `Precompiled` 归一化器换成 NFKC。
///
/// tokenizers 0.23.2 遇到该 null 会直接 panic。
///
/// # 参数
/// - `node`：`normalizer` 节点（递归处理 `Sequence`）。
///
/// # 返回
/// 是否做过替换。
///
/// # 示例
/// ```ignore
/// let mut v: serde_json::Value = serde_json::from_str(json)?;
/// patch_null_precompiled(&mut v["normalizer"]);
/// ```
pub fn patch_null_precompiled(node: &mut Value) -> bool {
    let Some(obj) = node.as_object_mut() else {
        return false;
    };
    let kind = obj.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind == "Precompiled" && obj.get("precompiled_charsmap").is_some_and(Value::is_null) {
        *node = serde_json::json!({ "type": "NFKC" });
        return true;
    }
    if kind == "Sequence" {
        if let Some(list) = obj.get_mut("normalizers").and_then(Value::as_array_mut) {
            // 不能短路：每个子归一化器都要检查
            let mut patched = false;
            for n in list.iter_mut() {
                patched |= patch_null_precompiled(n);
            }
            return patched;
        }
    }
    false
}

/// 读取 tokenizer.json 并构造分词器（含 null charsmap 修补，panic 转错误）。
///
/// # 参数
/// - `path`：tokenizer.json 路径。
///
/// # 返回
/// 分词器；失败返回 `LoadFailed`。
///
/// # 示例
/// ```ignore
/// let tk = load_tokenizer(std::path::Path::new("tokenizer.json"))?;
/// ```
pub fn load_tokenizer(path: &Path) -> Result<Tokenizer, TranslateError> {
    let fail = |m: String| TranslateError::new(ErrorKind::LoadFailed, m);
    let raw = std::fs::read(path).map_err(|e| fail(format!("read {}: {e}", path.display())))?;
    let mut json: Value = serde_json::from_slice(&raw)
        .map_err(|e| fail(format!("tokenizer.json is not valid JSON: {e}")))?;
    // 及时释放中间副本，压低加载期峰值
    drop(raw);
    if let Some(n) = json.get_mut("normalizer") {
        patch_null_precompiled(n);
    }
    let bytes = serde_json::to_vec(&json).map_err(|e| fail(e.to_string()))?;
    drop(json);
    match catch_unwind(AssertUnwindSafe(|| Tokenizer::from_bytes(bytes))) {
        Ok(Ok(tk)) => Ok(tk),
        Ok(Err(e)) => Err(fail(format!("tokenizer.json rejected: {e}"))),
        Err(_) => Err(fail("tokenizer.json caused a panic in the tokenizers crate".into())),
    }
}

/// 单次翻译请求的可选参数。
///
/// # 示例
/// ```ignore
/// let opts = TranslateOptions { max_len: None, num_beams: Some(4) };
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TranslateOptions {
    /// 每个片段最多生成的 token 数，`None` 取模型缺省。
    pub max_len: Option<usize>,
    /// 束宽，`None` 取模型缺省。
    pub num_beams: Option<usize>,
}

/// 解码参数（清单 > generation_config.json > config.json）。
#[derive(Debug, Clone, PartialEq)]
pub struct GenParams {
    /// 解码起始 token。
    pub start: i64,
    /// 结束 token。
    pub eos: i64,
    /// 禁止生成的 token。
    pub banned: Vec<i64>,
    /// 缺省最大新生成 token 数。
    pub max_new: usize,
    /// 缺省束宽。
    pub num_beams: usize,
    /// 束搜索长度惩罚指数。
    pub length_penalty: f32,
    /// 束搜索禁止重复的 n-gram 长度（0 关闭）。
    pub no_repeat_ngram: usize,
    /// 最小输出长度占输入 token 数的比例（0 关闭）。
    pub min_length_ratio: f32,
}

/// M2M100 族的语言配置（由清单 `lang_tokens` 与分词器词表解析而来）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct M2mConfig {
    /// 第一个生成位强制输出的 token（目标语言码 id）。
    pub forced_first: u32,
    /// 目标语言的 FLORES 码（如 `zho_Hans`），用于选择译文后处理。
    pub tgt_code: String,
    /// 译文解码前剔除的 id（升序去重）：`<s>`、`<pad>`、`</s>`、`<unk>` 与全部语言码。
    pub drop_ids: Vec<u32>,
}

/// 解析 M2M100 的语言 id：源语言码前缀、强制的目标语言码、需剔除的特殊 id。
///
/// # 参数
/// - `manifest`：模型清单（`lang_tokens`：应用语言码 → FLORES 码）。
/// - `tokenizer`：词表里必须直接含有这些语言码 token。
/// - `src`/`tgt`：源、目标语言码（应用侧写法，如 `zh-CN`）。
///
/// # 返回
/// `(源文本前缀 id 列表, M2mConfig)`；清单缺项返回 `UnsupportedPair`，词表缺 token 返回 `ManifestInvalid`。
///
/// # 示例
/// ```ignore
/// let (prefix, cfg) = resolve_m2m_langs(&manifest, &tokenizer, "zh-CN", "en")?;
/// ```
pub fn resolve_m2m_langs(
    manifest: &Manifest,
    tokenizer: &Tokenizer,
    src: &str,
    tgt: &str,
) -> Result<(Vec<u32>, M2mConfig), TranslateError> {
    let id_of = |lang: &str| -> Result<u32, TranslateError> {
        let token = manifest
            .lang_token_for(lang)
            .map_err(|m| TranslateError::new(ErrorKind::UnsupportedPair, m))?;
        tokenizer.token_to_id(token).ok_or_else(|| {
            TranslateError::new(
                ErrorKind::ManifestInvalid,
                format!("language token `{token}` is not in the tokenizer vocabulary"),
            )
        })
    };
    let src_id = id_of(src)?;
    let forced_first = id_of(tgt)?;
    let tgt_code = manifest
        .lang_token_for(tgt)
        .map_err(|m| TranslateError::new(ErrorKind::UnsupportedPair, m))?
        .to_string();
    let mut drop_ids: Vec<u32> = M2M_SPECIAL_TOKENS
        .iter()
        .filter_map(|t| tokenizer.token_to_id(t))
        .chain(
            manifest
                .lang_tokens
                .values()
                .filter_map(|t| tokenizer.token_to_id(t)),
        )
        .collect();
    drop_ids.sort_unstable();
    drop_ids.dedup();
    Ok((
        vec![src_id],
        M2mConfig {
            forced_first,
            tgt_code,
            drop_ids,
        },
    ))
}

/// NLLB 译文片段的标点后处理：目标为 zho_Hans/zho_Hant/jpn_Jpan 时半角标点转全角，其余目标原样。
///
/// # 参数
/// - `text`：片段译文。
/// - `cfg`：M2M100 配置（取目标语言码）。
/// - `quotes`：跨片段共享的引号计数，首个片段传 0。
///
/// # 返回
/// 处理后的译文。
///
/// # 示例
/// ```ignore
/// let mut q = 0;
/// assert_eq!(postprocess_m2m("你好,世界.", &cfg_zho_hans, &mut q), "你好，世界。");
/// ```
pub fn postprocess_m2m(text: &str, cfg: &M2mConfig, quotes: &mut usize) -> String {
    to_fullwidth_stateful(text, &cfg.tgt_code, quotes)
}

/// 最小输出长度：`ceil(比例 × 输入 token 数)`，比例 ≤ 0 时为 0。
///
/// # 参数
/// - `ratio`：比例。
/// - `input_len`：编码器输入 token 数（含语言码与结束符）。
///
/// # 返回
/// 生成步数（含强制的语言码）不足该值时禁止结束符。
///
/// # 示例
/// ```ignore
/// assert_eq!(min_output_len(0.5, 11), 6);
/// ```
pub fn min_output_len(ratio: f32, input_len: usize) -> usize {
    if ratio <= 0.0 {
        return 0;
    }
    (ratio * input_len as f32).ceil() as usize
}

/// 强制位的候选：每条存活束只有指定 token，对数概率 0（与 HF 的 `forced_bos_token_id` 一致）。
///
/// # 参数
/// - `alive`：存活束数量。
/// - `token`：强制输出的 token（目标语言码 id）。
///
/// # 返回
/// 与存活束等长的候选表，可直接交给 `BeamSearch::advance`。
///
/// # 示例
/// ```ignore
/// let cands = forced_candidates(1, 101233);
/// ```
pub fn forced_candidates(alive: usize, token: u32) -> Vec<Vec<Candidate>> {
    (0..alive).map(|_| vec![(token, 0.0)]).collect()
}

/// 取一行 logits 的前 `k` 个候选；`block_eos` 给出结束符时把它从候选里剔除
/// （归一化仍含它，与 HF 先 log-softmax 再屏蔽的顺序一致）。
///
/// # 参数
/// - `row`：一行词表 logits。
/// - `banned`：禁止的 token。
/// - `k`：保留候选数。
/// - `block_eos`：需要屏蔽的结束符 id。
///
/// # 返回
/// 最多 `k` 项的 `(token, 对数概率)`，降序。
///
/// # 示例
/// ```ignore
/// let c = masked_top_k(&logits, &[], 4, Some(2));
/// ```
pub fn masked_top_k(
    row: &[f32],
    banned: &[i64],
    k: usize,
    block_eos: Option<u32>,
) -> Vec<Candidate> {
    let extra = usize::from(block_eos.is_some());
    let mut c = top_k_log_softmax(row, banned, k + extra);
    if let Some(eos) = block_eos {
        c.retain(|&(t, _)| t != eos);
        c.truncate(k);
    }
    c
}

/// 解析生效的束宽：请求值优先，其次模型缺省；必须落在 `1..=MAX_BEAMS`。
///
/// # 参数
/// - `requested`：请求指定的束宽。
/// - `default`：模型缺省束宽。
///
/// # 返回
/// 生效束宽；越界返回 `BadRequest`。
///
/// # 示例
/// ```ignore
/// assert_eq!(resolve_beams(Some(4), 2)?, 4);
/// ```
pub fn resolve_beams(requested: Option<usize>, default: usize) -> Result<usize, TranslateError> {
    let beams = requested.unwrap_or(default);
    if (1..=MAX_BEAMS).contains(&beams) {
        Ok(beams)
    } else {
        Err(TranslateError::new(
            ErrorKind::BadRequest,
            format!("num_beams={beams} out of range 1..={MAX_BEAMS}"),
        ))
    }
}

/// 从 JSON 里取整数字段。
fn json_i64(v: &Option<Value>, key: &str) -> Option<i64> {
    v.as_ref()?.get(key)?.as_i64()
}

/// 读取可选 JSON 文件。
fn read_json_opt(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// 汇总解码参数。
///
/// # 参数
/// - `manifest`：模型清单。
/// - `dir`：模型目录（读取同目录 generation_config.json / config.json 补缺）。
///
/// # 返回
/// [`GenParams`]；缺起始/结束 token 时返回 `ManifestInvalid`。
///
/// # 示例
/// ```ignore
/// let g = resolve_gen_params(&manifest, dir)?;
/// ```
pub fn resolve_gen_params(manifest: &Manifest, dir: &Path) -> Result<GenParams, TranslateError> {
    let gen_cfg = read_json_opt(&dir.join("generation_config.json"));
    let cfg = read_json_opt(&dir.join("config.json"));
    let g = &manifest.generation;
    let pick = |own: Option<i64>, key: &str| {
        own.or_else(|| json_i64(&gen_cfg, key))
            .or_else(|| json_i64(&cfg, key))
    };
    let start = pick(g.decoder_start_token_id, "decoder_start_token_id");
    let eos = pick(g.eos_token_id, "eos_token_id");
    let pad = pick(g.pad_token_id, "pad_token_id");
    let (Some(start), Some(eos)) = (start, eos) else {
        return Err(TranslateError::new(
            ErrorKind::ManifestInvalid,
            "decoder_start_token_id / eos_token_id missing in model.json, generation_config.json and config.json",
        ));
    };
    let banned = match &g.bad_token_ids {
        Some(list) => list.clone(),
        None => {
            // bad_words_ids 形如 [[65000]]，只取单 token 项
            let from_json = gen_cfg
                .as_ref()
                .and_then(|v| v.get("bad_words_ids"))
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(|r| r.as_array().filter(|a| a.len() == 1))
                        .filter_map(|a| a[0].as_i64())
                        .collect::<Vec<_>>()
                });
            from_json.unwrap_or_else(|| pad.into_iter().collect())
        }
    };
    Ok(GenParams {
        start,
        eos,
        banned,
        max_new: g.max_new_tokens.unwrap_or(DEFAULT_MAX_NEW_TOKENS),
        num_beams: g.num_beams.unwrap_or(DEFAULT_NUM_BEAMS),
        length_penalty: g.length_penalty.unwrap_or(DEFAULT_LENGTH_PENALTY),
        no_repeat_ngram: g.no_repeat_ngram_size.unwrap_or(DEFAULT_NO_REPEAT_NGRAM),
        min_length_ratio: g.min_length_ratio.unwrap_or(DEFAULT_MIN_LENGTH_RATIO),
    })
}

/// 引擎一次翻译的输出。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineOutput {
    /// 译文（无法识别的句子原样在内）。
    pub text: String,
    /// 识别出的源语言（应用码，按出现顺序去重）；非 auto 时为 `[src]`。
    pub detected: Vec<String>,
    /// 是否有句子因无法识别而原样放进输出；非 auto 时恒为 false。
    pub unrecognized: bool,
}

/// 一个语言对的解码计划：语言 token 前缀、M2M100 配置与 CJK 标记。
///
/// 由 [`build_plan`] 按请求计算（很便宜），[`Engine`] 按语言对缓存；会话本身与语言无关。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LangPlan {
    /// 每个源文本片段前置的语言 token id（源语言码）。
    prefix_ids: Vec<u32>,
    /// M2M100 的语言配置。
    m2m: M2mConfig,
    /// 目标语言是否为 CJK。
    cjk_target: bool,
}

/// 计算一个语言对的解码计划。
///
/// # 参数
/// - `manifest`：模型清单。
/// - `tokenizer`：分词器（取语言 token 的 id）。
/// - `src`/`tgt`：语言对（应用侧写法）。
///
/// # 返回
/// 清单不支持该语言对返回 `UnsupportedPair`，词表缺语言 token 返回 `ManifestInvalid`。
///
/// # 示例
/// ```ignore
/// let plan = build_plan(&manifest, &tokenizer, "en", "zh-CN")?;
/// ```
pub fn build_plan(
    manifest: &Manifest,
    tokenizer: &Tokenizer,
    src: &str,
    tgt: &str,
) -> Result<LangPlan, TranslateError> {
    if !manifest.supports_pair(src, tgt) {
        return Err(unsupported_pair(manifest, src, tgt));
    }
    let (prefix_ids, m2m) = resolve_m2m_langs(manifest, tokenizer, src, tgt)?;
    Ok(LangPlan {
        prefix_ids,
        m2m,
        cjk_target: is_cjk_lang(tgt),
    })
}

/// 构造“模型不支持该语言对”的错误。
fn unsupported_pair(manifest: &Manifest, src: &str, tgt: &str) -> TranslateError {
    TranslateError::new(
        ErrorKind::UnsupportedPair,
        format!("model `{}` does not support {src} -> {tgt}", manifest.id),
    )
}

/// 已加载的翻译引擎（与语言对无关，语言对随每次翻译指定）。
pub struct Engine {
    /// 编码器会话。
    encoder: Session,
    /// 合并解码器会话。
    decoder: Session,
    /// 分词器。
    tokenizer: Tokenizer,
    /// 解码参数。
    gen_params: GenParams,
    /// 模型清单（按请求解析语言对时用）。
    manifest: Manifest,
    /// 已解析的语言对计划缓存（键为小写 `(src, tgt)`；只缓存清单支持的语言对，数量有界）。
    plans: HashMap<(String, String), Arc<LangPlan>>,
    /// 解码器的 `past_key_values.*` 输入名（保持模型顺序）。
    past_names: Vec<String>,
    /// KV 头数。
    kv_heads: i64,
    /// KV 每头维度。
    kv_head_dim: i64,
    /// 编码器是否接受 `attention_mask`。
    encoder_takes_mask: bool,
    /// 最大输入 token 数。
    max_input_tokens: usize,
    /// 模型 ID。
    model_id: String,
    /// 编码器隐层维度（从解码器输入形状读出，用于收缩内存的空跑）。
    hidden_dim: Option<usize>,
    /// 每个请求结束后是否收缩 arena。
    trim_after_request: bool,
}

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

/// 把推理期底层错误归为解码失败（内存不足优先）。
fn decode_err(e: &dyn fmt::Display) -> TranslateError {
    classify_error(&e.to_string(), ErrorKind::DecodeFailed)
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

/// 取 `logits` 输出：校验非空且至少含 `rows` 行，返回整块数据与词表大小。
fn step_logits<'o>(
    outputs: &'o SessionOutputs<'_>,
    rows: usize,
) -> Result<(&'o [f32], usize), TranslateError> {
    let (shape, logits) = outputs["logits"]
        .try_extract_tensor::<f32>()
        .map_err(|e| decode_err(&e))?;
    let vocab = shape.last().copied().unwrap_or(0).max(0) as usize;
    if vocab == 0 || logits.len() < vocab * rows {
        return Err(TranslateError::new(
            ErrorKind::DecodeFailed,
            "decoder returned empty logits",
        ));
    }
    Ok((logits, vocab))
}

/// 把本步 `present.*` 搬回 `past`：交叉注意力 KV 只在首步采用；
/// 自注意力 KV 直接采用，`reorder` 给出父束下标时先按其重排 batch 维。
fn store_present(
    past_names: &[String],
    past: &mut [DynValue],
    outputs: &mut SessionOutputs<'_>,
    step: usize,
    reorder: Option<&[usize]>,
) -> Result<(), TranslateError> {
    for (name, slot) in past_names.iter().zip(past.iter_mut()) {
        let present = name.replacen(PAST_PREFIX, PRESENT_PREFIX, 1);
        let Some(v) = outputs.remove(&present) else {
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

impl Engine {
    /// 加载模型并做自检；会话只建一次，之后任意语言对都用同一个引擎。
    ///
    /// # 参数
    /// - `dir`：模型目录（含 `model.json`）。
    /// - `env`：共享的 ORT 环境。
    /// - `threads`：算子线程数，0 取清单值（清单也为 0 则交给 ORT 自动）。
    ///
    /// # 返回
    /// 就绪的引擎；缺文件/清单非法/ORT 失败/OOM 均返回带类别的错误。
    ///
    /// # 示例
    /// ```ignore
    /// let mut engine = Engine::load(Path::new("/data/models/nllb"), &env, 4)?;
    /// ```
    pub fn load(dir: &Path, env: &Environment, threads: u32) -> Result<Self, TranslateError> {
        let manifest = Manifest::load(dir)?;
        let gen_params = resolve_gen_params(&manifest, dir)?;
        let (tokenizer, encoder, decoder) = load_parts(&manifest, dir, env, threads)?;

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

        let engine = Self {
            encoder,
            decoder,
            tokenizer,
            gen_params,
            max_input_tokens: manifest.max_input_tokens,
            model_id: manifest.id.clone(),
            trim_after_request: manifest.execution.trim_after_request,
            manifest,
            plans: HashMap::new(),
            past_names,
            kv_heads,
            kv_head_dim,
            encoder_takes_mask,
            hidden_dim,
        };
        engine.self_check()?;
        Ok(engine)
    }

    /// 取（必要时计算并缓存）一个语言对的解码计划。
    ///
    /// 只有清单支持的语言对才会进缓存，所以缓存大小有界。
    fn plan_for(&mut self, src: &str, tgt: &str) -> Result<Arc<LangPlan>, TranslateError> {
        let key = (src.to_ascii_lowercase(), tgt.to_ascii_lowercase());
        if let Some(plan) = self.plans.get(&key) {
            return Ok(Arc::clone(plan));
        }
        let plan = Arc::new(build_plan(&self.manifest, &self.tokenizer, src, tgt)?);
        self.plans.insert(key, Arc::clone(&plan));
        Ok(plan)
    }

    /// 模型 ID。
    ///
    /// # 返回
    /// 清单中的 `id`。
    pub fn model_id(&self) -> &str {
        &self.model_id
    }

    /// 是否支持某个有向语言对。
    ///
    /// # 参数
    /// - `src`/`tgt`：应用语言码。
    ///
    /// # 返回
    /// 清单支持返回 `true`。
    pub fn supports_pair(&self, src: &str, tgt: &str) -> bool {
        self.manifest.supports_pair(src, tgt)
    }

    /// 缺省束宽（来自清单）。
    ///
    /// # 返回
    /// 请求不指定束宽时使用的值。
    pub fn default_beams(&self) -> usize {
        self.gen_params.num_beams
    }

    /// 请求结束后的内存收缩：对解码器做一次最小空跑并要求 ORT 收缩 CPU arena。
    ///
    /// 未开启 `trim_after_request`、无法确定隐层维度或空跑失败时静默跳过（仅影响内存，不影响结果）。
    pub fn trim_memory(&mut self) {
        let Some(dim) = self.hidden_dim.filter(|_| self.trim_after_request) else {
            return;
        };
        let _ = self.trim_run(dim);
    }

    /// 带收缩标记的最小解码器空跑。
    fn trim_run(&mut self, dim: usize) -> Result<(), ort::Error> {
        let mut opts = RunOptions::new()?;
        opts.set(ARENA_SHRINK_KEY, ARENA_SHRINK_VALUE)?;
        let hidden = vec![0f32; dim];
        let mut inputs: DecoderInputs<'_> = vec![
            (
                INPUT_IDS.into(),
                Tensor::from_array(([1usize, 1], vec![self.gen_params.start]))?.into(),
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

    /// 分词器回环自检：样例句 encode→decode 应还原出原词。
    fn self_check(&self) -> Result<(), TranslateError> {
        let fail = |m: String| TranslateError::new(ErrorKind::LoadFailed, m);
        let enc = self
            .tokenizer
            .encode(SELF_CHECK_TEXT, false)
            .map_err(|e| fail(format!("tokenizer self-check encode failed: {e}")))?;
        let back = self
            .tokenizer
            .decode(enc.get_ids(), true)
            .map_err(|e| fail(format!("tokenizer self-check decode failed: {e}")))?;
        if enc.get_ids().is_empty() || back.trim() != SELF_CHECK_TEXT {
            return Err(fail(format!(
                "tokenizer round-trip mismatch: {SELF_CHECK_TEXT:?} -> {back:?}"
            )));
        }
        Ok(())
    }

    /// 翻译一段文本：分句、超长切块、逐片段解码，再按原分隔符拼回。
    ///
    /// # 参数
    /// - `text`：原文，可含多句与换行。
    /// - `src`/`tgt`：本次的语言对（应用侧写法）；`src` 为 `auto` 时按句识别源语言（见 `detect` 模块）。
    /// - `opts`：最大生成长度与束宽（`None` 取模型缺省）。
    ///
    /// # 返回
    /// [`EngineOutput`]：译文（无法识别的句子原样保留）、识别出的语言、是否有无法识别的句子。
    /// 空白文本原样返回。束宽越界返回 `BadRequest`，清单不支持该语言对（auto 时为目标语言）返回 `UnsupportedPair`，
    /// 推理失败返回 `DecodeFailed`/`OutOfMemory`。
    ///
    /// # 示例
    /// ```ignore
    /// let zh = engine.translate("Hello world. How are you?", "en", "zh-CN", &TranslateOptions::default())?.text;
    /// ```
    pub fn translate(
        &mut self,
        text: &str,
        src: &str,
        tgt: &str,
        opts: &TranslateOptions,
    ) -> Result<EngineOutput, TranslateError> {
        let beams = resolve_beams(opts.num_beams, self.gen_params.num_beams)?;
        let auto = is_auto(src);
        let supported = self.manifest.supported_languages();
        if auto && !supported.iter().any(|l| l.eq_ignore_ascii_case(tgt)) {
            return Err(unsupported_pair(&self.manifest, src, tgt));
        }
        let first_plan = if auto { None } else { Some(self.plan_for(src, tgt)?) };
        let segments = split_sentences(text);
        if segments.is_empty() {
            return Ok(EngineOutput { text: text.to_string(), detected: vec![], unrecognized: false });
        }
        let kinds = if auto {
            classify_segments(&segments, &supported, tgt)
        } else {
            vec![SegLang::Translate(src.to_string()); segments.len()]
        };
        let (detected, unrecognized) = if auto { summarize(&kinds) } else { (vec![src.to_string()], false) };
        let cap = opts.max_len.unwrap_or(self.gen_params.max_new).max(1);
        let mut parts = Vec::with_capacity(segments.len());
        // 全角标点后处理在片段间共享引号计数，跨句的引号才能成对
        let mut quotes = 0usize;
        for (seg, kind) in segments.into_iter().zip(kinds) {
            let translated = match kind {
                SegLang::Translate(lang) => {
                    let plan = match &first_plan {
                        Some(p) => Arc::clone(p),
                        None => self.plan_for(&lang, tgt)?,
                    };
                    let t = self.translate_segment(&seg.text, cap, beams, &plan)?;
                    postprocess_m2m(&t, &plan.m2m, &mut quotes)
                }
                SegLang::Keep(_) | SegLang::Unknown => seg.text,
            };
            parts.push((translated, seg.sep));
        }
        let cjk_target = is_cjk_lang(tgt);
        fill_empty_separators(&mut parts, cjk_target);
        let out = join_translated(&parts, cjk_target);
        self.trim_memory();
        Ok(EngineOutput { text: out, detected, unrecognized })
    }

    /// 翻译一个句级片段；超过输入上限时按 token 切块分别翻译。
    fn translate_segment(
        &mut self,
        text: &str,
        cap: usize,
        beams: usize,
        plan: &LangPlan,
    ) -> Result<String, TranslateError> {
        let ids: Vec<u32> = self
            .tokenizer
            .encode(text, false)
            .map_err(|e| {
                TranslateError::new(ErrorKind::DecodeFailed, format!("tokenize failed: {e}"))
            })?
            .get_ids()
            .to_vec();
        if ids.is_empty() {
            return Ok(text.to_string());
        }
        // 预留 eos 与语言前缀的位置
        let limit = self
            .max_input_tokens
            .saturating_sub(1 + plan.prefix_ids.len())
            .max(1);
        let tokenizer = &self.tokenizer;
        let chunks = chunk_ids(&ids, limit, |id| {
            tokenizer
                .id_to_token(id)
                .is_some_and(|t| t.starts_with(WORD_START_MARK))
        });
        let eos = self.gen_params.eos as u32;
        let mut pieces = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            let mut input = plan.prefix_ids.clone();
            input.extend_from_slice(&chunk);
            input.push(eos);
            // 强制的语言码占第一个生成步
            let budget = output_token_budget(chunk.len(), cap) + 1;
            let forced = plan.m2m.forced_first;
            let out = if beams > 1 {
                self.generate_beam(&input, budget, beams, forced)?
            } else {
                self.generate(&input, budget, forced)?
            };
            let decoded = self.detokenize(&out, &plan.m2m)?;
            pieces.push(decoded.trim().to_string());
        }
        let joiner = if plan.cjk_target { "" } else { " " };
        Ok(pieces.join(joiner))
    }

    /// 把生成的 id 还原成文本：先剔除特殊符号与语言码（`drop_ids` 已升序去重，二分查找）。
    fn detokenize(&self, ids: &[u32], cfg: &M2mConfig) -> Result<String, TranslateError> {
        let kept: Vec<u32> = ids
            .iter()
            .copied()
            .filter(|id| cfg.drop_ids.binary_search(id).is_err())
            .collect();
        self.tokenizer.decode(&kept, false).map_err(|e| {
            TranslateError::new(ErrorKind::DecodeFailed, format!("detokenize failed: {e}"))
        })
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

    /// 束搜索生成：batch 维 = 束宽，首步所有束同输入，仅第 0 束参与选择。
    fn generate_beam(
        &mut self,
        input_ids: &[u32],
        max_new: usize,
        width: usize,
        forced: u32,
    ) -> Result<Vec<u32>, TranslateError> {
        let src_len = input_ids.len();
        let (hidden1, hidden_dim) = self.run_encoder(input_ids)?;
        let hidden = hidden1.repeat(width);
        drop(hidden1);
        let mask = vec![1i64; src_len * width];

        let mut past: Vec<DynValue> = Vec::new();
        fill_empty_past(
            &mut past,
            self.past_names.len(),
            width,
            self.kv_heads as usize,
            self.kv_head_dim as usize,
        )?;
        let enc = EncoderView {
            mask: &mask,
            hidden: &hidden,
            rows: width,
            src_len,
            hidden_dim,
        };

        let gp = &self.gen_params;
        let min_len = min_output_len(gp.min_length_ratio, src_len).min(max_new.saturating_sub(1));
        let mut search = BeamSearch::new(
            width,
            gp.eos as u32,
            gp.length_penalty,
            max_new,
            gp.no_repeat_ngram,
        );
        // 每条存活束的下一步输入 token；不足 width 的行用第 0 行补齐
        let mut current: Vec<i64> = vec![gp.start; width];
        for step in 0..max_new {
            let inputs = decoder_inputs(&current, &enc, step > 0, &self.past_names, &past)?;
            let mut outputs = self.decoder.run(inputs).map_err(|e| decode_err(&e))?;

            let cands: Vec<Vec<Candidate>> = if step == 0 {
                // 首个生成位强制为目标语言码，本步 logits 不参与选择
                forced_candidates(search.alive_len(), forced)
            } else {
                let block_eos = (step < min_len).then_some(gp.eos as u32);
                let (logits, vocab) = step_logits(&outputs, width)?;
                // 每行取最后一个位置（序列长度恒为 1）
                let row_stride = logits.len() / width;
                (0..search.alive_len())
                    .map(|b| {
                        let row = &logits[b * row_stride..(b + 1) * row_stride];
                        masked_top_k(
                            &row[row.len() - vocab..],
                            &gp.banned,
                            BEAM_CANDIDATE_FACTOR * width,
                            block_eos,
                        )
                    })
                    .collect()
            };
            let (parents, tokens) = match search.advance(&cands) {
                Advance::Done => break,
                Advance::Continue { parents, tokens } => (parents, tokens),
            };
            // 补齐到 width 行：多余行复用第 0 行（其 logits 不会被读取）
            let mut parents_full = parents.clone();
            parents_full.resize(width, parents[0]);
            current = tokens.iter().map(|&t| t as i64).collect();
            current.resize(width, current[0]);

            let identity = parents_full.iter().enumerate().all(|(i, &p)| i == p);
            let reorder = (!identity).then_some(parents_full.as_slice());
            store_present(&self.past_names, &mut past, &mut outputs, step, reorder)?;
        }
        Ok(search.best())
    }

    /// 贪心生成：encoder 一次，decoder 循环直到 eos / 预算 / 退化重复。
    fn generate(
        &mut self,
        input_ids: &[u32],
        max_new: usize,
        forced: u32,
    ) -> Result<Vec<u32>, TranslateError> {
        let src_len = input_ids.len();
        let mask = vec![1i64; src_len];
        let (hidden, hidden_dim) = self.run_encoder(input_ids)?;

        // 初始 past：序列维为 0 的空张量
        let mut past: Vec<DynValue> = Vec::new();
        fill_empty_past(
            &mut past,
            self.past_names.len(),
            1,
            self.kv_heads as usize,
            self.kv_head_dim as usize,
        )?;
        let enc = EncoderView {
            mask: &mask,
            hidden: &hidden,
            rows: 1,
            src_len,
            hidden_dim,
        };

        let gp = &self.gen_params;
        let min_len = min_output_len(gp.min_length_ratio, src_len).min(max_new.saturating_sub(1));
        // 最小长度内额外禁止结束符：不变量，提到循环外只建一次
        let mut banned_no_eos = gp.banned.clone();
        banned_no_eos.push(gp.eos);
        let mut generated: Vec<u32> = Vec::new();
        let mut current = gp.start;
        for step in 0..max_new {
            let inputs = decoder_inputs(&[current], &enc, step > 0, &self.past_names, &past)?;

            let mut outputs = self.decoder.run(inputs).map_err(|e| decode_err(&e))?;
            let next = if step == 0 {
                // 首个生成位强制为目标语言码
                forced as i64
            } else {
                let (logits, vocab) = step_logits(&outputs, 1)?;
                let last = &logits[logits.len() - vocab..];
                let banned = if step < min_len {
                    &banned_no_eos
                } else {
                    &gp.banned
                };
                argmax_masked(last, banned).ok_or_else(|| {
                    TranslateError::new(ErrorKind::DecodeFailed, "no selectable token in logits")
                })? as i64
            };
            if next == gp.eos {
                break;
            }
            // 更新 KV：编码器侧 KV 只在第一步采用
            store_present(&self.past_names, &mut past, &mut outputs, step, None)?;
            generated.push(next as u32);
            if trim_tail_repeat(&mut generated) {
                break;
            }
            current = next;
        }
        Ok(generated)
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
    use crate::translate::manifest::GenerationOverride;
    use std::path::PathBuf;

    /// 构造最小 m2m100 清单。
    fn manifest_with(gen_override: GenerationOverride) -> Manifest {
        Manifest {
            schema_version: 1,
            id: "m".into(),
            display_name: String::new(),
            family: "m2m100".into(),
            quantization: String::new(),
            files: HashMap::new(),
            languages: vec![],
            max_input_tokens: 512,
            pairs: None,
            lang_tokens: HashMap::new(),
            generation: gen_override,
            execution: Default::default(),
        }
    }

    /// 创建临时目录并写入若干文件。
    fn temp_dir_with(tag: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arkli-translate-eng-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (n, c) in files {
            std::fs::write(dir.join(n), c).unwrap();
        }
        dir
    }

    /// OOM 关键词（中英文）归类为 OutOfMemory，其余保持默认。
    #[test]
    fn classifies_oom() {
        assert_eq!(
            classify_error("std::bad_alloc", ErrorKind::LoadFailed).kind,
            ErrorKind::OutOfMemory
        );
        assert_eq!(
            classify_error("Failed to allocate 1GB", ErrorKind::DecodeFailed).kind,
            ErrorKind::OutOfMemory
        );
        assert_eq!(
            classify_error("页面文件太小 (os error 1455)", ErrorKind::LoadFailed).kind,
            ErrorKind::OutOfMemory
        );
        assert_eq!(
            classify_error("invalid protobuf", ErrorKind::LoadFailed).kind,
            ErrorKind::LoadFailed
        );
    }

    /// null 的 Precompiled 被换成 NFKC，含 Sequence 内嵌套；有 charsmap 的保持不变。
    #[test]
    fn patches_null_precompiled() {
        let mut v = serde_json::json!({"type":"Precompiled","precompiled_charsmap":null});
        assert!(patch_null_precompiled(&mut v));
        assert_eq!(v, serde_json::json!({"type":"NFKC"}));

        let mut seq = serde_json::json!({"type":"Sequence","normalizers":[
            {"type":"Lowercase"},{"type":"Precompiled","precompiled_charsmap":null}]});
        assert!(patch_null_precompiled(&mut seq));
        assert_eq!(seq["normalizers"][1], serde_json::json!({"type":"NFKC"}));

        let mut real = serde_json::json!({"type":"Precompiled","precompiled_charsmap":"AAAA"});
        assert!(!patch_null_precompiled(&mut real));
        let mut none = Value::Null;
        assert!(!patch_null_precompiled(&mut none));
    }

    /// 解码参数优先级：清单 > generation_config.json > config.json，bad_words_ids 只取单 token 项。
    #[test]
    fn gen_params_precedence() {
        let dir = temp_dir_with(
            "gen",
            &[
                (
                    "generation_config.json",
                    r#"{"decoder_start_token_id":7,"eos_token_id":0,"bad_words_ids":[[65000],[1,2]]}"#,
                ),
                (
                    "config.json",
                    r#"{"decoder_start_token_id":99,"eos_token_id":99,"pad_token_id":5}"#,
                ),
            ],
        );
        let g = resolve_gen_params(&manifest_with(GenerationOverride::default()), &dir).unwrap();
        assert_eq!(
            (g.start, g.eos, g.banned.clone(), g.max_new),
            (7, 0, vec![65000], DEFAULT_MAX_NEW_TOKENS)
        );

        let over = GenerationOverride {
            decoder_start_token_id: Some(3),
            bad_token_ids: Some(vec![9]),
            max_new_tokens: Some(64),
            ..Default::default()
        };
        let g = resolve_gen_params(&manifest_with(over), &dir).unwrap();
        assert_eq!((g.start, g.banned, g.max_new), (3, vec![9], 64));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 缺起始/结束 token 时报 ManifestInvalid；无 bad_words 时回落到 pad。
    #[test]
    fn gen_params_missing_and_pad_fallback() {
        let empty = temp_dir_with("gen-empty", &[]);
        let e =
            resolve_gen_params(&manifest_with(GenerationOverride::default()), &empty).unwrap_err();
        assert_eq!(e.kind, ErrorKind::ManifestInvalid);
        let _ = std::fs::remove_dir_all(empty);

        let dir = temp_dir_with(
            "gen-pad",
            &[(
                "config.json",
                r#"{"decoder_start_token_id":1,"eos_token_id":0,"pad_token_id":8}"#,
            )],
        );
        let g = resolve_gen_params(&manifest_with(GenerationOverride::default()), &dir).unwrap();
        assert_eq!(g.banned, vec![8]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 束宽解析：请求优先、缺省回落、越界报 BadRequest。
    #[test]
    fn beams_resolution() {
        assert_eq!(resolve_beams(None, 2).unwrap(), 2);
        assert_eq!(resolve_beams(Some(4), 2).unwrap(), 4);
        assert_eq!(resolve_beams(None, 3).unwrap(), 3);
        assert_eq!(resolve_beams(Some(0), 2).unwrap_err().kind, ErrorKind::BadRequest);
        assert_eq!(
            resolve_beams(Some(MAX_BEAMS + 1), 2).unwrap_err().kind,
            ErrorKind::BadRequest
        );
    }

    /// 推理错误归类：普通错误为 DecodeFailed，内存不足关键词归 OutOfMemory。
    #[test]
    fn decode_err_classifies() {
        assert_eq!(decode_err(&"shape mismatch").kind, ErrorKind::DecodeFailed);
        assert_eq!(decode_err(&"std::bad_alloc").kind, ErrorKind::OutOfMemory);
    }

    /// 优化级别映射：0..=3 对应，越界按最高级。
    #[test]
    fn opt_level_mapping() {
        assert!(matches!(opt_level(0), GraphOptimizationLevel::Disable));
        assert!(matches!(opt_level(1), GraphOptimizationLevel::Level1));
        assert!(matches!(opt_level(2), GraphOptimizationLevel::Level2));
        assert!(matches!(opt_level(3), GraphOptimizationLevel::Level3));
        assert!(matches!(opt_level(9), GraphOptimizationLevel::Level3));
    }

    /// 缺省解码配置：beam=2、lp=2.0、min_ratio=0.7、no_repeat=0；清单可覆盖（含显式关闭最小长度）。
    #[test]
    fn gen_params_defaults_and_override() {
        let dir = temp_dir_with(
            "gen-defaults",
            &[(
                "config.json",
                r#"{"decoder_start_token_id":2,"eos_token_id":2,"pad_token_id":1}"#,
            )],
        );
        let g = resolve_gen_params(&manifest_with(GenerationOverride::default()), &dir).unwrap();
        assert_eq!(
            (g.num_beams, g.length_penalty, g.min_length_ratio, g.no_repeat_ngram, g.max_new),
            (2, 2.0, 0.7, 0, 256)
        );
        let over = GenerationOverride {
            num_beams: Some(4),
            length_penalty: Some(1.0),
            min_length_ratio: Some(0.0),
            no_repeat_ngram_size: Some(3),
            ..Default::default()
        };
        let g = resolve_gen_params(&manifest_with(over), &dir).unwrap();
        assert_eq!(
            (g.num_beams, g.length_penalty, g.min_length_ratio, g.no_repeat_ngram),
            (4, 1.0, 0.0, 3)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 极小的 BPE 分词器：含 4 个特殊符号与两个语言码，用于语言 id 解析测试。
    fn tiny_m2m_tokenizer() -> Tokenizer {
        let json = r#"{"version":"1.0","truncation":null,"padding":null,"added_tokens":[],
            "normalizer":null,"pre_tokenizer":null,"post_processor":null,"decoder":null,
            "model":{"type":"BPE","unk_token":"<unk>","vocab":{"<s>":0,"<pad>":1,"</s>":2,"<unk>":3,
            "a":4,"eng_Latn":5,"zho_Hans":6},"merges":[]}}"#;
        Tokenizer::from_bytes(json.as_bytes()).unwrap()
    }

    /// 构造带 `lang_tokens` 的 m2m100 清单。
    fn m2m_manifest() -> Manifest {
        let mut m = manifest_with(GenerationOverride::default());
        m.lang_tokens = HashMap::from([
            ("zh-CN".to_string(), "zho_Hans".to_string()),
            ("en".to_string(), "eng_Latn".to_string()),
            ("fr".to_string(), "fra_Latn".to_string()),
        ]);
        m
    }

    /// 语言码映射：源语言 id 作前缀、目标语言 id 作强制位，特殊符号与语言码都进剔除表；缺项分别报错。
    #[test]
    fn m2m_language_resolution() {
        let tk = tiny_m2m_tokenizer();
        let m = m2m_manifest();
        let (prefix, cfg) = resolve_m2m_langs(&m, &tk, "zh-cn", "en").unwrap();
        assert_eq!(prefix, vec![6]);
        assert_eq!(cfg.forced_first, 5);
        assert_eq!(cfg.tgt_code, "eng_Latn");
        assert_eq!(cfg.drop_ids, vec![0, 1, 2, 3, 5, 6]);
        // 清单没有该语言
        let e = resolve_m2m_langs(&m, &tk, "de", "en").unwrap_err();
        assert_eq!(e.kind, ErrorKind::UnsupportedPair);
        // 清单有但词表里没有该 token
        let e = resolve_m2m_langs(&m, &tk, "en", "fr").unwrap_err();
        assert_eq!(e.kind, ErrorKind::ManifestInvalid);
        assert!(e.message.contains("fra_Latn"), "{}", e.message);
    }

    /// 语言计划按请求计算：不同语言对得到不同的前缀、强制位与 CJK 标记；
    /// 不支持的语言对（含相同语言、有向 pairs 的反向）返回 `UnsupportedPair` 而不是 panic。
    #[test]
    fn build_plan_is_per_pair_and_rejects_unsupported() {
        let tk = tiny_m2m_tokenizer();
        let mut m = m2m_manifest();
        m.languages = vec!["zh-CN".into(), "en".into()];
        let to_zh = build_plan(&m, &tk, "en", "zh-CN").unwrap();
        let to_en = build_plan(&m, &tk, "zh-CN", "en").unwrap();
        assert_eq!(to_zh.prefix_ids, vec![5]);
        assert_eq!(to_zh.m2m.forced_first, 6);
        assert!(to_zh.cjk_target);
        assert_eq!(to_en.prefix_ids, vec![6]);
        assert_eq!(to_en.m2m.forced_first, 5);
        assert!(!to_en.cjk_target);
        // 大小写不敏感，相同语言与清单外的语言都不支持
        assert!(build_plan(&m, &tk, "EN", "zh-cn").is_ok());
        for (s, t) in [("en", "en"), ("en", "fr"), ("de", "en")] {
            let e = build_plan(&m, &tk, s, t).unwrap_err();
            assert_eq!(e.kind, ErrorKind::UnsupportedPair, "{s}->{t}");
        }
        // 显式 pairs 有向：反向不支持
        m.pairs = Some(vec![("en".into(), "zh-CN".into())]);
        assert!(build_plan(&m, &tk, "en", "zh-CN").is_ok());
        assert_eq!(
            build_plan(&m, &tk, "zh-CN", "en").unwrap_err().kind,
            ErrorKind::UnsupportedPair
        );
    }

    /// 强制位：束搜索首步只能选目标语言码，随后自由生成直到结束符；最终序列首项是语言码。
    #[test]
    fn forced_bos_is_first_token() {
        let mut bs = BeamSearch::new(2, 2, 1.0, 8, 0);
        let adv = bs.advance(&forced_candidates(bs.alive_len(), 5));
        assert_eq!(
            adv,
            Advance::Continue {
                parents: vec![0],
                tokens: vec![5]
            }
        );
        // 第二步：词 4 比结束符更好；第三步：结束符
        let adv = bs.advance(&[vec![(4, -0.1), (2, -2.0)]]);
        assert!(matches!(adv, Advance::Continue { .. }));
        let _ = bs.advance(&[vec![(2, -0.1), (4, -3.0)]]);
        assert_eq!(bs.best(), vec![5, 4]);
    }

    /// 最小输出长度：按输入长度取上整；比例为 0 关闭；屏蔽结束符后候选数仍满额。
    #[test]
    fn min_length_and_eos_blocking() {
        assert_eq!(min_output_len(0.0, 11), 0);
        assert_eq!(min_output_len(0.5, 11), 6);
        assert_eq!(min_output_len(1.0, 4), 4);
        let logits = [0.0, 0.0, 5.0, 1.0, 3.0, 2.0];
        let plain = masked_top_k(&logits, &[], 2, None);
        assert_eq!(plain.iter().map(|c| c.0).collect::<Vec<_>>(), vec![2, 4]);
        let blocked = masked_top_k(&logits, &[], 2, Some(2));
        assert_eq!(blocked.iter().map(|c| c.0).collect::<Vec<_>>(), vec![4, 5]);
        // 归一化仍包含被屏蔽的结束符：同一 token 的对数概率与未屏蔽时相同
        let p4 = plain.iter().find(|c| c.0 == 4).unwrap().1;
        assert_eq!(blocked[0].1, p4);
    }

    /// 最小长度屏蔽接到束搜索：到长度前结束符不可选，到长度后可选；强制语言码计入长度。
    #[test]
    fn min_length_gates_eos_in_beam_search() {
        // 输入 5 个 token，比例 0.7 -> 最小长度 4：第 0 步强制语言码，第 1..=3 步屏蔽 eos
        let min_len = min_output_len(0.7, 5);
        assert_eq!(min_len, 4);
        let eos = 2u32;
        let logits = [0.0, 0.0, 9.0, 1.0, 0.5];
        let mut bs = BeamSearch::new(2, eos, 2.0, 16, 0);
        let _ = bs.advance(&forced_candidates(bs.alive_len(), 5));
        for step in 1..32usize {
            let block = (step < min_len).then_some(eos);
            let cand = masked_top_k(&logits, &[], 4, block);
            let has_eos = cand.iter().any(|c| c.0 == eos);
            assert_eq!(has_eos, step >= min_len, "step {step}");
            let rows = vec![cand; bs.alive_len()];
            if bs.advance(&rows) == Advance::Done {
                // 结束只能发生在允许结束符之后，结果长度（含语言码）不小于最小长度
                assert!(step >= min_len);
                assert!(bs.best().len() >= min_len, "{:?}", bs.best());
                return;
            }
        }
        panic!("beam search did not finish");
    }

    /// 译文后处理：NLLB 中日目标转全角、引号跨片段成对，其它目标原样。
    #[test]
    fn postprocess_by_target() {
        let cfg = |tgt: &str| M2mConfig {
            forced_first: 0,
            tgt_code: tgt.into(),
            drop_ids: vec![],
        };
        let mut q = 0;
        assert_eq!(
            postprocess_m2m("你好,世界.", &cfg("zho_Hans"), &mut q),
            "你好，世界。"
        );
        assert_eq!(
            postprocess_m2m("彼は言った,行こう.", &cfg("jpn_Jpan"), &mut q),
            "彼は言った、行こう。"
        );
        assert_eq!(
            postprocess_m2m("Bonjour, le monde.", &cfg("fra_Latn"), &mut q),
            "Bonjour, le monde."
        );
        // 引号计数在片段间延续
        let mut q = 0;
        let zh = cfg("zho_Hans");
        assert_eq!(postprocess_m2m("他说:\"不行.", &zh, &mut q), "他说：“不行。");
        assert_eq!(postprocess_m2m("真的.\"", &zh, &mut q), "真的。”");
    }

    /// KV 维度推断：正常 4 维取头数与维度，动态维返回 None。
    #[test]
    fn kv_dims_inference() {
        assert_eq!(kv_dims(&[-1, 16, -1, 64]), Some((16, 64)));
        assert_eq!(kv_dims(&[-1, -1, -1, 64]), None);
        assert_eq!(kv_dims(&[1, 2]), None);
    }

    /// 带词表的 tokenizer.json 在 normalizer 为 null 的 Precompiled 时也能加载（走修补路径）。
    #[test]
    fn load_tokenizer_patches_null_charsmap() {
        let json = r#"{"version":"1.0","truncation":null,"padding":null,"added_tokens":[],
            "normalizer":{"type":"Precompiled","precompiled_charsmap":null},
            "pre_tokenizer":null,"post_processor":null,"decoder":null,
            "model":{"type":"BPE","unk_token":"<unk>","vocab":{"<unk>":0,"a":1},"merges":[]}}"#;
        let dir = temp_dir_with("tok-null", &[("tokenizer.json", json)]);
        assert!(load_tokenizer(&dir.join("tokenizer.json")).is_ok());
        assert_eq!(
            load_tokenizer(&dir.join("nope.json")).err().unwrap().kind,
            ErrorKind::LoadFailed
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
