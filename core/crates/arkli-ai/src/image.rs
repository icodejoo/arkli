//! 像素缓冲与几何采样：自写双线性缩放、四边形裁剪、旋转。不引 image 系依赖。

use crate::error::{AiError, Result};

/// 输入缓冲的像素排布。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    /// 每像素 3 字节 R G B
    Rgb,
    /// 每像素 4 字节 R G B A（非预乘）
    Rgba,
}

impl PixelFormat {
    /// 每像素字节数。
    pub fn channels(self) -> usize {
        match self {
            PixelFormat::Rgb => 3,
            PixelFormat::Rgba => 4,
        }
    }
}

/// 已解码的原始像素图（行优先、无行填充）。PNG 等格式的解码由上游负责。
#[derive(Debug, Clone, PartialEq)]
pub struct RawImage {
    /// 宽（像素）
    pub width: u32,
    /// 高（像素）
    pub height: u32,
    /// 像素排布
    pub format: PixelFormat,
    /// 像素数据，长度必须等于 `width * height * channels`
    pub data: Vec<u8>,
}

impl RawImage {
    /// 构造并校验缓冲长度。
    ///
    /// ```
    /// use arkli_ai::{PixelFormat, RawImage};
    /// let img = RawImage::new(2, 1, PixelFormat::Rgb, vec![0; 6]).unwrap();
    /// assert_eq!(img.width, 2);
    /// assert!(RawImage::new(2, 1, PixelFormat::Rgb, vec![0; 5]).is_err());
    /// ```
    pub fn new(width: u32, height: u32, format: PixelFormat, data: Vec<u8>) -> Result<Self> {
        if width == 0 || height == 0 {
            return Err(AiError::InvalidImage("宽高不能为 0".into()));
        }
        let expect = width as usize * height as usize * format.channels();
        if data.len() != expect {
            return Err(AiError::InvalidImage(format!(
                "缓冲长度 {} 与 {width}x{height} {:?} 不符，应为 {expect}",
                data.len(),
                format
            )));
        }
        Ok(Self {
            width,
            height,
            format,
            data,
        })
    }

    /// 转成 RGB 图。带透明度时按不透明度叠在白底上（截图里透明区域视为白纸）。
    pub fn to_rgb(&self) -> RgbImage {
        let n = self.width as usize * self.height as usize;
        let mut out = Vec::with_capacity(n * 3);
        match self.format {
            PixelFormat::Rgb => out.extend_from_slice(&self.data),
            PixelFormat::Rgba => {
                for px in self.data.chunks_exact(4) {
                    let a = px[3] as u32;
                    for &c in &px[..3] {
                        // c*a + 255*(255-a)，四舍五入除以 255
                        out.push(((c as u32 * a + 255 * (255 - a) + 127) / 255) as u8);
                    }
                }
            }
        }
        RgbImage {
            width: self.width,
            height: self.height,
            data: out,
        }
    }
}

/// 内部使用的 RGB8 图（行优先，3 字节/像素）。
#[derive(Debug, Clone, PartialEq)]
pub struct RgbImage {
    /// 宽
    pub width: u32,
    /// 高
    pub height: u32,
    /// 像素数据，长度 `width * height * 3`
    pub data: Vec<u8>,
}

/// 平面上的点 (x, y)，单位像素，原点在图左上角。
pub type Point = (f32, f32);

impl RgbImage {
    /// 创建纯色图，主要给测试和 padding 用。
    pub fn filled(width: u32, height: u32, rgb: [u8; 3]) -> Self {
        let mut data = Vec::with_capacity(width as usize * height as usize * 3);
        for _ in 0..(width as usize * height as usize) {
            data.extend_from_slice(&rgb);
        }
        Self {
            width,
            height,
            data,
        }
    }

    /// 取整数坐标处的像素（越界则夹到边缘）。
    fn px(&self, x: i64, y: i64) -> [f32; 3] {
        let xi = x.clamp(0, self.width as i64 - 1) as usize;
        let yi = y.clamp(0, self.height as i64 - 1) as usize;
        let i = (yi * self.width as usize + xi) * 3;
        [
            self.data[i] as f32,
            self.data[i + 1] as f32,
            self.data[i + 2] as f32,
        ]
    }

