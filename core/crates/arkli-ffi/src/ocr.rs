//! 文字识别（PP-OCRv5 / v6 small）的 FFI 面：加载模型目录、识别一张图、取消、卸载。
//!
//! 业务逻辑都在 `arkli-ai`（`OcrPipeline`），这里只管：进程内唯一的管线（加锁串行，一次只跑一个推理）、
//! 取消令牌、类型转换、错误映射。只支持 MNN 模型（`det.mnn` / `rec.mnn` / `cls.mnn` + `ppocr_keys.txt`），
//! 运行库按调用方传入的库名动态加载（安卓传裸名 `libarkli-mnn.so`）。

use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use arkli_ai::task::CancelToken;
use arkli_ai::mnn::MnnRuntime;
use arkli_ai::pipeline::OcrPipeline;
use arkli_ai::{AiError, PixelFormat, RawImage};

/// 文字识别 FFI 错误，Kotlin 侧对应 `OcrFfiException` 的各子类。
#[derive(Debug, uniffi::Error)]
pub enum OcrFfiError {
    /// 模型还没加载
    NotLoaded { reason: String },
    /// 入参不合法（像素长度、图过大等）
    InvalidInput { reason: String },
    /// 被取消
    Cancelled { reason: String },
    /// 推理后端出错（库或模型加载失败、推理失败、字典缺失）
    Backend { reason: String },
}

impl std::fmt::Display for OcrFfiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OcrFfiError::NotLoaded { reason }
            | OcrFfiError::InvalidInput { reason }
            | OcrFfiError::Cancelled { reason }
            | OcrFfiError::Backend { reason } => write!(f, "{reason}"),
        }
    }
}

/// 把 arkli-ai 的错误映射到 FFI 错误。
fn map_err(e: AiError) -> OcrFfiError {
    let reason = e.to_string();
    match e {
        AiError::InvalidImage(_) => OcrFfiError::InvalidInput { reason },
        AiError::Cancelled => OcrFfiError::Cancelled { reason },
        _ => OcrFfiError::Backend { reason },
    }
}

/// 一个点，原图像素坐标。
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct OcrPoint {
    /// 横坐标
    pub x: f32,
    /// 纵坐标
    pub y: f32,
}

/// 一行识别结果。
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct OcrTextLine {
    /// 文本框四个角（左上、右上、右下、左下）
    pub points: Vec<OcrPoint>,
    /// 识别文本
    pub text: String,
    /// 置信度 0..=1
    pub score: f32,
}

/// 一次识别的结果。
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct OcrResult {
    /// 输入图宽（像素，坐标系的基准）
    pub width: u32,
    /// 输入图高
    pub height: u32,
    /// 文本行，按阅读顺序
    pub lines: Vec<OcrTextLine>,
    /// 识别耗时（毫秒，不含模型加载）
    pub elapsed_ms: u64,
}

/// 进程内状态：MNN 运行时、当前管线与它加载自哪个目录（用来判断是否要重载）。
#[derive(Default)]
struct State {
    /// MNN 运行时，首次加载时创建
    mnn: Option<MnnRuntime>,
    /// 当前模型目录
    model_dir: Option<String>,
    /// 管线
    pipeline: Option<OcrPipeline>,
}

/// 全局状态；Mutex 同时保证“一次只跑一个推理”。
static STATE: Mutex<Option<State>> = Mutex::new(None);

/// 当前（或最近一次）识别的取消令牌；单独加锁，`ocr_cancel` 不必等推理结束。
static CANCEL: Mutex<Option<CancelToken>> = Mutex::new(None);

/// 取锁并确保状态已初始化后执行闭包（锁中毒时仍取出内部值继续用）。
fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(State::default))
}

/// 加载运行库与模型目录，已用同一目录加载过则直接返回。
///
/// 参数：
/// - `runtime_lib`：MNN 运行库名或路径，安卓传裸名 `libarkli-mnn.so`
/// - `model_dir`：模型目录绝对路径，含 `det.mnn`、`rec.mnn`、`cls.mnn`、`ppocr_keys.txt`
/// - `threads`：算子线程数，0 视为默认 4
///
/// 错误：`Backend`（库、模型或字典加载失败，未编译 MNN 后端）。
///
/// 示例（Kotlin）：`ocrLoad("libarkli-mnn.so", "/data/.../ppocrv6-small-mnn-fp16", 4u)`
#[uniffi::export]
pub fn ocr_load(runtime_lib: String, model_dir: String, threads: u32) -> Result<(), OcrFfiError> {
    with_state(|s| {
        if s.pipeline.is_some() && s.model_dir.as_deref() == Some(model_dir.as_str()) {
            return Ok(());
        }
        // 先丢掉旧会话再建新的，避免两份模型同时占内存
        s.pipeline = None;
        s.model_dir = None;
        let p = load_mnn(s, &runtime_lib, Path::new(&model_dir), threads)?;
        s.pipeline = Some(p);
        s.model_dir = Some(model_dir);
        Ok(())
    })
}

/// 用 MNN 加载管线（首次创建运行时）。
fn load_mnn(s: &mut State, lib: &str, dir: &Path, threads: u32) -> Result<OcrPipeline, OcrFfiError> {
    if s.mnn.is_none() {
        s.mnn = Some(MnnRuntime::load(lib).map_err(map_err)?);
    }
    let rt = s.mnn.as_ref().expect(crate::ENSURED_ABOVE);
    rt.load_ocr_pipeline(dir, threads).map_err(map_err)
}

