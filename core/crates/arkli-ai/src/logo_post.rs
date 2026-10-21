//! SDXS 文生图 Logo 符号图像后处理模块。
//!
//! 将 512x512 RGB 位图转换为单色矢量符号 SVG，包含：
//! - 灰度转换与大津法二值化（skimage 算法复刻）
//! - 4-连通域分析与微小噪点滤除
//! - 模型自画外圈检测（`find_ring`）与剔除
//! - 几何与启发式质量特征计算（`features`）
//! - 基于 7 条规则的自动质量闸门（`gate`）
//! - vtracer 二值化单色矢量描摹（`symbol_svg`）

use std::time::Instant;

use crate::clip::resize_rgb;
use crate::error::{AiError, Result};
use crate::image::{PixelFormat, RawImage};
use crate::task::CancelToken;

/// 画布标准边长（像素，来自 symbol.py 的 N = 512）。
pub const SYMBOL_CANVAS: usize = 512;

/// 符号画布内符号最大边长（像素，来自 symbol.py 的 SYM_SIDE = 480）。
pub const SYM_SIDE: u32 = 480;

/// 灰度图二值化小斑点面积占画面比例下限（来自 post_mono.py 的 MIN_AREA = 0.0008）。
pub const BINARIZE_MIN_AREA: f64 = 0.0008;

/// 外圈外径至少占画布的比例（来自 symbol.py 的 RING_MIN_SPAN = 0.7）。
pub const RING_MIN_SPAN: f32 = 0.7;

/// 外圈宽高比下限（来自 symbol.py 的 0.85 < w / h < 1.18）。
pub const RING_ASPECT_MIN: f32 = 0.85;

/// 外圈宽高比上限（来自 symbol.py 的 0.85 < w / h < 1.18）。
pub const RING_ASPECT_MAX: f32 = 1.18;

/// 径向填充率：进入圈带判定阈值（来自 symbol.py 的 RING_BAND_ON = 0.5）。
pub const RING_BAND_ON: f32 = 0.5;

/// 径向填充率：出圈带内缘判定阈值（来自 symbol.py 的 RING_BAND_OFF = 0.3）。
pub const RING_BAND_OFF: f32 = 0.3;

/// 圈厚占外径比例的合理下限（来自 symbol.py 的 RING_THICK_MIN = 0.03）。
pub const RING_THICK_MIN: f32 = 0.03;

/// 圈厚占外径比例的合理上限（来自 symbol.py 的 RING_THICK_MAX = 0.35）。
pub const RING_THICK_MAX: f32 = 0.35;

/// 去除外圈后向内收缩的边距（像素，来自 symbol.py 的 RING_CUT_MARGIN = 5）。
pub const RING_CUT_MARGIN: f32 = 5.0;

/// 去除外圈后微小残留连通块的最小面积（像素，来自 symbol.py 的 a >= 30）。
pub const RING_RESIDUAL_MIN_AREA: usize = 30;

/// 启发式特征中空图墨量上限（像素，来自 symbol.py 的 ink < 50）。
pub const FEATURE_EMPTY_INK_THRESHOLD: usize = 50;

/// 旋转对称性检测角度列表（度数，来自 symbol.py 的 ROT_ANGLES = (29, 61, 103)）。
pub const ROT_ANGLES: [f32; 3] = [29.0, 61.0, 103.0];

/// 较大连通域面积占画布比例下限（来自 symbol.py 的 a >= 0.0005 * N * N）。
pub const FEATURE_BIG_AREA_RATIO: f32 = 0.0005;

/// 小斑点面积下限（像素，来自 symbol.py 的 20 <= a）。
pub const FEATURE_SPECK_AREA_MIN: usize = 20;

/// 质量闸门：墨量占画布比例下限（来自 gate.py 的 INK_MIN = 0.02）。
pub const GATE_INK_MIN: f32 = 0.02;

/// 质量闸门：墨量占画布比例上限（来自 gate.py 的 INK_MAX = 0.2）。
pub const GATE_INK_MAX: f32 = 0.2;

/// 质量闸门：旋转对称 IoU 上限（来自 gate.py 的 ROT_MAX = 0.7）。
pub const GATE_ROT_MAX: f32 = 0.7;

/// 质量闸门：较大连通域数量上限（来自 gate.py 的 COMPS_MAX = 2）。
pub const GATE_COMPS_MAX: u32 = 2;

/// 质量闸门：小斑点数量上限（来自 gate.py 的 SPECKS_MAX = 1）。
pub const GATE_SPECKS_MAX: u32 = 1;

/// 质量闸门：符号最大边相对比例下限（来自 gate.py 的 SIZE_MIN = 0.5）。
pub const GATE_SIZE_MIN: f32 = 0.5;

/// 质量闸门：质心偏离比例上限（来自 gate.py 的 OFF_MAX = 0.12）。
pub const GATE_OFF_MAX: f32 = 0.12;

/// vtracer 斑点过滤参数（来自 symbol.py P_BIN 的 filter_speckle = 8）。
pub const VTRACER_FILTER_SPECKLE: usize = 8;

/// vtracer 拐角阈值度数（来自 symbol.py P_BIN 的 corner_threshold = 80）。
pub const VTRACER_CORNER_THRESHOLD: i32 = 80;

/// vtracer 分段长度阈值像素（来自 symbol.py P_BIN 的 length_threshold = 6.0）。
pub const VTRACER_LENGTH_THRESHOLD: f64 = 6.0;

/// vtracer 拼接阈值度数（来自 symbol.py P_BIN 的 splice_threshold = 45）。
pub const VTRACER_SPLICE_THRESHOLD: i32 = 45;

/// vtracer 坐标精度小数位数（来自 symbol.py P_BIN 的 path_precision = 2）。
pub const VTRACER_PATH_PRECISION: u32 = 2;

/// PIL 灰度转换 R 通道系数（来自 PIL/Image.c）。
const PIL_GRAY_R: u32 = 19595;

/// PIL 灰度转换 G 通道系数（来自 PIL/Image.c）。
const PIL_GRAY_G: u32 = 38470;

/// PIL 灰度转换 B 通道系数（来自 PIL/Image.c）。
const PIL_GRAY_B: u32 = 7471;

/// PIL 灰度转换四舍五入偏移量（0x8000 即 32768）。
const PIL_GRAY_ROUND: u32 = 0x8000;

/// PIL 灰度转换右移位数。
const PIL_GRAY_SHIFT: u32 = 16;

/// 二值化掩码缩放到画布的明暗分界阈值。
const RESIZE_BINARY_THRESHOLD: u8 = 127;

/// RGB 图像每个像素包含的通道字节数。
const RGB_CHANNELS: usize = 3;

/// vtracer 黑白二值化阈值（RGBA 里 R 通道不高于它视为前景）。
const VTRACER_BINARY_THRESHOLD: u8 = 128;

/// RGBA 图像每个像素包含的通道字节数。
const RGBA_CHANNELS: usize = 4;

