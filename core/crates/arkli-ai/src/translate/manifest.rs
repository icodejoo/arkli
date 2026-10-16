// 移植自 Cisox snow-translator（GPL-3.0-only，作者本人）。
//! 模型清单（`model.json`）解析与校验（只保留 m2m100 族，即 NLLB）。
//!
//! 编码器输入以源语言码开头、解码器第一个生成 token 强制为目标语言码，语言码取自 `lang_tokens`。
//! 外部数据权重：`files` 可额外列出 `encoder_data` / `decoder_data`（`.onnx_data`），
//! 文件名必须与 ONNX 图里记录的 `location` 一致，并与 `.onnx` 同目录（ORT 按 location 同目录加载并内存映射）。
//!
//! 两种模型格式由 `format` 区分（缺省视为 ORT，兼容旧模型）：
//! - `onnx-merged`：`encoder` + `decoder`（merged，含 KV 分支）+ `tokenizer`；
//! - `mnn-split`：`encoder` + `cross_kv` + `decoder`（单步）+ `embed`（int8）+ `embed_scale`（每行 float32）+ `tokenizer`，
//!   `encoder_data` / `cross_kv_data` / `decoder_data`（`.mnn.weight`）可选。

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

/// 当前唯一支持的清单版本。
pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;
/// 清单文件名。
pub const MANIFEST_FILE: &str = "model.json";
/// `files` 中必需的键：编码器。
pub const FILE_ENCODER: &str = "encoder";
/// `files` 中必需的键：合并解码器。
pub const FILE_DECODER: &str = "decoder";
/// `files` 中必需的键：分词器。
pub const FILE_TOKENIZER: &str = "tokenizer";
/// `files` 中可选的键：编码器外部数据（`.onnx_data`，与 `.onnx` 同目录）。
pub const FILE_ENCODER_DATA: &str = "encoder_data";
/// `files` 中可选的键：解码器外部数据。
pub const FILE_DECODER_DATA: &str = "decoder_data";
/// `files` 中 MNN 格式必需的键：交叉注意力 KV 小图。
pub const FILE_CROSS_KV: &str = "cross_kv";
/// `files` 中 MNN 格式可选的键：交叉 KV 图的外置权重（`.mnn.weight`）。
pub const FILE_CROSS_KV_DATA: &str = "cross_kv_data";
/// `files` 中 MNN 格式必需的键：词嵌入表（行主序 int8）。
pub const FILE_EMBED: &str = "embed";
/// `files` 中 MNN 格式必需的键：词嵌入每行的缩放（float32，小端）。
pub const FILE_EMBED_SCALE: &str = "embed_scale";
/// 清单 `format` 取值：ORT 的 merged 解码器（缺省）。
pub const FORMAT_ONNX_MERGED: &str = "onnx-merged";
/// 清单 `format` 取值：MNN 三图拆分。
pub const FORMAT_MNN_SPLIT: &str = "mnn-split";
/// 每个嵌入缩放值的字节数（float32）。
pub const EMBED_SCALE_BYTES: u64 = 4;
/// MNN 格式缺省的解码器层数（NLLB-200 distilled 600M）。
pub const DEFAULT_DECODER_LAYERS: usize = 12;
/// MNN 格式缺省的 KV 头数。
pub const DEFAULT_KV_HEADS: usize = 16;
/// MNN 格式缺省的 KV 每头维度。
pub const DEFAULT_KV_HEAD_DIM: usize = 64;
/// 架构族：M2M100（NLLB）。
pub const FAMILY_M2M100: &str = "m2m100";
/// 清单缺省的最大输入 token 数。
pub const DEFAULT_MAX_INPUT_TOKENS: usize = 512;
/// 缺省 ORT 图优化级别。
pub const DEFAULT_OPT_LEVEL: u8 = 3;
/// 最大优化级别。
pub const MAX_OPT_LEVEL: u8 = 3;
/// 束搜索缺省的 no-repeat n-gram 长度（0 关闭）。
pub const DEFAULT_NO_REPEAT_NGRAM: usize = 0;
/// 束宽上限（防止请求过大的束宽放大内存）。
pub const MAX_BEAMS: usize = 8;
/// 缺省束宽。
pub const DEFAULT_NUM_BEAMS: usize = 2;
/// 缺省长度惩罚指数（抑制偏短译文）。
pub const DEFAULT_LENGTH_PENALTY: f32 = 2.0;
/// 缺省最小输出长度比例。
pub const DEFAULT_MIN_LENGTH_RATIO: f32 = 0.7;
/// 缺省最大新生成 token 数。
pub const DEFAULT_MAX_NEW_TOKENS: usize = 256;

