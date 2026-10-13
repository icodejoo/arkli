//! DB 检测后处理：概率图 -> 二值化 -> 连通域 -> 最小外接矩形 -> unclip 扩张 -> 映射回原图。
//! 全部自写，不引 imageproc / clipper。
//!
//! unclip 说明：标准做法用 clipper 对多边形外扩距离 d = 面积 x 比例 / 周长。
//! 这里文本框已是矩形，等价于把宽、高各加 2d，不需要多边形库。

use crate::error::{AiError, Result};
use crate::image::Point;

/// 二值化阈值。
pub const DB_DEFAULT_THRESH: f32 = 0.3;
/// 框平均得分阈值，低于它的框丢掉。
pub const DB_DEFAULT_BOX_THRESH: f32 = 0.5;
/// unclip 扩张比例。
pub const DB_DEFAULT_UNCLIP_RATIO: f32 = 1.6;
/// 最小外接矩形短边下限（像素，检测图坐标）。
pub const DB_DEFAULT_MIN_SIZE: f32 = 3.0;
/// 候选连通域数量上限（只统计得分过线的），防止噪点图拖垮后续识别。
pub const DB_DEFAULT_MAX_CANDIDATES: usize = 1000;
/// 阅读顺序排序时，纵向相差小于它的框视为同一行（原图像素）。
pub const SAME_LINE_Y_TOLERANCE: f32 = 10.0;

/// DB 后处理参数。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DbConfig {
    /// 二值化阈值
    pub thresh: f32,
    /// 框得分阈值（连通域内概率均值）
    pub box_thresh: f32,
    /// unclip 比例
    pub unclip_ratio: f32,
    /// 最小外接矩形短边下限
    pub min_size: f32,
    /// 候选连通域上限（只统计得分达到 `box_thresh` 的）
    pub max_candidates: usize,
}

impl Default for DbConfig {
    fn default() -> Self {
        Self {
            thresh: DB_DEFAULT_THRESH,
            box_thresh: DB_DEFAULT_BOX_THRESH,
            unclip_ratio: DB_DEFAULT_UNCLIP_RATIO,
            min_size: DB_DEFAULT_MIN_SIZE,
            max_candidates: DB_DEFAULT_MAX_CANDIDATES,
        }
    }
}

/// 一个检测到的文本框。
#[derive(Debug, Clone, PartialEq)]
pub struct TextBox {
    /// 四个角，顺序：左上、右上、右下、左下
    pub quad: [Point; 4],
    /// 框得分（连通域内概率均值）
    pub score: f32,
}

/// 一个连通域的摘要：只保留边界像素，省内存。
struct Component {
    /// 边界像素坐标 (x, y)
    boundary: Vec<(u32, u32)>,
    /// 像素总数
    count: usize,
    /// 概率之和
    sum: f64,
}

/// 8 邻域连通域标记（迭代，不递归）。
///
/// 只有平均得分不低于 `min_score` 的连通域才进入结果并占 `limit` 名额，
/// 低分噪点不会挤掉后面扫描到的真实文字框。
fn find_components(
    mask: &[bool],
    prob: &[f32],
    w: usize,
    h: usize,
    limit: usize,
    min_score: f32,
) -> Vec<Component> {
    let mut visited = vec![false; w * h];
    let mut out = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..w * h {
        if !mask[start] || visited[start] {
            continue;
        }
        if out.len() >= limit {
            break;
        }
        let mut comp = Component {
            boundary: Vec::new(),
            count: 0,
            sum: 0.0,
        };
        visited[start] = true;
        stack.push(start);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            comp.count += 1;
            comp.sum += prob[i] as f64;
            let mut is_boundary = false;
            // 4 邻域判断边界
            let n4 = [(-1i64, 0i64), (1, 0), (0, -1), (0, 1)];
            for (dx, dy) in n4 {
                let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                if nx < 0
                    || ny < 0
                    || nx >= w as i64
                    || ny >= h as i64
                    || !mask[ny as usize * w + nx as usize]
                {
                    is_boundary = true;
                }
            }
            if is_boundary {
                comp.boundary.push((x as u32, y as u32));
            }
            // 8 邻域扩张
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                        continue;
                    }
                    let ni = ny as usize * w + nx as usize;
                    if mask[ni] && !visited[ni] {
                        visited[ni] = true;
                        stack.push(ni);
                    }
                }
            }
        }
        if (comp.sum / comp.count as f64) as f32 >= min_score {
            out.push(comp);
        }
    }
    out
}