/// 黑色十六进制颜色代码。
const COLOR_BLACK_HEX: &str = "#000000";

/// 单个 4-连通分量的统计信息。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectedComponent {
    /// 连通分量面积（包含的像素个数）
    pub area: usize,
    /// 最小 y 坐标（包含）
    pub min_y: usize,
    /// 最大 y 坐标（包含）
    pub max_y: usize,
    /// 最小 x 坐标（包含）
    pub min_x: usize,
    /// 最大 x 坐标（包含）
    pub max_x: usize,
}

impl ConnectedComponent {
    /// 外接框高度。
    #[inline]
    pub fn height(&self) -> usize {
        self.max_y - self.min_y + 1
    }

    /// 外接框宽度。
    #[inline]
    pub fn width(&self) -> usize {
        self.max_x - self.min_x + 1
    }
}

/// 4-连通标记与分量统计。
///
/// # 参数
/// - `mask`：二值图掩码，长度必须等于 `width * height`
/// - `width`：图宽
/// - `height`：图高
///
/// # 返回值
/// 返回 `(labels, components)`：
/// - `labels`：长度为 `width * height` 的 `Vec<u32>`，0 表示背景，`1..=components.len()` 表示连通块 ID
/// - `components`：所有连通分量列表，下标 `i` 对应标签 `i + 1`
///
/// # 示例
/// ```ignore
/// let m = [true, false, true, true];
/// let (labels, comps) = label_components(&m, 2, 2);
/// assert_eq!(comps.len(), 2);
/// ```
pub fn label_components(
    mask: &[bool],
    width: usize,
    height: usize,
) -> (Vec<u32>, Vec<ConnectedComponent>) {
    let total = width * height;
    if mask.len() != total || total == 0 {
        return (Vec::new(), Vec::new());
    }

    let mut labels = vec![0u32; total];
    let mut components = Vec::new();
    let mut queue = Vec::new();

    for y in 0..height {
        for x in 0..width {
            let idx = y * width + x;
            if !mask[idx] || labels[idx] != 0 {
                continue;
            }

            let comp_id = (components.len() + 1) as u32;
            labels[idx] = comp_id;
            queue.push((x, y));

            let mut q_head = 0;
            let mut area = 0;
            let mut min_x = x;
            let mut max_x = x;
            let mut min_y = y;
            let mut max_y = y;

            while q_head < queue.len() {
                let (cx, cy) = queue[q_head];
                q_head += 1;
                area += 1;

                if cx < min_x {
                    min_x = cx;
                }
                if cx > max_x {
                    max_x = cx;
                }
                if cy < min_y {
                    min_y = cy;
                }
                if cy > max_y {
                    max_y = cy;
                }

                if cx > 0 {
                    let n_idx = cy * width + (cx - 1);
                    if mask[n_idx] && labels[n_idx] == 0 {
                        labels[n_idx] = comp_id;
                        queue.push((cx - 1, cy));
                    }
                }
                if cx + 1 < width {
                    let n_idx = cy * width + (cx + 1);
                    if mask[n_idx] && labels[n_idx] == 0 {
                        labels[n_idx] = comp_id;
                        queue.push((cx + 1, cy));
                    }
                }
                if cy > 0 {
                    let n_idx = (cy - 1) * width + cx;
                    if mask[n_idx] && labels[n_idx] == 0 {
                        labels[n_idx] = comp_id;
                        queue.push((cx, cy - 1));
                    }
                }
                if cy + 1 < height {
                    let n_idx = (cy + 1) * width + cx;
                    if mask[n_idx] && labels[n_idx] == 0 {
                        labels[n_idx] = comp_id;
                        queue.push((cx, cy + 1));
                    }
                }
            }

            queue.clear();
            components.push(ConnectedComponent {
                area,
                min_y,
                max_y,
                min_x,
                max_x,
            });
        }
    }

    (labels, components)
}

/// 计算 RGB 像素图的 PIL 同款灰度值：`(R*19595 + G*38470 + B*7471 + 0x8000) >> 16`。
///
/// # 参数
/// - `rgb`：行优先的连续 RGB 字节切片，长度必须为 3 的倍数
///
/// # 返回值
/// 单通道灰度像素数组，长度为 `rgb.len() / 3`
///
/// # 示例
/// ```ignore
/// let rgb = [255, 255, 255, 0, 0, 0];
/// let gray = rgb_to_gray(&rgb);
/// assert_eq!(gray, vec![255, 0]);
/// ```
pub fn rgb_to_gray(rgb: &[u8]) -> Vec<u8> {
    let mut gray = Vec::with_capacity(rgb.len() / RGB_CHANNELS);
    for px in rgb.chunks_exact(RGB_CHANNELS) {
        let r = px[0] as u32;
        let g = px[1] as u32;
        let b = px[2] as u32;
        let y = (r * PIL_GRAY_R + g * PIL_GRAY_G + b * PIL_GRAY_B + PIL_GRAY_ROUND)
            >> PIL_GRAY_SHIFT;
        gray.push(y.min(255) as u8);
    }
    gray
}

/// 计算单通道 uint8 图像的大津法阈值（完全复刻 skimage `threshold_otsu`）。
///
/// # 参数
/// - `gray`：灰度图像像素切片（值域 0..=255）
///
/// # 返回值
/// 计算得到的整型阈值（若图像灰度全同，则直接返回该灰度值；空图返回 0）
///
/// # 示例
/// ```ignore
/// let g = [10u8, 10, 200, 200];
/// let t = threshold_otsu(&g);
/// assert!(t >= 10 && t <= 200);
/// ```
pub fn threshold_otsu(gray: &[u8]) -> u8 {
    if gray.is_empty() {
        return 0;
    }
    let mut min_val = 255u8;
    let mut max_val = 0u8;
    let mut full_hist = [0u32; 256];
    for &g in gray {
        if g < min_val {
            min_val = g;
        }
        if g > max_val {
            max_val = g;
        }
        full_hist[g as usize] += 1;
    }
    if min_val == max_val {
        return min_val;
    }

    let min_u = min_val as usize;
    let max_u = max_val as usize;
    let n_bins = max_u - min_u + 1;
    let mut hist = Vec::with_capacity(n_bins);
    let mut centers = Vec::with_capacity(n_bins);
    for (g, &count) in full_hist.iter().enumerate().take(max_u + 1).skip(min_u) {
        hist.push(count as f64);
        centers.push(g as f64);
    }

    let mut weight1 = Vec::with_capacity(n_bins);
    let mut sum_w = 0.0;
    for &h in &hist {
        sum_w += h;
        weight1.push(sum_w);
    }

    let mut weight2 = vec![0.0; n_bins];
    let mut sum_w2 = 0.0;
    for i in (0..n_bins).rev() {
        sum_w2 += hist[i];
        weight2[i] = sum_w2;
    }

    let mut mean1 = Vec::with_capacity(n_bins);
    let mut sum_hc = 0.0;
    for i in 0..n_bins {
        sum_hc += hist[i] * centers[i];
        let w = weight1[i];
        mean1.push(if w > 0.0 { sum_hc / w } else { 0.0 });
    }

    let mut mean2 = vec![0.0; n_bins];
    let mut sum_hc2 = 0.0;
    for i in (0..n_bins).rev() {
        sum_hc2 += hist[i] * centers[i];
        let w = weight2[i];
        mean2[i] = if w > 0.0 { sum_hc2 / w } else { 0.0 };
    }

    let mut best_idx = 0;
    let mut max_var = -1.0;
    for k in 0..(n_bins - 1) {
        let diff = mean1[k] - mean2[k + 1];
        let var = weight1[k] * weight2[k + 1] * diff * diff;
        if var > max_var {
            max_var = var;
            best_idx = k;
        }
    }

    centers[best_idx].round() as u8
}

