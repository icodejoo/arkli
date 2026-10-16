// 移植自 Cisox snow-translator（GPL-3.0-only，作者本人）。
//! M2M100（NLLB）翻译引擎：与推理后端无关的编排层。
//!
//! 引擎只做分词、分句/切块、贪心与束搜索、语言码强制、引号包裹法与标点后处理；编码、解码一步、KV 缓存与束重排
//! 交给 [`Seq2SeqRunner`]（ORT 的 `ort_runner`、MNN 的 `mnn_runner`）。引擎对 runner 泛型化而不是用 `Box<dyn>`：
//! 会话类型各不相同（ORT 张量 / MNN 句柄），泛型零开销，也方便用 mock runner 单测；运行时按清单 `format`
//! 选哪种实现由 `Translator`（`mod.rs`）用枚举分派。
//!
//! 束宽 1 走贪心；大于 1 走束搜索（batch 维 = 束宽，自注意力 KV 每步按父束重排，交叉注意力 KV 整句不变）。
//! 流程：编码器输入为 `[源语言码] + 词 + </s>`；解码器以 `</s>`（id 2）起步，第一个生成的 token 强制为目标语言码；
//! 译文解码前剔除特殊符号与语言码。

use std::collections::HashMap;
use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::Arc;

use serde_json::Value;
use tokenizers::Tokenizer;

use super::beam::{top_k_log_softmax, Advance, BeamSearch, Candidate};
use super::detect::{classify_segments, is_auto, summarize, SegLang};
use super::error::{ErrorKind, TranslateError};
use super::manifest::{
    Manifest, ManifestError, DEFAULT_LENGTH_PENALTY, DEFAULT_MAX_NEW_TOKENS, DEFAULT_MIN_LENGTH_RATIO,
    DEFAULT_NO_REPEAT_NGRAM, DEFAULT_NUM_BEAMS, MAX_BEAMS,
};
use super::runner::Seq2SeqRunner;
use super::text::{
    argmax_masked, chunk_ids, fill_empty_separators, is_cjk_lang, join_translated, output_token_budget, split_sentences,
    trim_tail_repeat,
};
use super::wrap::{extract_wrapped, should_wrap, wrap};
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
/// M2M100 词表里的四个基础特殊符号。
const M2M_SPECIAL_TOKENS: [&str; 4] = ["<s>", "<pad>", "</s>", "<unk>"];
/// 束搜索每束取的候选数倍率（HF 取 2×束宽）。
const BEAM_CANDIDATE_FACTOR: usize = 2;

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
    /// 极短输入是否启用引号包裹法（清单缺省 true）。
    pub short_phrase_wrap: bool,
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
        short_phrase_wrap: g.short_phrase_wrap.unwrap_or(true),
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
/// 把推理期底层错误归为解码失败（内存不足优先）。
pub(crate) fn decode_err(e: &dyn fmt::Display) -> TranslateError {
    classify_error(&e.to_string(), ErrorKind::DecodeFailed)
}

/// 已加载的翻译引擎（与语言对、推理后端都无关，语言对随每次翻译指定）。
pub struct Engine<R: Seq2SeqRunner> {
    /// 推理后端（编码 / 解码一步 / KV 管理）。
    runner: R,
    /// 分词器。
    tokenizer: Tokenizer,
    /// 解码参数。
    gen_params: GenParams,
    /// 模型清单（按请求解析语言对时用）。
    manifest: Manifest,
    /// 已解析的语言对计划缓存（键为小写 `(src, tgt)`；只缓存清单支持的语言对，数量有界）。
    plans: HashMap<(String, String), Arc<LangPlan>>,
    /// 最大输入 token 数。
    max_input_tokens: usize,
    /// 模型 ID。
    model_id: String,
}