/// 二维叉积 (b-a) x (c-a)。
fn cross(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

/// Andrew 单调链凸包，返回逆时针顶点（不重复首点）。
fn convex_hull(mut pts: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    pts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let mut hull: Vec<(f64, f64)> = Vec::with_capacity(pts.len() * 2);
    for &p in &pts {
        while hull.len() >= 2 && cross(hull[hull.len() - 2], hull[hull.len() - 1], p) <= 0.0 {
            hull.pop();
        }
        hull.push(p);
    }
    let lower = hull.len() + 1;
    for &p in pts.iter().rev().skip(1) {
        while hull.len() >= lower && cross(hull[hull.len() - 2], hull[hull.len() - 1], p) <= 0.0 {
            hull.pop();
        }
        hull.push(p);
    }
    hull.pop();
    hull
}

/// 旋转矩形：中心 + 两个单位轴 + 两个边长。
#[derive(Debug, Clone, Copy)]
struct MinRect {
    /// 中心
    c: (f64, f64),
    /// 第一个轴（单位向量）
    u: (f64, f64),
    /// 第二个轴（单位向量，与 u 垂直）
    v: (f64, f64),
    /// 沿 u 的边长
    w: f64,
    /// 沿 v 的边长
    h: f64,
}

impl MinRect {
    /// 短边长度。
    fn short_side(&self) -> f64 {
        self.w.min(self.h)
    }

    /// 四个角（未排序）。
    fn corners(&self) -> [(f64, f64); 4] {
        let (hw, hh) = (self.w / 2.0, self.h / 2.0);
        let at = |a: f64, b: f64| {
            (
                self.c.0 + self.u.0 * a + self.v.0 * b,
                self.c.1 + self.u.1 * a + self.v.1 * b,
            )
        };
        [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)]
    }
}