/// 图像二值化：灰度 -> 大津法 -> `g < t` 为暗 -> 四角偏暗时反相 -> 丢弃面积 < 0.08% 的连通块。
///
/// # 参数
/// - `gray`：单通道灰度切片，长度为 `width * height`
/// - `width`：图宽
/// - `height`：图高
///
/// # 返回值
/// 返回长度为 `width * height` 的布尔掩码（true 表示前景图形/暗部）
///
/// # 示例
/// ```ignore
/// let gray = vec![255u8; 512 * 512];
/// let mask = binarize(&gray, 512, 512);
/// assert_eq!(mask.len(), 512 * 512);
/// ```
pub fn binarize(gray: &[u8], width: usize, height: usize) -> Vec<bool> {
    let total = width * height;
    if gray.len() != total || total == 0 {
        return Vec::new();
    }

    let t = threshold_otsu(gray);
    let mut dark: Vec<bool> = gray.iter().map(|&g| g < t).collect();

    let c00 = gray[0];
    let c0w = gray[width - 1];
    let ch0 = gray[(height - 1) * width];
    let chw = gray[total - 1];
    let mut corners = [c00, c0w, ch0, chw];
    corners.sort_unstable();
    let median = (corners[1] as f64 + corners[2] as f64) / 2.0;

    if median < t as f64 {
        for v in &mut dark {
            *v = !*v;
        }
    }

    let (labels, comps) = label_components(&dark, width, height);
    if !comps.is_empty() {
        let min_area_threshold = BINARIZE_MIN_AREA * (width as f64) * (height as f64);
        let mut keep_label = vec![false; comps.len() + 1];
        for (i, comp) in comps.iter().enumerate() {
            if (comp.area as f64) >= min_area_threshold {
                keep_label[i + 1] = true;
            }
        }
        for (i, &lbl) in labels.iter().enumerate() {
            dark[i] = lbl > 0 && keep_label[lbl as usize];
        }
    }

    dark
}

/// 将布尔掩码转为灰度位图（true 为黑色 0，false 为白色 255）。
///
/// # 参数
/// - `mask`：二值图掩码切片
///
/// # 返回值
/// 单通道灰度数组，长度与 `mask` 相同
///
/// # 示例
/// ```ignore
/// let mask = [true, false];
/// assert_eq!(mask_to_gray(&mask), vec![0, 255]);
/// ```
pub fn mask_to_gray(mask: &[bool]) -> Vec<u8> {
    mask.iter().map(|&m| if m { 0 } else { 255 }).collect()
}

/// 检测二值图中的外圈。
///
/// # 参数
/// - `mask`：512x512 的二值掩码切片
///
/// # 返回值
/// 若检测到外圈，返回 `Some((cx, cy, r_out, r_in))`，否则返回 `None`
///
/// # 示例
/// ```ignore
/// let mask = vec![false; 512 * 512];
/// assert_eq!(find_ring(&mask), None);
/// ```
pub fn find_ring(mask: &[bool]) -> Option<(f32, f32, f32, f32)> {
    if mask.len() != SYMBOL_CANVAS * SYMBOL_CANVAS {
        return None;
    }

    let (_labels, comps) = label_components(mask, SYMBOL_CANVAS, SYMBOL_CANVAS);
    if comps.is_empty() {
        return None;
    }

    let mut best: Option<&ConnectedComponent> = None;
    for comp in &comps {
        let span = comp.width().max(comp.height());
        match best {
            None => best = Some(comp),
            Some(b) => {
                let best_span = b.width().max(b.height());
                if span > best_span {
                    best = Some(comp);
                }
            }
        }
    }
    let target = best?;
    let w = target.width() as f32;
    let h = target.height() as f32;

    let min_span = RING_MIN_SPAN * (SYMBOL_CANVAS as f32);
    if w < min_span || h < min_span {
        return None;
    }
    let aspect = w / h;
    if aspect <= RING_ASPECT_MIN || aspect >= RING_ASPECT_MAX {
        return None;
    }

    let cy = (target.min_y + target.max_y + 1) as f32 / 2.0;
    let cx = (target.min_x + target.max_x + 1) as f32 / 2.0;
    let r_out = (w + h) / 4.0;

    let r_start = (r_out * 0.3) as i32;
    let r_end = (r_out as i32) + 2;
    if r_end <= r_start {
        return None;
    }
    let rs_len = (r_end - r_start) as usize;

    let mut total_counts = vec![0u32; rs_len];
    let mut true_counts = vec![0u32; rs_len];

    for y in 0..SYMBOL_CANVAS {
        let dy = y as f32 - cy;
        let dy2 = dy * dy;
        let row_offset = y * SYMBOL_CANVAS;
        for x in 0..SYMBOL_CANVAS {
            let dx = x as f32 - cx;
            let d = (dx * dx + dy2).sqrt();
            let r_floor = d.floor() as i32;
            let is_fg = mask[row_offset + x];

            for r in [r_floor - 1, r_floor] {
                if (r as f32) <= d && d < (r + 2) as f32 && r >= r_start && r < r_end {
                    let k = (r - r_start) as usize;
                    total_counts[k] += 1;
                    if is_fg {
                        true_counts[k] += 1;
                    }
                }
            }
        }
    }

    let mut frac = vec![0.0f32; rs_len];
    for k in 0..rs_len {
        if total_counts[k] > 0 {
            frac[k] = true_counts[k] as f32 / total_counts[k] as f32;
        }
    }

    let mut i = rs_len - 1;
    while i > 0 && frac[i] < RING_BAND_ON {
        i -= 1;
    }
    if frac[i] < RING_BAND_ON {
        return None;
    }

    let mut j = i;
    while j > 0 && frac[j] > RING_BAND_OFF {
        j -= 1;
    }
    let r_in = (r_start + j as i32) as f32;
    if frac[j] > RING_BAND_OFF {
        return None;
    }

    let r_band_out = (r_start + i as i32) as f32;
    let t = (r_band_out - r_in) / r_out;
    if !(t > RING_THICK_MIN && t < RING_THICK_MAX) {
        return None;
    }

    Some((cx, cy, r_band_out, r_in))
}