/// 清单加载失败的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    /// 目录或 `model.json` 不存在。
    Missing(String),
    /// 内容非法（解析失败、版本不符、路径越界等）。
    Invalid(String),
}

/// 模型文件格式（由清单 `format` 决定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelFormat {
    /// ORT：encoder + merged decoder。
    OnnxMerged,
    /// MNN：encoder + cross_kv + 单步 decoder + 图外嵌入表。
    MnnSplit,
}

/// 生成参数（全部可选，缺省值由 `generation_config.json` / `config.json` 补齐）。
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct GenerationOverride {
    /// 解码起始 token。
    pub decoder_start_token_id: Option<i64>,
    /// 结束 token。
    pub eos_token_id: Option<i64>,
    /// 填充 token。
    pub pad_token_id: Option<i64>,
    /// 禁止生成的 token。
    pub bad_token_ids: Option<Vec<i64>>,
    /// 最大新生成 token 数。
    pub max_new_tokens: Option<usize>,
    /// 缺省束宽，1 即贪心；请求可覆盖，范围 `1..=MAX_BEAMS`。
    pub num_beams: Option<usize>,
    /// 束搜索长度惩罚指数。
    pub length_penalty: Option<f32>,
    /// 束搜索禁止重复的 n-gram 长度，0 关闭。
    pub no_repeat_ngram_size: Option<usize>,
    /// 最小输出长度占输入 token 数的比例：生成 token 数（含强制的语言码、不含解码起始符）
    /// 不足 `ceil(比例 × 输入 token 数)` 前禁止结束符；显式写 0 即关闭。
    pub min_length_ratio: Option<f32>,
    /// 极短输入是否启用“引号包裹法”（见 `wrap` 模块）；缺省 `true`，显式 `false` 关闭。
    pub short_phrase_wrap: Option<bool>,
}

/// 执行参数（可选）。
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ExecutionOptions {
    /// 单算子内并行线程数，0 表示自动。
    #[serde(default)]
    pub intra_threads: usize,
    /// 是否启用 ORT CPU 内存 arena；缺省 `true`。
    #[serde(default = "default_true")]
    pub cpu_arena: bool,
    /// 是否启用 ORT 内存模式规划；缺省 `true`。
    #[serde(default = "default_true")]
    pub mem_pattern: bool,
    /// ORT 图优化级别 0..=3（0 关闭），缺省 3。
    #[serde(default = "default_opt_level")]
    pub opt_level: u8,
    /// 是否启用权重预打包；缺省 `true`。
    #[serde(default = "default_true")]
    pub prepacking: bool,
    /// 每个翻译请求结束后收缩 ORT arena，把闲置内存还给系统；缺省 `false`。
    #[serde(default)]
    pub trim_after_request: bool,
}

impl Default for ExecutionOptions {
    /// 缺省：自动线程，arena 与内存模式保持 ORT 默认（开）。
    fn default() -> Self {
        Self {
            intra_threads: 0,
            cpu_arena: true,
            mem_pattern: true,
            opt_level: DEFAULT_OPT_LEVEL,
            prepacking: true,
            trim_after_request: false,
        }
    }
}

/// serde 缺省值：图优化级别。
fn default_opt_level() -> u8 {
    DEFAULT_OPT_LEVEL
}

/// serde 缺省值：`true`。
fn default_true() -> bool {
    true
}

/// serde 缺省值：最大输入 token 数。
fn default_max_input_tokens() -> usize {
    DEFAULT_MAX_INPUT_TOKENS
}