impl<R: Seq2SeqRunner> Engine<R> {
    /// 由已加载的各部件组装引擎并做分词器自检。
    ///
    /// # 参数
    /// - `manifest`：已校验的清单。
    /// - `gen_params`：解码参数（[`resolve_gen_params`] 的结果）。
    /// - `tokenizer`：分词器（[`load_tokenizer`] 的结果）。
    /// - `runner`：推理后端。
    ///
    /// # 返回
    /// 就绪的引擎；分词器回环自检失败返回 `LoadFailed`。
    ///
    /// # 示例
    /// ```ignore
    /// let engine = Engine::new(manifest, gen_params, tokenizer, runner)?;
    /// ```
    pub fn new(
        manifest: Manifest,
        gen_params: GenParams,
        tokenizer: Tokenizer,
        runner: R,
    ) -> Result<Self, TranslateError> {
        let engine = Self {
            runner,
            tokenizer,
            gen_params,
            max_input_tokens: manifest.max_input_tokens,
            model_id: manifest.id.clone(),
            manifest,
            plans: HashMap::new(),
        };
        engine.self_check()?;
        Ok(engine)
    }

    /// 测试用：跳过分词器自检直接组装引擎（mock runner 配极简分词器）。
    #[cfg(test)]
    pub(crate) fn for_test(manifest: Manifest, gen_params: GenParams, tokenizer: Tokenizer, runner: R) -> Self {
        Self {
            runner,
            tokenizer,
            gen_params,
            max_input_tokens: manifest.max_input_tokens,
            model_id: manifest.id.clone(),
            manifest,
            plans: HashMap::new(),
        }
    }