/// 符号提取：从 512x512 RGB 位图中提取符号二值掩码，并可选剔除外圈。
///
/// # 参数
/// - `rgb512`：512x512 RGB8 像素切片（长度必须等于 `512 * 512 * 3`）
/// - `remove_ring`：是否检测并剔除外圈
///
/// # 返回值
/// 成功时返回 `(mask, ring_detected, r_in)`：
/// - `mask`：长度为 512*512 的布尔掩码
/// - `ring_detected`：是否检测到了外圈
/// - `r_in`：检测到的外圈内半径（若未检测到则为 None）
///
/// # 错误
/// 若图像尺寸非 512x512，返回 [`AiError::InvalidImage`]。
///
/// # 示例
/// ```ignore
/// let rgb = vec![255u8; 512 * 512 * 3];
/// let (mask, ring_detected, r_in) = extract_symbol(&rgb, true).unwrap();
/// assert_eq!(mask.len(), 512 * 512);
/// ```
pub fn extract_symbol(
    rgb512: &[u8],
    remove_ring: bool,
) -> Result<(Vec<bool>, bool, Option<f32>)> {
    let expected_len = SYMBOL_CANVAS * SYMBOL_CANVAS * RGB_CHANNELS;
    if rgb512.len() != expected_len {
        return Err(AiError::InvalidImage(format!(
            "输入图像字节长度为 {}，必须为 512x512 RGB 格式（{} 字节）",
            rgb512.len(),
            expected_len
        )));
    }

    let gray = rgb_to_gray(rgb512);
    let mut m = binarize(&gray, SYMBOL_CANVAS, SYMBOL_CANVAS);

    let ring = if remove_ring { find_ring(&m) } else { None };
    if let Some((cx, cy, _ro, ri)) = ring {
        let max_r = ri - RING_CUT_MARGIN;
        for y in 0..SYMBOL_CANVAS {
            let dy = y as f32 - cy;
            let dy2 = dy * dy;
            let row_offset = y * SYMBOL_CANVAS;
            for x in 0..SYMBOL_CANVAS {
                let dx = x as f32 - cx;
                let d = (dx * dx + dy2).sqrt();
                if d >= max_r {
                    m[row_offset + x] = false;
                }
            }
        }

        let (labels, comps) = label_components(&m, SYMBOL_CANVAS, SYMBOL_CANVAS);
        if !comps.is_empty() {
            let mut keep_label = vec![false; comps.len() + 1];
            for (i, c) in comps.iter().enumerate() {
                if c.area >= RING_RESIDUAL_MIN_AREA {
                    keep_label[i + 1] = true;
                }
            }
            for (i, &lbl) in labels.iter().enumerate() {
                m[i] = lbl > 0 && keep_label[lbl as usize];
            }
        }
        Ok((m, true, Some(ri)))
    } else {
        Ok((m, false, None))
    }
}

/// 符号图像的几何与启发式质量特征。
#[derive(Debug, Clone, PartialEq)]
pub struct SymbolFeatures {
    /// 墨量占画布比例（前景像素数 / 512^2）
    pub ink_canvas: f32,
    /// 旋转对称性最小 IoU（在 29/61/103 度旋转下的最小重合度）
    pub rot_iou: f32,
    /// 较大连通域个数（面积 >= 0.0005 * 512^2 = 131.072 像素）
    pub comps: u32,
    /// 小斑点个数（20 <= 面积 < 0.0005 * 512^2）
    pub specks: u32,
    /// 符号最大边相对于参考基准（2 * r_in 或 512）的比例
    pub size_rel: f32,
    /// 符号质心偏离画布中心的比例（距离 / 512）
    pub off: f32,
    /// 符号外接框内的填充率（墨量 / (bh * bw)）
    pub fill_bbox: f32,
    /// 是否为空图（墨量 < 50）
    pub empty: bool,
}

/// 提取符号掩码的质量特征。
///
/// # 参数
/// - `mask`：512x512 符号布尔掩码切片
/// - `r_in`：检测到的外圈内半径（若未检测到则传 None）
///
/// # 返回值
/// 计算得到的 [`SymbolFeatures`] 结构体
///
/// # 示例
/// ```ignore
/// let mask = vec![false; 512 * 512];
/// let feat = features(&mask, None);
/// assert!(feat.empty);
/// ```
pub fn features(mask: &[bool], r_in: Option<f32>) -> SymbolFeatures {
    let canvas_f = SYMBOL_CANVAS as f32;
    let canvas_total_f = (SYMBOL_CANVAS * SYMBOL_CANVAS) as f32;
    let ink = mask.iter().filter(|&&v| v).count();
    let ink_f = ink as f32;
    let ink_canvas = ink_f / canvas_total_f;

    if ink < FEATURE_EMPTY_INK_THRESHOLD {
        return SymbolFeatures {
            ink_canvas,
            rot_iou: 1.0,
            comps: 0,
            specks: 0,
            size_rel: 0.0,
            off: 1.0,
            fill_bbox: 0.0,
            empty: true,
        };
    }

    let mut min_x = SYMBOL_CANVAS;
    let mut max_x = 0;
    let mut min_y = SYMBOL_CANVAS;
    let mut max_y = 0;
    let mut sum_x = 0.0f32;
    let mut sum_y = 0.0f32;

    for y in 0..SYMBOL_CANVAS {
        let row_offset = y * SYMBOL_CANVAS;
        for x in 0..SYMBOL_CANVAS {
            if mask[row_offset + x] {
                if x < min_x {
                    min_x = x;
                }
                if x > max_x {
                    max_x = x;
                }
                if y < min_y {
                    min_y = y;
                }
                if y > max_y {
                    max_y = y;
                }
                sum_x += x as f32;
                sum_y += y as f32;
            }
        }
    }

    let bh = (max_y - min_y + 1) as f32;
    let bw = (max_x - min_x + 1) as f32;
    let cx = sum_x / ink_f;
    let cy = sum_y / ink_f;

    let center = canvas_f / 2.0;
    let shift_y = center - cy;
    let shift_x = center - cx;

    let mut base = vec![false; SYMBOL_CANVAS * SYMBOL_CANVAS];
    for y in 0..SYMBOL_CANVAS {
        let orig_y = (y as f32 - shift_y).round() as i32;
        if orig_y < 0 || orig_y >= SYMBOL_CANVAS as i32 {
            continue;
        }
        let src_row = orig_y as usize * SYMBOL_CANVAS;
        let dst_row = y * SYMBOL_CANVAS;
        for x in 0..SYMBOL_CANVAS {
            let orig_x = (x as f32 - shift_x).round() as i32;
            if orig_x >= 0 && orig_x < SYMBOL_CANVAS as i32 {
                base[dst_row + x] = mask[src_row + orig_x as usize];
            }
        }
    }

    let mut min_iou = 1.0f32;
    for &angle_deg in &ROT_ANGLES {
        let rad = angle_deg * std::f32::consts::PI / 180.0;
        let cos_a = rad.cos();
        let sin_a = rad.sin();

        let mut intersection = 0u32;
        let mut union_count = 0u32;

        for y in 0..SYMBOL_CANVAS {
            let dy = y as f32 - center;
            let dst_row = y * SYMBOL_CANVAS;
            for x in 0..SYMBOL_CANVAS {
                let dx = x as f32 - center;
                let src_x = (center + dx * cos_a + dy * sin_a).round() as i32;
                let src_y = (center - dx * sin_a + dy * cos_a).round() as i32;

                let r_val = if src_x >= 0
                    && src_x < SYMBOL_CANVAS as i32
                    && src_y >= 0
                    && src_y < SYMBOL_CANVAS as i32
                {
                    base[src_y as usize * SYMBOL_CANVAS + src_x as usize]
                } else {
                    false
                };

                let b_val = base[dst_row + x];
                if b_val && r_val {
                    intersection += 1;
                }
                if b_val || r_val {
                    union_count += 1;
                }
            }
        }

        let iou = if union_count == 0 {
            1.0
        } else {
            intersection as f32 / union_count as f32
        };
        if iou < min_iou {
            min_iou = iou;
        }
    }

    let (_labels, comps) = label_components(mask, SYMBOL_CANVAS, SYMBOL_CANVAS);
    let big_limit = FEATURE_BIG_AREA_RATIO * canvas_total_f;
    let mut comps_count = 0u32;
    let mut specks_count = 0u32;
    for comp in &comps {
        let a = comp.area as f32;
        if a >= big_limit {
            comps_count += 1;
        } else if a >= FEATURE_SPECK_AREA_MIN as f32 {
            specks_count += 1;
        }
    }

    let ref_size = if let Some(ri) = r_in {
        2.0 * ri
    } else {
        canvas_f
    };
    let size_rel = bh.max(bw) / ref_size;
    let off_dist = ((cx - center).powi(2) + (cy - center).powi(2)).sqrt();
    let off = off_dist / canvas_f;
    let fill_bbox = ink_f / (bh * bw);

    SymbolFeatures {
        ink_canvas,
        rot_iou: min_iou,
        comps: comps_count,
        specks: specks_count,
        size_rel,
        off,
        fill_bbox,
        empty: false,
    }
}

