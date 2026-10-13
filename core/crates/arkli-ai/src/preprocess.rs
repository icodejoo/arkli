//! 三个模型的输入预处理：缩放、归一化、NCHW 排布。

use crate::backend::Tensor;
use crate::error::{AiError, Result};
use crate::image::RgbImage;

/// 检测模型尺寸需对齐的倍数。
pub const DET_SIZE_ALIGN: u32 = 32;
/// 检测默认最长边。
pub const DET_DEFAULT_MAX_SIDE: u32 = 960;
/// 检测归一化均值（ImageNet）。
pub const DET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
/// 检测归一化标准差（ImageNet）。
pub const DET_STD: [f32; 3] = [0.229, 0.224, 0.225];
/// 识别 / 分类归一化：(x/255 - 0.5) / 0.5。
pub const REC_MEAN: [f32; 3] = [0.5; 3];
/// 识别 / 分类归一化标准差。
pub const REC_STD: [f32; 3] = [0.5; 3];
/// 识别输入固定高度。
pub const REC_HEIGHT: u32 = 48;
/// 识别输入最小宽度（不足则右侧补 0）。
pub const REC_MIN_WIDTH: u32 = 320;
/// 识别输入最大宽度（超过则整体压窄）。
pub const REC_MAX_WIDTH: u32 = 2400;
/// 方向分类输入固定高度。
pub const CLS_HEIGHT: u32 = 48;
/// 方向分类输入固定宽度。
pub const CLS_WIDTH: u32 = 192;

/// 送入模型的通道顺序。PaddleOCR / RapidOCR 的参考实现喂的是 OpenCV 读出来的 BGR，
/// 所以默认 BGR；是否一致需要用真模型复验。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelOrder {
    /// 红绿蓝
    Rgb,
    /// 蓝绿红
    Bgr,
}

impl ChannelOrder {
    /// 输出的第 `c` 个通道取自 RGB 像素的哪个下标。
    fn src_index(self, c: usize) -> usize {
        match self {
            ChannelOrder::Rgb => c,
            ChannelOrder::Bgr => 2 - c,
        }
    }
}

/// 检测预处理参数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetPreConfig {
    /// 最长边上限，超过则等比缩小
    pub max_side: u32,
    /// 通道顺序
    pub channel_order: ChannelOrder,
}

impl Default for DetPreConfig {
    fn default() -> Self {
        Self {
            max_side: DET_DEFAULT_MAX_SIDE,
            channel_order: ChannelOrder::Bgr,
        }
    }
}

/// 检测预处理结果。
#[derive(Debug, Clone, PartialEq)]
pub struct DetInput {
    /// 形状 `[1, 3, H, W]` 的输入张量
    pub tensor: Tensor,
    /// 缩放后宽（32 的倍数）
    pub resized_w: u32,
    /// 缩放后高（32 的倍数）
    pub resized_h: u32,
    /// 原图宽
    pub src_w: u32,
    /// 原图高
    pub src_h: u32,
}

/// 算出检测输入尺寸：最长边超限则等比缩小，再把宽高四舍五入到 32 的倍数（至少 32）。
///
/// ```
/// use arkli_ai::preprocess::det_target_size;
/// assert_eq!(det_target_size(200, 100, 960), (192, 96));
/// assert_eq!(det_target_size(1920, 960, 960), (960, 480));
/// ```
pub fn det_target_size(w: u32, h: u32, max_side: u32) -> (u32, u32) {
    let longest = w.max(h);
    let ratio = if longest > max_side {
        max_side as f32 / longest as f32
    } else {
        1.0
    };
    let align = |v: u32| -> u32 {
        let scaled = (v as f32 * ratio / DET_SIZE_ALIGN as f32).round() as u32;
        scaled.max(1) * DET_SIZE_ALIGN
    };
    (align(w), align(h))
}

/// 把一张图按 `(x/255 - mean) / std` 归一化并排成 CHW 平面（不含 batch 维）。
///
/// - `canvas_w`：输出每个平面的宽，大于图宽时右侧补 0（归一化后的 0）
pub fn to_chw(
    img: &RgbImage,
    mean: [f32; 3],
    std: [f32; 3],
    order: ChannelOrder,
    canvas_w: u32,
) -> Vec<f32> {
    let (w, h, cw) = (img.width as usize, img.height as usize, canvas_w as usize);
    let mut out = vec![0.0f32; 3 * h * cw];
    for c in 0..3 {
        let si = order.src_index(c);
        let plane = c * h * cw;
        for y in 0..h {
            for x in 0..w {
                let v = img.data[(y * w + x) * 3 + si] as f32 / 255.0;
                out[plane + y * cw + x] = (v - mean[c]) / std[c];
            }
        }
    }
    out
}