    /// 双线性采样。坐标取"像素边缘"约定：像素 (i, j) 的中心在 (i+0.5, j+0.5)。
    /// 越界时夹到边缘。
    pub fn sample(&self, fx: f32, fy: f32) -> [f32; 3] {
        let x = fx - 0.5;
        let y = fy - 0.5;
        let x0 = x.floor();
        let y0 = y.floor();
        let tx = x - x0;
        let ty = y - y0;
        let (xi, yi) = (x0 as i64, y0 as i64);
        let p00 = self.px(xi, yi);
        let p10 = self.px(xi + 1, yi);
        let p01 = self.px(xi, yi + 1);
        let p11 = self.px(xi + 1, yi + 1);
        let mut out = [0.0; 3];
        for c in 0..3 {
            let top = p00[c] + (p10[c] - p00[c]) * tx;
            let bot = p01[c] + (p11[c] - p01[c]) * tx;
            out[c] = top + (bot - top) * ty;
        }
        out
    }

    /// 双线性缩放到指定尺寸（半像素中心对齐，与 OpenCV INTER_LINEAR 一致）。
    ///
    /// - `new_w` / `new_h`：目标宽高，必须大于 0
    pub fn resize_bilinear(&self, new_w: u32, new_h: u32) -> Result<RgbImage> {
        if new_w == 0 || new_h == 0 {
            return Err(AiError::InvalidImage("目标尺寸不能为 0".into()));
        }
        let sx = self.width as f32 / new_w as f32;
        let sy = self.height as f32 / new_h as f32;
        let mut data = Vec::with_capacity(new_w as usize * new_h as usize * 3);
        for y in 0..new_h {
            let fy = (y as f32 + 0.5) * sy;
            for x in 0..new_w {
                let fx = (x as f32 + 0.5) * sx;
                for v in self.sample(fx, fy) {
                    data.push(v.round().clamp(0.0, 255.0) as u8);
                }
            }
        }
        Ok(RgbImage {
            width: new_w,
            height: new_h,
            data,
        })
    }

    /// 逆时针旋转 90 度（宽高互换）。
    pub fn rotate90_ccw(&self) -> RgbImage {
        let (w, h) = (self.width as usize, self.height as usize);
        let mut data = vec![0u8; w * h * 3];
        // 新图宽 = h，高 = w；new(x', y') = old(w-1-y', x')
        for ny in 0..w {
            for nx in 0..h {
                let (ox, oy) = (w - 1 - ny, nx);
                let src = (oy * w + ox) * 3;
                let dst = (ny * h + nx) * 3;
                data[dst..dst + 3].copy_from_slice(&self.data[src..src + 3]);
            }
        }
        RgbImage {
            width: self.height,
            height: self.width,
            data,
        }
    }

    /// 旋转 180 度。
    pub fn rotate180(&self) -> RgbImage {
        let mut data = Vec::with_capacity(self.data.len());
        for px in self.data.chunks_exact(3).rev() {
            data.extend_from_slice(px);
        }
        RgbImage {
            width: self.width,
            height: self.height,
            data,
        }
    }

    /// 把四边形（顺序：左上、右上、右下、左下）展开成正放的矩形图。
    /// 用平行四边形双线性映射，对旋转矩形是精确的。
    ///
    /// 竖排文字（高 >= 1.5 倍宽）会逆时针转 90 度，与 PaddleOCR 一致。
    pub fn crop_quad(&self, quad: &[Point; 4]) -> Result<RgbImage> {
        let dist = |a: Point, b: Point| ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
        let [tl, tr, br, bl] = *quad;
        let w = dist(tl, tr).max(dist(bl, br)).round().max(1.0) as u32;
        let h = dist(tl, bl).max(dist(tr, br)).round().max(1.0) as u32;
        let mut data = Vec::with_capacity(w as usize * h as usize * 3);
        for y in 0..h {
            let v = (y as f32 + 0.5) / h as f32;
            for x in 0..w {
                let u = (x as f32 + 0.5) / w as f32;
                let px = tl.0 + u * (tr.0 - tl.0) + v * (bl.0 - tl.0);
                let py = tl.1 + u * (tr.1 - tl.1) + v * (bl.1 - tl.1);
                for c in self.sample(px, py) {
                    data.push(c.round().clamp(0.0, 255.0) as u8);
                }
            }
        }
        let img = RgbImage {
            width: w,
            height: h,
            data,
        };
        Ok(if h as f32 >= w as f32 * VERTICAL_TEXT_RATIO {
            img.rotate90_ccw()
        } else {
            img
        })
    }
}

