//! logo 符号生成（SDXS 一步文生图 + 后处理）的 FFI 面：加载模型、生成、取消、卸载。
//!
//! 业务逻辑都在 `arkli-ai::logo_gen` / `logo_post`，这里只管：进程内唯一的引擎（加锁串行，一次只跑一个生成）、
//! 取消令牌、阶段进度、类型转换、错误映射。只认 `.mnn` 模型，运行库按调用方传入的库名动态加载。
//!
//! 取消：一次前向不可中途打断，只在 分词 / 文本编码 / UNet / 解码 / 后处理 各段之间检查，
//! 所以取消延迟最长约一次 UNet（真机 6~8 秒）。取消后引擎照常可用，不残留状态。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;

use arkli_ai::logo_gen::{LogoGenerator, LogoStage, Residency};
use arkli_ai::logo_post::mask_to_gray;
use arkli_ai::mnn::{MnnLogoLoader, MnnRuntime};
use arkli_ai::task::CancelToken;
use arkli_ai::AiError;

/// 提示词最大字节数（只是防滥用的上限，分词本身会截到 77 个 token）。
const MAX_PROMPT_BYTES: usize = 2000;
/// 进度：空闲（没有生成在跑）。
const STAGE_IDLE: u8 = 0;

/// logo 生成 FFI 错误，Kotlin 侧对应 `LogoFfiException` 的各子类。
#[derive(Debug, uniffi::Error)]
pub enum LogoFfiError {
    /// 模型还没加载
    NotLoaded { reason: String },
    /// 入参不合法（提示词为空或过长等）
    InvalidInput { reason: String },
    /// 被取消
    Cancelled { reason: String },
    /// 推理后端出错（库或模型加载失败、模型缺文件、非 .mnn 模型、推理失败）
    Backend { reason: String },
}

impl std::fmt::Display for LogoFfiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LogoFfiError::NotLoaded { reason }
            | LogoFfiError::InvalidInput { reason }
            | LogoFfiError::Cancelled { reason }
            | LogoFfiError::Backend { reason } => write!(f, "{reason}"),
        }
    }
}

/// 模型驻留方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LogoFfiResidency {
    /// 三张图常驻内存：快，真机峰值约 1.3GB
    Resident,
    /// 每段用完即卸载：峰值约 720MB（低内存兜底），每次生成要重新加载，慢约 50%
    PerStage,
}

impl LogoFfiResidency {
    /// 转成引擎层的驻留方式。
    fn engine(self) -> Residency {
        match self {
            LogoFfiResidency::Resident => Residency::Resident,
            LogoFfiResidency::PerStage => Residency::PerStage,
        }
    }
}

/// 生成进度的阶段（供 `logo_stage` 轮询）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LogoFfiStage {
    /// 没有生成在跑
    Idle,
    /// 分词
    Tokenize,
    /// 文本编码
    TextEncode,
    /// UNet 一步
    Unet,
    /// TAESD 解码
    Decode,
    /// 后处理（二值化、闸门、描摹）
    Post,
}

impl LogoFfiStage {
    /// 引擎阶段转成 FFI 阶段。
    fn from_engine(s: LogoStage) -> Self {
        match s {
            LogoStage::Tokenize => LogoFfiStage::Tokenize,
            LogoStage::TextEncode => LogoFfiStage::TextEncode,
            LogoStage::Unet => LogoFfiStage::Unet,
            LogoStage::Decode => LogoFfiStage::Decode,
            LogoStage::Post => LogoFfiStage::Post,
        }
    }

    /// 存进原子量用的编码。
    fn code(self) -> u8 {
        self as u8
    }

    /// 从原子量里的编码还原，未知值当空闲。
    fn from_code(c: u8) -> Self {
        [LogoFfiStage::Idle, LogoFfiStage::Tokenize, LogoFfiStage::TextEncode, LogoFfiStage::Unet, LogoFfiStage::Decode, LogoFfiStage::Post]
            .get(c as usize)
            .copied()
            .unwrap_or(LogoFfiStage::Idle)
    }
}

/// 符号的质量特征（闸门的输入，调试与调参用）。
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LogoFfiFeatures {
    /// 墨量占画布比例
    pub ink_canvas: f32,
    /// 旋转对称最小 IoU（越高越像靶心圆）
    pub rot_iou: f32,
    /// 较大连通域个数
    pub comps: u32,
    /// 小斑点个数
    pub specks: u32,
    /// 符号最大边相对画布（或外圈内径）的比例
    pub size_rel: f32,
    /// 质心偏离画布中心的比例
    pub off: f32,
    /// 外接框内的填充率
    pub fill_bbox: f32,
    /// 是否空图
    pub empty: bool,
}