    /// 取（必要时计算并缓存）一个语言对的解码计划。
    ///
    /// 只有清单支持的语言对才会进缓存，所以缓存大小有界。
    pub(crate) fn plan_for(&mut self, src: &str, tgt: &str) -> Result<Arc<LangPlan>, TranslateError> {
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
    /// 请求结束后的内存收缩，具体动作由 runner 决定（ORT 收缩 arena，MNN 无操作）。
    pub fn trim_memory(&mut self) {
        self.runner.trim_memory();
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
        // 引号包裹法只对“整段输入恰为一句”的极短文本启用
        let single = segments.len() == 1;
        for (seg, kind) in segments.into_iter().zip(kinds) {
            let translated = match kind {
                SegLang::Translate(lang) => {
                    let plan = match &first_plan {
                        Some(p) => Arc::clone(p),
                        None => self.plan_for(&lang, tgt)?,
                    };
                    let wrapped = if single && self.gen_params.short_phrase_wrap && should_wrap(&seg.text, &lang, tgt) {
                        self.translate_wrapped(&seg.text, &lang, tgt, cap, beams, &plan)?
                    } else {
                        None
                    };
                    match wrapped {
                        Some(t) => t,
                        None => {
                            let t = self.translate_segment(&seg.text, cap, beams, &plan)?;
                            postprocess_m2m(&t, &plan.m2m, &mut quotes)
                        }
                    }
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

    /// 开关引号包裹法（测试对比用；生产由清单 `short_phrase_wrap` 决定）。
    #[cfg(test)]
    pub(crate) fn set_short_phrase_wrap(&mut self, on: bool) {
        self.gen_params.short_phrase_wrap = on;
    }

    /// 引号包裹法：翻译 `前缀"X"` 并取第一对引号里的内容；任一回退条件命中返回 `None`。
    fn translate_wrapped(
        &mut self,
        text: &str,
        src_lang: &str,
        tgt: &str,
        cap: usize,
        beams: usize,
        plan: &LangPlan,
    ) -> Result<Option<String>, TranslateError> {
        let raw = self.translate_segment(&wrap(text, src_lang), cap, beams, plan)?;
        // 独立的引号计数：包裹译文自成一体，不影响调用方共享的计数
        let out = postprocess_m2m(&raw, &plan.m2m, &mut 0usize);
        Ok(extract_wrapped(&out, tgt, text))
    }

    /// 翻译一个句级片段；超过输入上限时按 token 切块分别翻译。
    pub(crate) fn translate_segment(
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
    /// 束搜索生成：batch 维 = 束宽，首步所有束同输入，仅第 0 束参与选择。
    fn generate_beam(
        &mut self,
        input_ids: &[u32],
        max_new: usize,
        width: usize,
        forced: u32,
    ) -> Result<Vec<u32>, TranslateError> {
        let src_len = input_ids.len();
        let mut session = self.runner.begin(input_ids, width)?;

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
            let logits = self.runner.step(&mut session, step, &current, step > 0)?;

            let cands: Vec<Vec<Candidate>> = match logits {
                // 首个生成位强制为目标语言码，本步 logits 不参与选择
                None => forced_candidates(search.alive_len(), forced),
                Some(logits) => {
                    let block_eos = (step < min_len).then_some(gp.eos as u32);
                    (0..search.alive_len())
                        .map(|b| {
                            masked_top_k(
                                logits.row(b),
                                &gp.banned,
                                BEAM_CANDIDATE_FACTOR * width,
                                block_eos,
                            )
                        })
                        .collect()
                }
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
            self.runner.commit(&mut session, step, reorder)?;
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
        let mut session = self.runner.begin(input_ids, 1)?;

        let gp = &self.gen_params;
        let min_len = min_output_len(gp.min_length_ratio, src_len).min(max_new.saturating_sub(1));
        // 最小长度内额外禁止结束符：不变量，提到循环外只建一次
        let mut banned_no_eos = gp.banned.clone();
        banned_no_eos.push(gp.eos);
        let mut generated: Vec<u32> = Vec::new();
        let mut current = gp.start;
        for step in 0..max_new {
            let logits = self.runner.step(&mut session, step, &[current], step > 0)?;
            let next = match logits {
                // 首个生成位强制为目标语言码
                None => forced as i64,
                Some(logits) => {
                    let banned = if step < min_len {
                        &banned_no_eos
                    } else {
                        &gp.banned
                    };
                    argmax_masked(logits.row(0), banned).ok_or_else(|| {
                        TranslateError::new(ErrorKind::DecodeFailed, "no selectable token in logits")
                    })? as i64
                }
            };
            if next == gp.eos {
                break;
            }
            // 更新 KV：编码器侧 KV 只在第一步采用
            self.runner.commit(&mut session, step, None)?;
            generated.push(next as u32);
            if trim_tail_repeat(&mut generated) {
                break;
            }
            current = next;
        }
        Ok(generated)
    }
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
            format: None,
            files: HashMap::new(),
            decoder_layers: None,
            kv_heads: None,
            kv_head_dim: None,
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
        // 引号包裹法缺省开启，清单显式 false 可关
        assert!(g.short_phrase_wrap);
        let off = GenerationOverride { short_phrase_wrap: Some(false), ..Default::default() };
        assert!(!resolve_gen_params(&manifest_with(off), &dir).unwrap().short_phrase_wrap);
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

    /// mock MNN runner 下的贪心与束搜索：用假三图（只收 batch=1）验证强制语言码、KV 逐步增长、交叉 KV 不变、
    /// 最小长度屏蔽结束符与结束条件。
    #[cfg(feature = "mnn-backend")]
    mod mock_engine {
        use super::*;
        use crate::translate::mnn_runner::tests::{mock_runner, MockGraph, StepRecord, EOS};
        use crate::translate::mnn_runner::MnnRunner;
        use std::sync::{Arc, Mutex};

        /// 假引擎的解码参数：起始 2、结束 2、最小长度比例 0.7、无惩罚。
        fn params(beams: usize) -> GenParams {
            GenParams {
                start: 2,
                eos: 2,
                banned: vec![],
                max_new: 16,
                num_beams: beams,
                length_penalty: 1.0,
                no_repeat_ngram: 0,
                min_length_ratio: 0.7,
                short_phrase_wrap: false,
            }
        }

        /// 造引擎与调用记录；`script[i]` 是第 i 次解码器调用时最高分的 token（越界后取结束符）。
        fn engine(beams: usize, script: Vec<usize>) -> (Engine<MnnRunner<MockGraph>>, Arc<Mutex<Vec<StepRecord>>>) {
            let log = Arc::new(Mutex::new(Vec::new()));
            let runner = mock_runner(Box::new(move |_, call| script.get(call).copied().unwrap_or(EOS)), log.clone());
            let e = Engine::for_test(manifest_with(GenerationOverride::default()), params(beams), tiny_m2m_tokenizer(), runner);
            (e, log)
        }

        /// 贪心：强制位 5，随后 3、4，再到结束符；最小长度（ceil(0.7×3)=3）内结束符被屏蔽，所以脚本在第 2 步给结束符也不会提前结束。
        #[test]
        fn greedy_runs_forced_then_script_until_eos() {
            // 第 0 步强制；第 1 步 3；第 2 步想结束（被屏蔽，退而取次优）；第 3 步 4；第 4 步结束
            let (mut e, log) = engine(1, vec![0, 3, EOS, 4, EOS]);
            let out = e.generate(&[4, 3, 2], 16, 5).unwrap();
            // 第 2 步结束符被屏蔽：其余分数相同，argmax 取下标最小的 0
            assert_eq!(out, vec![5, 3, 0, 4]);
            let recs = log.lock().unwrap();
            assert_eq!(recs.len(), 5);
            // 喂入的 token：起始符、强制位、上一步输出……
            let fed: Vec<i32> = recs.iter().map(|r| r.token).collect();
            assert_eq!(fed, vec![2, 5, 3, 0, 4]);
            // 自注意力 KV 长度逐步 +1，首步为 0；交叉 KV 整句不变
            let lens: Vec<i64> = recs.iter().map(|r| r.past_shape[2]).collect();
            assert_eq!(lens, vec![0, 1, 2, 3, 4]);
            assert!(recs.iter().all(|r| r.cross_key == recs[0].cross_key));
        }

        /// 预算耗尽也会停：强制位 + 两个生成 token。
        #[test]
        fn greedy_stops_on_budget() {
            let (mut e, log) = engine(1, vec![0, 3, 3, 3, 3, 3, 3, 3]);
            let out = e.generate(&[4, 3, 2], 3, 5).unwrap();
            assert_eq!(out, vec![5, 3, 3]);
            assert_eq!(log.lock().unwrap().len(), 3);
        }

        /// 束搜索：最终序列以强制位开头；每次调用的 KV 都能追溯到更早某次调用的 KV 加上该次的输入 token（重排没串行）；
        /// 首步与补齐行（同 token 同 KV）不重复计算。
        #[test]
        fn beam_search_keeps_kv_lineage_and_forced_first() {
            let (mut e, log) = engine(2, vec![0, 3, 4, 3, 4, EOS, EOS, EOS, EOS, EOS]);
            let out = e.generate_beam(&[4, 3, 2], 8, 2, 5).unwrap();
            assert_eq!(out[0], 5, "{out:?}");
            assert!(out.len() > 1);
            let recs = log.lock().unwrap();
            assert!(recs.len() >= 3);
            assert_eq!(recs[0].past_shape, vec![1, 1, 0, 2]);
            for (i, r) in recs.iter().enumerate() {
                assert_eq!(r.mask_shape, vec![1, 3]);
                if r.past_shape[2] == 0 {
                    continue;
                }
                let found = recs[..i].iter().any(|e| {
                    let mut want = e.past_key.clone();
                    want.extend_from_slice(&[e.token as f32, 0.0]);
                    want == r.past_key
                });
                assert!(found, "第 {i} 次调用的 KV 找不到来源：{:?}", r.past_key);
            }
            // 首步两行同输入，只算一次：第 0 次调用之后紧跟的是 past 长度为 1 的调用
            assert_eq!(recs[1].past_shape[2], 1);
        }
    }
}