/// 高/宽达到该比例的文本框按竖排处理（裁剪后转 90 度）。
const VERTICAL_TEXT_RATIO: f32 = 1.5;

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成每个像素值唯一的小图，方便检查几何变换。
    fn gradient(w: u32, h: u32) -> RgbImage {
        let mut data = Vec::new();
        for y in 0..h {
            for x in 0..w {
                data.extend_from_slice(&[(x * 10) as u8, (y * 10) as u8, 0]);
            }
        }
        RgbImage {
            width: w,
            height: h,
            data,
        }
    }

    #[test]
    fn 缓冲长度校验() {
        assert!(RawImage::new(0, 1, PixelFormat::Rgb, vec![]).is_err());
        assert!(RawImage::new(2, 2, PixelFormat::Rgba, vec![0; 15]).is_err());
        assert!(RawImage::new(2, 2, PixelFormat::Rgba, vec![0; 16]).is_ok());
    }

    #[test]
    fn rgba叠白底() {
        let img = RawImage::new(2, 1, PixelFormat::Rgba, vec![0, 0, 0, 255, 0, 0, 0, 0]).unwrap();
        let rgb = img.to_rgb();
        assert_eq!(rgb.data, vec![0, 0, 0, 255, 255, 255]);
    }

    #[test]
    fn 同尺寸缩放保持不变() {
        let g = gradient(5, 4);
        assert_eq!(g.resize_bilinear(5, 4).unwrap(), g);
    }

    #[test]
    fn 缩放形状与纯色不变() {
        let img = RgbImage::filled(7, 3, [10, 20, 30]);
        let r = img.resize_bilinear(20, 9).unwrap();
        assert_eq!((r.width, r.height), (20, 9));
        assert_eq!(r.data.len(), 20 * 9 * 3);
        assert!(r.data.chunks_exact(3).all(|p| p == [10, 20, 30]));
        assert!(img.resize_bilinear(0, 3).is_err());
    }

    #[test]
    fn 二倍放大线性插值() {
        // 1 行 2 像素 [0, 100] 放大到 4 像素：0, 25, 75, 100
        let img = RgbImage {
            width: 2,
            height: 1,
            data: vec![0, 0, 0, 100, 100, 100],
        };
        let r = img.resize_bilinear(4, 1).unwrap();
        let reds: Vec<u8> = r.data.chunks_exact(3).map(|p| p[0]).collect();
        assert_eq!(reds, vec![0, 25, 75, 100]);
    }

    #[test]
    fn 旋转() {
        let g = gradient(3, 2);
        let r = g.rotate90_ccw();
        assert_eq!((r.width, r.height), (2, 3));
        // 旧图右上角 (2,0) -> 新图左上角
        assert_eq!(&r.data[0..3], &[20, 0, 0]);
        // 四次逆时针 90 度回到原样
        assert_eq!(r.rotate90_ccw().rotate90_ccw().rotate90_ccw(), g);
        assert_eq!(g.rotate180().rotate180(), g);
        assert_eq!(&g.rotate180().data[0..3], &[20, 10, 0]);
    }

    #[test]
    fn 轴对齐裁剪() {
        let g = gradient(10, 10);
        // 取 x 2..6, y 3..5 的 4x2 区域
        let quad = [(2.0, 3.0), (6.0, 3.0), (6.0, 5.0), (2.0, 5.0)];
        let c = g.crop_quad(&quad).unwrap();
        assert_eq!((c.width, c.height), (4, 2));
        assert_eq!(&c.data[0..3], &[20, 30, 0]);
    }

    #[test]
    fn 竖排裁剪会转向() {
        let g = gradient(10, 10);
        let quad = [(2.0, 1.0), (4.0, 1.0), (4.0, 7.0), (2.0, 7.0)];
        let c = g.crop_quad(&quad).unwrap();
        // 2x6 -> 旋转后 6x2
        assert_eq!((c.width, c.height), (6, 2));
    }
}
