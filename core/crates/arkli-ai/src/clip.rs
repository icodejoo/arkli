//! CLIP 类图像编码器（目前用于 SigLIP2 `q4_half`）：缩放 -> 归一化 -> 推理 -> L2 归一化向量。
//!
//! 输入是原生已解码的 RGB/RGBA 像素（任意尺寸），Rust 负责缩放到 224x224。
//! 缩放选 Rust 而不是原生：参考结果（PC 评测）用的是 PIL 的 bilinear，
//! 它缩小时带抗锯齿（滤波核随缩放比例变宽）；安卓 `createScaledBitmap` 没有这一步，结果会偏。
//! 这里按 PIL 的系数公式实现，并在测试里与 PIL 的输出对表。

use crate::backend::{GraphSession, GraphTensorSession, Session, Tensor};
use crate::error::{AiError, Result};
use crate::image::RawImage;

/// 模型输入边长（像素）。
pub const INPUT_SIZE: u32 = 224;
/// 归一化均值（RGB 三通道相同）。
pub const NORM_MEAN: f32 = 0.5;
/// 归一化标准差（RGB 三通道相同）。
pub const NORM_STD: f32 = 0.5;
/// 模型输入名（MNN 后端按名字绑定；ORT 后端取第一个输入，不依赖它）。
pub const INPUT_NAME: &str = "pixel_values";
/// 取向量用的模型输出名。
pub const OUTPUT_NAME: &str = "pooler_output";
/// 像素最大值，用于 0..255 到 0..1。
const PIXEL_MAX: f32 = 255.0;

/// 一个方向上的重采样系数：每个输出点对应 `[start, start + weights.len())` 的输入点。
struct Taps {
    /// 起始输入下标
    start: usize,
    /// 归一化后的权重
    weights: Vec<f32>,
}

/// 三角（bilinear）滤波核，支持范围 (-1, 1)。
fn triangle(x: f32) -> f32 {
    let x = x.abs();
    if x < 1.0 {
        1.0 - x
    } else {
        0.0
    }
}

/// 按 PIL 的 `precompute_coeffs` 公式算一个方向的系数。缩小时核按比例变宽（抗锯齿）。
fn build_taps(in_len: usize, out_len: usize) -> Vec<Taps> {
    let scale = in_len as f32 / out_len as f32;
    let filter_scale = scale.max(1.0);
    let support = filter_scale;
    (0..out_len)
        .map(|o| {
            let center = (o as f32 + 0.5) * scale;
            let start = ((center - support + 0.5) as i64).max(0) as usize;
            let end = (((center + support + 0.5) as i64).max(0) as usize).min(in_len);
            let end = end.max(start + 1).min(in_len);
            let mut weights: Vec<f32> = (start..end)
                .map(|i| triangle((i as f32 - center + 0.5) / filter_scale))
                .collect();
            let sum: f32 = weights.iter().sum();
            if sum > 0.0 {
                weights.iter_mut().for_each(|w| *w /= sum);
            } else {
                // 极端情况兜底：退化成最近点
                weights = vec![1.0];
            }
            Taps { start, weights }
        })
        .collect()
}

/// f32 四舍五入并夹到 0..=255。
fn to_u8(v: f32) -> u8 {
    (v + 0.5).floor().clamp(0.0, PIXEL_MAX) as u8
}