/// 质量闸门拦截原因枚举。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GateReason {
    /// 空图（墨量过低）
    Empty,
    /// 墨量过低（太淡）
    InkLow,
    /// 墨量过高（整块黑）
    InkHigh,
    /// 旋转对称度过高（靶心圆/同心圆）
    Concentric,
    /// 较大连通域过多（碎片化）
    Fragments,
    /// 小斑点过多
    Specks,
    /// 尺寸过小
    Small,
    /// 质心偏离中心过远
    OffCenter,
}

impl GateReason {
    /// 对应的字符串代码（与 Python gate.py 完全一致）。
    pub const fn code(self) -> &'static str {
        match self {
            GateReason::Empty => "empty",
            GateReason::InkLow => "ink_low",
            GateReason::InkHigh => "ink_high",
            GateReason::Concentric => "concentric",
            GateReason::Fragments => "fragments",
            GateReason::Specks => "specks",
            GateReason::Small => "small",
            GateReason::OffCenter => "off_center",
        }
    }
}

/// 质量闸门检验结果。
#[derive(Debug, Clone, PartialEq)]
pub struct GateResult {
    /// 是否通过全部质量检验规则
    pub ok: bool,
    /// 未通过的原因列表（通过时为空）
    pub reasons: Vec<GateReason>,
}

/// 质量闸门检验函数（对照 gate.py 的 7 条启发式规则）。
///
/// # 参数
/// - `f`：[`SymbolFeatures`] 结构体引用
///
/// # 返回值
/// 返回检验结果 [`GateResult`]
///
/// # 示例
/// ```ignore
/// let f = SymbolFeatures {
///     ink_canvas: 0.1, rot_iou: 0.5, comps: 1, specks: 0,
///     size_rel: 0.8, off: 0.05, fill_bbox: 0.5, empty: false,
/// };
/// let res = gate(&f);
/// assert!(res.ok);
/// ```
pub fn gate(f: &SymbolFeatures) -> GateResult {
    if f.empty {
        return GateResult {
            ok: false,
            reasons: vec![GateReason::Empty],
        };
    }

    let mut reasons = Vec::new();
    if f.ink_canvas < GATE_INK_MIN {
        reasons.push(GateReason::InkLow);
    }
    if f.ink_canvas > GATE_INK_MAX {
        reasons.push(GateReason::InkHigh);
    }
    if f.rot_iou > GATE_ROT_MAX {
        reasons.push(GateReason::Concentric);
    }
    if f.comps > GATE_COMPS_MAX {
        reasons.push(GateReason::Fragments);
    }
    if f.specks > GATE_SPECKS_MAX {
        reasons.push(GateReason::Specks);
    }
    if f.size_rel < GATE_SIZE_MIN {
        reasons.push(GateReason::Small);
    }
    if f.off > GATE_OFF_MAX {
        reasons.push(GateReason::OffCenter);
    }

    GateResult {
        ok: reasons.is_empty(),
        reasons,
    }
}

/// 符号矢量描摹结果。
#[derive(Debug, Clone, PartialEq)]
pub struct SymbolSvg {
    /// 包含的所有 `<path .../>` 片段字符串拼接（填充色确保为 `#000000`）
    pub paths: String,
    /// 路径元素个数
    pub path_count: usize,
}

/// 生成完整的 SVG 文档（viewBox="0 0 512 512"）。
///
/// # 参数
/// - `paths`：拼接的 `<path .../>` 片段字符串
///
/// # 返回值
/// 完整的 SVG 文档字符串
///
/// # 示例
/// ```ignore
/// let doc = symbol_document(r#"<path d="M0 0" fill="#000000"/>"#);
/// assert!(doc.starts_with("<svg"));
/// ```
pub fn symbol_document(paths: &str) -> String {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\">\n{}\n</svg>",
        paths
    )
}

