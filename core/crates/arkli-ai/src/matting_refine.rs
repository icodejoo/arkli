//! 抠图边缘细化：引导滤波收紧 alpha + Blur-Fusion 估计前景色，纯 Rust 自写，不引依赖。
//!
//! 为什么要做：模型只在 512 / 320 上推理，alpha 放大回原图后发丝边缘又软又糊；而输出 PNG 的 RGB 若仍是原图像素，
//! 半透明边缘里混着原背景色，换到新背景上就会发亮、发色边。这里分两步在**原图分辨率**上补救：
//!
//! 1. **alpha 细化**：以原图亮度为引导的快速引导滤波（He et al.，box 滤波，低分辨率估计系数再双线性放大），
//!    让 alpha 的过渡贴合原图边缘；再过一条对比度曲线（夹断两端 + 可选 smoothstep）收紧半透明带。
//! 2. **前景色估计**：Blur-Fusion（Forte & Pitié 2021，单遍大半径），由原图 I 与 alpha 估出纯前景色 F，输出 PNG 的 RGB 改用 F
//!    （straight alpha，非预乘）。
//!
//! 耗时：所有模糊都在 1/s 分辨率上做（`s = round(长边 / 512)`，至少 1），全分辨率只有几遍线性扫描，且只在半透明像素上做插值。
//!
//! 取消：全分辨率扫描按 64 行一块、每波（线程数个块）之间检查一次，命中返回 [`AiError::Cancelled`]。
//!
//! 强度：[`RefineStrength`] 是给页面滑块预留的入口，[`RefineStrength::Off`] 等同没有细化（alpha 不变、F 即原图）。

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use crate::error::{AiError, Result};
use crate::task::CancelToken;

/// 低分辨率估计的目标长边（像素），长边超过它时按整数倍降采样。
pub const FAST_SIDE: usize = 512;
/// 8 位像素最大值。
const PIXEL_MAX: f32 = 255.0;
/// `1 / 255`，热循环里用乘法代替除法。
const INV_PIXEL_MAX: f32 = 1.0 / PIXEL_MAX;
/// 参与引导滤波的“不确定带”下界（8 位 alpha，含）。
const UNC_LO: u8 = 3;
/// 不确定带上界（含）。
const UNC_HI: u8 = 252;
/// 半透明像素下界（含），其外 alpha 视为纯背景 / 纯前景。
const BAND_LO: u8 = 1;
/// 半透明像素上界（含）。
const BAND_HI: u8 = 254;
/// 比值估计的分母下限，低于它视为“窗口里没有这类像素”。
const DENOM_EPS: f32 = 1e-3;
/// 引导滤波半径取长边的几分之一（`长边 / 此值`），再夹到 [`GF_RADIUS_MIN`, `GF_RADIUS_MAX`]。
const GF_RADIUS_DIV: usize = 150;
/// 引导滤波半径下限（原图像素）。
const GF_RADIUS_MIN: usize = 3;
/// 引导滤波半径上限（原图像素）。
const GF_RADIUS_MAX: usize = 24;
/// 前景色估计的模糊半径取长边的几分之一，夹到 [`FG_RADIUS_MIN`, `FG_RADIUS_MAX`]。
/// 半径要够大：模型给的 alpha 往外晕得宽，窗口里得有足够的“纯前景”像素才估得准（实测 1024 图取 36 比取 10 误差低）。
const FG_RADIUS_DIV: usize = 30;
/// 前景色模糊半径下限（原图像素）。
const FG_RADIUS_MIN: usize = 8;
/// 前景色模糊半径上限（原图像素）。
const FG_RADIUS_MAX: usize = 96;

/// 细化强度。给页面滑块预留；缺省 [`RefineStrength::Standard`]。
///
/// ```
/// use arkli_ai::matting_refine::RefineStrength;
/// assert_eq!(RefineStrength::default(), RefineStrength::Standard);
/// assert!(RefineStrength::Off.params(100, 100).is_none());
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RefineStrength {
    /// 不细化：alpha 原样，前景色即原图像素（旧行为）
    Off,
    /// 轻：只轻微收紧，最保守
    Light,
    /// 标准（缺省）
    #[default]
    Standard,
    /// 强：过渡更利落，细发丝可能被削弱
    Strong,
}

/// 各档强度的曲线与滤波参数：（引导滤波 eps，曲线下端，曲线上端，smoothstep 混合比）。
const LEVEL_LIGHT: (f32, f32, f32, f32) = (4e-3, 0.03, 0.97, 0.0);
/// 标准档参数，含义同 [`LEVEL_LIGHT`]。
const LEVEL_STANDARD: (f32, f32, f32, f32) = (1e-3, 0.06, 0.94, 0.5);
/// 强档参数，含义同 [`LEVEL_LIGHT`]。
const LEVEL_STRONG: (f32, f32, f32, f32) = (4e-4, 0.12, 0.90, 1.0);

/// 一次细化的具体参数，由 [`RefineStrength::params`] 按图大小算出。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RefineParams {
    /// 引导滤波半径（原图像素）
    pub gf_radius: usize,
    /// 引导滤波正则项（灰度 0..1 的方差量纲）
    pub gf_eps: f32,
    /// 对比度曲线下端：alpha 低于它压成 0
    pub curve_lo: f32,
    /// 对比度曲线上端：alpha 高于它拉成 1
    pub curve_hi: f32,
    /// 曲线里 smoothstep 的混合比，0 为线性拉伸，1 为纯 smoothstep
    pub curve_smooth: f32,
    /// 前景色估计的模糊半径（原图像素）
    pub fg_radius: usize,
    /// 低分辨率估计的降采样倍数（>= 1）
    pub scale: usize,
    /// 全分辨率扫描的并行线程数（>= 1）
    pub threads: usize,
}