/// 把图缩放到 `out_w` x `out_h`，算法与 PIL 的 `resize(BILINEAR)` 一致（先横后竖，中间结果取整到 u8）。
///
/// - `img`：输入图（带透明度时叠白底）
/// - 返回：RGB 行优先 u8，长度 `out_w * out_h * 3`
///
/// ```
/// use arkli_ai::{clip::resize_rgb, PixelFormat, RawImage};
/// let img = RawImage::new(2, 2, PixelFormat::Rgb, vec![10; 12]).unwrap();
/// let out = resize_rgb(&img, 4, 4).unwrap();
/// assert_eq!(out.len(), 4 * 4 * 3);
/// assert!(out.iter().all(|&v| v == 10));
/// ```
pub fn resize_rgb(img: &RawImage, out_w: u32, out_h: u32) -> Result<Vec<u8>> {
    if out_w == 0 || out_h == 0 {
        return Err(AiError::InvalidConfig("目标尺寸不能为 0".into()));
    }
    let rgb = img.to_rgb();
    let (iw, ih) = (rgb.width as usize, rgb.height as usize);
    let (ow, oh) = (out_w as usize, out_h as usize);
    let hx = build_taps(iw, ow);
    let vy = build_taps(ih, oh);
    // 横向：ih 行 x ow 列
    let mut mid = vec![0u8; ih * ow * 3];
    for y in 0..ih {
        for (ox, t) in hx.iter().enumerate() {
            for c in 0..3 {
                let mut acc = 0.0f32;
                for (k, w) in t.weights.iter().enumerate() {
                    acc += w * rgb.data[(y * iw + t.start + k) * 3 + c] as f32;
                }
                mid[(y * ow + ox) * 3 + c] = to_u8(acc);
            }
        }
    }
    // 纵向：oh 行 x ow 列
    let mut out = vec![0u8; oh * ow * 3];
    for (oy, t) in vy.iter().enumerate() {
        for x in 0..ow {
            for c in 0..3 {
                let mut acc = 0.0f32;
                for (k, w) in t.weights.iter().enumerate() {
                    acc += w * mid[((t.start + k) * ow + x) * 3 + c] as f32;
                }
                out[(oy * ow + x) * 3 + c] = to_u8(acc);
            }
        }
    }
    Ok(out)
}

/// 把 224x224 的 RGB u8 像素转成模型输入张量：`(v/255 - mean) / std`，NCHW，`[1, 3, 224, 224]`。
///
/// - `rgb`：行优先 RGB，长度必须是 `INPUT_SIZE * INPUT_SIZE * 3`
pub fn normalize_nchw(rgb: &[u8]) -> Result<Tensor> {
    let side = INPUT_SIZE as usize;
    if rgb.len() != side * side * 3 {
        return Err(AiError::InvalidImage(format!(
            "像素长度 {} 与 {side}x{side} RGB 不符",
            rgb.len()
        )));
    }
    let plane = side * side;
    let mut data = vec![0.0f32; 3 * plane];
    for (i, px) in rgb.chunks_exact(3).enumerate() {
        for c in 0..3 {
            data[c * plane + i] = (px[c] as f32 / PIXEL_MAX - NORM_MEAN) / NORM_STD;
        }
    }
    Tensor::new(vec![1, 3, side as i64, side as i64], data)
}

/// 完整预处理：任意尺寸图 -> 缩放到 224x224 -> 归一化张量。
pub fn preprocess(img: &RawImage) -> Result<Tensor> {
    let px = resize_rgb(img, INPUT_SIZE, INPUT_SIZE)?;
    normalize_nchw(&px)
}

/// 原地 L2 归一化。零向量或含非有限值返回错误。
///
/// ```
/// let mut v = vec![3.0, 4.0];
/// arkli_ai::clip::l2_normalize(&mut v).unwrap();
/// assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6);
/// ```
pub fn l2_normalize(v: &mut [f32]) -> Result<()> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if !norm.is_finite() || norm <= 0.0 {
        return Err(AiError::BadModelOutput("向量范数为 0 或非有限".into()));
    }
    v.iter_mut().for_each(|x| *x /= norm);
    Ok(())
}

/// 图像编码器：持有一个模型会话，可反复调用（会话复用，不要每次重建）。
///
/// ```no_run
/// # use arkli_ai::{clip::ClipEncoder, RawImage, PixelFormat, Session};
/// # fn demo(session: Box<dyn Session>, img: &RawImage) {
/// let mut enc = ClipEncoder::new(session);
/// let vec = enc.embed(img).unwrap(); // 768 维，已 L2 归一化
/// # }
/// ```
pub struct ClipEncoder {
    /// 模型会话
    session: Box<dyn Session>,
}

