//! 抠图（MODNet 人像 / U2Net-p 通用）的 FFI 面：加载模型、对一张图抠图、取消、卸载。
//!
//! 业务逻辑都在 `arkli-ai::matting`，这里只管：进程内唯一的会话状态（两种模式各占一个槽位，加锁串行，
//! 一次只跑一个推理）、取消令牌、类型转换、错误映射。只支持 `.mnn` 模型，运行库按调用方传入的库名动态加载。

use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use arkli_ai::backend::is_mnn_model;
use arkli_ai::matting::{Matter, MattingMode};
use arkli_ai::matting_refine::RefineStrength;
use arkli_ai::mnn::{MnnNet, MnnRuntime};
use arkli_ai::task::CancelToken;
use arkli_ai::{AiError, PixelFormat, RawImage};

/// 抠图 FFI 错误，Kotlin 侧对应 `MattingFfiException` 的各子类。
#[derive(Debug, uniffi::Error)]
pub enum MattingFfiError {
    /// 该模式的模型还没加载
    NotLoaded { reason: String },
    /// 入参不合法（像素长度、图过大等）
    InvalidInput { reason: String },
    /// 被取消
    Cancelled { reason: String },
    /// 推理后端出错（库或模型加载失败、非 .mnn 模型、推理失败）
    Backend { reason: String },
}

impl std::fmt::Display for MattingFfiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MattingFfiError::NotLoaded { reason }
            | MattingFfiError::InvalidInput { reason }
            | MattingFfiError::Cancelled { reason }
            | MattingFfiError::Backend { reason } => write!(f, "{reason}"),
        }
    }
}

/// 抠图模式，对应两个模型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MattingFfiMode {
    /// 人像（MODNet）
    Portrait,
    /// 通用主体（U2Net-p）
    General,
}

impl MattingFfiMode {
    /// 转成引擎层的模式。
    fn engine(self) -> MattingMode {
        match self {
            MattingFfiMode::Portrait => MattingMode::Portrait,
            MattingFfiMode::General => MattingMode::General,
        }
    }

    /// 槽位下标。
    fn slot(self) -> usize {
        match self {
            MattingFfiMode::Portrait => 0,
            MattingFfiMode::General => 1,
        }
    }
}

/// 边缘细化强度（给页面滑块预留），对应引擎层 [`RefineStrength`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MattingFfiRefine {
    /// 不细化：alpha 原样，前景色即原图像素
    Off,
    /// 轻
    Light,
    /// 标准（缺省）
    Standard,
    /// 强：过渡更利落，细发丝可能被削弱
    Strong,
}

impl MattingFfiRefine {
    /// 转成引擎层的强度。
    fn engine(self) -> RefineStrength {
        match self {
            MattingFfiRefine::Off => RefineStrength::Off,
            MattingFfiRefine::Light => RefineStrength::Light,
            MattingFfiRefine::Standard => RefineStrength::Standard,
            MattingFfiRefine::Strong => RefineStrength::Strong,
        }
    }
}

/// 把 arkli-ai 的错误映射到 FFI 错误。
fn map_err(e: AiError) -> MattingFfiError {
    let reason = e.to_string();
    match e {
        AiError::InvalidImage(_) | AiError::InvalidConfig(_) => MattingFfiError::InvalidInput { reason },
        AiError::Cancelled => MattingFfiError::Cancelled { reason },
        _ => MattingFfiError::Backend { reason },
    }
}

/// 一次抠图的结果。
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct MattingResult {
    /// 宽（同输入图）
    pub width: u32,
    /// 高（同输入图）
    pub height: u32,
    /// 与输入图同尺寸的 8 位 alpha，行优先，长度 `width * height`
    pub alpha: Vec<u8>,
    /// 去污染后的前景色 RGB（straight alpha），行优先，长度 `width * height * 3`；`Off` 时就是原图像素
    pub fg: Vec<u8>,
    /// 抠图总耗时（毫秒，不含模型加载）= 推理段 + 细化段
    pub elapsed_ms: u64,
    /// 其中缩放、前向、alpha 缩回原图尺寸的耗时
    pub infer_ms: u64,
    /// 其中边缘细化（引导滤波 + 前景色估计）耗时，`Off` 时为 0
    pub refine_ms: u64,
}

/// 一个模式的已加载会话与它加载自哪个文件。
struct Slot {
    /// 模型文件路径（用来判断是否要重载）
    model_path: String,
    /// 引擎
    matter: Matter<MnnNet>,
}

/// 进程内状态：MNN 运行时（只加载一次）与两个模式的槽位。
#[derive(Default)]
struct State {
    /// MNN 运行时，首次加载时创建
    mnn: Option<MnnRuntime>,
    /// 槽位：0 人像，1 通用
    slots: [Option<Slot>; 2],
}