impl RefineStrength {
    /// 按强度与图大小算参数。
    ///
    /// - `w`、`h`：图宽高（像素）
    /// - 返回：[`RefineStrength::Off`] 返回 `None`，其余返回具体参数
    pub fn params(self, w: usize, h: usize) -> Option<RefineParams> {
        let (eps, lo, hi, smooth) = match self {
            RefineStrength::Off => return None,
            RefineStrength::Light => LEVEL_LIGHT,
            RefineStrength::Standard => LEVEL_STANDARD,
            RefineStrength::Strong => LEVEL_STRONG,
        };
        let long = w.max(h);
        let fg_radius = (long / FG_RADIUS_DIV).clamp(FG_RADIUS_MIN, FG_RADIUS_MAX);
        Some(RefineParams {
            gf_radius: (long / GF_RADIUS_DIV).clamp(GF_RADIUS_MIN, GF_RADIUS_MAX),
            gf_eps: eps,
            curve_lo: lo,
            curve_hi: hi,
            curve_smooth: smooth,
            fg_radius,
            scale: fast_scale(w, h),
            threads: default_threads(),
        })
    }
}

/// 细化结果。
#[derive(Debug, Clone, PartialEq)]
pub struct Refined {
    /// 细化后的 8 位 alpha，长度 `w * h`
    pub alpha: Vec<u8>,
    /// 去污染后的前景色（RGB，straight alpha），长度 `w * h * 3`
    pub fg: Vec<u8>,
}

/// 细化最多用的线程数。任务动态领取，大小核混合的手机上多开线程也不会被慢核拖住（真机实测 8 线程比 4 线程快约 25%）。
const MAX_THREADS: usize = 8;

/// 缺省并行线程数：机器可用核数，夹到 `[1, MAX_THREADS]`。
fn default_threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).clamp(1, MAX_THREADS)
}

/// 低分辨率估计的降采样倍数：`round(长边 / FAST_SIDE)`，至少 1。
pub fn fast_scale(w: usize, h: usize) -> usize {
    ((w.max(h) as f32 / FAST_SIDE as f32).round() as usize).max(1)
}

/// 对比度曲线：把 `[lo, hi]` 线性拉伸到 `[0, 1]` 并夹断，再按 `smooth` 混入 smoothstep。
///
/// ```
/// use arkli_ai::matting_refine::tighten_curve;
/// assert_eq!(tighten_curve(0.02, 0.05, 0.95, 0.0), 0.0);
/// assert_eq!(tighten_curve(0.99, 0.05, 0.95, 0.0), 1.0);
/// assert!((tighten_curve(0.5, 0.05, 0.95, 1.0) - 0.5).abs() < 1e-6);
/// ```
pub fn tighten_curve(a: f32, lo: f32, hi: f32, smooth: f32) -> f32 {
    let t = ((a - lo) / (hi - lo).max(1e-6)).clamp(0.0, 1.0);
    let s = t * t * (3.0 - 2.0 * t);
    t + smooth * (s - t)
}

/// 对一张图做 alpha 细化与前景色估计。
///
/// - `rgb`：原图 RGB，长度 `w * h * 3`
/// - `alpha`：放大回原图尺寸的 8 位 alpha，长度 `w * h`（所有权交入，`Off` 时原样返回）
/// - `strength`：细化强度
/// - `cancel`：取消令牌，扫描时按波检查（每波约 `线程数 × 64` 行）
/// - 返回：细化后的 alpha 与前景色；入参长度不符返回 [`AiError::InvalidImage`]
///
/// ```
/// use arkli_ai::{matting_refine::{refine, RefineStrength}, CancelToken};
/// let out = refine(&[10, 20, 30], vec![255], 1, 1, RefineStrength::Standard, &CancelToken::new()).unwrap();
/// assert_eq!(out.fg, vec![10, 20, 30]);
/// ```
pub fn refine(rgb: &[u8], alpha: Vec<u8>, w: usize, h: usize, strength: RefineStrength, cancel: &CancelToken) -> Result<Refined> {
    refine_with(rgb, alpha, w, h, strength, &mut || cancel.check())
}