/// 模型清单。
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Manifest {
    /// 清单版本，必须为 1。
    pub schema_version: u32,
    /// 模型唯一标识。
    pub id: String,
    /// 展示名。
    #[serde(default)]
    pub display_name: String,
    /// 架构族：目前只支持 `m2m100`。
    pub family: String,
    /// 量化类型。
    #[serde(default)]
    pub quantization: String,
    /// 模型文件格式：`onnx-merged`（缺省）或 `mnn-split`。
    #[serde(default)]
    pub format: Option<String>,
    /// 文件表：必需键随 `format` 而定（见模块说明），`*_data` 可选；值为相对模型目录的路径。
    pub files: HashMap<String, String>,
    /// MNN 格式的解码器层数，缺省 [`DEFAULT_DECODER_LAYERS`]。
    #[serde(default)]
    pub decoder_layers: Option<usize>,
    /// MNN 格式的 KV 头数，缺省 [`DEFAULT_KV_HEADS`]。
    #[serde(default)]
    pub kv_heads: Option<usize>,
    /// MNN 格式的 KV 每头维度，缺省 [`DEFAULT_KV_HEAD_DIM`]。
    #[serde(default)]
    pub kv_head_dim: Option<usize>,
    /// 支持的语言列表（`pairs` 缺省时取其有向全排列）。
    #[serde(default)]
    pub languages: Vec<String>,
    /// 最大输入 token 数。
    #[serde(default = "default_max_input_tokens")]
    pub max_input_tokens: usize,
    /// 有向语言对，缺省由 `languages` 展开。
    #[serde(default)]
    pub pairs: Option<Vec<(String, String)>>,
    /// 应用语言码 → 模型内语言 token（如 `zh-CN` → `zho_Hans`）。
    #[serde(default)]
    pub lang_tokens: HashMap<String, String>,
    /// 生成参数覆盖。
    #[serde(default)]
    pub generation: GenerationOverride,
    /// 执行参数。
    #[serde(default)]
    pub execution: ExecutionOptions,
}