/// 全局状态；Mutex 同时保证“一次只跑一个推理”。
static STATE: Mutex<Option<State>> = Mutex::new(None);

/// 当前（或最近一次）抠图的取消令牌；单独加锁，`matting_cancel` 不必等推理结束。
static CANCEL: Mutex<Option<CancelToken>> = Mutex::new(None);

/// 取锁并确保状态已初始化后执行闭包（锁中毒时仍取出内部值继续用）。
fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(State::default))
}

/// 加载运行库与某个模式的模型，已用同一文件加载过则直接返回。
///
/// 参数：
/// - `runtime_lib`：MNN 运行库名或路径，安卓传裸名 `libarkli-mnn.so`
/// - `mode`：抠图模式
/// - `model_path`：`.mnn` 模型绝对路径
/// - `threads`：算子线程数，0 视为默认 4
///
/// 错误：`Backend`（库或模型加载失败、模型不是 `.mnn`）。
///
/// 示例（Kotlin）：`mattingLoad("libarkli-mnn.so", MattingFfiMode.PORTRAIT, "/data/.../modnet512_fp32.mnn", 4u)`
#[uniffi::export]
pub fn matting_load(runtime_lib: String, mode: MattingFfiMode, model_path: String, threads: u32) -> Result<(), MattingFfiError> {
    with_state(|s| {
        let i = mode.slot();
        if s.slots[i].as_ref().is_some_and(|x| x.model_path == model_path) {
            return Ok(());
        }
        // 先丢掉旧会话再建新的，避免两份模型同时占内存
        s.slots[i] = None;
        let path = Path::new(&model_path);
        if !is_mnn_model(path) {
            return Err(MattingFfiError::Backend { reason: format!("不支持的模型格式（只认 .mnn）：{model_path}") });
        }
        if s.mnn.is_none() {
            s.mnn = Some(MnnRuntime::load(&runtime_lib).map_err(map_err)?);
        }
        let rt = s.mnn.as_ref().expect(crate::ENSURED_ABOVE);
        let matter = rt.load_matter(path, mode.engine(), threads).map_err(map_err)?;
        s.slots[i] = Some(Slot { model_path, matter });
        Ok(())
    })
}

/// 对一张图抠图，返回与原图同尺寸的 alpha。
///
/// 参数：
/// - `mode`：抠图模式（该模式须已 `matting_load`）
/// - `width`、`height`：像素宽高（最长边不得超过 4096，更大的图由原生侧先降采样）
/// - `rgb`：行优先 RGB，长度 `width * height * 3`（原生已解码并摆正方向）
/// - `refine`：边缘细化强度，原生缺省传 `Standard`；`Off` 等同旧行为
///
/// 返回：8 位 alpha（0 透明 255 不透明）、去污染前景色 RGB 与分段耗时。
///
/// 错误：`NotLoaded`、`InvalidInput`、`Cancelled`（期间调用了 `matting_cancel`）、`Backend`。
/// 一次前向不可中途打断，取消最迟在前向结束后生效。
///
/// 示例（Kotlin）：`val r = mattingRun(MattingFfiMode.GENERAL, w.toUInt(), h.toUInt(), rgbBytes, MattingFfiRefine.STANDARD)`
#[uniffi::export]
pub fn matting_run(
    mode: MattingFfiMode,
    width: u32,
    height: u32,
    rgb: Vec<u8>,
    refine: MattingFfiRefine,
) -> Result<MattingResult, MattingFfiError> {
    let img = RawImage::new(width, height, PixelFormat::Rgb, rgb).map_err(map_err)?;
    // 先登记令牌再等状态锁：排队期间调用 matting_cancel 也能让本次一开始就取消
    let token = CancelToken::new();
    *CANCEL.lock().unwrap_or_else(|p| p.into_inner()) = Some(token.clone());
    with_state(|s| {
        let slot = s.slots[mode.slot()]
            .as_mut()
            .ok_or_else(|| MattingFfiError::NotLoaded { reason: "抠图模型未加载".into() })?;
        let t0 = Instant::now();
        let m = slot.matter.matte(&img, &token, refine.engine()).map_err(map_err)?;
        Ok(MattingResult {
            width: m.width,
            height: m.height,
            alpha: m.alpha,
            fg: m.fg,
            elapsed_ms: t0.elapsed().as_millis() as u64,
            infer_ms: m.infer_ms,
            refine_ms: m.refine_ms,
        })
    })
}

/// 取消正在进行（或排队中）的抠图，在下一个检查点返回 `Cancelled`。可在任意线程调用，没有抠图在跑时无副作用。
#[uniffi::export]
pub fn matting_cancel() {
    if let Some(t) = CANCEL.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        t.cancel();
    }
}