/// 检测预处理：缩放（限最长边、对齐 32）+ ImageNet 归一化 + NCHW。
pub fn preprocess_det(img: &RgbImage, cfg: &DetPreConfig) -> Result<DetInput> {
    if cfg.max_side < DET_SIZE_ALIGN {
        return Err(AiError::InvalidConfig(format!(
            "max_side 不能小于 {DET_SIZE_ALIGN}"
        )));
    }
    let (rw, rh) = det_target_size(img.width, img.height, cfg.max_side);
    let resized = img.resize_bilinear(rw, rh)?;
    let data = to_chw(&resized, DET_MEAN, DET_STD, cfg.channel_order, rw);
    Ok(DetInput {
        tensor: Tensor::new(vec![1, 3, rh as i64, rw as i64], data)?,
        resized_w: rw,
        resized_h: rh,
        src_w: img.width,
        src_h: img.height,
    })
}

/// 识别预处理参数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecPreConfig {
    /// 固定高度
    pub height: u32,
    /// 最小宽度，内容不足时右侧补 0
    pub min_width: u32,
    /// 最大宽度，超出时整体压窄
    pub max_width: u32,
    /// 通道顺序
    pub channel_order: ChannelOrder,
}

impl Default for RecPreConfig {
    fn default() -> Self {
        Self {
            height: REC_HEIGHT,
            min_width: REC_MIN_WIDTH,
            max_width: REC_MAX_WIDTH,
            channel_order: ChannelOrder::Bgr,
        }
    }
}

/// 固定高度缩放 + 宽度补 0：先按宽高比缩到 `height`，内容宽夹在 `[1, max_width]`，
/// 画布宽取 `max(min_width, 内容宽)`，其余补 0；输出 `[1, 3, height, 画布宽]`。
fn fixed_height_tensor(
    crop: &RgbImage,
    height: u32,
    min_width: u32,
    max_width: u32,
    order: ChannelOrder,
) -> Result<Tensor> {
    let ratio = crop.width as f32 / crop.height as f32;
    let content_w = ((height as f32 * ratio).ceil() as u32).clamp(1, max_width);
    let canvas_w = min_width.max(content_w);
    let resized = crop.resize_bilinear(content_w, height)?;
    let data = to_chw(&resized, REC_MEAN, REC_STD, order, canvas_w);
    Tensor::new(vec![1, 3, height as i64, canvas_w as i64], data)
}

/// 识别预处理：固定高 48、按比例定宽、右侧补 0、(x-0.5)/0.5 归一化。
pub fn preprocess_rec(crop: &RgbImage, cfg: &RecPreConfig) -> Result<Tensor> {
    if cfg.height == 0 || cfg.max_width == 0 || cfg.min_width > cfg.max_width {
        return Err(AiError::InvalidConfig("识别预处理参数不合法".into()));
    }
    fixed_height_tensor(
        crop,
        cfg.height,
        cfg.min_width,
        cfg.max_width,
        cfg.channel_order,
    )
}