impl ClipEncoder {
    /// 用已加载的会话构造。
    pub fn new(session: Box<dyn Session>) -> Self {
        Self { session }
    }

    /// 用图推理会话（如 MNN 的 `MnnNet`，或测试里的 mock）构造。
    ///
    /// - `graph`：单输入会话，输出里须有名为 [`OUTPUT_NAME`] 的那一个
    pub fn from_graph<G: GraphSession + 'static>(graph: G) -> Self {
        Self::new(Box::new(GraphTensorSession::new(graph)))
    }

    /// 对一张图算向量。
    ///
    /// - `img`：已解码像素（任意尺寸）
    /// - 返回：L2 归一化后的向量；输出形状不是 `[1, dim]` 时报 [`AiError::BadModelOutput`]
    pub fn embed(&mut self, img: &RawImage) -> Result<Vec<f32>> {
        let input = preprocess(img)?;
        let out = self.session.run_named(input, OUTPUT_NAME)?;
        if out.shape.len() != 2 || out.shape[0] != 1 {
            return Err(AiError::BadModelOutput(format!(
                "期望 [1, dim]，实际 {:?}",
                out.shape
            )));
        }
        let mut v = out.data;
        l2_normalize(&mut v)?;
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::GraphValue;
    use crate::image::PixelFormat;

    /// 记录输入并返回固定输出的假会话。
    struct FakeSession {
        /// 要返回的输出
        out: Tensor,
    }

    impl Session for FakeSession {
        fn run(&mut self, _input: Tensor) -> Result<Tensor> {
            Ok(self.out.clone())
        }
        fn run_named(&mut self, input: Tensor, output: &str) -> Result<Tensor> {
            assert_eq!(output, OUTPUT_NAME);
            assert_eq!(input.shape, vec![1, 3, 224, 224]);
            Ok(self.out.clone())
        }
    }

    /// 假图值：只存形状与数据。
    struct MockValue {
        /// 形状
        shape: Vec<i64>,
        /// 数据
        data: Vec<f32>,
    }

    impl GraphValue for MockValue {
        fn shape(&self) -> Vec<i64> {
            self.shape.clone()
        }
        fn to_f32(&self) -> Result<Vec<f32>> {
            Ok(self.data.clone())
        }
        fn to_i32(&self) -> Result<Vec<i32>> {
            Err(AiError::BadModelOutput("mock 无 i32".into()))
        }
    }

    /// 记录的一次输入：(形状, 数据)
    type Seen = (Vec<i64>, Vec<f32>);

    /// 假图会话：记录收到的输入，返回固定输出（按 `out_names` 顺序）。
    struct MockGraph {
        /// 输入名
        ins: Vec<String>,
        /// 输出名
        outs: Vec<String>,
        /// 每个输出的 (形状, 数据)
        results: Vec<(Vec<i64>, Vec<f32>)>,
        /// 收到的输入形状与数据前几个值，供断言
        seen: std::sync::Arc<std::sync::Mutex<Vec<Seen>>>,
        /// 让 run 失败
        fail: bool,
    }

    impl MockGraph {
        /// 构造：输出名 `last_hidden_state`、`pooler_output`，后者是 `pooled`。
        fn new(pooled: Vec<f32>) -> Self {
            let n = pooled.len() as i64;
            Self {
                ins: vec![INPUT_NAME.into()],
                outs: vec!["last_hidden_state".into(), OUTPUT_NAME.into()],
                results: vec![(vec![1, 2, 2], vec![9.0; 4]), (vec![1, n], pooled)],
                seen: Default::default(),
                fail: false,
            }
        }
    }

    impl GraphSession for MockGraph {
        type Value = MockValue;
        fn input_names(&self) -> &[String] {
            &self.ins
        }
        fn output_names(&self) -> &[String] {
            &self.outs
        }
        fn value_f32(&self, shape: &[i64], data: &[f32]) -> Result<MockValue> {
            Ok(MockValue { shape: shape.to_vec(), data: data.to_vec() })
        }
        fn value_i32(&self, _: &[i64], _: &[i32]) -> Result<MockValue> {
            Err(AiError::Unsupported("mock".into()))
        }
        fn run(&mut self, inputs: &[&MockValue]) -> Result<Vec<MockValue>> {
            if self.fail {
                return Err(AiError::Backend("mock 推理失败".into()));
            }
            self.seen.lock().unwrap().push((inputs[0].shape.clone(), inputs[0].data.clone()));
            Ok(self.results.iter().map(|(s, d)| MockValue { shape: s.clone(), data: d.clone() }).collect())
        }
    }

    #[test]
    fn 图会话驱动编码器_形状与归一化() {
        let g = MockGraph::new(vec![1.0, 2.0, 2.0, 4.0]);
        let seen = g.seen.clone();
        let mut enc = ClipEncoder::from_graph(g);
        let v = enc.embed(&golden_image()).unwrap();
        // 取的是 pooler_output（不是第一个输出），且已 L2 归一化
        assert_eq!(v.len(), 4);
        assert!((v.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-6);
        assert!((v[3] - 4.0 / 5.0).abs() < 1e-6);
        // 输入是 [1,3,224,224] 且值在 [-1, 1]
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, vec![1, 3, 224, 224]);
        assert_eq!(seen[0].1.len(), 3 * 224 * 224);
        assert!(seen[0].1.iter().all(|x| (-1.0..=1.0).contains(x)));
    }

    #[test]
    fn 图会话错误会向上传播() {
        let mut g = MockGraph::new(vec![1.0]);
        g.fail = true;
        let mut enc = ClipEncoder::from_graph(g);
        assert!(matches!(enc.embed(&golden_image()), Err(AiError::Backend(_))));
    }

    #[test]
    fn 图会话缺少同名输出报错() {
        let mut g = MockGraph::new(vec![1.0]);
        g.outs = vec!["a".into(), "b".into()];
        let mut enc = ClipEncoder::from_graph(g);
        assert!(matches!(enc.embed(&golden_image()), Err(AiError::BadModelOutput(_))));
    }

    #[test]
    fn 图会话输出形状异常被拒() {
        let mut g = MockGraph::new(vec![1.0; 4]);
        g.results[1] = (vec![2, 2], vec![1.0; 4]);
        let mut enc = ClipEncoder::from_graph(g);
        assert!(matches!(enc.embed(&golden_image()), Err(AiError::BadModelOutput(_))));
    }

    #[test]
    fn 多输入图会话不能用单输入适配器() {
        let mut g = MockGraph::new(vec![1.0]);
        g.ins.push("extra".into());
        let mut enc = ClipEncoder::from_graph(g);
        assert!(matches!(enc.embed(&golden_image()), Err(AiError::Unsupported(_))));
    }

    #[test]
    fn 适配器run取第一个输出() {
        let mut s = GraphTensorSession::new(MockGraph::new(vec![1.0, 2.0]));
        let t = Tensor::new(vec![1, 1], vec![0.5]).unwrap();
        let out = s.run(t).unwrap();
        assert_eq!(out.shape, vec![1, 2, 2]);
    }

    /// 与 PIL 对表用的图：像素 = (x*37 + y*91 + c*53) % 256，11x7。
    fn golden_image() -> RawImage {
        let mut d = Vec::new();
        for y in 0..7u32 {
            for x in 0..11u32 {
                for c in 0..3u32 {
                    d.push(((x * 37 + y * 91 + c * 53) % 256) as u8);
                }
            }
        }
        RawImage::new(11, 7, PixelFormat::Rgb, d).unwrap()
    }

    #[test]
    fn 缩放与pil的结果一致() {
        // 期望值由 PIL 10.x `Image.resize((4, 3), BILINEAR)` 生成；允许 ±1 的取整差
        let expect: [u8; 36] = [
            102, 134, 135, 133, 146, 135, 112, 122, 141, 113, 122, 128, 109, 128, 140, 116, 141,
            125, 129, 136, 138, 114, 128, 145, 126, 132, 141, 113, 132, 142, 119, 139, 121, 119,
            130, 152,
        ];
        let got = resize_rgb(&golden_image(), 4, 3).unwrap();
        assert_eq!(got.len(), expect.len());
        for (i, (g, e)) in got.iter().zip(expect.iter()).enumerate() {
            assert!((*g as i32 - *e as i32).abs() <= 1, "下标 {i}：{g} vs {e}");
        }
    }

    #[test]
    fn 纯色图缩放后不变且尺寸正确() {
        let img = RawImage::new(5, 9, PixelFormat::Rgb, vec![77; 5 * 9 * 3]).unwrap();
        let out = resize_rgb(&img, 224, 224).unwrap();
        assert_eq!(out.len(), 224 * 224 * 3);
        assert!(out.iter().all(|&v| v == 77));
    }

    #[test]
    fn rgba叠白底后缩放() {
        // 全透明 -> 白
        let img = RawImage::new(2, 2, PixelFormat::Rgba, vec![0; 16]).unwrap();
        let out = resize_rgb(&img, 2, 2).unwrap();
        assert!(out.iter().all(|&v| v == 255));
    }

    #[test]
    fn 缩放目标为零报错() {
        assert!(resize_rgb(&golden_image(), 0, 3).is_err());
    }

    #[test]
    fn 归一化到负一至一且通道平面排布() {
        let mut px = vec![0u8; 224 * 224 * 3];
        // 第一个像素 RGB = 0 / 255 / 51
        px[0] = 0;
        px[1] = 255;
        px[2] = 51;
        let t = normalize_nchw(&px).unwrap();
        assert_eq!(t.shape, vec![1, 3, 224, 224]);
        let plane = 224 * 224;
        assert_eq!(t.data[0], -1.0);
        assert_eq!(t.data[plane], 1.0);
        assert!((t.data[2 * plane] - (51.0 / 255.0 - 0.5) / 0.5).abs() < 1e-6);
        assert!(normalize_nchw(&px[..10]).is_err());
    }

    #[test]
    fn l2归一化() {
        let mut v = vec![0.0, 3.0, 4.0];
        l2_normalize(&mut v).unwrap();
        assert!((v.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-6);
        assert!(l2_normalize(&mut [0.0, 0.0]).is_err());
        assert!(l2_normalize(&mut [f32::NAN, 1.0]).is_err());
    }

    #[test]
    fn 编码器输出归一化向量() {
        let out = Tensor::new(vec![1, 4], vec![1.0, 2.0, 2.0, 4.0]).unwrap();
        let mut enc = ClipEncoder::new(Box::new(FakeSession { out }));
        let v = enc.embed(&golden_image()).unwrap();
        assert_eq!(v.len(), 4);
        assert!((v.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn 编码器拒绝异常输出形状() {
        let out = Tensor::new(vec![2, 2], vec![1.0; 4]).unwrap();
        let mut enc = ClipEncoder::new(Box::new(FakeSession { out }));
        assert!(matches!(
            enc.embed(&golden_image()),
            Err(AiError::BadModelOutput(_))
        ));
    }

    #[test]
    fn 默认会话不支持按名取输出() {
        struct Plain;
        impl Session for Plain {
            fn run(&mut self, input: Tensor) -> Result<Tensor> {
                Ok(input)
            }
        }
        let t = Tensor::new(vec![1], vec![0.0]).unwrap();
        assert!(matches!(Plain.run_named(t, "x"), Err(AiError::Unsupported(_))));
    }
}