/// 将 512x512 符号掩码裁剪、缩放到 480 居中贴图，并用 vtracer 进行矢量描摹。
///
/// # 参数
/// - `mask`：512x512 符号二值掩码切片
/// - `cancel`：取消令牌引用
///
/// # 返回值
/// 成功返回包含 paths 片段与路径数的 [`SymbolSvg`]
///
/// # 错误
/// 若取消令牌触发返回 [`AiError::Cancelled`]；若掩码为空返回 [`AiError::InvalidImage`]。
///
/// # 示例
/// ```ignore
/// let cancel = CancelToken::new();
/// let mask = vec![true; 512 * 512];
/// let svg = symbol_svg(&mask, &cancel).unwrap();
/// assert!(svg.path_count >= 1);
/// ```
pub fn symbol_svg(mask: &[bool], cancel: &CancelToken) -> Result<SymbolSvg> {
    cancel.check()?;

    if mask.len() != SYMBOL_CANVAS * SYMBOL_CANVAS {
        return Err(AiError::InvalidImage(format!(
            "掩码长度 {} 与 512x512 不符",
            mask.len()
        )));
    }

    let mut min_x = SYMBOL_CANVAS;
    let mut max_x = 0;
    let mut min_y = SYMBOL_CANVAS;
    let mut max_y = 0;
    let mut has_pixel = false;

    for y in 0..SYMBOL_CANVAS {
        let row_offset = y * SYMBOL_CANVAS;
        for x in 0..SYMBOL_CANVAS {
            if mask[row_offset + x] {
                has_pixel = true;
                if x < min_x {
                    min_x = x;
                }
                if x > max_x {
                    max_x = x;
                }
                if y < min_y {
                    min_y = y;
                }
                if y > max_y {
                    max_y = y;
                }
            }
        }
    }

    if !has_pixel {
        return Err(AiError::InvalidImage("掩码为空，无法描摹".into()));
    }

    let crop_w = (max_x - min_x + 1) as u32;
    let crop_h = (max_y - min_y + 1) as u32;
    let max_side = crop_w.max(crop_h);
    let scale = SYM_SIDE as f32 / max_side as f32;
    let target_w = (crop_w as f32 * scale).round().max(1.0) as u32;
    let target_h = (crop_h as f32 * scale).round().max(1.0) as u32;

    let mut crop_rgb = Vec::with_capacity((crop_w * crop_h) as usize * RGB_CHANNELS);
    for y in min_y..=max_y {
        let row_offset = y * SYMBOL_CANVAS;
        for x in min_x..=max_x {
            let val = if mask[row_offset + x] { 255u8 } else { 0u8 };
            crop_rgb.extend_from_slice(&[val; RGB_CHANNELS]);
        }
    }

    let crop_raw = RawImage::new(crop_w, crop_h, PixelFormat::Rgb, crop_rgb)?;
    let resized_rgb = resize_rgb(&crop_raw, target_w, target_h)?;

    let offset_x = (SYMBOL_CANVAS as i32 - target_w as i32) / 2;
    let offset_y = (SYMBOL_CANVAS as i32 - target_h as i32) / 2;

    let mut canvas_fg = vec![false; SYMBOL_CANVAS * SYMBOL_CANVAS];
    for y in 0..target_h {
        let cy = offset_y + y as i32;
        if cy < 0 || cy >= SYMBOL_CANVAS as i32 {
            continue;
        }
        let dst_row = cy as usize * SYMBOL_CANVAS;
        let src_row = (y * target_w) as usize * RGB_CHANNELS;
        for x in 0..target_w {
            let cx = offset_x + x as i32;
            if cx < 0 || cx >= SYMBOL_CANVAS as i32 {
                continue;
            }
            let r_val = resized_rgb[src_row + x as usize * RGB_CHANNELS];
            if r_val > RESIZE_BINARY_THRESHOLD {
                canvas_fg[dst_row + cx as usize] = true;
            }
        }
    }

    let mut rgba_pixels = vec![255u8; SYMBOL_CANVAS * SYMBOL_CANVAS * RGBA_CHANNELS];
    for (i, &fg) in canvas_fg.iter().enumerate() {
        if fg {
            let idx = i * RGBA_CHANNELS;
            rgba_pixels[idx] = 0;
            rgba_pixels[idx + 1] = 0;
            rgba_pixels[idx + 2] = 0;
        }
    }

    cancel.check()?;

    let color_image = vtracer::ColorImage {
        pixels: rgba_pixels,
        width: SYMBOL_CANVAS,
        height: SYMBOL_CANVAS,
    };

    let mut config = vtracer::Config::from_preset(vtracer::Preset::Bw);
    config.mode = vtracer::FitMode::Spline;
    config.filter_speckle = VTRACER_FILTER_SPECKLE;
    config.corner_threshold = VTRACER_CORNER_THRESHOLD;
    config.length_threshold = VTRACER_LENGTH_THRESHOLD;
    config.splice_threshold = VTRACER_SPLICE_THRESHOLD;
    config.path_precision = Some(VTRACER_PATH_PRECISION);
    config.binary_threshold = VTRACER_BINARY_THRESHOLD;

    let pipeline = config
        .build()
        .map_err(|e| AiError::Backend(format!("vtracer 构建失败: {e:?}")))?;

    let vt_cancel = vtracer::CancelToken::new();
    if cancel.is_cancelled() {
        vt_cancel.cancel();
    }

    let doc = pipeline
        .run_with_progress(&color_image, &vt_cancel, &mut |_| {
            if cancel.is_cancelled() {
                vt_cancel.cancel();
            }
        })
        .map_err(|e| match e {
            vtracer::Error::Cancelled => AiError::Cancelled,
            other => AiError::Backend(format!("vtracer 运行失败: {other:?}")),
        })?;

    cancel.check()?;

    let raw_svg = pipeline.writer.write(&doc);

    let mut paths = String::new();
    let mut path_count = 0;
    let mut search_idx = 0;

    while let Some(pos) = raw_svg[search_idx..].find("<path") {
        let abs_start = search_idx + pos;
        if let Some(end_rel) = raw_svg[abs_start..].find("/>") {
            let abs_end = abs_start + end_rel + 2;
            let mut element = raw_svg[abs_start..abs_end].to_string();

            if element.contains("fill=") {
                if !element.contains(COLOR_BLACK_HEX) {
                    if let Some(f_idx) = element.find("fill=\"") {
                        let after = f_idx + 6;
                        if let Some(q_idx) = element[after..].find('"') {
                            let old_fill = &element[f_idx..after + q_idx + 1];
                            element = element.replace(old_fill, &format!("fill=\"{COLOR_BLACK_HEX}\""));
                        }
                    }
                }
            } else {
                element.insert_str(element.len() - 2, &format!(" fill=\"{COLOR_BLACK_HEX}\""));
            }

            paths.push_str(&element);
            path_count += 1;
            search_idx = abs_end;
        } else {
            break;
        }
    }

    Ok(SymbolSvg { paths, path_count })
}

/// 耗时统计。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PostTimings {
    /// 符号提取耗时（毫秒）
    pub extract_ms: u64,
    /// 特征提取耗时（毫秒）
    pub features_ms: u64,
    /// 质量闸门检验耗时（毫秒）
    pub gate_ms: u64,
    /// 矢量描摹耗时（毫秒）
    pub trace_ms: u64,
}

/// 符号处理全流程结果。
#[derive(Debug, Clone, PartialEq)]
pub struct SymbolOutcome {
    /// 最终提取的 512x512 布尔掩码
    pub mask: Vec<bool>,
    /// 是否检测到外圈
    pub ring_detected: bool,
    /// 启发式质量特征
    pub features: SymbolFeatures,
    /// 质量闸门检验结果
    pub gate: GateResult,
    /// 描摹后的矢量 SVG（若 features.empty 为 false 则生成，否则为 None）
    pub svg: Option<SymbolSvg>,
    /// 各步骤耗时
    pub timings: PostTimings,
}

