//! 抠图引擎：人像用 MODNet（512，fp32），通用用 U2Net-p（320，f16）；另有两个实验模型 PP-MattingV2、BiRefNet-lite。
//!
//! 流程：原图缩放到模型输入边长（PIL 同款抗锯齿 bilinear，与桌面验证脚本一致）-> 按模式归一化 ->
//! 单次前向 -> 取 alpha（U2Net-p 要 min-max 归一化）-> 缩回原图尺寸（8 位 alpha）-> 边缘细化
//! （[`crate::matting_refine`]：引导滤波收紧 alpha、估计去污染前景色）。
//! 合成带透明通道的 PNG 由原生完成，这里交出与原图同尺寸的 alpha 和对应的前景色 RGB。
//!
//! 取消：一次前向没有循环可插检查点，不可中途打断；只在“预处理前 / 前向前 / 后处理前”以及后处理按行分块时
//! 检查令牌，所以取消延迟最长约一次前向（4 线程约 0.6~0.8 秒）。
//!
//! 前后处理以 `native/mnn/.work/convert/matting-tools/{prep,eval}.py` 里已对拍验证的为准：
//! - MODNet：输入 `input`，`(v - 127.5) / 127.5`，输出 `output`，值域 0~1
//! - U2Net-p：输入 `input.1`，先 `v / max(全图最大值)`，再 ImageNet mean/std，输出 `1959`（最后融合的 d0），min-max 归一化
//! - PP-MattingV2（实验）：输入 `img` 512，`(v/255 - 0.5)/0.5`，输出 `sigmoid_5.tmp_0` 已是 0~1 的 alpha
//! - BiRefNet-lite（实验）：输入 `input_image` 512（社区 512 重导出版），`v/255` 后 ImageNet mean/std，输出 `output_image`；
//!   值越出 0~1 说明是 logits，整体过 sigmoid（与桌面 `run_models.py` 一致）

use std::borrow::Cow;
use std::time::Instant;

use crate::backend::{GraphSession, GraphValue};
use crate::clip::{build_taps, resize_rgb};
use crate::error::{AiError, Result};
use crate::image::{PixelFormat, RawImage};
use crate::matting_refine::{refine, RefineStrength};
use crate::task::CancelToken;

/// MODNet 输入边长。
pub const MODNET_SIZE: u32 = 512;
/// U2Net-p 输入边长。
pub const U2NETP_SIZE: u32 = 320;
/// MODNet 输入名。
pub const MODNET_INPUT: &str = "input";
/// MODNet 输出名。
pub const MODNET_OUTPUT: &str = "output";
/// U2Net-p 输入名。
pub const U2NETP_INPUT: &str = "input.1";
/// U2Net-p 输出名（最后融合后的 d0）。
pub const U2NETP_OUTPUT: &str = "1959";
/// PP-MattingV2 输入边长（固定）。
pub const PPMATTING_SIZE: u32 = 512;
/// PP-MattingV2 输入名。
pub const PPMATTING_INPUT: &str = "img";
/// PP-MattingV2 输出名。
pub const PPMATTING_OUTPUT: &str = "sigmoid_5.tmp_0";
/// BiRefNet-lite 输入边长（固定，512 重导出版；1024 版真机内存峰值约 5.2GB 会被系统杀）。
pub const BIREFNET_SIZE: u32 = 512;
/// BiRefNet-lite 输入名。
pub const BIREFNET_INPUT: &str = "input_image";
/// BiRefNet-lite 输出名。
pub const BIREFNET_OUTPUT: &str = "output_image";
/// 输入图最长边上限，与 OCR 一致。
pub const MAX_INPUT_SIDE: u32 = 4096;
/// 像素最大值，用于 0..255 到 0..1。
const PIXEL_MAX: f32 = 255.0;
/// MODNet 归一化的中心与缩放（0..255 空间）。
const MODNET_MID: f32 = 127.5;
/// ImageNet 均值（RGB）。
const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
/// ImageNet 标准差（RGB）。
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];
/// 除零保护。
const EPS: f32 = 1e-6;
/// 后处理每处理这么多输出行检查一次取消。
const CANCEL_CHECK_ROWS: usize = 256;