/// [`refine`] 的实现，取消检查以闭包传入，便于单测在指定检查次数后触发取消。
pub(crate) fn refine_with(
    rgb: &[u8],
    alpha: Vec<u8>,
    w: usize,
    h: usize,
    strength: RefineStrength,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<Refined> {
    if w == 0 || h == 0 || rgb.len() != w * h * 3 || alpha.len() != w * h {
        return Err(AiError::InvalidImage(format!("细化入参长度不符：{w}x{h}，rgb {}，alpha {}", rgb.len(), alpha.len())));
    }
    check()?;
    let Some(p) = strength.params(w, h) else {
        return Ok(Refined { alpha, fg: rgb.to_vec() });
    };
    run(rgb, &alpha, w, h, &p, check)
}

/// 低分辨率网格的尺寸：`ceil(n / s)`。
fn low_size(n: usize, s: usize) -> usize {
    n.div_ceil(s)
}

/// 一个并行任务处理的全分辨率行数（降采样倍数不能整除时向上取整到 `s` 的倍数）。
const TASK_ROWS: usize = 64;

/// 灰度整数权重（Rec.601，和为 256）：`gray = (77R + 150G + 29B) / 256`。
const GRAY_I: [u32; 3] = [77, 150, 29];

/// 并行执行 `f(序号, 项)`：`threads` 个线程（含当前线程）从同一个计数器里动态领任务，快核多干、慢核少干，
/// 不会被最慢的线程拖住。当前线程每领一项前先 `check()`，命中就通知其余线程停手并返回错误。
/// 只有一项或 `threads <= 1` 时在当前线程顺序跑。各项互不相交，结果与线程数无关。
fn par_items<T: Send, F: Fn(usize, &mut T) + Sync>(
    items: &mut [T],
    threads: usize,
    check: &mut dyn FnMut() -> Result<()>,
    f: F,
) -> Result<()> {
    if threads <= 1 || items.len() <= 1 {
        for (i, item) in items.iter_mut().enumerate() {
            check()?;
            f(i, item);
        }
        return Ok(());
    }
    let n_items = items.len();
    let slots: Vec<Mutex<Option<&mut T>>> = items.iter_mut().map(|t| Mutex::new(Some(t))).collect();
    let next = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let take = || -> Option<(usize, &mut T)> {
        let i = next.fetch_add(1, Ordering::Relaxed);
        slots.get(i)?.lock().unwrap_or_else(|e| e.into_inner()).take().map(|t| (i, t))
    };
    let worker = || {
        while !stop.load(Ordering::Relaxed) {
            match take() {
                Some((i, t)) => f(i, t),
                None => break,
            }
        }
    };
    let mut result = Ok(());
    std::thread::scope(|sc| {
        for _ in 1..threads.min(n_items) {
            sc.spawn(worker);
        }
        while let Some((i, t)) = {
            result = check();
            if result.is_err() {
                stop.store(true, Ordering::Relaxed);
                None
            } else {
                take()
            }
        } {
            f(i, t);
        }
    });
    result
}

/// 方窗均值（半径 `r`，边缘按窗口内实际像素数平均），先横后纵，滑窗累加。
/// 低分辨率平面最大约千像素宽、取值 0..1，f32 累加的误差可忽略，且利于向量化。
fn box_mean(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0.0f32; w * h];
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let mut sum: f32 = row[..=r.min(w - 1)].iter().sum();
        for x in 0..w {
            let (lo, hi) = (x.saturating_sub(r), (x + r).min(w - 1));
            tmp[y * w + x] = sum / (hi - lo + 1) as f32;
            if x + r + 1 < w {
                sum += row[x + r + 1];
            }
            if x >= r {
                sum -= row[x - r];
            }
        }
    }
    let mut out = vec![0.0f32; w * h];
    let mut col = vec![0.0f32; w];
    for y in 0..=r.min(h - 1) {
        for (c, t) in col.iter_mut().zip(&tmp[y * w..(y + 1) * w]) {
            *c += t;
        }
    }
    for y in 0..h {
        let (lo, hi) = (y.saturating_sub(r), (y + r).min(h - 1));
        let inv = 1.0 / (hi - lo + 1) as f32;
        for (o, c) in out[y * w..(y + 1) * w].iter_mut().zip(&col) {
            *o = c * inv;
        }
        if y + r + 1 < h {
            for (c, t) in col.iter_mut().zip(&tmp[(y + r + 1) * w..(y + r + 2) * w]) {
                *c += t;
            }
        }
        if y >= r {
            for (c, t) in col.iter_mut().zip(&tmp[(y - r) * w..(y - r + 1) * w]) {
                *c -= t;
            }
        }
    }
    out
}

/// 低分辨率到全分辨率的一维双线性插值表项。
#[derive(Clone, Copy)]
struct Lerp {
    /// 左（上）邻下标
    i0: usize,
    /// 右（下）邻下标
    i1: usize,
    /// 右（下）邻权重
    t: f32,
}

/// 构造 `n_full` 个全分辨率坐标到 `n_low` 个低分辨率格点（块中心对齐）的插值表。
fn lerp_table(n_full: usize, n_low: usize, s: usize) -> Vec<Lerp> {
    (0..n_full)
        .map(|x| {
            let f = ((x as f32 + 0.5) / s as f32 - 0.5).max(0.0);
            let i0 = (f.floor() as usize).min(n_low - 1);
            Lerp { i0, i1: (i0 + 1).min(n_low - 1), t: (f - i0 as f32).clamp(0.0, 1.0) }
        })
        .collect()
}

/// 一个像素的四邻下标与权重。
#[derive(Clone, Copy)]
struct Tap {
    /// 四邻在低分辨率平面里的下标
    idx: [usize; 4],
    /// 四邻权重
    w: [f32; 4],
}

impl Tap {
    /// 由横纵插值表项与低分辨率宽度合成。
    fn new(lx: Lerp, ly: Lerp, lw: usize) -> Self {
        let (ax, ay) = (1.0 - lx.t, 1.0 - ly.t);
        Tap {
            idx: [ly.i0 * lw + lx.i0, ly.i0 * lw + lx.i1, ly.i1 * lw + lx.i0, ly.i1 * lw + lx.i1],
            w: [ax * ay, lx.t * ay, ax * ly.t, lx.t * ly.t],
        }
    }

    /// 在一个低分辨率平面上插值取值。
    fn get(&self, plane: &[f32]) -> f32 {
        self.w[0] * plane[self.idx[0]] + self.w[1] * plane[self.idx[1]] + self.w[2] * plane[self.idx[2]] + self.w[3] * plane[self.idx[3]]
    }
}

/// 8 位量化。
fn to_u8(v: f32) -> u8 {
    (v * PIXEL_MAX + 0.5).clamp(0.0, PIXEL_MAX) as u8
}