/// 各段耗时（毫秒，不含模型加载以外的排队时间）。
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LogoFfiTimings {
    /// 分词
    pub tokenize_ms: u64,
    /// 文本编码
    pub text_ms: u64,
    /// UNet 一步
    pub unet_ms: u64,
    /// 一步采样公式
    pub step_ms: u64,
    /// TAESD 解码
    pub vae_ms: u64,
    /// 模型加载（常驻模式只在被卸载后的首次出现；分段模式每次都有）
    pub load_ms: u64,
    /// 二值化与符号提取
    pub extract_ms: u64,
    /// 质量特征
    pub features_ms: u64,
    /// 闸门
    pub gate_ms: u64,
    /// vtracer 描摹
    pub trace_ms: u64,
    /// 总耗时（出图 + 后处理）
    pub total_ms: u64,
}

/// 一次生成的结果。
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LogoFfiResult {
    /// 单色符号的 `<path .../>` 片段（填充色统一为 `#000000`，坐标系 512x512，由 App 换成主题色并放进容器）；空图时为 `None`
    pub svg_paths: Option<String>,
    /// 路径元素个数
    pub path_count: u32,
    /// 闸门是否通过。没过时 `svg_paths` 仍可能有值，由调用方取舍（过闸率只有约一半，不过就换概念重出或回落模板）
    pub gate_ok: bool,
    /// 闸门未通过的原因代码：`empty` `ink_low` `ink_high` `concentric` `fragments` `specks` `small` `off_center`
    pub gate_reasons: Vec<String>,
    /// 是否检测到并去掉了模型自画的外圈
    pub ring_detected: bool,
    /// 质量特征
    pub features: LogoFfiFeatures,
    /// 各段耗时
    pub timings: LogoFfiTimings,
    /// 512x512 灰度二值图（图形黑 0、背景白 255，长 262144），只有调用时 `with_mask = true` 才给；调试与对比用
    pub mask_gray: Option<Vec<u8>>,
}

/// 把 arkli-ai 的错误映射到 FFI 错误（生成过程）。
fn map_err(e: AiError) -> LogoFfiError {
    let reason = e.to_string();
    match e {
        AiError::InvalidImage(_) | AiError::InvalidConfig(_) => LogoFfiError::InvalidInput { reason },
        AiError::Cancelled => LogoFfiError::Cancelled { reason },
        _ => LogoFfiError::Backend { reason },
    }
}

/// 把 arkli-ai 的错误映射到 FFI 错误（加载过程：模型缺文件、词表不合法都算后端问题）。
fn map_load_err(e: AiError) -> LogoFfiError {
    match e {
        AiError::Cancelled => LogoFfiError::Cancelled { reason: e.to_string() },
        other => LogoFfiError::Backend { reason: other.to_string() },
    }
}

/// 已加载的引擎与它的加载参数（用来判断是否要重载）。
struct Loaded {
    /// 模型目录
    dir: String,
    /// 线程数（0 视为默认）
    threads: u32,
    /// 驻留方式
    residency: LogoFfiResidency,
    /// 引擎
    gen: LogoGenerator<MnnLogoLoader>,
}

/// 进程内状态：MNN 运行时（只加载一次）与引擎。
#[derive(Default)]
struct State {
    /// MNN 运行时，首次加载时创建
    mnn: Option<MnnRuntime>,
    /// 已加载的引擎
    loaded: Option<Loaded>,
}

/// 阶段复位守卫：离开作用域（含 panic 展开）时把 `STAGE` 复位为空闲。
struct StageReset;

impl Drop for StageReset {
    /// 复位阶段为空闲。
    fn drop(&mut self) {
        STAGE.store(STAGE_IDLE, Ordering::Relaxed);
    }
}

/// 全局状态；Mutex 同时保证“一次只跑一个生成”。
static STATE: Mutex<Option<State>> = Mutex::new(None);

/// 当前（或最近一次）生成的取消令牌；单独加锁，`logo_cancel` 不必等生成结束。
static CANCEL: Mutex<Option<CancelToken>> = Mutex::new(None);

