//! 识物（SigLIP2）的 FFI 面：加载模型与词表、对一张图分类。
//!
//! 业务逻辑都在 `arkli-ai`，这里只管：进程内唯一的会话状态（加锁串行，一次只跑一个推理）、
//! 类型转换、错误映射。ORT 动态库通过 `ort` 的 load-dynamic 按裸名 `libonnxruntime.so` 加载。

use std::path::Path;
use std::sync::Mutex;

use arkli_ai::backend::InferenceBackend;
use arkli_ai::classify::{classify_image, ClassifyOptions, Vocab, VocabEntry};
use arkli_ai::clip::ClipEncoder;
use arkli_ai::ort_backend::OrtBackend;
use arkli_ai::provider::{Provider, SessionOptions};
use arkli_ai::{AiError, PixelFormat, RawImage};

/// 识物 FFI 错误，Kotlin 侧对应 `ClipFfiException` 的各子类。
#[derive(Debug, uniffi::Error)]
pub enum ClipFfiError {
    /// 模型或词表还没加载
    NotLoaded { reason: String },
    /// 入参不合法（像素长度、词表格式等）
    InvalidInput { reason: String },
    /// 推理后端出错（找不到 ORT 库、模型损坏、推理失败）
    Backend { reason: String },
}

impl std::fmt::Display for ClipFfiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClipFfiError::NotLoaded { reason }
            | ClipFfiError::InvalidInput { reason }
            | ClipFfiError::Backend { reason } => write!(f, "{reason}"),
        }
    }
}

/// 把 arkli-ai 的错误映射到 FFI 错误。
fn map_err(e: AiError) -> ClipFfiError {
    let reason = e.to_string();
    match e {
        AiError::InvalidImage(_) | AiError::InvalidConfig(_) => ClipFfiError::InvalidInput { reason },
        _ => ClipFfiError::Backend { reason },
    }
}

/// 词表条目（来自 `garbage_vocab.json`）。
#[derive(Debug, Clone, uniffi::Record)]
pub struct ClipVocabEntry {
    /// 稳定 id
    pub id: String,
    /// 中文名
    pub name_zh: String,
    /// 英文名
    pub name_en: String,
    /// 分类代码
    pub category: String,
}

/// 一个命中的物品。
#[derive(Debug, Clone, uniffi::Record)]
pub struct ClipItemHit {
    /// 词表下标
    pub index: u32,
    /// 余弦相似度
    pub score: f32,
}

/// 一个分类的聚合概率。
#[derive(Debug, Clone, uniffi::Record)]
pub struct ClipCategoryProb {
    /// 分类代码
    pub category: String,
    /// 概率
    pub prob: f32,
}

/// 分类结果。
#[derive(Debug, Clone, uniffi::Record)]
pub struct ClipClassifyResult {
    /// top-k 物品，余弦从大到小
    pub items: Vec<ClipItemHit>,
    /// 分类概率，从大到小
    pub categories: Vec<ClipCategoryProb>,
    /// 最大分类概率
    pub confidence: f32,
    /// 是否低于“拿不准”阈值
    pub uncertain: bool,
}

/// 进程内状态：ORT 后端（只加载一次）、编码器（会话复用）、词表。
#[derive(Default)]
struct State {
    /// ORT 后端，首次 `clip_load` 时创建
    backend: Option<OrtBackend>,
    /// 当前模型路径，用来判断是否要重载
    model_path: Option<String>,
    /// 编码器
    encoder: Option<ClipEncoder>,
    /// 词表
    vocab: Option<Vocab>,
}

/// 全局状态；Mutex 同时保证“一次只跑一个推理”。
static STATE: Mutex<Option<State>> = Mutex::new(None);

/// 取锁并确保状态已初始化后执行闭包（锁中毒时仍取出内部值继续用）。
fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(State::default))
}

/// 加载 ORT 与模型，已用同一模型加载过则直接返回。
///
/// 参数：
/// - `ort_lib`：ORT 动态库名或路径，APK 内传裸名 `libonnxruntime.so`
/// - `model_path`：`q4_half.onnx` 绝对路径
/// - `threads`：算子线程数，0 视为默认 4
///
/// 错误：`Backend`（库或模型加载失败）。
///
/// 示例（Kotlin）：`clipLoad("libonnxruntime.so", "/data/.../q4_half.onnx", 4u)`
#[uniffi::export]
pub fn clip_load(ort_lib: String, model_path: String, threads: u32) -> Result<(), ClipFfiError> {
    with_state(|s| {
        if s.encoder.is_some() && s.model_path.as_deref() == Some(model_path.as_str()) {
            return Ok(());
        }
        if s.backend.is_none() {
            s.backend = Some(OrtBackend::load(&ort_lib).map_err(map_err)?);
        }
        let opts = SessionOptions {
            provider: Provider::Cpu,
            intra_threads: if threads == 0 { arkli_ai::provider::DEFAULT_THREADS } else { threads },
        };
        // 先丢掉旧会话再建新的，避免两份模型同时占内存
        s.encoder = None;
        let backend = s.backend.as_ref().expect("上面已确保存在");
        let session = backend.load_model(Path::new(&model_path), &opts).map_err(map_err)?;
        s.encoder = Some(ClipEncoder::new(session));
        s.model_path = Some(model_path);
        Ok(())
    })
}