/// 取像素 `i` 的灰度（0..1，整数权重近似）。
fn gray_at(rgb: &[u8], i: usize) -> f32 {
    (GRAY_I[0] * rgb[i * 3] as u32 + GRAY_I[1] * rgb[i * 3 + 1] as u32 + GRAY_I[2] * rgb[i * 3 + 2] as u32) as f32 * (INV_PIXEL_MAX / 256.0)
}

/// 取像素 `i` 的 RGB（0..1）。
fn rgb_at(rgb: &[u8], i: usize) -> [f32; 3] {
    [rgb[i * 3] as f32 * INV_PIXEL_MAX, rgb[i * 3 + 1] as f32 * INV_PIXEL_MAX, rgb[i * 3 + 2] as f32 * INV_PIXEL_MAX]
}

/// 用“比值”估计窗口里的某类颜色：`num / den`，分母太小说明窗口里没有这类像素，返回 `fallback`。
fn ratio_or(num: f32, den: f32, fallback: f32) -> f32 {
    if den > DENOM_EPS {
        num / den
    } else {
        fallback
    }
}

/// Blur-Fusion 一步融合：由模糊前景 `fb`、模糊背景 `bb`、原像素 `i`、alpha `a` 修正出 `(F, B)`。
///
/// `F = fb + a * (i - a*fb - (1-a)*bb)`，`B = bb + (1-a) * (i - a*fb - (1-a)*bb)`，都夹到 0..1。
fn fuse(i: [f32; 3], a: f32, fb: [f32; 3], bb: [f32; 3]) -> ([f32; 3], [f32; 3]) {
    let (mut f, mut b) = ([0.0f32; 3], [0.0f32; 3]);
    for c in 0..3 {
        let resid = i[c] - a * fb[c] - (1.0 - a) * bb[c];
        f[c] = (fb[c] + a * resid).clamp(0.0, 1.0);
        b[c] = (bb[c] + (1.0 - a) * resid).clamp(0.0, 1.0);
    }
    (f, b)
}

/// 第一遍扫描的块累加量（整数，一个低分辨率格一份）。
#[derive(Clone, Copy, Default)]
struct Sums {
    /// alpha 之和
    a: u32,
    /// 灰度整数权重之和（见 [`GRAY_I`]）
    g: u32,
    /// 不确定带像素个数
    unc: u32,
    /// 各通道像素值之和
    i: [u32; 3],
    /// 各通道 像素值×alpha 之和
    ia: [u32; 3],
}