/// 当前阶段（`LogoFfiStage::code`）；原子量，`logo_stage` 随时可读。
static STAGE: AtomicU8 = AtomicU8::new(STAGE_IDLE);

/// 取锁并确保状态已初始化后执行闭包（锁中毒时仍取出内部值继续用）。
fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(State::default))
}

/// 加载运行库与 logo 生成模型，已用同样参数加载过则直接返回。
///
/// 参数：
/// - `runtime_lib`：MNN 运行库名或路径，安卓传裸名 `libarkli-mnn.so`
/// - `model_dir`：模型目录，含 `text_encoder.mnn`、`unet.mnn`、`vae_decoder.mnn`、`tokenizer.json`
/// - `threads`：算子线程数，0 视为默认 4（真机 8 线程反而慢约 15%，别开大）
/// - `residency`：常驻（快、峰值约 1.3GB）或每段用完即卸载（峰值约 720MB）
///
/// 错误：`Backend`（库或模型加载失败、缺文件、词表不合法）。参数变了会先卸掉旧引擎再加载。
///
/// 示例（Kotlin）：`logoLoad("libarkli-mnn.so", "/data/.../sdxs", 4u, LogoFfiResidency.RESIDENT)`
#[uniffi::export]
pub fn logo_load(runtime_lib: String, model_dir: String, threads: u32, residency: LogoFfiResidency) -> Result<(), LogoFfiError> {
    with_state(|s| {
        if s.loaded.as_ref().is_some_and(|l| l.dir == model_dir && l.threads == threads && l.residency == residency) {
            return Ok(());
        }
        // 先丢掉旧引擎并让运行时与进程分配器归还内存，再建新的，避免两份模型同时占内存
        if s.loaded.take().is_some() {
            if let Some(rt) = &s.mnn {
                rt.release_memory();
            }
            crate::mem::purge_heap();
        }
        if s.mnn.is_none() {
            s.mnn = Some(MnnRuntime::load(&runtime_lib).map_err(map_load_err)?);
        }
        let rt = s.mnn.as_ref().expect(crate::ENSURED_ABOVE);
        let gen = rt.load_logo_gen(&PathBuf::from(&model_dir), threads, residency.engine()).map_err(map_load_err)?;
        s.loaded = Some(Loaded { dir: model_dir, threads, residency, gen });
        Ok(())
    })
}

/// 生成一个符号：提示词 -> 一步出图 -> 二值化 -> 质量闸门 -> 单色 SVG path。
///
/// 参数：
/// - `prompt`：已拼好的英文提示词（非空，不超过 2000 字节；超过 77 个 token 的部分被截断）
/// - `seed`：随机种子，同种子同提示词同模型得到同一结果
/// - `remove_ring`：后处理是否检测并去掉模型自画的外圈（推荐的提示词不会画圈，原型默认 `true`）
/// - `with_mask`：是否返回二值位图（调试用，262KB）
///
/// 返回：SVG path、闸门结果与原因、质量特征、各段耗时。闸门没过时也会给 path（若非空图），由调用方取舍。
///
/// 错误：`NotLoaded`、`InvalidInput`、`Cancelled`（期间调用了 `logo_cancel`）、`Backend`。
/// 一次前向不可中途打断，取消最迟在当前这一段结束后生效（最长约一次 UNet）。
///
/// 调用约定：调用方必须保证同一时刻只有一个生成在飞（Kotlin 的 `LogoService` 已保证）；
/// 本函数内部虽会加锁串行，但并发调用只会排队空等，且后登记的取消令牌会覆盖先登记的，`logo_cancel` 只认最新一次。
///
/// 示例（Kotlin）：`val r = logoGenerate(prompt, 1uL, true, false)`
#[uniffi::export]
pub fn logo_generate(prompt: String, seed: u64, remove_ring: bool, with_mask: bool) -> Result<LogoFfiResult, LogoFfiError> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(LogoFfiError::InvalidInput { reason: "提示词不能为空".into() });
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(LogoFfiError::InvalidInput { reason: format!("提示词过长（超过 {MAX_PROMPT_BYTES} 字节）") });
    }
    // 先登记令牌再等状态锁：排队期间调用 logo_cancel 也能让本次一开始就取消
    let token = CancelToken::new();
    *CANCEL.lock().unwrap_or_else(|p| p.into_inner()) = Some(token.clone());
    let out = with_state(|s| {
        let loaded = s.loaded.as_mut().ok_or_else(|| LogoFfiError::NotLoaded { reason: "logo 生成模型未加载".into() })?;
        let _reset = StageReset;
        loaded.gen.generate(&prompt, seed, remove_ring, &token, &mut |st| STAGE.store(LogoFfiStage::from_engine(st).code(), Ordering::Relaxed)).map_err(map_err)
    })?;
    let (r, sym) = (out.render, out.symbol);
    let f = &sym.features;
    let (rt, pt) = (r.timings, sym.timings);
    Ok(LogoFfiResult {
        svg_paths: sym.svg.as_ref().map(|s| s.paths.clone()),
        path_count: sym.svg.as_ref().map_or(0, |s| s.path_count as u32),
        gate_ok: sym.gate.ok,
        gate_reasons: sym.gate.reasons.iter().map(|x| x.code().to_string()).collect(),
        ring_detected: sym.ring_detected,
        features: LogoFfiFeatures {
            ink_canvas: f.ink_canvas,
            rot_iou: f.rot_iou,
            comps: f.comps,
            specks: f.specks,
            size_rel: f.size_rel,
            off: f.off,
            fill_bbox: f.fill_bbox,
            empty: f.empty,
        },
        timings: LogoFfiTimings {
            tokenize_ms: rt.tokenize_ms,
            text_ms: rt.text_ms,
            unet_ms: rt.unet_ms,
            step_ms: rt.step_ms,
            vae_ms: rt.vae_ms,
            load_ms: rt.load_ms,
            extract_ms: pt.extract_ms,
            features_ms: pt.features_ms,
            gate_ms: pt.gate_ms,
            trace_ms: pt.trace_ms,
            total_ms: rt.total_ms + pt.extract_ms + pt.features_ms + pt.gate_ms + pt.trace_ms,
        },
        mask_gray: with_mask.then(|| mask_to_gray(&sym.mask)),
    })
}