/// 抠图模式，对应两个模型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MattingMode {
    /// 人像（MODNet）
    Portrait,
    /// 通用主体（U2Net-p）
    General,
    /// 人像 v2（PP-MattingV2，实验）
    PpMatting,
    /// 通用高精（BiRefNet-lite，实验）
    BiRefNet,
}

impl MattingMode {
    /// 模型输入边长。
    pub fn input_size(self) -> u32 {
        match self {
            MattingMode::Portrait => MODNET_SIZE,
            MattingMode::General => U2NETP_SIZE,
            MattingMode::PpMatting => PPMATTING_SIZE,
            MattingMode::BiRefNet => BIREFNET_SIZE,
        }
    }

    /// 模型输入名。
    pub fn input_name(self) -> &'static str {
        match self {
            MattingMode::Portrait => MODNET_INPUT,
            MattingMode::General => U2NETP_INPUT,
            MattingMode::PpMatting => PPMATTING_INPUT,
            MattingMode::BiRefNet => BIREFNET_INPUT,
        }
    }

    /// 模型输出名。
    pub fn output_name(self) -> &'static str {
        match self {
            MattingMode::Portrait => MODNET_OUTPUT,
            MattingMode::General => U2NETP_OUTPUT,
            MattingMode::PpMatting => PPMATTING_OUTPUT,
            MattingMode::BiRefNet => BIREFNET_OUTPUT,
        }
    }
}

/// 一次抠图的结果：与输入图同尺寸的 8 位 alpha 与去污染前景色。
#[derive(Debug, Clone, PartialEq)]
pub struct AlphaMatte {
    /// 宽（同输入图）
    pub width: u32,
    /// 高（同输入图）
    pub height: u32,
    /// 行优先 alpha，0 全透明 255 不透明，长度 `width * height`
    pub alpha: Vec<u8>,
    /// 前景色 RGB（straight alpha，非预乘），长度 `width * height * 3`；细化关闭时就是原图像素
    pub fg: Vec<u8>,
    /// 缩放、前向、alpha 缩回原图尺寸的耗时（毫秒）
    pub infer_ms: u64,
    /// 边缘细化（引导滤波 + 前景色估计）耗时（毫秒）；关闭时为 0
    pub refine_ms: u64,
}

/// 抠图引擎：持有一个已加载的图会话，按模式预处理、前向、后处理。
///
/// ```ignore
/// let mut m = Matter::new(graph, MattingMode::Portrait);
/// let matte = m.matte(&img, &CancelToken::new(), RefineStrength::Standard)?;
/// ```
pub struct Matter<G: GraphSession> {
    /// 图会话
    graph: G,
    /// 模式
    mode: MattingMode,
}

impl<G: GraphSession> Matter<G> {
    /// 包装一个已加载的图会话。
    ///
    /// - `graph`：输入输出名须分别是 [`MattingMode::input_name`] / [`MattingMode::output_name`]
    /// - `mode`：模式，决定缩放尺寸与归一化
    pub fn new(graph: G, mode: MattingMode) -> Self {
        Self { graph, mode }
    }

    /// 当前模式。
    pub fn mode(&self) -> MattingMode {
        self.mode
    }