/// 第一遍：整行整行地累加每个低分辨率格的整数和（alpha、灰度、不确定带、像素值、像素值×alpha），按低分辨率行分任务并行。
fn first_scan(
    rgb: &[u8],
    alpha: &[u8],
    w: usize,
    h: usize,
    p: &RefineParams,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<Vec<Sums>> {
    let s = p.scale.max(1);
    let (lw, lh) = (low_size(w, s), low_size(h, s));
    let rows_per = TASK_ROWS.div_ceil(s);
    let mut cells = vec![Sums::default(); lw * lh];
    let mut tasks: Vec<&mut [Sums]> = cells.chunks_mut(lw * rows_per).collect();
    par_items(&mut tasks, p.threads, check, |ti, chunk| {
        let ly0 = ti * rows_per;
        for y in ly0 * s..((ly0 + chunk.len() / lw) * s).min(h) {
            let base = (y / s - ly0) * lw;
            let (arow, crow) = (&alpha[y * w..(y + 1) * w], &rgb[y * w * 3..(y + 1) * w * 3]);
            for (lx, cell) in chunk[base..base + lw].iter_mut().enumerate() {
                let x1 = ((lx + 1) * s).min(w);
                let mut c = *cell;
                for x in lx * s..x1 {
                    let a = arow[x] as u32;
                    let (r, g, b) = (crow[x * 3] as u32, crow[x * 3 + 1] as u32, crow[x * 3 + 2] as u32);
                    c.a += a;
                    c.g += GRAY_I[0] * r + GRAY_I[1] * g + GRAY_I[2] * b;
                    c.unc += (a.wrapping_sub(UNC_LO as u32) <= (UNC_HI - UNC_LO) as u32) as u32;
                    c.i[0] += r;
                    c.i[1] += g;
                    c.i[2] += b;
                    c.ia[0] += r * a;
                    c.ia[1] += g * a;
                    c.ia[2] += b * a;
                }
                *cell = c;
            }
        }
    })?;
    Ok(cells)
}

/// 低分辨率平面集合：第一遍累加量换算成的浮点平面。
struct Planes {
    /// alpha（0..1）
    a: Vec<f32>,
    /// 灰度（0..1）
    g: Vec<f32>,
    /// 不确定带占比（0..1）
    unc: Vec<f32>,
    /// 各通道像素值（0..1）
    i: [Vec<f32>; 3],
    /// 各通道 像素值×alpha（0..1）
    ia: [Vec<f32>; 3],
}

/// 把第一遍的整数和换算成按格平均的浮点平面。
fn to_planes(cells: &[Sums], w: usize, h: usize, s: usize) -> Planes {
    let (lw, lh) = (low_size(w, s), low_size(h, s));
    let n = lw * lh;
    let mut p = Planes {
        a: vec![0.0; n],
        g: vec![0.0; n],
        unc: vec![0.0; n],
        i: [vec![0.0; n], vec![0.0; n], vec![0.0; n]],
        ia: [vec![0.0; n], vec![0.0; n], vec![0.0; n]],
    };
    for ly in 0..lh {
        let ch = (h - ly * s).min(s);
        for lx in 0..lw {
            let k = ly * lw + lx;
            let cnt = (ch * (w - lx * s).min(s)) as f32;
            let (inv1, inv2) = (INV_PIXEL_MAX / cnt, INV_PIXEL_MAX * INV_PIXEL_MAX / cnt);
            let c = &cells[k];
            p.a[k] = c.a as f32 * inv1;
            p.g[k] = c.g as f32 * (inv1 / 256.0);
            p.unc[k] = c.unc as f32 / cnt;
            for ch in 0..3 {
                p.i[ch][k] = c.i[ch] as f32 * inv1;
                p.ia[ch][k] = c.ia[ch] as f32 * inv2;
            }
        }
    }
    p
}

/// 引导滤波的低分辨率系数：`q = mean_a · I + mean_b`，以及“不确定带邻域”标记（>0 表示该格附近有不确定像素）。
struct GfFields {
    /// 系数 a 的方窗均值
    ma: Vec<f32>,
    /// 系数 b 的方窗均值
    mb: Vec<f32>,
    /// 不确定带向外扩 `r + 1` 格后的占比
    active: Vec<f32>,
}

/// 由低分辨率的 alpha / 灰度 / 不确定带算引导滤波系数（He et al. 的 a、b 与其方窗均值）。
fn gf_fields(pl: &Planes, lw: usize, lh: usize, r: usize, eps: f32) -> GfFields {
    let n = lw * lh;
    let (mi, mp) = (box_mean(&pl.g, lw, lh, r), box_mean(&pl.a, lw, lh, r));
    let ii: Vec<f32> = pl.g.iter().map(|v| v * v).collect();
    let ip: Vec<f32> = pl.g.iter().zip(&pl.a).map(|(i, p)| i * p).collect();
    let (corr_i, corr_ip) = (box_mean(&ii, lw, lh, r), box_mean(&ip, lw, lh, r));
    let mut a = vec![0.0f32; n];
    let mut b = vec![0.0f32; n];
    for k in 0..n {
        let var = corr_i[k] - mi[k] * mi[k];
        let cov = corr_ip[k] - mi[k] * mp[k];
        a[k] = cov / (var.max(0.0) + eps);
        b[k] = mp[k] - a[k] * mi[k];
    }
    GfFields { ma: box_mean(&a, lw, lh, r), mb: box_mean(&b, lw, lh, r), active: box_mean(&pl.unc, lw, lh, r + 1) }
}

/// 细化的完整流程（所有输入已校验）：
///
/// 1. 第一遍整数累加（原 alpha）→ 引导滤波系数 → 扫描出新 alpha（引导滤波 + 曲线）；
/// 2. 用新 alpha 再整数累加一遍 → 前景 / 背景模糊场（大半径，分子分母分别模糊）；
/// 3. 只对半透明像素融合出前景色，其余像素直接用原图。
///
/// - `rgb`、`alpha`、`w`、`h`：原图与放大后的 alpha
/// - `p`：参数，见 [`RefineStrength::params`]
/// - `check`：取消检查，波与波之间调用
pub(crate) fn run(rgb: &[u8], alpha: &[u8], w: usize, h: usize, p: &RefineParams, check: &mut dyn FnMut() -> Result<()>) -> Result<Refined> {
    let s = p.scale.max(1);
    let (lw, lh) = (low_size(w, s), low_size(h, s));
    let rows_per = TASK_ROWS.div_ceil(s);
    let (tx, ty) = (lerp_table(w, lw, s), lerp_table(h, lh, s));
    // 1. 引导滤波
    let pl0 = to_planes(&first_scan(rgb, alpha, w, h, p, check)?, w, h, s);
    let gf = gf_fields(&pl0, lw, lh, (p.gf_radius / s).max(1), p.gf_eps);
    drop(pl0);
    check()?;
    // 不确定带之外的 alpha 只过曲线，查表
    let curve_lut: Vec<u8> =
        (0..=255u32).map(|v| to_u8(tighten_curve(v as f32 * INV_PIXEL_MAX, p.curve_lo, p.curve_hi, p.curve_smooth))).collect();
    let mut new_alpha = vec![0u8; w * h];
    par_items(&mut new_alpha.chunks_mut(w * rows_per * s).collect::<Vec<_>>(), p.threads, check, |ti, chunk| {
        for (ry, orow) in chunk.chunks_mut(w).enumerate() {
            let y = ti * rows_per * s + ry;
            let near = (y / s).min(lh - 1) * lw;
            let arow = &alpha[y * w..(y + 1) * w];
            // 先在纵向插值出本行的系数，再逐像素只做横向插值
            let t = ty[y];
            let va: Vec<f32> = (0..lw).map(|k| gf.ma[t.i0 * lw + k] * (1.0 - t.t) + gf.ma[t.i1 * lw + k] * t.t).collect();
            let vb: Vec<f32> = (0..lw).map(|k| gf.mb[t.i0 * lw + k] * (1.0 - t.t) + gf.mb[t.i1 * lw + k] * t.t).collect();
            for lx in 0..lw {
                let (x0, x1) = (lx * s, ((lx + 1) * s).min(w));
                if gf.active[near + lx] > 0.0 {
                    for x in x0..x1 {
                        let l = tx[x];
                        let a = va[l.i0] * (1.0 - l.t) + va[l.i1] * l.t;
                        let b = vb[l.i0] * (1.0 - l.t) + vb[l.i1] * l.t;
                        orow[x] = curve_lut[to_u8(a * gray_at(rgb, y * w + x) + b) as usize];
                    }
                } else {
                    for x in x0..x1 {
                        orow[x] = curve_lut[arow[x] as usize];
                    }
                }
            }
        }
    })?;
    drop(gf);
    // 2. 用新 alpha 的第一遍前景 / 背景模糊场：分子分母分别模糊
    let pl = to_planes(&first_scan(rgb, &new_alpha, w, h, p, check)?, w, h, s);
    let r1 = (p.fg_radius / s).max(1);
    let m1a = box_mean(&pl.a, lw, lh, r1);
    let m1i: Vec<Vec<f32>> = pl.i.iter().map(|v| box_mean(v, lw, lh, r1)).collect();
    let m1ia: Vec<Vec<f32>> = pl.ia.iter().map(|v| box_mean(v, lw, lh, r1)).collect();
    check()?;
    // 第一遍的 (F, B)：分子分母分别插值再相除；窗口里没有这类像素就退回原像素
    let first = |tap: &Tap, i: [f32; 3]| -> ([f32; 3], [f32; 3]) {
        let ma = tap.get(&m1a);
        let (mut fb, mut bb) = ([0.0f32; 3], [0.0f32; 3]);
        for k in 0..3 {
            let (ia, ic) = (tap.get(&m1ia[k]), tap.get(&m1i[k]));
            fb[k] = ratio_or(ia, ma, i[k]);
            bb[k] = ratio_or(ic - ia, 1.0 - ma, i[k]);
        }
        (fb, bb)
    };
    // 3. 前景色先整体取原图，再只对半透明像素融合改写
    let mut fg = vec![0u8; w * h * 3];
    let na = &new_alpha;
    par_items(&mut fg.chunks_mut(w * 3 * TASK_ROWS).collect::<Vec<_>>(), p.threads, check, |ti, chunk| {
        let y0 = ti * TASK_ROWS;
        for (ry, row) in chunk.chunks_mut(w * 3).enumerate() {
            let y = y0 + ry;
            row.copy_from_slice(&rgb[y * w * 3..(y + 1) * w * 3]);
            for (x, &a8) in na[y * w..(y + 1) * w].iter().enumerate() {
                if !(BAND_LO..=BAND_HI).contains(&a8) {
                    continue;
                }
                let c = rgb_at(rgb, y * w + x);
                let (fb, bb) = first(&Tap::new(tx[x], ty[y], lw), c);
                let f = fuse(c, a8 as f32 * INV_PIXEL_MAX, fb, bb).0;
                for k in 0..3 {
                    row[x * 3 + k] = to_u8(f[k]);
                }
            }
        }
    })?;
    Ok(Refined { alpha: new_alpha, fg })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 不取消的检查闭包。
    fn never() -> impl FnMut() -> Result<()> {
        || Ok(())
    }

    /// 构造左右分界的合成图：左 `x < edge` 是前景色 `f`、右是背景色 `b`，真实 alpha 是在 `edge` 处宽 `soft` 的线性过渡。
    /// 返回（原图 I = α·F + (1-α)·B，真实前景 F 的平面，真实 alpha）。
    fn synth(w: usize, h: usize, edge: usize, soft: usize, f: [u8; 3], b: [u8; 3]) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let (mut img, mut fg, mut al) = (vec![0u8; w * h * 3], vec![0u8; w * h * 3], vec![0u8; w * h]);
        for y in 0..h {
            for x in 0..w {
                let a = ((edge + soft) as f32 - x as f32 - 0.5).clamp(0.0, soft as f32) / soft as f32;
                al[y * w + x] = (a * 255.0).round() as u8;
                for c in 0..3 {
                    img[(y * w + x) * 3 + c] = (a * f[c] as f32 + (1.0 - a) * b[c] as f32).round() as u8;
                    fg[(y * w + x) * 3 + c] = f[c];
                }
            }
        }
        (img, fg, al)
    }

    /// 半透明像素上两个 RGB 平面的平均绝对差。
    fn band_err(a: &[u8], b: &[u8], alpha: &[u8]) -> f32 {
        let (mut sum, mut n) = (0.0f32, 0);
        for (i, &al) in alpha.iter().enumerate() {
            if (BAND_LO..=BAND_HI).contains(&al) {
                for c in 0..3 {
                    sum += (a[i * 3 + c] as f32 - b[i * 3 + c] as f32).abs();
                }
                n += 3;
            }
        }
        sum / n.max(1) as f32
    }

    #[test]
    fn 曲线两端夹断中点不动() {
        assert_eq!(tighten_curve(0.0, 0.1, 0.9, 0.5), 0.0);
        assert_eq!(tighten_curve(1.0, 0.1, 0.9, 0.5), 1.0);
        assert!((tighten_curve(0.5, 0.1, 0.9, 0.5) - 0.5).abs() < 1e-6);
        // smoothstep 让中段更陡：0.3 线性拉伸后 0.25，混入 smoothstep 后更小
        assert!(tighten_curve(0.3, 0.1, 0.9, 1.0) < tighten_curve(0.3, 0.1, 0.9, 0.0));
    }

    #[test]
    fn 缩放倍数按长边取整() {
        assert_eq!(fast_scale(100, 100), 1);
        assert_eq!(fast_scale(500, 700), 1);
        assert_eq!(fast_scale(1024, 700), 2);
        assert_eq!(fast_scale(3072, 2304), 6);
        assert_eq!(fast_scale(4096, 10), 8);
    }

    #[test]
    fn 强度档参数递进且关闭返回空() {
        assert!(RefineStrength::Off.params(1000, 1000).is_none());
        let (l, s, g) = (
            RefineStrength::Light.params(1000, 1000).unwrap(),
            RefineStrength::Standard.params(1000, 1000).unwrap(),
            RefineStrength::Strong.params(1000, 1000).unwrap(),
        );
        assert!(l.curve_lo < s.curve_lo && s.curve_lo < g.curve_lo);
        assert!(l.gf_eps > s.gf_eps && s.gf_eps > g.gf_eps);
        assert_eq!(RefineStrength::default(), RefineStrength::Standard);
    }

    #[test]
    fn 半径随图大小夹在范围内() {
        let small = RefineStrength::Standard.params(50, 40).unwrap();
        assert_eq!((small.gf_radius, small.fg_radius), (GF_RADIUS_MIN, FG_RADIUS_MIN));
        let big = RefineStrength::Standard.params(4096, 4096).unwrap();
        assert_eq!(big.gf_radius, GF_RADIUS_MAX);
        assert_eq!(big.fg_radius, FG_RADIUS_MAX);
    }

    #[test]
    fn 方窗均值常数不变且边缘按实际像素数平均() {
        let v = box_mean(&[0.5; 20], 5, 4, 2);
        assert!(v.iter().all(|x| (x - 0.5).abs() < 1e-6));
        // 一维 [0,0,0,3]，半径 1：末位窗口只有两个像素 (0+3)/2
        let m = box_mean(&[0.0, 0.0, 0.0, 3.0], 4, 1, 1);
        assert!((m[3] - 1.5).abs() < 1e-6 && (m[2] - 1.0).abs() < 1e-6 && m[0] == 0.0);
    }

    #[test]
    fn 前景色估计误差明显小于直接用原图() {
        // 前景红、背景蓝，过渡带 8 像素：原图在过渡带里混着蓝
        let (w, h) = (64, 8);
        let (img, truth, al) = synth(w, h, 24, 8, [220, 40, 40], [30, 30, 220]);
        let p = RefineStrength::Standard.params(w, h).unwrap();
        let fg = run(&img, &al, w, h, &p, &mut never()).unwrap().fg;
        let (e_old, e_new) = (band_err(&img, &truth, &al), band_err(&fg, &truth, &al));
        assert!(e_new < e_old * 0.5, "旧 {e_old} 新 {e_new}");
    }

    #[test]
    fn 纯前景与纯背景像素的前景色原样不动() {
        let (w, h) = (40, 6);
        let (img, _, al) = synth(w, h, 16, 6, [200, 100, 50], [10, 120, 230]);
        let p = RefineStrength::Standard.params(w, h).unwrap();
        let r = run(&img, &al, w, h, &p, &mut never()).unwrap();
        for i in 0..w * h {
            if r.alpha[i] == 0 || r.alpha[i] == 255 {
                assert_eq!(&r.fg[i * 3..i * 3 + 3], &img[i * 3..i * 3 + 3]);
            }
        }
    }

    #[test]
    fn 降采样路径与全分辨率路径结果接近() {
        let (w, h) = (96, 32);
        let (img, truth, al) = synth(w, h, 40, 10, [200, 60, 60], [40, 40, 200]);
        let mut p = RefineStrength::Standard.params(w, h).unwrap();
        p.scale = 1;
        let full = run(&img, &al, w, h, &p, &mut never()).unwrap().fg;
        p.scale = 3;
        let low = run(&img, &al, w, h, &p, &mut never()).unwrap().fg;
        assert!(band_err(&low, &truth, &al) < band_err(&img, &truth, &al) * 0.6);
        assert!(band_err(&low, &full, &al) < 12.0);
    }

    #[test]
    fn 引导滤波让软alpha贴合图像边缘() {
        // 真实边缘在 x=32 处陡变（亮 / 暗），模型给的 alpha 却是 6 像素宽的软坡（29..35）
        let (w, h) = (64, 16);
        let mut img = vec![0u8; w * h * 3];
        let mut soft = vec![0u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let v = if x < 32 { 230 } else { 20 };
                img[(y * w + x) * 3..(y * w + x) * 3 + 3].fill(v);
                soft[y * w + x] = ((35.0 - x as f32) / 6.0).clamp(0.0, 1.0).mul_add(255.0, 0.0) as u8;
            }
        }
        let mut p = RefineStrength::Standard.params(w, h).unwrap();
        p.curve_lo = 0.0;
        p.curve_hi = 1.0;
        p.curve_smooth = 0.0;
        let out = run(&img, &soft, w, h, &p, &mut never()).unwrap().alpha;
        // 边缘两侧的 alpha 落差应明显大于原来的软坡
        let drop_new = out[8 * w + 31] as i32 - out[8 * w + 33] as i32;
        let drop_old = soft[8 * w + 31] as i32 - soft[8 * w + 33] as i32;
        assert!(drop_new > drop_old + 60, "旧 {drop_old} 新 {drop_new}");
    }

    #[test]
    fn 远离不确定带的像素不被滤波改动() {
        let (w, h) = (48, 8);
        let (img, _, al) = synth(w, h, 20, 4, [200, 50, 50], [20, 20, 200]);
        let mut p = RefineStrength::Standard.params(w, h).unwrap();
        p.curve_lo = 0.0;
        p.curve_hi = 1.0;
        p.curve_smooth = 0.0;
        let out = run(&img, &al, w, h, &p, &mut never()).unwrap().alpha;
        assert_eq!(out[0], 255);
        assert_eq!(out[w - 1], 0);
    }

    #[test]
    fn 结果与线程数无关() {
        let (w, h) = (130, 150);
        let (img, _, al) = synth(w, h, 60, 12, [200, 90, 40], [20, 60, 220]);
        let mut p = RefineStrength::Standard.params(w, h).unwrap();
        p.scale = 2;
        p.threads = 1;
        let one = run(&img, &al, w, h, &p, &mut never()).unwrap();
        p.threads = 4;
        let four = run(&img, &al, w, h, &p, &mut never()).unwrap();
        assert_eq!(one, four);
    }

    #[test]
    fn 全0全1与单像素不出错() {
        for v in [0u8, 255] {
            let r = refine(&[9; 4 * 4 * 3], vec![v; 16], 4, 4, RefineStrength::Strong, &CancelToken::new()).unwrap();
            assert!(r.alpha.iter().all(|&a| a == v));
            assert_eq!(r.fg, vec![9; 48]);
        }
        let r = refine(&[1, 2, 3], vec![128], 1, 1, RefineStrength::Standard, &CancelToken::new()).unwrap();
        assert_eq!((r.alpha.len(), r.fg.len()), (1, 3));
    }

    #[test]
    fn 非正方形与奇数尺寸不越界() {
        for (w, h) in [(37, 5), (5, 37), (1, 30), (30, 1), (101, 67)] {
            let (img, _, al) = synth(w, h, w / 2, (w / 6).max(1), [200, 90, 40], [20, 60, 220]);
            let r = refine(&img, al, w, h, RefineStrength::Standard, &CancelToken::new()).unwrap();
            assert_eq!((r.alpha.len(), r.fg.len()), (w * h, w * h * 3));
        }
    }

    #[test]
    fn 关闭时原样返回() {
        let (img, _, al) = synth(20, 4, 8, 4, [200, 90, 40], [20, 60, 220]);
        let r = refine(&img, al.clone(), 20, 4, RefineStrength::Off, &CancelToken::new()).unwrap();
        assert_eq!((r.alpha, r.fg), (al, img));
    }

    #[test]
    fn 入参长度不符报错() {
        assert!(matches!(refine(&[0; 5], vec![0; 2], 2, 1, RefineStrength::Standard, &CancelToken::new()), Err(AiError::InvalidImage(_))));
        assert!(matches!(refine(&[], vec![], 0, 0, RefineStrength::Off, &CancelToken::new()), Err(AiError::InvalidImage(_))));
    }

    #[test]
    fn 令牌已取消则立刻退出() {
        let t = CancelToken::new();
        t.cancel();
        assert_eq!(refine(&[0; 12], vec![128; 4], 2, 2, RefineStrength::Standard, &t), Err(AiError::Cancelled));
    }

    #[test]
    fn 后处理阶段按分块检查取消_取消后可再跑() {
        // 600 行 -> 每遍扫描都会多次检查；第 N 次检查时触发取消，应在随后的检查点退出
        let (w, h) = (8, 600);
        let img = vec![100u8; w * h * 3];
        let al = vec![128u8; w * h];
        let mut calls = 0;
        let r = refine_with(&img, al.clone(), w, h, RefineStrength::Standard, &mut || {
            calls += 1;
            if calls >= 5 { Err(AiError::Cancelled) } else { Ok(()) }
        });
        assert_eq!(r, Err(AiError::Cancelled));
        assert_eq!(calls, 5);
        // 同样的入参用新的检查闭包仍能跑完，并且检查次数远多于 5（分块确实在检查）
        let mut total = 0;
        let ok = refine_with(&img, al, w, h, RefineStrength::Standard, &mut || {
            total += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(ok.alpha.len(), w * h);
        assert!(total > 10, "检查次数 {total}");
    }

    /// 调参与耗时实测：读桌面脚本导出的原图与旧 alpha，跑细化并写出结果。
    ///
    /// 环境变量：`ARKLI_REFINE_RGB`（8 字节小端宽高 + RGB）、`ARKLI_REFINE_ALPHA`（原始 u8 alpha）、
    /// `ARKLI_REFINE_OUT`（输出前缀，写 `.alpha` 与 `.fg`）、可选 `ARKLI_REFINE_LEVEL`（off/light/standard/strong）。
    /// 命令：`cargo test --release -p arkli-ai refine_real -- --ignored --nocapture`
    #[test]
    #[ignore = "需要 ARKLI_REFINE_RGB / ARKLI_REFINE_ALPHA / ARKLI_REFINE_OUT"]
    fn refine_real_image() {
        let env = |n: &str| std::env::var(n).unwrap_or_else(|_| panic!("未设置 {n}"));
        let raw = std::fs::read(env("ARKLI_REFINE_RGB")).unwrap();
        let (w, h) = (u32::from_le_bytes(raw[0..4].try_into().unwrap()) as usize, u32::from_le_bytes(raw[4..8].try_into().unwrap()) as usize);
        let alpha = std::fs::read(env("ARKLI_REFINE_ALPHA")).unwrap();
        let level = match std::env::var("ARKLI_REFINE_LEVEL").as_deref() {
            Ok("off") => RefineStrength::Off,
            Ok("light") => RefineStrength::Light,
            Ok("strong") => RefineStrength::Strong,
            _ => RefineStrength::Standard,
        };
        let t = std::time::Instant::now();
        let r = refine(&raw[8..], alpha, w, h, level, &CancelToken::new()).unwrap();
        println!("{w}x{h} {level:?} {} ms", t.elapsed().as_millis());
        let out = env("ARKLI_REFINE_OUT");
        std::fs::write(format!("{out}.alpha"), &r.alpha).unwrap();
        std::fs::write(format!("{out}.fg"), &r.fg).unwrap();
    }
}