/// 符号后处理完整流程：extract_symbol -> features -> gate -> symbol_svg。
///
/// # 参数
/// - `rgb512`：512x512 RGB8 格式像素切片
/// - `remove_ring`：是否剔除模型自画外圈
/// - `cancel`：取消令牌引用
///
/// # 返回值
/// 成功返回 [`SymbolOutcome`]
///
/// # 错误
/// 取消返回 [`AiError::Cancelled`]，输入图像格式不符返回 [`AiError::InvalidImage`]。
///
/// # 示例
/// ```ignore
/// let cancel = CancelToken::new();
/// let rgb = vec![255u8; 512 * 512 * 3];
/// let res = process_symbol(&rgb, true, &cancel).unwrap();
/// assert_eq!(res.mask.len(), 512 * 512);
/// ```
pub fn process_symbol(
    rgb512: &[u8],
    remove_ring: bool,
    cancel: &CancelToken,
) -> Result<SymbolOutcome> {
    cancel.check()?;

    let t0 = Instant::now();
    let (mask, ring_detected, r_in) = extract_symbol(rgb512, remove_ring)?;
    let extract_ms = t0.elapsed().as_millis() as u64;

    cancel.check()?;

    let t1 = Instant::now();
    let feat = features(&mask, r_in);
    let features_ms = t1.elapsed().as_millis() as u64;

    cancel.check()?;

    let t2 = Instant::now();
    let gate_res = gate(&feat);
    let gate_ms = t2.elapsed().as_millis() as u64;

    cancel.check()?;

    let (svg, trace_ms) = if !feat.empty {
        let t3 = Instant::now();
        let s = symbol_svg(&mask, cancel)?;
        let ms = t3.elapsed().as_millis() as u64;
        (Some(s), ms)
    } else {
        (None, 0)
    };

    Ok(SymbolOutcome {
        mask,
        ring_detected,
        features: feat,
        gate: gate_res,
        svg,
        timings: PostTimings {
            extract_ms,
            features_ms,
            gate_ms,
            trace_ms,
        },
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 灰度转换公式与极限值() {
        let black = [0u8, 0, 0];
        assert_eq!(rgb_to_gray(&black), vec![0]);

        let white = [255u8, 255, 255];
        assert_eq!(rgb_to_gray(&white), vec![255]);

        let red = [255u8, 0, 0];
        let red_gray = ((255u32 * PIL_GRAY_R + PIL_GRAY_ROUND) >> PIL_GRAY_SHIFT) as u8;
        assert_eq!(rgb_to_gray(&red), vec![red_gray]);
    }

    #[test]
    fn 大津法阈值与单值处理() {
        assert_eq!(threshold_otsu(&[]), 0);

        let flat = [128u8; 100];
        assert_eq!(threshold_otsu(&flat), 128);

        let mut bimodal = vec![10u8; 100];
        bimodal.extend(std::iter::repeat_n(200u8, 100));
        let t = threshold_otsu(&bimodal);
        assert!((10..=200).contains(&t));
    }

    #[test]
    fn 四连通分量标记与统计() {
        let (labels, comps) = label_components(&[], 0, 0);
        assert!(labels.is_empty() && comps.is_empty());

        let mask = [
            true, true, false,
            true, true, false,
            false, false, true,
        ];
        let (labels, comps) = label_components(&mask, 3, 3);
        assert_eq!(comps.len(), 2);
        assert_eq!(comps[0].area, 4);
        assert_eq!(comps[0].width(), 2);
        assert_eq!(comps[0].height(), 2);
        assert_eq!(comps[1].area, 1);
        assert_eq!(labels[0], 1);
        assert_eq!(labels[8], 2);
    }

    #[test]
    fn 掩码转灰度位图() {
        let m = [true, false, true];
        assert_eq!(mask_to_gray(&m), vec![0, 255, 0]);
    }

    #[test]
    fn 二值化与四角反相及小噪点过滤() {
        let w = 50;
        let h = 50;
        let mut gray = vec![240u8; w * h];
        for y in 20..30 {
            for x in 20..30 {
                gray[y * w + x] = 20;
            }
        }
        for y in 19..=30 {
            gray[y * w + 19] = 100;
            gray[y * w + 30] = 100;
        }
        for x in 19..=30 {
            gray[19 * w + x] = 100;
            gray[30 * w + x] = 100;
        }
        let mask = binarize(&gray, w, h);
        assert!(mask[25 * w + 25]);
        assert!(!mask[0]);

        let mut inv_gray = vec![30u8; w * h];
        for y in 15..35 {
            for x in 15..35 {
                inv_gray[y * w + x] = 200;
            }
        }
        inv_gray[0] = 10;
        inv_gray[w - 1] = 10;
        inv_gray[(h - 1) * w] = 10;
        inv_gray[w * h - 1] = 10;
        let inv_mask = binarize(&inv_gray, w, h);
        assert!(inv_mask[25 * w + 25]);
        assert!(!inv_mask[0]);

        let mut speck_gray = vec![240u8; 512 * 512];
        speck_gray[10 * 512 + 10] = 20;
        speck_gray[10 * 512 + 11] = 100;
        let speck_mask = binarize(&speck_gray, 512, 512);
        assert!(!speck_mask[10 * 512 + 10]);
    }

    #[test]
    fn 外圈检测与符号提取() {
        let mut gray = vec![240u8; SYMBOL_CANVAS * SYMBOL_CANVAS];
        let cx = 256.0f32;
        let cy = 256.0f32;
        for y in 0..SYMBOL_CANVAS {
            let dy = y as f32 - cy;
            for x in 0..SYMBOL_CANVAS {
                let dx = x as f32 - cx;
                let d = (dx * dx + dy * dy).sqrt();
                if (180.0..=205.0).contains(&d) {
                    gray[y * SYMBOL_CANVAS + x] = 20;
                } else if (178.0..180.0).contains(&d) || (d > 205.0 && d <= 207.0) {
                    gray[y * SYMBOL_CANVAS + x] = 100;
                }

                if dx.abs() <= 20.0 && dy.abs() <= 20.0 {
                    gray[y * SYMBOL_CANVAS + x] = 20;
                } else if dx.abs() <= 22.0 && dy.abs() <= 22.0 && gray[y * SYMBOL_CANVAS + x] == 240 {
                    gray[y * SYMBOL_CANVAS + x] = 100;
                }
            }
        }

        let mask = binarize(&gray, SYMBOL_CANVAS, SYMBOL_CANVAS);
        let ring = find_ring(&mask);
        assert!(ring.is_some());
        let (rcx, rcy, ro, ri) = ring.unwrap();
        assert!((rcx - cx).abs() < 5.0);
        assert!((rcy - cy).abs() < 5.0);
        assert!(ro > 195.0);
        assert!(ri < 190.0);

        let mut rgb = vec![0u8; SYMBOL_CANVAS * SYMBOL_CANVAS * 3];
        for (i, &g) in gray.iter().enumerate() {
            rgb[i * 3] = g;
            rgb[i * 3 + 1] = g;
            rgb[i * 3 + 2] = g;
        }

        let (extracted, detected, r_in_opt) = extract_symbol(&rgb, true).unwrap();
        assert!(detected);
        assert!(r_in_opt.is_some());
        assert!(extracted[256 * SYMBOL_CANVAS + 256]);
        assert!(!extracted[256 * SYMBOL_CANVAS + 256 + 195]);

        let bad_rgb = vec![0u8; 100];
        assert!(matches!(
            extract_symbol(&bad_rgb, true),
            Err(AiError::InvalidImage(_))
        ));
    }

    #[test]
    fn 特征计算对称与非对称区别() {
        let empty_mask = vec![false; SYMBOL_CANVAS * SYMBOL_CANVAS];
        let empty_f = features(&empty_mask, None);
        assert!(empty_f.empty);
        assert_eq!(empty_f.rot_iou, 1.0);

        let mut ring_mask = vec![false; SYMBOL_CANVAS * SYMBOL_CANVAS];
        for y in 0..SYMBOL_CANVAS {
            let dy = y as f32 - 256.0;
            for x in 0..SYMBOL_CANVAS {
                let dx = x as f32 - 256.0;
                let d = (dx * dx + dy * dy).sqrt();
                if (100.0..=120.0).contains(&d) {
                    ring_mask[y * SYMBOL_CANVAS + x] = true;
                }
            }
        }
        let ring_f = features(&ring_mask, None);
        assert!(!ring_f.empty);
        assert!(ring_f.rot_iou > 0.85);

        let mut asym_mask = vec![false; SYMBOL_CANVAS * SYMBOL_CANVAS];
        for y in 50..120 {
            for x in 300..450 {
                asym_mask[y * SYMBOL_CANVAS + x] = true;
            }
        }
        let asym_f = features(&asym_mask, None);
        assert!(!asym_f.empty);
        assert!(asym_f.rot_iou < 0.4);
        assert!(asym_f.off > 0.1);
    }

    #[test]
    fn 质量闸门七条规则上下边界() {
        let base = SymbolFeatures {
            ink_canvas: 0.1,
            rot_iou: 0.5,
            comps: 1,
            specks: 0,
            size_rel: 0.6,
            off: 0.05,
            fill_bbox: 0.5,
            empty: false,
        };
        assert!(gate(&base).ok);

        let mut f = base.clone();
        f.empty = true;
        assert_eq!(gate(&f).reasons, vec![GateReason::Empty]);

        let mut f = base.clone();
        f.ink_canvas = 0.0199;
        assert_eq!(gate(&f).reasons, vec![GateReason::InkLow]);
        f.ink_canvas = 0.02;
        assert!(gate(&f).ok);

        let mut f = base.clone();
        f.ink_canvas = 0.2001;
        assert_eq!(gate(&f).reasons, vec![GateReason::InkHigh]);
        f.ink_canvas = 0.2;
        assert!(gate(&f).ok);

        let mut f = base.clone();
        f.rot_iou = 0.7001;
        assert_eq!(gate(&f).reasons, vec![GateReason::Concentric]);
        f.rot_iou = 0.7;
        assert!(gate(&f).ok);

        let mut f = base.clone();
        f.comps = 3;
        assert_eq!(gate(&f).reasons, vec![GateReason::Fragments]);
        f.comps = 2;
        assert!(gate(&f).ok);

        let mut f = base.clone();
        f.specks = 2;
        assert_eq!(gate(&f).reasons, vec![GateReason::Specks]);
        f.specks = 1;
        assert!(gate(&f).ok);

        let mut f = base.clone();
        f.size_rel = 0.499;
        assert_eq!(gate(&f).reasons, vec![GateReason::Small]);
        f.size_rel = 0.5;
        assert!(gate(&f).ok);

        let mut f = base.clone();
        f.off = 0.1201;
        assert_eq!(gate(&f).reasons, vec![GateReason::OffCenter]);
        f.off = 0.12;
        assert!(gate(&f).ok);

        assert_eq!(GateReason::Empty.code(), "empty");
        assert_eq!(GateReason::InkLow.code(), "ink_low");
        assert_eq!(GateReason::InkHigh.code(), "ink_high");
        assert_eq!(GateReason::Concentric.code(), "concentric");
        assert_eq!(GateReason::Fragments.code(), "fragments");
        assert_eq!(GateReason::Specks.code(), "specks");
        assert_eq!(GateReason::Small.code(), "small");
        assert_eq!(GateReason::OffCenter.code(), "off_center");
    }

    #[test]
    fn 矢量描摹与文档包装及取消() {
        let mut mask = vec![false; SYMBOL_CANVAS * SYMBOL_CANVAS];
        for y in 156..356 {
            for x in 156..356 {
                mask[y * SYMBOL_CANVAS + x] = true;
            }
        }

        let cancel = CancelToken::new();
        let svg = symbol_svg(&mask, &cancel).unwrap();
        assert!(svg.path_count >= 1);
        assert!(svg.paths.contains("<path"));
        assert!(svg.paths.contains("fill=\"#000000\""));

        let doc = symbol_document(&svg.paths);
        assert!(doc.starts_with("<svg"));
        assert!(doc.ends_with("</svg>"));
        assert!(doc.contains("viewBox=\"0 0 512 512\""));
        assert!(doc.contains("fill=\"#000000\""));

        let cancelled_token = CancelToken::new();
        cancelled_token.cancel();
        let res = symbol_svg(&mask, &cancelled_token);
        assert_eq!(res, Err(AiError::Cancelled));
    }

    #[test]
    fn 符号全流程处理() {
        let cancel = CancelToken::new();
        let mut rgb = vec![240u8; SYMBOL_CANVAS * SYMBOL_CANVAS * 3];
        for y in 200..300 {
            for x in 200..300 {
                let idx = (y * SYMBOL_CANVAS + x) * 3;
                rgb[idx] = 20;
                rgb[idx + 1] = 20;
                rgb[idx + 2] = 20;
            }
        }
        for y in 198..=302 {
            for &x in &[198, 199, 301, 302] {
                let idx = (y * SYMBOL_CANVAS + x) * 3;
                rgb[idx] = 100;
                rgb[idx + 1] = 100;
                rgb[idx + 2] = 100;
            }
        }
        for x in 198..=302 {
            for &y in &[198, 199, 301, 302] {
                let idx = (y * SYMBOL_CANVAS + x) * 3;
                rgb[idx] = 100;
                rgb[idx + 1] = 100;
                rgb[idx + 2] = 100;
            }
        }

        let outcome = process_symbol(&rgb, false, &cancel).unwrap();
        assert_eq!(outcome.mask.len(), SYMBOL_CANVAS * SYMBOL_CANVAS);
        assert!(!outcome.features.empty);
        assert!(outcome.svg.is_some());
        let svg = outcome.svg.unwrap();
        assert!(svg.path_count >= 1);
    }
}