    /// 对一张图抠图。
    ///
    /// - `img`：原图，最长边不超过 [`MAX_INPUT_SIDE`]
    /// - `cancel`：取消令牌；预处理前、前向前、后处理前与后处理（放大、细化）分块时检查，命中返回 [`AiError::Cancelled`]
    /// - `strength`：边缘细化强度，缺省用 [`RefineStrength::default`]（强）；[`RefineStrength::Off`] 等同旧行为
    /// - 返回：与 `img` 同尺寸的 alpha 与前景色
    pub fn matte(&mut self, img: &RawImage, cancel: &CancelToken, strength: RefineStrength) -> Result<AlphaMatte> {
        if img.width.max(img.height) > MAX_INPUT_SIDE {
            return Err(AiError::InvalidImage(format!("图片最长边超过 {MAX_INPUT_SIDE}")));
        }
        cancel.check()?;
        let t0 = Instant::now();
        let size = self.mode.input_size();
        let rgb = resize_rgb(img, size, size)?;
        let data = normalize(self.mode, &rgb);
        cancel.check()?;
        let shape = [1, 3, size as i64, size as i64];
        let input = self.graph.value_f32(&shape, &data)?;
        drop(data);
        let outs = self.graph.run(&[&input])?;
        let out = outs.first().ok_or_else(|| AiError::BadModelOutput("模型没有输出".into()))?;
        let mut alpha = out.to_f32()?;
        let side = size as usize;
        if alpha.len() != side * side {
            return Err(AiError::BadModelOutput(format!(
                "输出长度 {} 与 {side}x{side} 不符，形状 {:?}",
                alpha.len(),
                out.shape()
            )));
        }
        drop(outs);
        cancel.check()?;
        finish_alpha(self.mode, &mut alpha);
        let full = upscale_alpha(&alpha, side, img.width as usize, img.height as usize, cancel)?;
        let infer_ms = t0.elapsed().as_millis() as u64;
        let t1 = Instant::now();
        let rgb_full: Cow<[u8]> = if img.format == PixelFormat::Rgb { Cow::Borrowed(&img.data[..]) } else { Cow::Owned(img.to_rgb().data) };
        let r = refine(&rgb_full, full, img.width as usize, img.height as usize, strength, cancel)?;
        let refine_ms = if strength == RefineStrength::Off { 0 } else { t1.elapsed().as_millis() as u64 };
        Ok(AlphaMatte { width: img.width, height: img.height, alpha: r.alpha, fg: r.fg, infer_ms, refine_ms })
    }
}

/// 把模型尺寸的 RGB u8 按模式变成 NCHW 的 f32 输入。
///
/// - MODNet：`(v - 127.5) / 127.5`
/// - U2Net-p：`v / max(全图最大值)` 后用 ImageNet mean/std（最大值取全图三通道，与桌面脚本一致）
/// - PP-MattingV2：同 MODNet（`(v/255-0.5)/0.5` 即 `(v-127.5)/127.5`）
/// - BiRefNet-lite：`v/255` 后用 ImageNet mean/std
pub fn normalize(mode: MattingMode, rgb: &[u8]) -> Vec<f32> {
    let plane = rgb.len() / 3;
    let mut out = vec![0.0f32; 3 * plane];
    match mode {
        // PP-MattingV2 的 `(v/255-0.5)/0.5` 与 MODNet 的 `(v-127.5)/127.5` 等价
        MattingMode::Portrait | MattingMode::PpMatting => {
            for (i, px) in rgb.chunks_exact(3).enumerate() {
                for c in 0..3 {
                    out[c * plane + i] = (px[c] as f32 - MODNET_MID) / MODNET_MID;
                }
            }
        }
        MattingMode::General => {
            let max = (rgb.iter().copied().max().unwrap_or(0) as f32).max(EPS);
            for (i, px) in rgb.chunks_exact(3).enumerate() {
                for c in 0..3 {
                    out[c * plane + i] = (px[c] as f32 / max - IMAGENET_MEAN[c]) / IMAGENET_STD[c];
                }
            }
        }
        MattingMode::BiRefNet => {
            for (i, px) in rgb.chunks_exact(3).enumerate() {
                for c in 0..3 {
                    out[c * plane + i] = (px[c] as f32 / PIXEL_MAX - IMAGENET_MEAN[c]) / IMAGENET_STD[c];
                }
            }
        }
    }
    out
}