/// 设置词表。可反复调用，后一次覆盖前一次。
///
/// 参数：
/// - `entries`：条目元数据
/// - `dim`：向量维度
/// - `vectors_f16le`：`entries.len() * dim` 个小端 fp16
///
/// 错误：`InvalidInput`（长度或数值不合法）。
#[uniffi::export]
pub fn clip_set_vocab(entries: Vec<ClipVocabEntry>, dim: u32, vectors_f16le: Vec<u8>) -> Result<(), ClipFfiError> {
    let entries = entries
        .into_iter()
        .map(|e| VocabEntry {
            id: e.id,
            name_zh: e.name_zh,
            name_en: e.name_en,
            category: e.category,
        })
        .collect();
    let vocab = Vocab::from_f16le(entries, dim as usize, &vectors_f16le).map_err(map_err)?;
    with_state(|s| s.vocab = Some(vocab));
    Ok(())
}

/// 对一张图分类。
///
/// 参数：
/// - `width`、`height`：像素宽高
/// - `rgb`：行优先 RGB，长度 `width * height * 3`（原生已解码并摆正方向，Rust 负责缩放到 224）
/// - `top_k`：返回物品数，0 视为默认 3
///
/// 返回：top-k 物品下标与余弦、分类概率、置信度。
///
/// 错误：`NotLoaded`（没调用过 `clip_load` / `clip_set_vocab`）、`InvalidInput`、`Backend`。
#[uniffi::export]
pub fn clip_classify(width: u32, height: u32, rgb: Vec<u8>, top_k: u32) -> Result<ClipClassifyResult, ClipFfiError> {
    let img = RawImage::new(width, height, PixelFormat::Rgb, rgb).map_err(map_err)?;
    let mut opts = ClassifyOptions::default();
    if top_k > 0 {
        opts.top_k = top_k as usize;
    }
    with_state(|s| {
        let vocab = s.vocab.as_ref().ok_or_else(|| ClipFfiError::NotLoaded { reason: "词表未设置".into() })?;
        let enc = s.encoder.as_mut().ok_or_else(|| ClipFfiError::NotLoaded { reason: "模型未加载".into() })?;
        let r = classify_image(enc, vocab, &img, opts).map_err(map_err)?;
        Ok(ClipClassifyResult {
            items: r.items.iter().map(|h| ClipItemHit { index: h.index as u32, score: h.score }).collect(),
            categories: r.categories.into_iter().map(|c| ClipCategoryProb { category: c.category, prob: c.prob }).collect(),
            confidence: r.confidence,
            uncertain: r.uncertain,
        })
    })
}

/// 释放模型会话（约 100MB 内存），词表与 ORT 库保留。下次分类前需重新 `clip_load`。
#[uniffi::export]
pub fn clip_unload() {
    with_state(|s| {
        s.encoder = None;
        s.model_path = None;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两条目、2 维的最小词表字节：(1,0) 与 (0,1)，fp16 的 1.0 = 0x3C00。
    fn tiny_vocab() -> (Vec<ClipVocabEntry>, Vec<u8>) {
        let e = |id: &str, c: &str| ClipVocabEntry { id: id.into(), name_zh: id.into(), name_en: id.into(), category: c.into() };
        let one = 0x3C00u16.to_le_bytes();
        let zero = 0u16.to_le_bytes();
        (vec![e("a", "R"), e("b", "D")], [one, zero, zero, one].concat())
    }

    #[test]
    fn 未加载模型时分类报未就绪() {
        clip_unload();
        let (e, b) = tiny_vocab();
        clip_set_vocab(e, 2, b).unwrap();
        let r = clip_classify(1, 1, vec![0; 3], 3);
        assert!(matches!(r, Err(ClipFfiError::NotLoaded { .. })));
    }

    #[test]
    fn 词表长度不对报入参错误() {
        let (e, _) = tiny_vocab();
        assert!(matches!(clip_set_vocab(e, 2, vec![0; 3]), Err(ClipFfiError::InvalidInput { .. })));
    }

    #[test]
    fn 像素长度不对报入参错误() {
        assert!(matches!(clip_classify(2, 2, vec![0; 5], 3), Err(ClipFfiError::InvalidInput { .. })));
    }

    #[test]
    fn 找不到ort库报后端错误() {
        let r = clip_load("definitely-not-exist-libonnxruntime.so".into(), "x.onnx".into(), 4);
        assert!(matches!(r, Err(ClipFfiError::Backend { .. })));
    }
}