/// 旋转卡尺：沿凸包每条边的方向试一遍，取面积最小的外接矩形。
fn min_area_rect(hull: &[(f64, f64)]) -> Option<MinRect> {
    if hull.len() < 3 {
        return None;
    }
    let mut best: Option<(f64, MinRect)> = None;
    for i in 0..hull.len() {
        let (p, q) = (hull[i], hull[(i + 1) % hull.len()]);
        let (dx, dy) = (q.0 - p.0, q.1 - p.1);
        let len = (dx * dx + dy * dy).sqrt();
        if len == 0.0 {
            continue;
        }
        let u = (dx / len, dy / len);
        let v = (-u.1, u.0);
        let (mut u0, mut u1, mut v0, mut v1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        for &(x, y) in hull {
            let (a, b) = (x * u.0 + y * u.1, x * v.0 + y * v.1);
            u0 = u0.min(a);
            u1 = u1.max(a);
            v0 = v0.min(b);
            v1 = v1.max(b);
        }
        let (w, h) = (u1 - u0, v1 - v0);
        let area = w * h;
        if best.as_ref().is_none_or(|(a, _)| area < *a) {
            let (ca, cb) = ((u0 + u1) / 2.0, (v0 + v1) / 2.0);
            let c = (ca * u.0 + cb * v.0, ca * u.1 + cb * v.1);
            best = Some((area, MinRect { c, u, v, w, h }));
        }
    }
    best.map(|(_, r)| r)
}

/// unclip：d = 面积 x 比例 / 周长，宽高各加 2d。
fn unclip(r: MinRect, ratio: f64) -> MinRect {
    let d = r.w * r.h * ratio / (2.0 * (r.w + r.h));
    MinRect {
        w: r.w + 2.0 * d,
        h: r.h + 2.0 * d,
        ..r
    }
}

/// 把四个角排成 左上、右上、右下、左下。
fn order_quad(pts: [(f64, f64); 4]) -> [Point; 4] {
    let mut p = pts;
    p.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let (mut left, mut right) = ([p[0], p[1]], [p[2], p[3]]);
    left.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    right.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    let f = |q: (f64, f64)| (q.0 as f32, q.1 as f32);
    [f(left[0]), f(right[0]), f(right[1]), f(left[1])]
}

/// DB 后处理主入口：概率图 -> 文本框（坐标仍在检测图坐标系）。
///
/// - `prob`：概率图，行优先，长度必须等于 `w * h`
/// - `w` / `h`：概率图宽高
/// - `cfg`：阈值等参数
/// - 返回：文本框列表，未排序
///
/// ```
/// use arkli_ai::db::{db_boxes, DbConfig};
/// let (w, h) = (32, 16);
/// let mut prob = vec![0.0f32; w * h];
/// for y in 5..9 { for x in 4..28 { prob[y * w + x] = 0.9; } }
/// let boxes = db_boxes(&prob, w, h, &DbConfig::default()).unwrap();
/// assert_eq!(boxes.len(), 1);
/// ```
pub fn db_boxes(prob: &[f32], w: usize, h: usize, cfg: &DbConfig) -> Result<Vec<TextBox>> {
    if w == 0 || h == 0 || prob.len() != w * h {
        return Err(AiError::BadModelOutput(format!(
            "概率图长度 {} 与 {w}x{h} 不符",
            prob.len()
        )));
    }
    let mask: Vec<bool> = prob.iter().map(|&p| p > cfg.thresh).collect();
    let mut boxes = Vec::new();
    for comp in find_components(&mask, prob, w, h, cfg.max_candidates, cfg.box_thresh) {
        let score = (comp.sum / comp.count as f64) as f32;
        if score < cfg.box_thresh {
            continue;
        }
        // 用像素格的四个角算外接矩形，边界才不会少半个像素
        let mut pts = Vec::with_capacity(comp.boundary.len() * 4);
        for &(x, y) in &comp.boundary {
            let (x, y) = (x as f64, y as f64);
            pts.extend_from_slice(&[(x, y), (x + 1.0, y), (x, y + 1.0), (x + 1.0, y + 1.0)]);
        }
        let Some(rect) = min_area_rect(&convex_hull(pts)) else {
            continue;
        };
        if rect.short_side() < cfg.min_size as f64 {
            continue;
        }
        let grown = unclip(rect, cfg.unclip_ratio as f64);
        boxes.push(TextBox {
            quad: order_quad(grown.corners()),
            score,
        });
    }
    Ok(boxes)
}

/// 把检测图坐标系的框映射回原图坐标系，并夹在图内。
///
/// - `resized_w` / `resized_h`：检测输入的宽高
/// - `src_w` / `src_h`：原图宽高
pub fn map_to_source(
    boxes: &mut [TextBox],
    resized_w: u32,
    resized_h: u32,
    src_w: u32,
    src_h: u32,
) {
    let (sx, sy) = (
        src_w as f32 / resized_w as f32,
        src_h as f32 / resized_h as f32,
    );
    for b in boxes {
        for p in &mut b.quad {
            p.0 = (p.0 * sx).clamp(0.0, src_w as f32);
            p.1 = (p.1 * sy).clamp(0.0, src_h as f32);
        }
    }
}

/// 按阅读顺序排序：先按左上角 (y, x)，同一行（纵向差小于容差）内再按 x 修正。
pub fn sort_reading_order(boxes: &mut [TextBox]) {
    boxes.sort_by(|a, b| {
        let (pa, pb) = (a.quad[0], b.quad[0]);
        (pa.1, pa.0).partial_cmp(&(pb.1, pb.0)).unwrap()
    });
    for i in 0..boxes.len().saturating_sub(1) {
        for j in (0..=i).rev() {
            let (a, b) = (boxes[j].quad[0], boxes[j + 1].quad[0]);
            if (b.1 - a.1).abs() < SAME_LINE_Y_TOLERANCE && b.0 < a.0 {
                boxes.swap(j, j + 1);
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 在概率图里填一个矩形 [x0,x1) x [y0,y1)。
    fn fill(prob: &mut [f32], w: usize, x0: usize, x1: usize, y0: usize, y1: usize, v: f32) {
        for y in y0..y1 {
            for x in x0..x1 {
                prob[y * w + x] = v;
            }
        }
    }

    /// 取四边形的轴对齐包围盒 (xmin, ymin, xmax, ymax)。
    fn bbox(q: &[Point; 4]) -> (f32, f32, f32, f32) {
        let xs = q.iter().map(|p| p.0);
        let ys = q.iter().map(|p| p.1);
        (
            xs.clone().fold(f32::MAX, f32::min),
            ys.clone().fold(f32::MAX, f32::min),
            xs.fold(f32::MIN, f32::max),
            ys.fold(f32::MIN, f32::max),
        )
    }

    #[test]
    fn 两个矩形找出两个框并做unclip() {
        let (w, h) = (64, 64);
        let mut prob = vec![0.0f32; w * h];
        fill(&mut prob, w, 10, 40, 8, 16, 0.9); // 30x8
        fill(&mut prob, w, 10, 30, 40, 48, 0.8); // 20x8
        let mut boxes = db_boxes(&prob, w, h, &DbConfig::default()).unwrap();
        assert_eq!(boxes.len(), 2);
        sort_reading_order(&mut boxes);
        // A：d = 240*1.6/76 ≈ 5.05
        let (x0, y0, x1, y1) = bbox(&boxes[0].quad);
        assert!(
            (x0 - 4.95).abs() < 0.2 && (x1 - 45.05).abs() < 0.2,
            "{x0} {x1}"
        );
        assert!(
            (y0 - 2.95).abs() < 0.2 && (y1 - 21.05).abs() < 0.2,
            "{y0} {y1}"
        );
        assert!((boxes[0].score - 0.9).abs() < 1e-5);
        assert!((boxes[1].score - 0.8).abs() < 1e-5);
        // 顺序是 左上、右上、右下、左下
        let q = boxes[0].quad;
        assert!(q[0].0 < q[1].0 && q[0].1 < q[3].1 && q[2].0 > q[3].0);
    }

    #[test]
    fn 低分框与小框被丢弃() {
        let (w, h) = (64, 64);
        let mut prob = vec![0.0f32; w * h];
        fill(&mut prob, w, 10, 40, 8, 16, 0.4); // 超过二值化阈值但得分不够
        fill(&mut prob, w, 50, 52, 50, 52, 0.95); // 2x2，短边 < 3
        assert!(db_boxes(&prob, w, h, &DbConfig::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn 低分噪点不占候选名额() {
        // 上半部 20 个孤立低分噪点（得分 0.4，过二值化但不过框阈值），下半部一个真实文字框
        let (w, h) = (128, 64);
        let mut prob = vec![0.0f32; w * h];
        for i in 0..20 {
            fill(&mut prob, w, 4 + i * 6, 7 + i * 6, 2, 5, 0.4);
        }
        fill(&mut prob, w, 10, 60, 40, 50, 0.9);
        let cfg = DbConfig {
            max_candidates: 5,
            ..Default::default()
        };
        let boxes = db_boxes(&prob, w, h, &cfg).unwrap();
        assert_eq!(boxes.len(), 1, "真实文字框应被保留");
        assert!((boxes[0].score - 0.9).abs() < 1e-5);
    }

    #[test]
    fn 过线候选超过上限时截断() {
        let (w, h) = (128, 64);
        let mut prob = vec![0.0f32; w * h];
        for i in 0..10 {
            fill(&mut prob, w, 4 + i * 8, 10 + i * 8, 10, 16, 0.9);
        }
        let cfg = DbConfig {
            max_candidates: 3,
            ..Default::default()
        };
        assert_eq!(db_boxes(&prob, w, h, &cfg).unwrap().len(), 3);
    }

    #[test]
    fn 空图无框() {
        let prob = vec![0.0f32; 16 * 16];
        assert!(db_boxes(&prob, 16, 16, &DbConfig::default())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn 长度不符报错() {
        assert!(db_boxes(&[0.0; 10], 4, 4, &DbConfig::default()).is_err());
        assert!(db_boxes(&[], 0, 0, &DbConfig::default()).is_err());
    }

    #[test]
    fn 斜放的菱形得到旋转矩形() {
        let (w, h) = (64, 64);
        let mut prob = vec![0.0f32; w * h];
        let (cx, cy, r) = (32i32, 32i32, 10i32);
        for y in 0..h as i32 {
            for x in 0..w as i32 {
                if (x - cx).abs() + (y - cy).abs() <= r {
                    prob[y as usize * w + x as usize] = 0.9;
                }
            }
        }
        let cfg = DbConfig {
            unclip_ratio: 0.0, // 关掉扩张，直接看外接矩形
            ..Default::default()
        };
        let boxes = db_boxes(&prob, w, h, &cfg).unwrap();
        assert_eq!(boxes.len(), 1);
        let q = boxes[0].quad;
        let side = |a: Point, b: Point| ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
        // 对角线约 21，边长约 14.8；轴对齐包围盒会是 21，这里应明显小于它
        for s in [side(q[0], q[1]), side(q[1], q[2])] {
            assert!((s - 15.0).abs() < 2.5, "边长 {s}");
        }
    }

    #[test]
    fn 映射回原图并夹边() {
        let mut boxes = vec![TextBox {
            quad: [(0.0, 0.0), (96.0, 0.0), (96.0, 48.0), (0.0, 48.0)],
            score: 1.0,
        }];
        // 检测图 192x96，原图 200x100
        map_to_source(&mut boxes, 192, 96, 200, 100);
        let q = boxes[0].quad;
        assert!((q[1].0 - 100.0).abs() < 1e-3);
        assert!((q[2].1 - 50.0).abs() < 1e-3);
        // 超出部分夹到原图边界
        let mut over = vec![TextBox {
            quad: [(-5.0, -5.0), (300.0, -5.0), (300.0, 300.0), (-5.0, 300.0)],
            score: 1.0,
        }];
        map_to_source(&mut over, 200, 100, 200, 100);
        assert_eq!(over[0].quad[0], (0.0, 0.0));
        assert_eq!(over[0].quad[2], (200.0, 100.0));
    }

    #[test]
    fn 映射夹取越界与缩放组合() {
        // 放大 2 倍后超界的点被夹住；负坐标夹到 0
        let mut boxes = vec![TextBox {
            quad: [(-10.0, -10.0), (60.0, -10.0), (60.0, 60.0), (-10.0, 60.0)],
            score: 1.0,
        }];
        map_to_source(&mut boxes, 50, 50, 100, 100);
        let q = boxes[0].quad;
        assert_eq!(q[0], (0.0, 0.0));
        assert_eq!(q[1], (100.0, 0.0));
        assert_eq!(q[2], (100.0, 100.0));
        assert_eq!(q[3], (0.0, 100.0));
    }

    #[test]
    fn 阅读顺序先上后下同行先左后右() {
        let mk = |x: f32, y: f32| TextBox {
            quad: [(x, y), (x + 5.0, y), (x + 5.0, y + 5.0), (x, y + 5.0)],
            score: 1.0,
        };
        // 第二行的右侧框 y 略小于左侧框 3 像素，应仍视作同一行、左在前
        let mut boxes = vec![mk(80.0, 47.0), mk(10.0, 50.0), mk(30.0, 10.0)];
        sort_reading_order(&mut boxes);
        let xs: Vec<f32> = boxes.iter().map(|b| b.quad[0].0).collect();
        assert_eq!(xs, vec![30.0, 10.0, 80.0]);
    }

    #[test]
    fn 凸包与最小矩形() {
        let pts = vec![(0.0, 0.0), (4.0, 0.0), (4.0, 2.0), (0.0, 2.0), (2.0, 1.0)];
        let hull = convex_hull(pts);
        assert_eq!(hull.len(), 4);
        let r = min_area_rect(&hull).unwrap();
        assert!((r.w * r.h - 8.0).abs() < 1e-9);
        assert!(min_area_rect(&hull[..2]).is_none());
    }
}