/// 识别一张图里的文字。
///
/// 参数：
/// - `width`、`height`：像素宽高（最长边不得超过 4096，更大的图由原生侧先降采样）
/// - `rgb`：行优先 RGB，长度 `width * height * 3`（原生已解码并摆正方向）
///
/// 返回：按阅读顺序的文本行（坐标为输入图像素坐标），低分与空文本已剔除。
///
/// 错误：`NotLoaded`（没调用过 `ocr_load`）、`InvalidInput`、`Cancelled`（期间调用了 `ocr_cancel`）、`Backend`。
///
/// 示例（Kotlin）：`val r = ocrRecognize(w.toUInt(), h.toUInt(), rgbBytes)`
#[uniffi::export]
pub fn ocr_recognize(width: u32, height: u32, rgb: Vec<u8>) -> Result<OcrResult, OcrFfiError> {
    let img = RawImage::new(width, height, PixelFormat::Rgb, rgb).map_err(map_err)?;
    // 先登记令牌再等状态锁：排队期间调用 ocr_cancel 也能让本次一开始就取消
    let token = CancelToken::new();
    *CANCEL.lock().unwrap_or_else(|p| p.into_inner()) = Some(token.clone());
    with_state(|s| {
        let p = s.pipeline.as_mut().ok_or_else(|| OcrFfiError::NotLoaded { reason: "文字识别模型未加载".into() })?;
        let t0 = Instant::now();
        let lines = p.recognize(&img, &token, &mut |_| {}).map_err(map_err)?;
        Ok(OcrResult {
            width,
            height,
            lines: lines
                .into_iter()
                .map(|l| OcrTextLine {
                    points: l.quad.iter().map(|&(x, y)| OcrPoint { x, y }).collect(),
                    text: l.text,
                    score: l.score,
                })
                .collect(),
            elapsed_ms: t0.elapsed().as_millis() as u64,
        })
    })
}

/// 取消正在进行（或排队中）的识别，在管线下一个检查点返回 `Cancelled`。可在任意线程调用，没有识别在跑时无副作用。
#[uniffi::export]
pub fn ocr_cancel() {
    if let Some(t) = CANCEL.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        t.cancel();
    }
}

/// 释放识别模型（约数十 MB 内存），运行库保留。下次识别前需重新 `ocr_load`。
#[uniffi::export]
pub fn ocr_unload() {
    with_state(|s| {
        s.pipeline = None;
        s.model_dir = None;
    });
    // MNN：先让它丢缓存缓冲、退还空闲页，再让进程分配器归还
        with_state(|s| {
        if let Some(rt) = &s.mnn {
            rt.release_memory();
        }
    });
    crate::mem::purge_heap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 未加载模型时识别报未就绪() {
        ocr_unload();
        let r = ocr_recognize(1, 1, vec![0; 3]);
        assert!(matches!(r, Err(OcrFfiError::NotLoaded { .. })));
    }

    #[test]
    fn 像素长度不对报入参错误() {
        assert!(matches!(ocr_recognize(2, 2, vec![0; 5]), Err(OcrFfiError::InvalidInput { .. })));
    }

    #[test]
    fn 找不到mnn库报后端错误() {
        ocr_unload();
        let r = ocr_load("definitely-not-exist-libarkli-mnn.so".into(), "Z:/not/here".into(), 4);
        assert!(matches!(r, Err(OcrFfiError::Backend { .. })));
    }

    #[test]
    fn 没有识别在跑时取消无副作用() {
        ocr_cancel();
        ocr_unload();
    }

    #[test]
    fn 错误映射() {
        assert!(matches!(map_err(AiError::Cancelled), OcrFfiError::Cancelled { .. }));
        assert!(matches!(map_err(AiError::InvalidImage("x".into())), OcrFfiError::InvalidInput { .. }));
        assert!(matches!(map_err(AiError::Backend("x".into())), OcrFfiError::Backend { .. }));
    }

    /// 取必需的环境变量。
    fn env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("未设置 {name}"))
    }

    /// 运行条件：ARKLI_MNN_DYLIB（arkli-mnn.dll，同目录要有 MNN.dll）、ARKLI_OCR_DIR（ppocrv6-small-mnn-fp16 或 ppocrv5-mnn-fp16 目录）、
    /// ARKLI_OCR_RGB（`scripts/mnn/ocr_case.py` 生成的 case.rgb）。
    /// 命令：`cargo test -p arkli-ffi ocr -- --ignored --nocapture`
    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_OCR_DIR / ARKLI_OCR_RGB"]
    fn 真库经ffi识别并可卸载重载() {
        ocr_load(env("ARKLI_MNN_DYLIB"), env("ARKLI_OCR_DIR"), 4).unwrap();
        // 同目录再加载是空操作
        ocr_load(env("ARKLI_MNN_DYLIB"), env("ARKLI_OCR_DIR"), 4).unwrap();
        let raw = std::fs::read(env("ARKLI_OCR_RGB")).unwrap();
        let w = u32::from_le_bytes(raw[0..4].try_into().unwrap());
        let h = u32::from_le_bytes(raw[4..8].try_into().unwrap());
        let r = ocr_recognize(w, h, raw[8..].to_vec()).unwrap();
        println!("{}x{} {} 行 {}ms", r.width, r.height, r.lines.len(), r.elapsed_ms);
        for l in &r.lines {
            println!("  [{:.3}] {} {:?}", l.score, l.text, l.points[0]);
        }
        assert_eq!(r.lines.len(), 6);
        assert!(r.lines.iter().all(|l| l.points.len() == 4));
        ocr_unload();
        assert!(matches!(ocr_recognize(w, h, raw[8..].to_vec()), Err(OcrFfiError::NotLoaded { .. })));
        ocr_load(env("ARKLI_MNN_DYLIB"), env("ARKLI_OCR_DIR"), 4).unwrap();
        assert_eq!(ocr_recognize(w, h, raw[8..].to_vec()).unwrap().lines.len(), 6);
        ocr_unload();
    }
}