impl Manifest {
    /// 读取并校验模型目录下的 `model.json`。
    ///
    /// # 参数
    /// - `dir`：模型目录。
    ///
    /// # 返回
    /// 通过校验的清单；目录/文件缺失返回 [`ManifestError::Missing`]，其余问题返回 [`ManifestError::Invalid`]。
    ///
    /// # 示例
    /// ```ignore
    /// let m = Manifest::load(std::path::Path::new("/data/models/nllb"))?;
    /// ```
    pub fn load(dir: &Path) -> Result<Self, ManifestError> {
        if !dir.is_dir() {
            return Err(ManifestError::Missing(format!(
                "model directory not found: {}",
                dir.display()
            )));
        }
        let path = dir.join(MANIFEST_FILE);
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| ManifestError::Missing(format!("cannot read {}: {e}", path.display())))?;
        Self::parse(&raw, dir)
    }

    /// 解析清单文本并校验（含文件存在性与路径安全）。
    ///
    /// # 参数
    /// - `raw`：`model.json` 文本。
    /// - `dir`：模型目录（用于检查 `files`）。
    ///
    /// # 返回
    /// 通过校验的清单，或 [`ManifestError`]。
    ///
    /// # 示例
    /// ```ignore
    /// let m = Manifest::parse(&text, dir)?;
    /// ```
    pub fn parse(raw: &str, dir: &Path) -> Result<Self, ManifestError> {
        let manifest: Manifest = serde_json::from_str(raw)
            .map_err(|e| ManifestError::Invalid(format!("model.json parse error: {e}")))?;
        manifest.validate(dir)?;
        Ok(manifest)
    }

    /// 校验版本、必需字段、`files` 路径安全与存在性。
    fn validate(&self, dir: &Path) -> Result<(), ManifestError> {
        let bad = ManifestError::Invalid;
        if self.schema_version != SUPPORTED_SCHEMA_VERSION {
            return Err(bad(format!(
                "unsupported schema_version {} (expected {SUPPORTED_SCHEMA_VERSION})",
                self.schema_version
            )));
        }
        if self.id.trim().is_empty() {
            return Err(bad("id must not be empty".into()));
        }
        if self.family != FAMILY_M2M100 {
            return Err(bad(format!(
                "unsupported family `{}` (expected `{FAMILY_M2M100}`)",
                self.family
            )));
        }
        if self.max_input_tokens < 2 {
            return Err(bad("max_input_tokens must be >= 2".into()));
        }
        if let Some(beams) = self.generation.num_beams {
            if !(1..=MAX_BEAMS).contains(&beams) {
                return Err(bad(format!("num_beams={beams} out of range 1..={MAX_BEAMS}")));
            }
        }
        if let Some(lp) = self.generation.length_penalty {
            if !(lp.is_finite() && lp >= 0.0) {
                return Err(bad(format!("length_penalty={lp} must be a finite number >= 0")));
            }
        }
        if let Some(ratio) = self.generation.min_length_ratio {
            if !(ratio.is_finite() && (0.0..=1.0).contains(&ratio)) {
                return Err(bad(format!("min_length_ratio={ratio} must be within 0..=1")));
            }
        }
        if self.execution.opt_level > MAX_OPT_LEVEL {
            return Err(bad(format!(
                "execution.opt_level={} out of range 0..={MAX_OPT_LEVEL}",
                self.execution.opt_level
            )));
        }
        self.validate_lang_tokens()?;
        let format = self.model_format()?;
        for (name, v) in [
            ("decoder_layers", self.decoder_layers),
            ("kv_heads", self.kv_heads),
            ("kv_head_dim", self.kv_head_dim),
        ] {
            if v == Some(0) {
                return Err(bad(format!("{name} must be >= 1")));
            }
        }
        let (required, optional_keys) = match format {
            ModelFormat::OnnxMerged => (
                vec![FILE_ENCODER, FILE_DECODER, FILE_TOKENIZER],
                vec![FILE_ENCODER_DATA, FILE_DECODER_DATA],
            ),
            ModelFormat::MnnSplit => (
                vec![FILE_ENCODER, FILE_CROSS_KV, FILE_DECODER, FILE_EMBED, FILE_EMBED_SCALE, FILE_TOKENIZER],
                vec![FILE_ENCODER_DATA, FILE_CROSS_KV_DATA, FILE_DECODER_DATA],
            ),
        };
        let optional = optional_keys.into_iter().filter(|k| self.files.contains_key(*k));
        for key in required.into_iter().chain(optional) {
            let path = self.resolve_file(dir, key)?;
            if !path.is_file() {
                return Err(ManifestError::Missing(format!(
                    "model file `{key}` not found: {}",
                    path.display()
                )));
            }
        }
        if format == ModelFormat::MnnSplit {
            self.validate_embed_files(dir)?;
        }
        Ok(())
    }

    /// 模型文件格式：`format` 缺省为 ORT；未知取值返回 [`ManifestError::Invalid`]。
    ///
    /// # 返回
    /// [`ModelFormat`]。
    ///
    /// # 示例
    /// ```ignore
    /// assert_eq!(manifest.model_format()?, ModelFormat::MnnSplit);
    /// ```
    pub fn model_format(&self) -> Result<ModelFormat, ManifestError> {
        match self.format.as_deref() {
            None | Some(FORMAT_ONNX_MERGED) => Ok(ModelFormat::OnnxMerged),
            Some(FORMAT_MNN_SPLIT) => Ok(ModelFormat::MnnSplit),
            Some(other) => Err(ManifestError::Invalid(format!(
                "unsupported format `{other}` (expected `{FORMAT_ONNX_MERGED}` or `{FORMAT_MNN_SPLIT}`)"
            ))),
        }
    }

    /// MNN 格式的解码器结构：`(层数, KV 头数, KV 每头维度)`，清单缺省取 NLLB-600M 的 12/16/64。
    ///
    /// # 返回
    /// 三元组，用于生成图的张量名与空 KV 的形状。
    ///
    /// # 示例
    /// ```ignore
    /// let (layers, heads, head_dim) = manifest.decoder_dims();
    /// ```
    pub fn decoder_dims(&self) -> (usize, usize, usize) {
        (
            self.decoder_layers.unwrap_or(DEFAULT_DECODER_LAYERS),
            self.kv_heads.unwrap_or(DEFAULT_KV_HEADS),
            self.kv_head_dim.unwrap_or(DEFAULT_KV_HEAD_DIM),
        )
    }

    /// 校验嵌入表两个文件的大小自洽：缩放字节数是 4 的倍数且非 0，嵌入字节数能被行数整除。
    ///
    /// 只看文件大小（不读内容）；与分词器词数是否一致由引擎加载时再核对。
    fn validate_embed_files(&self, dir: &Path) -> Result<(), ManifestError> {
        let bad = ManifestError::Invalid;
        let size = |key: &str| -> Result<u64, ManifestError> {
            let p = self.resolve_file(dir, key)?;
            std::fs::metadata(&p)
                .map(|m| m.len())
                .map_err(|e| ManifestError::Missing(format!("cannot stat {}: {e}", p.display())))
        };
        let (i8_len, scale_len) = (size(FILE_EMBED)?, size(FILE_EMBED_SCALE)?);
        if scale_len == 0 || scale_len % EMBED_SCALE_BYTES != 0 {
            return Err(bad(format!(
                "files.{FILE_EMBED_SCALE} size {scale_len} must be a non-zero multiple of {EMBED_SCALE_BYTES}"
            )));
        }
        let rows = scale_len / EMBED_SCALE_BYTES;
        if i8_len == 0 || i8_len % rows != 0 {
            return Err(bad(format!(
                "files.{FILE_EMBED} size {i8_len} is not a multiple of the {rows} rows in files.{FILE_EMBED_SCALE}"
            )));
        }
        Ok(())
    }

    /// 查询语言代码对应的模型内 token（不区分大小写）。
    ///
    /// # 参数
    /// - `lang`：语言代码，如 `zh-CN`。
    ///
    /// # 返回
    /// `lang_tokens` 中的 token（如 `zho_Hans`）；缺失返回错误说明。
    ///
    /// # 示例
    /// ```ignore
    /// assert_eq!(manifest.lang_token_for("zh-cn")?, "zho_Hans");
    /// ```
    pub fn lang_token_for(&self, lang: &str) -> Result<&str, String> {
        self.lang_tokens
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(lang))
            .map(|(_, v)| v.as_str())
            .ok_or_else(|| format!("lang_tokens has no entry for `{lang}`"))
    }

    /// 模型支持的语言集合（`languages` 优先，空则取 `pairs` 里的源语言，去重保序）。
    ///
    /// # 返回
    /// 应用语言码列表。
    ///
    /// # 示例
    /// ```ignore
    /// assert!(manifest.supported_languages().contains(&"en".to_string()));
    /// ```
    pub fn supported_languages(&self) -> Vec<String> {
        let mut out: Vec<String> = self.languages.clone();
        if out.is_empty() {
            for (s, _) in self.pairs.iter().flatten() {
                if !out.iter().any(|o| o.eq_ignore_ascii_case(s)) {
                    out.push(s.clone());
                }
            }
        }
        out
    }

    /// 每个出现在 `languages` / `pairs` 里的语言都必须有 `lang_tokens` 项。
    fn validate_lang_tokens(&self) -> Result<(), ManifestError> {
        let from_pairs = self
            .pairs
            .iter()
            .flatten()
            .flat_map(|(s, t)| [s.as_str(), t.as_str()]);
        let mut all: Vec<&str> = self.languages.iter().map(String::as_str).collect();
        all.extend(from_pairs);
        for lang in all {
            self.lang_token_for(lang).map_err(ManifestError::Invalid)?;
        }
        Ok(())
    }

    /// 解析 `files[key]` 为模型目录内的路径，拒绝绝对路径与 `..`。
    ///
    /// # 参数
    /// - `dir`：模型目录。
    /// - `key`：文件键。
    ///
    /// # 返回
    /// 目录内的路径；键缺失或路径越界返回 [`ManifestError::Invalid`]。
    ///
    /// # 示例
    /// ```ignore
    /// let enc = manifest.resolve_file(dir, "encoder")?;
    /// ```
    pub fn resolve_file(&self, dir: &Path, key: &str) -> Result<PathBuf, ManifestError> {
        let rel = self
            .files
            .get(key)
            .ok_or_else(|| ManifestError::Invalid(format!("files.{key} is required")))?;
        let rel_path = Path::new(rel);
        let safe = !rel.is_empty()
            && rel_path
                .components()
                .all(|c| matches!(c, Component::Normal(_)));
        if !safe {
            return Err(ManifestError::Invalid(format!(
                "files.{key} must be a relative path inside the model directory: {rel}"
            )));
        }
        Ok(dir.join(rel_path))
    }

    /// 判断是否支持某个有向语言对（不区分大小写）；`pairs` 缺省时由 `languages` 展开，相同语言不支持。
    ///
    /// # 参数
    /// - `src`：源语言代码。
    /// - `tgt`：目标语言代码。
    ///
    /// # 返回
    /// 支持返回 `true`。
    ///
    /// # 示例
    /// ```ignore
    /// assert!(manifest.supports_pair("en", "zh-CN"));
    /// ```
    pub fn supports_pair(&self, src: &str, tgt: &str) -> bool {
        let eq = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
        match &self.pairs {
            Some(pairs) => pairs.iter().any(|(s, t)| eq(s, src) && eq(t, tgt)),
            None => {
                !eq(src, tgt)
                    && self.languages.iter().any(|l| eq(l, src))
                    && self.languages.iter().any(|l| eq(l, tgt))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 创建带占位模型文件的临时目录。
    fn temp_model_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arkli-translate-mf-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for f in ["encoder.onnx", "decoder.onnx", "tokenizer.json"] {
            fs::write(dir.join(f), b"x").unwrap();
        }
        dir
    }

    /// 最小合法清单文本。
    const BASE: &str = r#"{"schema_version":1,"id":"m","family":"m2m100",
        "files":{"encoder":"encoder.onnx","decoder":"decoder.onnx","tokenizer":"tokenizer.json"},
        "languages":["zh-CN","en"],"lang_tokens":{"zh-CN":"zho_Hans","en":"eng_Latn"}}"#;

    /// 合法清单：缺省值生效，语言对大小写不敏感，相同语言不支持。
    #[test]
    fn parses_valid_manifest_with_defaults() {
        let dir = temp_model_dir("ok");
        let m = Manifest::parse(BASE, &dir).unwrap();
        assert_eq!(m.max_input_tokens, DEFAULT_MAX_INPUT_TOKENS);
        assert_eq!(m.execution, ExecutionOptions::default());
        assert!(m.supports_pair("EN", "zh-cn"));
        assert!(!m.supports_pair("en", "en"));
        assert!(!m.supports_pair("en", "de"));
        assert_eq!(m.lang_token_for("zh-cn").unwrap(), "zho_Hans");
        let _ = fs::remove_dir_all(dir);
    }

    /// 非 m2m100 族、错误版本、束宽越界、min_length_ratio 越界、opt_level 越界、语言缺 token 都报 Invalid。
    #[test]
    fn rejects_invalid_fields() {
        let dir = temp_model_dir("bad");
        let cases = [
            BASE.replace("m2m100", "marian"),
            BASE.replace("\"schema_version\":1", "\"schema_version\":2"),
            BASE.replace("\"languages\"", "\"generation\":{\"num_beams\":99},\"languages\""),
            BASE.replace("\"languages\"", "\"generation\":{\"min_length_ratio\":1.5},\"languages\""),
            BASE.replace("\"languages\"", "\"execution\":{\"opt_level\":9},\"languages\""),
            BASE.replace("\"en\":\"eng_Latn\"", "\"fr\":\"fra_Latn\""),
        ];
        for raw in cases {
            assert!(matches!(Manifest::parse(&raw, &dir), Err(ManifestError::Invalid(_))), "{raw}");
        }
        let _ = fs::remove_dir_all(dir);
    }

    /// `generation.short_phrase_wrap`：缺省为 None（引擎取 true）、显式 false 可解析、非布尔报 Invalid。
    #[test]
    fn parses_short_phrase_wrap_field() {
        let dir = temp_model_dir("wrap");
        let m = Manifest::parse(BASE, &dir).unwrap();
        assert_eq!(m.generation.short_phrase_wrap, None);
        let off = BASE.replace("\"languages\"", "\"generation\":{\"short_phrase_wrap\":false},\"languages\"");
        assert_eq!(Manifest::parse(&off, &dir).unwrap().generation.short_phrase_wrap, Some(false));
        let on = BASE.replace("\"languages\"", "\"generation\":{\"short_phrase_wrap\":true},\"languages\"");
        assert_eq!(Manifest::parse(&on, &dir).unwrap().generation.short_phrase_wrap, Some(true));
        let bad = BASE.replace("\"languages\"", "\"generation\":{\"short_phrase_wrap\":\"yes\"},\"languages\"");
        assert!(matches!(Manifest::parse(&bad, &dir), Err(ManifestError::Invalid(_))));
        let _ = fs::remove_dir_all(dir);
    }

    /// 文件缺失报 Missing，路径越界报 Invalid；目录不存在报 Missing。
    #[test]
    fn checks_files_and_paths() {
        let dir = temp_model_dir("files");
        let escape = BASE.replace("encoder.onnx", "../encoder.onnx");
        assert!(matches!(Manifest::parse(&escape, &dir), Err(ManifestError::Invalid(_))));
        fs::remove_file(dir.join("decoder.onnx")).unwrap();
        assert!(matches!(Manifest::parse(BASE, &dir), Err(ManifestError::Missing(_))));
        assert!(matches!(
            Manifest::load(Path::new("Z:/definitely/not/here")),
            Err(ManifestError::Missing(_))
        ));
        let _ = fs::remove_dir_all(dir);
    }

    /// 有向 pairs 优先于 languages：反向不支持。
    #[test]
    fn explicit_pairs_are_directed() {
        let dir = temp_model_dir("pairs");
        let raw = BASE.replace("\"languages\"", "\"pairs\":[[\"en\",\"zh-CN\"]],\"languages\"");
        let m = Manifest::parse(&raw, &dir).unwrap();
        assert!(m.supports_pair("en", "zh-CN"));
        assert!(!m.supports_pair("zh-CN", "en"));
        let _ = fs::remove_dir_all(dir);
    }

    /// 支持语言集合：languages 优先；为空时取 pairs 的源语言并去重。
    #[test]
    fn supported_languages_fallback() {
        let dir = temp_model_dir("supported");
        let m = Manifest::parse(BASE, &dir).unwrap();
        assert_eq!(m.supported_languages(), vec!["zh-CN".to_string(), "en".to_string()]);
        let mut m2 = m.clone();
        m2.languages = vec![];
        m2.pairs = Some(vec![("en".into(), "zh-CN".into()), ("EN".into(), "fr".into())]);
        assert_eq!(m2.supported_languages(), vec!["en".to_string()]);
        let _ = fs::remove_dir_all(dir);
    }

    /// 创建带占位 MNN 三图文件的目录：`embed.scale` 为 `rows` 行，`embed.i8` 为 `rows × dim` 字节。
    fn temp_mnn_dir(tag: &str, rows: usize, dim: usize) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arkli-translate-mnn-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for f in ["encoder.mnn", "cross_kv.mnn", "decoder_step.mnn", "tokenizer.json"] {
            fs::write(dir.join(f), b"x").unwrap();
        }
        fs::write(dir.join("embed.i8"), vec![0u8; rows * dim]).unwrap();
        fs::write(dir.join("embed.scale"), vec![0u8; rows * 4]).unwrap();
        dir
    }

    /// 最小合法 MNN 清单文本。
    const MNN_BASE: &str = r#"{"schema_version":1,"id":"m","family":"m2m100","format":"mnn-split",
        "files":{"encoder":"encoder.mnn","cross_kv":"cross_kv.mnn","decoder":"decoder_step.mnn",
        "embed":"embed.i8","embed_scale":"embed.scale","tokenizer":"tokenizer.json"},
        "languages":["zh-CN","en"],"lang_tokens":{"zh-CN":"zho_Hans","en":"eng_Latn"}}"#;

    /// `format` 缺省视为 ORT，显式 onnx-merged 同样；mnn-split 解析为 MNN；未知取值报 Invalid。
    #[test]
    fn format_dispatch() {
        let dir = temp_model_dir("fmt");
        assert_eq!(Manifest::parse(BASE, &dir).unwrap().model_format().unwrap(), ModelFormat::OnnxMerged);
        let explicit = BASE.replace("\"files\"", "\"format\":\"onnx-merged\",\"files\"");
        assert_eq!(Manifest::parse(&explicit, &dir).unwrap().model_format().unwrap(), ModelFormat::OnnxMerged);
        let unknown = BASE.replace("\"files\"", "\"format\":\"tflite\",\"files\"");
        assert!(matches!(Manifest::parse(&unknown, &dir), Err(ManifestError::Invalid(m)) if m.contains("tflite")));
        let mnn_dir = temp_mnn_dir("fmt", 4, 8);
        let m = Manifest::parse(MNN_BASE, &mnn_dir).unwrap();
        assert_eq!(m.model_format().unwrap(), ModelFormat::MnnSplit);
        // MNN 格式不要求 ONNX 的文件；ORT 格式（缺省）也不会去找 cross_kv/embed
        assert!(Manifest::parse(BASE, &mnn_dir).is_err());
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(mnn_dir);
    }

    /// MNN 清单必需 cross_kv / embed / embed_scale：任一缺键报 Invalid，文件缺失报 Missing；`*_data` 可选且给了就必须存在。
    #[test]
    fn mnn_required_files() {
        let dir = temp_mnn_dir("req", 4, 8);
        for key in ["cross_kv", "embed", "embed_scale"] {
            let needle = match key {
                "cross_kv" => "\"cross_kv\":\"cross_kv.mnn\",",
                "embed" => "\"embed\":\"embed.i8\",",
                _ => "\"embed_scale\":\"embed.scale\",",
            };
            let raw = MNN_BASE.replace(needle, "");
            assert!(matches!(Manifest::parse(&raw, &dir), Err(ManifestError::Invalid(m)) if m.contains(key)), "{key}");
        }
        fs::remove_file(dir.join("embed.i8")).unwrap();
        assert!(matches!(Manifest::parse(MNN_BASE, &dir), Err(ManifestError::Missing(m)) if m.contains("embed")));
        fs::write(dir.join("embed.i8"), vec![0u8; 32]).unwrap();
        let with_data = MNN_BASE.replace("\"embed\":", "\"cross_kv_data\":\"cross_kv.mnn.weight\",\"embed\":");
        assert!(matches!(Manifest::parse(&with_data, &dir), Err(ManifestError::Missing(_))));
        fs::write(dir.join("cross_kv.mnn.weight"), b"x").unwrap();
        assert!(Manifest::parse(&with_data, &dir).is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    /// 嵌入表文件大小不自洽报 Invalid：scale 不是 4 的倍数、i8 不能被行数整除、空文件。
    #[test]
    fn mnn_embed_size_checks() {
        let dir = temp_mnn_dir("embed", 4, 8);
        assert!(Manifest::parse(MNN_BASE, &dir).is_ok());
        fs::write(dir.join("embed.scale"), vec![0u8; 15]).unwrap();
        assert!(matches!(Manifest::parse(MNN_BASE, &dir), Err(ManifestError::Invalid(m)) if m.contains("embed_scale")));
        fs::write(dir.join("embed.scale"), vec![0u8; 16]).unwrap();
        fs::write(dir.join("embed.i8"), vec![0u8; 33]).unwrap();
        assert!(matches!(Manifest::parse(MNN_BASE, &dir), Err(ManifestError::Invalid(m)) if m.contains("embed")));
        fs::write(dir.join("embed.i8"), b"").unwrap();
        assert!(matches!(Manifest::parse(MNN_BASE, &dir), Err(ManifestError::Invalid(_))));
        fs::write(dir.join("embed.i8"), vec![0u8; 32]).unwrap();
        fs::write(dir.join("embed.scale"), b"").unwrap();
        assert!(matches!(Manifest::parse(MNN_BASE, &dir), Err(ManifestError::Invalid(_))));
        let _ = fs::remove_dir_all(dir);
    }

    /// 解码器结构缺省 12/16/64，清单可覆盖，写 0 报 Invalid。
    #[test]
    fn decoder_dims_defaults_and_override() {
        let dir = temp_mnn_dir("dims", 4, 8);
        let m = Manifest::parse(MNN_BASE, &dir).unwrap();
        assert_eq!(m.decoder_dims(), (DEFAULT_DECODER_LAYERS, DEFAULT_KV_HEADS, DEFAULT_KV_HEAD_DIM));
        let over = MNN_BASE.replace("\"files\"", "\"decoder_layers\":6,\"kv_heads\":8,\"kv_head_dim\":32,\"files\"");
        assert_eq!(Manifest::parse(&over, &dir).unwrap().decoder_dims(), (6, 8, 32));
        let zero = MNN_BASE.replace("\"files\"", "\"kv_heads\":0,\"files\"");
        assert!(matches!(Manifest::parse(&zero, &dir), Err(ManifestError::Invalid(_))));
        let _ = fs::remove_dir_all(dir);
    }

    /// M6a 实际产物的 `model.json` 样式（含 `generation`、`execution`、`*_data`）能解析，`short_phrase_wrap` 缺省。
    #[test]
    fn parses_m6a_style_manifest() {
        let dir = temp_mnn_dir("m6a", 4, 8);
        for f in ["encoder.mnn.weight", "cross_kv.mnn.weight", "decoder_step.mnn.weight"] {
            fs::write(dir.join(f), b"x").unwrap();
        }
        let raw = r#"{"schema_version":1,"family":"m2m100","format":"mnn-split",
          "files":{"encoder":"encoder.mnn","encoder_data":"encoder.mnn.weight","cross_kv":"cross_kv.mnn",
          "cross_kv_data":"cross_kv.mnn.weight","decoder":"decoder_step.mnn","decoder_data":"decoder_step.mnn.weight",
          "embed":"embed.i8","embed_scale":"embed.scale","tokenizer":"tokenizer.json"},
          "languages":["zh-CN","en"],"lang_tokens":{"zh-CN":"zho_Hans","en":"eng_Latn"},"max_input_tokens":512,
          "generation":{"decoder_start_token_id":2,"eos_token_id":2,"pad_token_id":1,"bad_token_ids":[],
          "max_new_tokens":256,"num_beams":2,"length_penalty":2.0,"min_length_ratio":0.7,"no_repeat_ngram_size":0},
          "execution":{"intra_threads":0,"cpu_arena":true,"mem_pattern":true,"opt_level":3,"prepacking":true},
          "id":"nllb600m-un6-mnn-w6","quantization":"mnn-w6-hqq"}"#;
        let m = Manifest::parse(raw, &dir).unwrap();
        assert_eq!(m.generation.short_phrase_wrap, None);
        assert_eq!(m.generation.bad_token_ids, Some(vec![]));
        let _ = fs::remove_dir_all(dir);
    }
}