/// 方向分类预处理：固定 `height x width`（默认 48x192），宽度不足补 0，过宽压窄。
pub fn preprocess_cls(
    crop: &RgbImage,
    height: u32,
    width: u32,
    order: ChannelOrder,
) -> Result<Tensor> {
    if height == 0 || width == 0 {
        return Err(AiError::InvalidConfig("分类输入尺寸不能为 0".into()));
    }
    fixed_height_tensor(crop, height, width, width, order)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 检测尺寸对齐与限长() {
        assert_eq!(det_target_size(200, 100, 960), (192, 96));
        assert_eq!(det_target_size(1920, 960, 960), (960, 480));
        // 超长截图：1080x4000 -> 最长边压到 960，再对齐
        assert_eq!(det_target_size(1080, 4000, 960), (256, 960));
        // 极小图至少 32
        assert_eq!(det_target_size(5, 5, 960), (32, 32));
    }

    #[test]
    fn 检测预处理形状与数值() {
        let img = RgbImage::filled(64, 32, [255, 0, 0]); // 纯红
        let out = preprocess_det(
            &img,
            &DetPreConfig {
                max_side: 960,
                channel_order: ChannelOrder::Rgb,
            },
        )
        .unwrap();
        assert_eq!(out.tensor.shape, vec![1, 3, 32, 64]);
        assert_eq!((out.resized_w, out.resized_h), (64, 32));
        let plane = 32 * 64;
        // R 通道：(1 - 0.485) / 0.229
        assert!((out.tensor.data[0] - (1.0 - 0.485) / 0.229).abs() < 1e-5);
        // G 通道：(0 - 0.456) / 0.224
        assert!((out.tensor.data[plane] - (-0.456 / 0.224)).abs() < 1e-5);
        assert_eq!(out.tensor.data.len(), 3 * plane);
    }

    #[test]
    fn bgr顺序会换通道() {
        let img = RgbImage::filled(32, 32, [255, 0, 0]);
        let out = preprocess_det(&img, &DetPreConfig::default()).unwrap();
        let plane = 32 * 32;
        // BGR：第 0 个通道取的是 B（=0），第 2 个通道取的是 R（=255）
        assert!((out.tensor.data[0] - (-0.485 / 0.229)).abs() < 1e-5);
        assert!((out.tensor.data[2 * plane] - (1.0 - 0.406) / 0.225).abs() < 1e-5);
    }

    #[test]
    fn 检测预处理拒绝过小上限() {
        let img = RgbImage::filled(32, 32, [0; 3]);
        let cfg = DetPreConfig {
            max_side: 16,
            ..Default::default()
        };
        assert!(preprocess_det(&img, &cfg).is_err());
    }

    #[test]
    fn 识别预处理补零与宽度() {
        // 宽高比 2:1，内容宽 96，不足 320，补零到 320
        let crop = RgbImage::filled(96, 48, [255, 255, 255]);
        let t = preprocess_rec(&crop, &RecPreConfig::default()).unwrap();
        assert_eq!(t.shape, vec![1, 3, 48, 320]);
        // 内容区：白色归一化后为 1.0
        assert!((t.data[0] - 1.0).abs() < 1e-5);
        assert!((t.data[95] - 1.0).abs() < 1e-5);
        // padding 区为 0
        assert_eq!(t.data[96], 0.0);
        assert_eq!(t.data[319], 0.0);
    }

    #[test]
    fn 识别预处理长行加宽并限顶() {
        // 宽高比 10:1 -> 内容宽 480，画布 480
        let crop = RgbImage::filled(480, 48, [0, 0, 0]);
        let t = preprocess_rec(&crop, &RecPreConfig::default()).unwrap();
        assert_eq!(t.shape, vec![1, 3, 48, 480]);
        assert!((t.data[0] + 1.0).abs() < 1e-5);
        // 超过上限被压窄
        let huge = RgbImage::filled(6000, 48, [0; 3]);
        let t = preprocess_rec(&huge, &RecPreConfig::default()).unwrap();
        assert_eq!(t.shape[3], REC_MAX_WIDTH as i64);
    }

    #[test]
    fn 识别预处理参数校验() {
        let crop = RgbImage::filled(10, 10, [0; 3]);
        let bad = RecPreConfig {
            min_width: 500,
            max_width: 100,
            ..Default::default()
        };
        assert!(preprocess_rec(&crop, &bad).is_err());
    }

    #[test]
    fn 分类预处理固定尺寸() {
        let crop = RgbImage::filled(400, 48, [255; 3]);
        let t = preprocess_cls(&crop, CLS_HEIGHT, CLS_WIDTH, ChannelOrder::Bgr).unwrap();
        assert_eq!(t.shape, vec![1, 3, 48, 192]);
        let short = RgbImage::filled(48, 48, [255; 3]);
        let t = preprocess_cls(&short, CLS_HEIGHT, CLS_WIDTH, ChannelOrder::Bgr).unwrap();
        assert_eq!(t.data[47], 1.0);
        assert_eq!(t.data[48], 0.0);
        assert!(preprocess_cls(&short, 0, 192, ChannelOrder::Rgb).is_err());
    }
}