/// 释放某个模式的模型会话，运行库保留。下次抠图前需重新 `matting_load`。
///
/// 参数：`mode` 要释放的模式。
#[uniffi::export]
pub fn matting_unload(mode: MattingFfiMode) {
    with_state(|s| {
        s.slots[mode.slot()] = None;
        // MNN：先让它丢缓存缓冲、退还空闲页，再让进程分配器归还
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
    fn 未加载模型时抠图报未就绪() {
        matting_unload(MattingFfiMode::Portrait);
        let r = matting_run(MattingFfiMode::Portrait, 1, 1, vec![0; 3], MattingFfiRefine::Standard);
        assert!(matches!(r, Err(MattingFfiError::NotLoaded { .. })));
    }

    #[test]
    fn 像素长度不对报入参错误() {
        assert!(matches!(matting_run(MattingFfiMode::General, 2, 2, vec![0; 5], MattingFfiRefine::Standard), Err(MattingFfiError::InvalidInput { .. })));
    }

    #[test]
    fn 非mnn模型报后端错误() {
        let r = matting_load("libarkli-mnn.so".into(), MattingFfiMode::General, "x.onnx".into(), 4);
        assert!(matches!(&r, Err(MattingFfiError::Backend { reason }) if reason.contains(".mnn")), "{r:?}");
    }

    #[test]
    fn 找不到mnn库报后端错误() {
        let r = matting_load("definitely-not-exist-libarkli-mnn.so".into(), MattingFfiMode::Portrait, "x.mnn".into(), 4);
        assert!(matches!(r, Err(MattingFfiError::Backend { .. })));
    }

    #[test]
    fn 没有抠图在跑时取消无副作用() {
        matting_cancel();
        matting_unload(MattingFfiMode::General);
    }

    #[test]
    fn 错误映射() {
        assert!(matches!(map_err(AiError::Cancelled), MattingFfiError::Cancelled { .. }));
        assert!(matches!(map_err(AiError::InvalidImage("x".into())), MattingFfiError::InvalidInput { .. }));
        assert!(matches!(map_err(AiError::Backend("x".into())), MattingFfiError::Backend { .. }));
    }

    #[test]
    fn 细化强度映射到引擎层() {
        assert_eq!(MattingFfiRefine::Off.engine(), RefineStrength::Off);
        assert_eq!(MattingFfiRefine::Light.engine(), RefineStrength::Light);
        assert_eq!(MattingFfiRefine::Standard.engine(), RefineStrength::default());
        assert_eq!(MattingFfiRefine::Strong.engine(), RefineStrength::Strong);
    }

    #[test]
    fn 模式槽位互不相同() {
        assert_ne!(MattingFfiMode::Portrait.slot(), MattingFfiMode::General.slot());
        assert_eq!(MattingFfiMode::General.engine(), MattingMode::General);
    }

    /// 取必需的环境变量。
    fn env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("未设置 {name}"))
    }

    /// 运行条件：ARKLI_MNN_DYLIB（arkli-mnn.dll，同目录要有 MNN.dll）、ARKLI_MATTING_MODEL（`.mnn`）、
    /// ARKLI_MATTING_MODE（`portrait` 或 `general`）、ARKLI_MATTING_RGB（8 字节小端宽高 + RGB）；可选 ARKLI_MATTING_OUT（写出 alpha 原始字节）。
    /// 命令：`cargo test -p arkli-ffi matting -- --ignored --nocapture`
    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_MATTING_MODEL / ARKLI_MATTING_MODE / ARKLI_MATTING_RGB"]
    fn 真库经ffi抠图并可卸载重载() {
        let mode = if env("ARKLI_MATTING_MODE") == "general" { MattingFfiMode::General } else { MattingFfiMode::Portrait };
        matting_load(env("ARKLI_MNN_DYLIB"), mode, env("ARKLI_MATTING_MODEL"), 4).unwrap();
        let raw = std::fs::read(env("ARKLI_MATTING_RGB")).unwrap();
        let w = u32::from_le_bytes(raw[0..4].try_into().unwrap());
        let h = u32::from_le_bytes(raw[4..8].try_into().unwrap());
        let r = matting_run(mode, w, h, raw[8..].to_vec(), MattingFfiRefine::Standard).unwrap();
        println!("{}x{} {}ms（推理 {}ms，细化 {}ms）", r.width, r.height, r.elapsed_ms, r.infer_ms, r.refine_ms);
        assert_eq!(r.alpha.len(), (w * h) as usize);
        assert_eq!(r.fg.len(), (w * h * 3) as usize);
        // 给桌面对拍脚本留下 alpha（可选）
        if let Ok(out) = std::env::var("ARKLI_MATTING_OUT") {
            std::fs::write(out, &r.alpha).unwrap();
        }
        matting_unload(mode);
        assert!(matches!(matting_run(mode, w, h, raw[8..].to_vec(), MattingFfiRefine::Off), Err(MattingFfiError::NotLoaded { .. })));
    }
}