/// 就地整理模型输出：U2Net-p 做 min-max 归一化；BiRefNet 输出越出 0..1 时整体过 sigmoid；最后都夹到 0..1。
pub fn finish_alpha(mode: MattingMode, alpha: &mut [f32]) {
    if mode == MattingMode::BiRefNet && alpha.iter().any(|&v| !(0.0..=1.0).contains(&v)) {
        alpha.iter_mut().for_each(|v| *v = 1.0 / (1.0 + (-*v).exp()));
    }
    if mode == MattingMode::General {
        let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
        for &v in alpha.iter() {
            lo = lo.min(v);
            hi = hi.max(v);
        }
        let span = (hi - lo).max(EPS);
        alpha.iter_mut().for_each(|v| *v = (*v - lo) / span);
    }
    alpha.iter_mut().for_each(|v| *v = v.clamp(0.0, 1.0));
}

/// 把 `side x side` 的 f32 alpha（0..1）双线性缩到 `out_w x out_h` 的 8 位 alpha。
/// 系数与 PIL 的 bilinear 一致（缩小时抗锯齿）；按输出行分块检查取消。
pub fn upscale_alpha(alpha: &[f32], side: usize, out_w: usize, out_h: usize, cancel: &CancelToken) -> Result<Vec<u8>> {
    if out_w == 0 || out_h == 0 {
        return Err(AiError::InvalidImage("目标尺寸不能为 0".into()));
    }
    let hx = build_taps(side, out_w);
    let vy = build_taps(side, out_h);
    // 横向：side 行 x out_w 列
    let mut mid = vec![0.0f32; side * out_w];
    for y in 0..side {
        let row = &alpha[y * side..(y + 1) * side];
        for (ox, t) in hx.iter().enumerate() {
            let mut acc = 0.0f32;
            for (k, w) in t.weights.iter().enumerate() {
                acc += w * row[t.start + k];
            }
            mid[y * out_w + ox] = acc;
        }
    }
    // 纵向：out_h 行 x out_w 列
    let mut out = vec![0u8; out_h * out_w];
    for (oy, t) in vy.iter().enumerate() {
        if oy % CANCEL_CHECK_ROWS == 0 {
            cancel.check()?;
        }
        for x in 0..out_w {
            let mut acc = 0.0f32;
            for (k, w) in t.weights.iter().enumerate() {
                acc += w * mid[(t.start + k) * out_w + x];
            }
            out[oy * out_w + x] = (acc * PIXEL_MAX + 0.5).floor().clamp(0.0, PIXEL_MAX) as u8;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::PixelFormat;
    use std::sync::{Arc, Mutex};

    /// 假张量。
    struct Val {
        /// 形状
        shape: Vec<i64>,
        /// 数据
        data: Vec<f32>,
    }

    impl GraphValue for Val {
        fn shape(&self) -> Vec<i64> {
            self.shape.clone()
        }
        fn to_f32(&self) -> Result<Vec<f32>> {
            Ok(self.data.clone())
        }
        fn to_i32(&self) -> Result<Vec<i32>> {
            Err(AiError::BadModelOutput("无 i32".into()))
        }
    }

    /// 假图会话：返回固定 alpha，记录收到的输入；可在 run 里触发取消。
    struct Fake {
        /// 输入名
        ins: Vec<String>,
        /// 输出名
        outs: Vec<String>,
        /// 固定输出
        out: Vec<f32>,
        /// 记录输入 (形状, 数据)
        seen: Arc<Mutex<Vec<(Vec<i64>, Vec<f32>)>>>,
        /// run 时顺手取消的令牌
        cancel_in_run: Option<CancelToken>,
    }

    impl Fake {
        /// 按模式造一个输出全为 `v` 的假会话。
        fn new(mode: MattingMode, v: f32) -> Self {
            let n = (mode.input_size() * mode.input_size()) as usize;
            Self {
                ins: vec![mode.input_name().into()],
                outs: vec![mode.output_name().into()],
                out: vec![v; n],
                seen: Default::default(),
                cancel_in_run: None,
            }
        }
    }

    impl GraphSession for Fake {
        type Value = Val;
        fn input_names(&self) -> &[String] {
            &self.ins
        }
        fn output_names(&self) -> &[String] {
            &self.outs
        }
        fn value_f32(&self, shape: &[i64], data: &[f32]) -> Result<Val> {
            Ok(Val { shape: shape.to_vec(), data: data.to_vec() })
        }
        fn value_i32(&self, _: &[i64], _: &[i32]) -> Result<Val> {
            Err(AiError::Unsupported("mock".into()))
        }
        fn run(&mut self, inputs: &[&Val]) -> Result<Vec<Val>> {
            self.seen.lock().unwrap().push((inputs[0].shape.clone(), inputs[0].data.clone()));
            if let Some(t) = &self.cancel_in_run {
                t.cancel();
            }
            let side = (self.out.len() as f64).sqrt() as i64;
            Ok(vec![Val { shape: vec![1, 1, side, side], data: self.out.clone() }])
        }
    }

    /// 纯色测试图。
    fn solid(w: u32, h: u32, rgb: [u8; 3]) -> RawImage {
        let data = (0..w * h).flat_map(|_| rgb).collect();
        RawImage::new(w, h, PixelFormat::Rgb, data).unwrap()
    }

    #[test]
    fn 人像归一化到负一到一() {
        let v = normalize(MattingMode::Portrait, &[0, 255, 127, 0, 255, 127]);
        // 通道平面排布：R 平面、G 平面、B 平面
        assert_eq!(v.len(), 6);
        assert!((v[0] - -1.0).abs() < 1e-6 && (v[1] - -1.0).abs() < 1e-6);
        assert!((v[2] - 1.0).abs() < 1e-6);
        assert!((v[4] - (127.0 - 127.5) / 127.5).abs() < 1e-6);
    }

    #[test]
    fn 通用先除全图最大值再做imagenet归一化() {
        // 单像素 (100, 200, 50)：最大值 200
        let v = normalize(MattingMode::General, &[100, 200, 50]);
        assert!((v[0] - (0.5 - 0.485) / 0.229).abs() < 1e-5);
        assert!((v[1] - (1.0 - 0.456) / 0.224).abs() < 1e-5);
        assert!((v[2] - (0.25 - 0.406) / 0.225).abs() < 1e-5);
    }

    #[test]
    fn 全黑图通用归一化不除零() {
        let v = normalize(MattingMode::General, &[0, 0, 0]);
        assert!(v.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn 通用模式做minmax_人像只夹值() {
        let mut a = vec![2.0, 4.0, 6.0];
        finish_alpha(MattingMode::General, &mut a);
        assert_eq!(a, vec![0.0, 0.5, 1.0]);
        let mut b = vec![-0.2, 0.5, 1.3];
        finish_alpha(MattingMode::Portrait, &mut b);
        assert_eq!(b, vec![0.0, 0.5, 1.0]);
    }

    #[test]
    fn 常数输出的通用模式不产生非数() {
        let mut a = vec![3.0; 4];
        finish_alpha(MattingMode::General, &mut a);
        assert!(a.iter().all(|x| x.is_finite() && (0.0..=1.0).contains(x)));
    }

    #[test]
    fn 缩放保持常数与目标尺寸() {
        let a = vec![1.0f32; 4 * 4];
        let out = upscale_alpha(&a, 4, 9, 5, &CancelToken::new()).unwrap();
        assert_eq!(out.len(), 45);
        assert!(out.iter().all(|&v| v == 255));
        let z = upscale_alpha(&vec![0.0; 16], 4, 3, 7, &CancelToken::new()).unwrap();
        assert!(z.iter().all(|&v| v == 0));
    }

    #[test]
    fn 缩放保持左右半边() {
        // 左半 0、右半 1 的 4x4 图放大到 8x8：最左列为 0，最右列为 255
        let mut a = vec![0.0f32; 16];
        for y in 0..4 {
            for x in 2..4 {
                a[y * 4 + x] = 1.0;
            }
        }
        let out = upscale_alpha(&a, 4, 8, 8, &CancelToken::new()).unwrap();
        assert_eq!(out[0], 0);
        assert_eq!(out[7], 255);
        assert!(out[3] < 255 && out[4] > 0);
    }

    #[test]
    fn 完整流程输入形状与输出尺寸() {
        let g = Fake::new(MattingMode::Portrait, 1.0);
        let seen = g.seen.clone();
        let mut m = Matter::new(g, MattingMode::Portrait);
        let r = m.matte(&solid(30, 20, [10, 20, 30]), &CancelToken::new(), RefineStrength::Standard).unwrap();
        assert_eq!((r.width, r.height, r.alpha.len()), (30, 20, 600));
        assert!(r.alpha.iter().all(|&v| v == 255));
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, vec![1, 3, 512, 512]);
    }

    #[test]
    fn ppmatting归一化与人像一致() {
        let rgb = [0u8, 127, 255, 10, 20, 30];
        assert_eq!(normalize(MattingMode::PpMatting, &rgb), normalize(MattingMode::Portrait, &rgb));
    }

    #[test]
    fn birefnet用255做分母加imagenet() {
        let out = normalize(MattingMode::BiRefNet, &[255, 0, 255]);
        assert!((out[0] - (1.0 - IMAGENET_MEAN[0]) / IMAGENET_STD[0]).abs() < 1e-5);
        assert!((out[1] - (0.0 - IMAGENET_MEAN[1]) / IMAGENET_STD[1]).abs() < 1e-5);
    }

    #[test]
    fn birefnet的logits过sigmoid_已在0到1则不动() {
        let mut a = [-20.0f32, 0.0, 20.0];
        finish_alpha(MattingMode::BiRefNet, &mut a);
        assert!(a[0] < 1e-6 && (a[1] - 0.5).abs() < 1e-6 && a[2] > 1.0 - 1e-6);
        let mut b = [0.1f32, 0.9];
        finish_alpha(MattingMode::BiRefNet, &mut b);
        assert_eq!(b, [0.1, 0.9]);
    }

    #[test]
    fn 新模式的尺寸与名字() {
        assert_eq!(MattingMode::PpMatting.input_size(), 512);
        assert_eq!(MattingMode::BiRefNet.input_size(), 512);
        assert_eq!(MattingMode::PpMatting.input_name(), "img");
        assert_eq!(MattingMode::BiRefNet.output_name(), "output_image");
    }

    #[test]
    fn 通用模式输入尺寸是320() {
        let g = Fake::new(MattingMode::General, 0.3);
        let seen = g.seen.clone();
        let mut m = Matter::new(g, MattingMode::General);
        let r = m.matte(&solid(8, 8, [200, 100, 50]), &CancelToken::new(), RefineStrength::Standard).unwrap();
        // 常数输出 min-max 后全 0
        assert!(r.alpha.iter().all(|&v| v == 0));
        assert_eq!(seen.lock().unwrap()[0].0, vec![1, 3, 320, 320]);
    }

    #[test]
    fn 带透明度的输入按白底处理不报错() {
        let img = RawImage::new(2, 2, PixelFormat::Rgba, vec![0; 16]).unwrap();
        let mut m = Matter::new(Fake::new(MattingMode::Portrait, 0.5), MattingMode::Portrait);
        let r = m.matte(&img, &CancelToken::new(), RefineStrength::Standard).unwrap();
        assert_eq!(r.alpha.len(), 4);
        assert!(r.alpha.iter().all(|&v| (127..=128).contains(&v)));
    }

    #[test]
    fn 超长边报入参错误() {
        let mut m = Matter::new(Fake::new(MattingMode::Portrait, 1.0), MattingMode::Portrait);
        let img = RawImage::new(MAX_INPUT_SIDE + 1, 1, PixelFormat::Rgb, vec![0; (MAX_INPUT_SIDE as usize + 1) * 3]).unwrap();
        assert!(matches!(m.matte(&img, &CancelToken::new(), RefineStrength::Standard), Err(AiError::InvalidImage(_))));
    }

    #[test]
    fn 前向前已取消则不跑前向() {
        let g = Fake::new(MattingMode::Portrait, 1.0);
        let seen = g.seen.clone();
        let mut m = Matter::new(g, MattingMode::Portrait);
        let t = CancelToken::new();
        t.cancel();
        assert_eq!(m.matte(&solid(4, 4, [0; 3]), &t, RefineStrength::Standard), Err(AiError::Cancelled));
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn 前向中被取消则在后处理前退出_取消后可再跑() {
        let mut g = Fake::new(MattingMode::Portrait, 1.0);
        let t = CancelToken::new();
        g.cancel_in_run = Some(t.clone());
        let mut m = Matter::new(g, MattingMode::Portrait);
        assert_eq!(m.matte(&solid(4, 4, [0; 3]), &t, RefineStrength::Standard), Err(AiError::Cancelled));
        // 换新令牌后同一个引擎还能正常出结果（会话不残留取消状态）
        m.graph.cancel_in_run = None;
        let r = m.matte(&solid(4, 4, [0; 3]), &CancelToken::new(), RefineStrength::Standard).unwrap();
        assert_eq!(r.alpha.len(), 16);
    }

    #[test]
    fn 输出长度不符报模型输出异常() {
        let mut g = Fake::new(MattingMode::Portrait, 1.0);
        g.out = vec![1.0; 10];
        let mut m = Matter::new(g, MattingMode::Portrait);
        assert!(matches!(m.matte(&solid(4, 4, [0; 3]), &CancelToken::new(), RefineStrength::Standard), Err(AiError::BadModelOutput(_))));
    }

    #[test]
    fn 细化关闭时前景色就是原图且耗时为零() {
        let mut m = Matter::new(Fake::new(MattingMode::Portrait, 0.5), MattingMode::Portrait);
        let img = solid(6, 4, [10, 20, 30]);
        let r = m.matte(&img, &CancelToken::new(), RefineStrength::Off).unwrap();
        assert_eq!(r.fg, img.data);
        assert_eq!(r.refine_ms, 0);
    }

    #[test]
    fn 细化开启时前景色长度正确且纯色图不变() {
        let mut m = Matter::new(Fake::new(MattingMode::Portrait, 0.5), MattingMode::Portrait);
        let img = solid(9, 7, [10, 20, 30]);
        let r = m.matte(&img, &CancelToken::new(), RefineStrength::Standard).unwrap();
        assert_eq!(r.fg.len(), 9 * 7 * 3);
        assert!(r.fg.chunks(3).all(|p| p == [10, 20, 30]));
    }

    #[test]
    fn 后处理细化阶段被取消则退出_取消后可再跑() {
        // 前向照常跑完，随后在细化的第一个检查点命中：用“前向结束时才取消”的假图模拟
        let mut g = Fake::new(MattingMode::Portrait, 0.5);
        let t = CancelToken::new();
        g.cancel_in_run = Some(t.clone());
        let mut m = Matter::new(g, MattingMode::Portrait);
        assert_eq!(m.matte(&solid(64, 64, [1, 2, 3]), &t, RefineStrength::Strong), Err(AiError::Cancelled));
        m.graph.cancel_in_run = None;
        assert!(m.matte(&solid(64, 64, [1, 2, 3]), &CancelToken::new(), RefineStrength::Strong).is_ok());
    }
}