/// 取消正在进行（或排队中）的生成，在下一段之间返回 `Cancelled`。可在任意线程调用，没有生成在跑时无副作用。
///
/// 调用约定：同一时刻只应有一个生成在飞（`LogoService` 已保证），取消的是最近一次登记的那次生成。
/// 卸载前应先调用本函数，否则 `logo_unload` 要等当前生成结束，最长约一次完整生成。
#[uniffi::export]
pub fn logo_cancel() {
    if let Some(t) = CANCEL.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        t.cancel();
    }
}

/// 当前生成所处阶段，供界面轮询显示进度；没有生成在跑返回 `Idle`。不加锁，随时可调。
///
/// 示例（Kotlin）：`val stage = logoStage()`
#[uniffi::export]
pub fn logo_stage() -> LogoFfiStage {
    LogoFfiStage::from_code(STAGE.load(Ordering::Relaxed))
}

/// 释放引擎与三张图（运行库保留），并让 MNN 与进程分配器归还内存。下次生成前需重新 `logo_load`。
///
/// 调用约定：卸载前应先 `logo_cancel`（并保证同一时刻只有一个生成在飞），否则本函数要等当前生成结束才拿到锁，
/// 最长约一次完整生成（真机十几秒）。
#[uniffi::export]
pub fn logo_unload() {
    with_state(|s| {
        s.loaded = None;
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
    fn 未加载模型时生成报未就绪() {
        logo_unload();
        assert!(matches!(logo_generate("a cat".into(), 1, true, false), Err(LogoFfiError::NotLoaded { .. })));
        assert_eq!(logo_stage(), LogoFfiStage::Idle);
        // 生成中途 panic，守卫也要把阶段复位为空闲（与上面同一个测试里串行做，避免争用全局 STAGE）
        let r = std::panic::catch_unwind(|| {
            STAGE.store(LogoFfiStage::Unet.code(), Ordering::Relaxed);
            let _reset = StageReset;
            panic!("模拟生成中途 panic");
        });
        assert!(r.is_err());
        assert_eq!(logo_stage(), LogoFfiStage::Idle);
    }

    #[test]
    fn 空提示词与超长提示词报入参错误() {
        assert!(matches!(logo_generate("   ".into(), 1, true, false), Err(LogoFfiError::InvalidInput { .. })));
        assert!(matches!(logo_generate("x".repeat(MAX_PROMPT_BYTES + 1), 1, true, false), Err(LogoFfiError::InvalidInput { .. })));
    }

    #[test]
    fn 找不到mnn库报后端错误() {
        let r = logo_load("definitely-not-exist-libarkli-mnn.so".into(), "x".into(), 4, LogoFfiResidency::Resident);
        assert!(matches!(r, Err(LogoFfiError::Backend { .. })));
    }

    #[test]
    fn 没有生成在跑时取消无副作用() {
        logo_cancel();
        logo_unload();
    }

    #[test]
    fn 错误映射() {
        assert!(matches!(map_err(AiError::Cancelled), LogoFfiError::Cancelled { .. }));
        assert!(matches!(map_err(AiError::InvalidConfig("x".into())), LogoFfiError::InvalidInput { .. }));
        assert!(matches!(map_err(AiError::Backend("x".into())), LogoFfiError::Backend { .. }));
        // 加载过程里配置问题（缺模型文件）归后端
        assert!(matches!(map_load_err(AiError::InvalidConfig("缺文件".into())), LogoFfiError::Backend { .. }));
        assert!(matches!(map_load_err(AiError::Cancelled), LogoFfiError::Cancelled { .. }));
    }

    #[test]
    fn 驻留方式映射到引擎层() {
        assert_eq!(LogoFfiResidency::Resident.engine(), Residency::Resident);
        assert_eq!(LogoFfiResidency::PerStage.engine(), Residency::PerStage);
    }

    #[test]
    fn 阶段编码互相可逆() {
        for s in [LogoFfiStage::Idle, LogoFfiStage::Tokenize, LogoFfiStage::TextEncode, LogoFfiStage::Unet, LogoFfiStage::Decode, LogoFfiStage::Post] {
            assert_eq!(LogoFfiStage::from_code(s.code()), s);
        }
        assert_eq!(LogoFfiStage::from_code(200), LogoFfiStage::Idle);
        assert_eq!(LogoFfiStage::from_engine(LogoStage::Post), LogoFfiStage::Post);
        assert_eq!(LogoFfiStage::from_engine(LogoStage::Unet), LogoFfiStage::Unet);
    }

    /// 取必需的环境变量。
    fn env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("未设置 {name}"))
    }

    /// 运行条件：ARKLI_MNN_DYLIB（arkli-mnn.dll，同目录要有 MNN.dll）、ARKLI_LOGO_DIR（模型目录）。
    /// 命令：`cargo test -p arkli-ffi logo -- --ignored --nocapture`
    #[test]
    #[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_LOGO_DIR"]
    fn 真库经ffi生成取消卸载重载() {
        let prompt = "flat pictogram glyph of a carrot, solid black emoji silhouette, bold simple shape, minimalist icon, white background";
        logo_load(env("ARKLI_MNN_DYLIB"), env("ARKLI_LOGO_DIR"), 4, LogoFfiResidency::Resident).unwrap();
        let r = logo_generate(prompt.into(), 1, true, true).unwrap();
        println!("闸门 {} {:?}，path {} 个，总 {}ms（UNet {}ms）", r.gate_ok, r.gate_reasons, r.path_count, r.timings.total_ms, r.timings.unet_ms);
        assert_eq!(r.mask_gray.as_ref().map(Vec::len), Some(512 * 512));
        assert!(r.svg_paths.as_deref().is_some_and(|s| s.contains("<path")));
        // 同种子同结果
        assert_eq!(logo_generate(prompt.into(), 1, true, false).unwrap().svg_paths, r.svg_paths);
        // 生成中途（300ms 后）取消：在段间返回 Cancelled，随后照常可用
        let t = std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(300));
            logo_cancel();
        });
        let c = logo_generate(prompt.into(), 2, true, false);
        t.join().unwrap();
        println!("中途取消结果：{:?}", c.as_ref().map(|_| "未被打断").map_err(|e| e.to_string()));
        assert!(logo_generate(prompt.into(), 2, true, false).is_ok());
        // 卸载后报未就绪，重载后恢复
        logo_unload();
        assert!(matches!(logo_generate(prompt.into(), 1, true, false), Err(LogoFfiError::NotLoaded { .. })));
        logo_load(env("ARKLI_MNN_DYLIB"), env("ARKLI_LOGO_DIR"), 4, LogoFfiResidency::PerStage).unwrap();
        let p = logo_generate(prompt.into(), 1, true, false).unwrap();
        assert_eq!(p.svg_paths, r.svg_paths, "分段模式与常驻结果应一致");
        println!("分段模式 总 {}ms 加载 {}ms", p.timings.total_ms, p.timings.load_ms);
        logo_unload();
    }
}
