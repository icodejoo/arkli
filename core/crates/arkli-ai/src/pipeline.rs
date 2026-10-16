//! PP-OCR 管线编排：检测 -> 排序 -> 逐行（裁剪、方向分类、识别、CTC 解码）。
//! 只依赖 [`Session`] trait，不关心底层是 ORT 还是 mock。

use std::path::PathBuf;

use crate::backend::{InferenceBackend, Session, Tensor};
use crate::ctc::CtcDecoder;
use crate::db::{db_boxes, map_to_source, sort_reading_order, DbConfig};
use crate::error::{AiError, Result};
use crate::image::{Point, RawImage};
use crate::preprocess::{
    preprocess_cls, preprocess_det, preprocess_rec, ChannelOrder, DetPreConfig, RecPreConfig,
    CLS_HEIGHT, CLS_WIDTH,
};
use crate::provider::SessionOptions;
use crate::task::{CancelToken, Progress, Stage};

/// 输入图最长边上限。更大的图应由上游（原生侧 inSampleSize）先降采样。
pub const MAX_INPUT_SIDE: u32 = 4096;
/// 识别结果得分低于它的行被丢弃。
pub const DEFAULT_DROP_SCORE: f32 = 0.5;
/// 方向分类判定"倒置"的概率阈值。
pub const DEFAULT_CLS_THRESH: f32 = 0.9;
/// 方向分类输出里"旋转 180 度"对应的类别下标。
const CLS_ROTATED_INDEX: usize = 1;
/// 方向分类输出类别数。
const CLS_CLASSES: usize = 2;

/// OCR 管线参数。
#[derive(Debug, Clone, PartialEq)]
pub struct OcrOptions {
    /// 检测预处理
    pub det_pre: DetPreConfig,
    /// DB 后处理
    pub det_post: DbConfig,
    /// 识别预处理
    pub rec_pre: RecPreConfig,
    /// 方向分类输入高
    pub cls_height: u32,
    /// 方向分类输入宽
    pub cls_width: u32,
    /// 方向分类倒置阈值
    pub cls_thresh: f32,
    /// 识别得分低于它的行丢弃
    pub drop_score: f32,
    /// 输入图最长边上限
    pub max_input_side: u32,
    /// 大图分块高度（预留接口，目前设为 Some 会返回 [`AiError::Unsupported`]）
    pub max_tile_height: Option<u32>,
}

impl Default for OcrOptions {
    fn default() -> Self {
        Self {
            det_pre: DetPreConfig::default(),
            det_post: DbConfig::default(),
            rec_pre: RecPreConfig::default(),
            cls_height: CLS_HEIGHT,
            cls_width: CLS_WIDTH,
            cls_thresh: DEFAULT_CLS_THRESH,
            drop_score: DEFAULT_DROP_SCORE,
            max_input_side: MAX_INPUT_SIDE,
            max_tile_height: None,
        }
    }
}

impl OcrOptions {
    /// 统一设置送入三个模型的通道顺序。
    pub fn with_channel_order(mut self, order: ChannelOrder) -> Self {
        self.det_pre.channel_order = order;
        self.rec_pre.channel_order = order;
        self
    }
}

/// 模型与字典文件路径。
#[derive(Debug, Clone, PartialEq)]
pub struct OcrModelPaths {
    /// 检测模型
    pub det: PathBuf,
    /// 识别模型
    pub rec: PathBuf,
    /// 文本行方向分类模型，可选（默认只带 det + rec）
    pub cls: Option<PathBuf>,
    /// 字典文件（一行一字）
    pub dict: PathBuf,
}

/// MNN 版模型目录里的检测模型文件名。
pub const OCR_DET_FILE: &str = "det.mnn";
/// MNN 版模型目录里的识别模型文件名。
pub const OCR_REC_FILE: &str = "rec.mnn";
/// MNN 版模型目录里的方向分类模型文件名。
pub const OCR_CLS_FILE: &str = "cls.mnn";
/// 模型目录里的识别字典文件名（一行一字）。
pub const OCR_DICT_FILE: &str = "ppocr_keys.txt";
/// PP-OCRv5 方向分类模型（PP-LCNet_x0_25）的输入高。
pub const OCR_V5_CLS_HEIGHT: u32 = 80;
/// PP-OCRv5 方向分类模型的输入宽。
pub const OCR_V5_CLS_WIDTH: u32 = 160;

impl OcrModelPaths {
    /// 按约定文件名拼出模型目录里的四个路径（det / rec / cls / 字典，cls 总是带上）。
    ///
    /// ```
    /// use arkli_ai::OcrModelPaths;
    /// let p = OcrModelPaths::in_dir(std::path::Path::new("m"));
    /// assert!(p.det.ends_with("det.mnn") && p.dict.ends_with("ppocr_keys.txt"));
    /// ```
    pub fn in_dir(dir: &std::path::Path) -> Self {
        Self {
            det: dir.join(OCR_DET_FILE),
            rec: dir.join(OCR_REC_FILE),
            cls: Some(dir.join(OCR_CLS_FILE)),
            dict: dir.join(OCR_DICT_FILE),
        }
    }
}

/// PP-OCRv6 small 的识别字典项数（rec 输出类别数 = 它 + 2：blank 与末尾空格）。
pub const OCR_V6_DICT_SIZE: usize = 18_708;
/// PP-OCRv6 官方 det 后处理：二值化阈值（inference.yml 的 `thresh`）。
pub const OCR_V6_DET_THRESH: f32 = 0.2;
/// PP-OCRv6 官方 det 后处理：框平均得分阈值（`box_thresh`）。
pub const OCR_V6_DET_BOX_THRESH: f32 = 0.45;
/// PP-OCRv6 官方 det 后处理：unclip 比例（`unclip_ratio`）。
pub const OCR_V6_DET_UNCLIP_RATIO: f32 = 1.4;

impl OcrOptions {
    /// PP-OCRv5 模型组的参数：方向分类输入是 80x160（该 onnx/mnn 的固定输入），其余沿用默认。
    pub fn for_ppocr_v5() -> Self {
        Self {
            cls_height: OCR_V5_CLS_HEIGHT,
            cls_width: OCR_V5_CLS_WIDTH,
            ..Self::default()
        }
    }

    /// PP-OCRv6 small 模型组的参数：det 后处理取官方 inference.yml 的值
    /// （thresh 0.2 / box_thresh 0.45 / unclip 1.4），方向分类沿用 v5 的 80x160；识别预处理与 v5 相同。
    pub fn for_ppocr_v6() -> Self {
        let mut o = Self::for_ppocr_v5();
        o.det_post.thresh = OCR_V6_DET_THRESH;
        o.det_post.box_thresh = OCR_V6_DET_BOX_THRESH;
        o.det_post.unclip_ratio = OCR_V6_DET_UNCLIP_RATIO;
        o
    }

    /// 按字典项数判别模型代际：恰为 [`OCR_V6_DICT_SIZE`] 用 v6 参数，其余一律按 v5。
    ///
    /// - `dict_len`：字典文件的项数（一行一字）
    ///
    /// ```
    /// use arkli_ai::OcrOptions;
    /// assert_eq!(OcrOptions::for_dict_len(18_708), OcrOptions::for_ppocr_v6());
    /// assert_eq!(OcrOptions::for_dict_len(18_383), OcrOptions::for_ppocr_v5());
    /// ```
    pub fn for_dict_len(dict_len: usize) -> Self {
        if dict_len == OCR_V6_DICT_SIZE {
            Self::for_ppocr_v6()
        } else {
            Self::for_ppocr_v5()
        }
    }
}

/// 一行识别结果。
#[derive(Debug, Clone, PartialEq)]
pub struct TextLine {
    /// 文本框四个角（原图坐标；左上、右上、右下、左下）
    pub quad: [Point; 4],
    /// 识别文本
    pub text: String,
    /// 识别置信度 0..=1
    pub score: f32,
}

/// OCR 管线。持有三个会话（cls 可选）与字典解码器。
pub struct OcrPipeline {
    /// 检测会话
    det: Box<dyn Session>,
    /// 识别会话
    rec: Box<dyn Session>,
    /// 方向分类会话
    cls: Option<Box<dyn Session>>,
    /// CTC 解码器
    decoder: CtcDecoder,
    /// 参数
    options: OcrOptions,
}

impl OcrPipeline {
    /// 用已有的会话直接组装（测试和自定义后端用）。
    pub fn new(
        det: Box<dyn Session>,
        rec: Box<dyn Session>,
        cls: Option<Box<dyn Session>>,
        decoder: CtcDecoder,
        options: OcrOptions,
    ) -> Self {
        Self {
            det,
            rec,
            cls,
            decoder,
            options,
        }
    }

    /// 从模型文件加载。
    ///
    /// - `backend`：推理后端
    /// - `paths`：模型与字典路径
    /// - `session_opts`：provider/线程数，通常来自 [`crate::provider::resolve_options`]
    /// - `options`：管线参数
    pub fn load(
        backend: &dyn InferenceBackend,
        paths: &OcrModelPaths,
        session_opts: &SessionOptions,
        options: OcrOptions,
    ) -> Result<Self> {
        Self::load_with(paths, &mut |p| backend.load_model(p, session_opts), options)
    }

    /// 用自定义的“路径 -> 会话”加载函数组装（MNN 等不走 [`InferenceBackend`] 的后端用）。
    ///
    /// - `paths`：模型与字典路径
    /// - `loader`：按路径加载一个单输入单输出会话
    /// - `options`：管线参数
    pub fn load_with(
        paths: &OcrModelPaths,
        loader: &mut dyn FnMut(&std::path::Path) -> Result<Box<dyn Session>>,
        options: OcrOptions,
    ) -> Result<Self> {
        let dict = std::fs::read_to_string(&paths.dict)
            .map_err(|e| AiError::InvalidConfig(format!("读取字典失败：{e}")))?;
        let decoder = CtcDecoder::from_dict_text(&dict, true)?;
        let det = loader(&paths.det)?;
        let rec = loader(&paths.rec)?;
        let cls = match &paths.cls {
            Some(p) => Some(loader(p)?),
            None => None,
        };
        Ok(Self::new(det, rec, cls, decoder, options))
    }

    /// 识别一张图里的所有文字。
    ///
    /// - `image`：已解码的原始像素图（PNG 等格式解码由上游完成）
    /// - `cancel`：取消令牌；触发后在下一个检查点返回 [`AiError::Cancelled`]
    /// - `progress`：进度回调。顺序：检测 0/1、检测 1/1、识别 k/n（每行一次；无文字时 0/0）
    /// - 返回：按阅读顺序排好的文本行，低于 `drop_score` 与空文本已剔除
    pub fn recognize(
        &mut self,
        image: &RawImage,
        cancel: &CancelToken,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<Vec<TextLine>> {
        if self.options.max_tile_height.is_some() {
            return Err(AiError::Unsupported("大图分块识别尚未实现".into()));
        }
        if image.width.max(image.height) > self.options.max_input_side {
            return Err(AiError::InvalidImage(format!(
                "图像最长边超过 {}，请先降采样",
                self.options.max_input_side
            )));
        }
        cancel.check()?;
        let rgb = image.to_rgb();

        // 1. 检测
        progress(Progress {
            stage: Stage::Detect,
            current: 0,
            total: 1,
        });
        let det_in = preprocess_det(&rgb, &self.options.det_pre)?;
        let (rw, rh) = (det_in.resized_w, det_in.resized_h);
        let prob = self.det.run(det_in.tensor)?;
        let expect = [1, 1, rh as i64, rw as i64];
        if prob.shape != expect {
            return Err(AiError::BadModelOutput(format!(
                "检测输出形状 {:?}，应为 {expect:?}",
                prob.shape
            )));
        }
        let mut boxes = db_boxes(&prob.data, rw as usize, rh as usize, &self.options.det_post)?;
        map_to_source(&mut boxes, rw, rh, det_in.src_w, det_in.src_h);
        sort_reading_order(&mut boxes);
        progress(Progress {
            stage: Stage::Detect,
            current: 1,
            total: 1,
        });

        // 2. 逐行识别
        let total = boxes.len() as u32;
        if total == 0 {
            progress(Progress {
                stage: Stage::Recognize,
                current: 0,
                total: 0,
            });
        }
        let mut lines = Vec::new();
        for (i, b) in boxes.iter().enumerate() {
            cancel.check()?;
            let mut crop = rgb.crop_quad(&b.quad)?;
            if let Some(cls) = self.cls.as_mut() {
                let t = preprocess_cls(
                    &crop,
                    self.options.cls_height,
                    self.options.cls_width,
                    self.options.det_pre.channel_order,
                )?;
                if is_rotated(&cls.run(t)?, self.options.cls_thresh)? {
                    crop = crop.rotate180();
                }
            }
            let t = preprocess_rec(&crop, &self.options.rec_pre)?;
            let out = self.rec.run(t)?;
            let [_, steps, classes] = out.shape[..] else {
                return Err(AiError::BadModelOutput(format!(
                    "识别输出形状 {:?}，应为 [1, T, C]",
                    out.shape
                )));
            };
            let (text, score) = self
                .decoder
                .decode(&out.data, steps as usize, classes as usize)?;
            if !text.is_empty() && score >= self.options.drop_score {
                lines.push(TextLine {
                    quad: b.quad,
                    text,
                    score,
                });
            }
            progress(Progress {
                stage: Stage::Recognize,
                current: i as u32 + 1,
                total,
            });
        }
        Ok(lines)
    }
}

/// 解析方向分类输出：倒置类别概率超过阈值才算倒置。
fn is_rotated(out: &Tensor, thresh: f32) -> Result<bool> {
    if out.data.len() != CLS_CLASSES {
        return Err(AiError::BadModelOutput(format!(
            "方向分类输出形状 {:?}，应为 [1, {CLS_CLASSES}]",
            out.shape
        )));
    }
    let (best, p) = if out.data[CLS_ROTATED_INDEX] >= out.data[1 - CLS_ROTATED_INDEX] {
        (CLS_ROTATED_INDEX, out.data[CLS_ROTATED_INDEX])
    } else {
        (1 - CLS_ROTATED_INDEX, out.data[1 - CLS_ROTATED_INDEX])
    };
    Ok(best == CLS_ROTATED_INDEX && p > thresh)
}

/// 测试用的函数式会话：用闭包伪造模型。
#[cfg(test)]
pub(crate) struct FnSession<F>(pub F);

#[cfg(test)]
impl<F: FnMut(Tensor) -> Result<Tensor> + Send> Session for FnSession<F> {
    fn run(&mut self, input: Tensor) -> Result<Tensor> {
        (self.0)(input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::PixelFormat;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// 200x100 的白图。
    fn white() -> RawImage {
        RawImage::new(200, 100, PixelFormat::Rgb, vec![255; 200 * 100 * 3]).unwrap()
    }

    /// 伪检测：在检测图 (x 20..100, y 30..50) 画一个高概率矩形，其余为 0。
    fn fake_det() -> Box<dyn Session> {
        Box::new(FnSession(|t: Tensor| {
            let (h, w) = (t.shape[2] as usize, t.shape[3] as usize);
            let mut d = vec![0.0f32; h * w];
            for y in 30..50 {
                for x in 20..100 {
                    d[y * w + x] = 0.9;
                }
            }
            Tensor::new(vec![1, 1, h as i64, w as i64], d)
        }))
    }

    /// 伪识别：固定输出 a a blank b b blank c（字典 a b c + 空格，共 5 类）。
    fn fake_rec(calls: Arc<AtomicUsize>) -> Box<dyn Session> {
        Box::new(FnSession(move |_t: Tensor| {
            calls.fetch_add(1, Ordering::SeqCst);
            let seq = [1usize, 1, 0, 2, 2, 0, 3];
            let mut d = vec![0.05f32; seq.len() * 5];
            for (t, &c) in seq.iter().enumerate() {
                d[t * 5 + c] = 0.9;
            }
            Tensor::new(vec![1, seq.len() as i64, 5], d)
        }))
    }

    fn decoder() -> CtcDecoder {
        CtcDecoder::from_dict_text("a\nb\nc", true).unwrap()
    }

    fn pipeline(cls: Option<Box<dyn Session>>, calls: Arc<AtomicUsize>) -> OcrPipeline {
        OcrPipeline::new(
            fake_det(),
            fake_rec(calls),
            cls,
            decoder(),
            OcrOptions::default(),
        )
    }

    #[test]
    fn 端到端识别并映射坐标() {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut p = pipeline(None, calls.clone());
        let mut events = Vec::new();
        let lines = p
            .recognize(&white(), &CancelToken::new(), &mut |e| events.push(e))
            .unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "abc");
        assert!((lines[0].score - 0.9).abs() < 1e-5);
        // 检测图 192x96 -> 原图 200x100，x 比例 1.0417；框约 x 12..~112，y 22..58
        let q = lines[0].quad;
        assert!(q[0].0 > 5.0 && q[0].0 < 20.0, "{q:?}");
        assert!(q[1].0 > 100.0 && q[1].0 < 125.0, "{q:?}");
        assert!(q.iter().all(|p| p.0 <= 200.0 && p.1 <= 100.0));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // 进度顺序
        let seq: Vec<(Stage, u32, u32)> = events
            .iter()
            .map(|e| (e.stage, e.current, e.total))
            .collect();
        assert_eq!(
            seq,
            vec![
                (Stage::Detect, 0, 1),
                (Stage::Detect, 1, 1),
                (Stage::Recognize, 1, 1)
            ]
        );
    }

    #[test]
    fn 方向分类倒置时被调用且不影响结果() {
        let cls_calls = Arc::new(AtomicUsize::new(0));
        let c = cls_calls.clone();
        let cls: Box<dyn Session> = Box::new(FnSession(move |t: Tensor| {
            assert_eq!(t.shape, vec![1, 3, 48, 192]);
            c.fetch_add(1, Ordering::SeqCst);
            Tensor::new(vec![1, 2], vec![0.02, 0.98])
        }));
        let mut p = pipeline(Some(cls), Arc::new(AtomicUsize::new(0)));
        let lines = p
            .recognize(&white(), &CancelToken::new(), &mut |_| {})
            .unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(cls_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn 低分行被丢弃() {
        let mut p = pipeline(None, Arc::new(AtomicUsize::new(0)));
        p.options.drop_score = 0.95;
        assert!(p
            .recognize(&white(), &CancelToken::new(), &mut |_| {})
            .unwrap()
            .is_empty());
    }

    #[test]
    fn 无文字时进度为零比零() {
        let det: Box<dyn Session> = Box::new(FnSession(|t: Tensor| {
            Tensor::new(
                t.shape
                    .iter()
                    .map(|&d| if d == 3 { 1 } else { d })
                    .collect(),
                vec![0.0; (t.shape[2] * t.shape[3]) as usize],
            )
        }));
        let mut p = OcrPipeline::new(
            det,
            fake_rec(Arc::new(AtomicUsize::new(0))),
            None,
            decoder(),
            OcrOptions::default(),
        );
        let mut last = None;
        let lines = p
            .recognize(&white(), &CancelToken::new(), &mut |e| last = Some(e))
            .unwrap();
        assert!(lines.is_empty());
        assert_eq!(last.unwrap().total, 0);
    }

    #[test]
    fn 开始前已取消() {
        let mut p = pipeline(None, Arc::new(AtomicUsize::new(0)));
        let token = CancelToken::new();
        token.cancel();
        assert_eq!(
            p.recognize(&white(), &token, &mut |_| {}),
            Err(AiError::Cancelled)
        );
    }

    #[test]
    fn 检测完成后从进度回调里取消() {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut p = pipeline(None, calls.clone());
        let token = CancelToken::new();
        let t2 = token.clone();
        let r = p.recognize(&white(), &token, &mut |e| {
            if e.stage == Stage::Detect && e.current == 1 {
                t2.cancel();
            }
        });
        assert_eq!(r, Err(AiError::Cancelled));
        assert_eq!(calls.load(Ordering::SeqCst), 0, "取消后不应再跑识别");
    }

    #[test]
    fn 错误路径() {
        let ok = |_: &mut OcrPipeline| ();
        // 分块未实现
        let mut p = pipeline(None, Arc::new(AtomicUsize::new(0)));
        ok(&mut p);
        p.options.max_tile_height = Some(1024);
        assert!(matches!(
            p.recognize(&white(), &CancelToken::new(), &mut |_| {}),
            Err(AiError::Unsupported(_))
        ));
        // 输入过大
        let mut p = pipeline(None, Arc::new(AtomicUsize::new(0)));
        p.options.max_input_side = 100;
        assert!(matches!(
            p.recognize(&white(), &CancelToken::new(), &mut |_| {}),
            Err(AiError::InvalidImage(_))
        ));
        // 检测输出形状不对
        let bad_det: Box<dyn Session> = Box::new(FnSession(|_t: Tensor| {
            Tensor::new(vec![1, 1, 2, 2], vec![0.0; 4])
        }));
        let mut p = OcrPipeline::new(
            bad_det,
            fake_rec(Arc::new(AtomicUsize::new(0))),
            None,
            decoder(),
            OcrOptions::default(),
        );
        assert!(matches!(
            p.recognize(&white(), &CancelToken::new(), &mut |_| {}),
            Err(AiError::BadModelOutput(_))
        ));
        // 后端错误向上传递
        let fail_rec: Box<dyn Session> =
            Box::new(FnSession(|_t: Tensor| Err(AiError::Backend("boom".into()))));
        let mut p = OcrPipeline::new(fake_det(), fail_rec, None, decoder(), OcrOptions::default());
        assert_eq!(
            p.recognize(&white(), &CancelToken::new(), &mut |_| {}),
            Err(AiError::Backend("boom".into()))
        );
    }

    #[test]
    fn 按目录拼路径且v5参数用80x160分类输入() {
        let p = OcrModelPaths::in_dir(std::path::Path::new("m"));
        assert_eq!(p.det, std::path::Path::new("m").join("det.mnn"));
        assert_eq!(p.cls, Some(std::path::Path::new("m").join("cls.mnn")));
        let o = OcrOptions::for_ppocr_v5();
        assert_eq!((o.cls_height, o.cls_width), (80, 160));
        assert_eq!(o.drop_score, OcrOptions::default().drop_score);
    }

    #[test]
    fn v6参数取官方后处理且按字典项数判别() {
        let v6 = OcrOptions::for_ppocr_v6();
        assert_eq!(v6.det_post.thresh, 0.2);
        assert_eq!(v6.det_post.box_thresh, 0.45);
        assert_eq!(v6.det_post.unclip_ratio, 1.4);
        assert_eq!((v6.cls_height, v6.cls_width), (80, 160));
        assert_eq!(OcrOptions::for_dict_len(OCR_V6_DICT_SIZE), v6);
        assert_eq!(OcrOptions::for_dict_len(18_383), OcrOptions::for_ppocr_v5());
        // v5 的 det 后处理保持库默认值
        assert_eq!(OcrOptions::for_ppocr_v5().det_post, DbConfig::default());
    }

    #[test]
    fn load_with按序加载三个模型并读字典() {
        let dir = std::env::temp_dir().join(format!("arkli-ocr-lw-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(OCR_DICT_FILE), "a
b
c
").unwrap();
        let paths = OcrModelPaths::in_dir(&dir);
        let mut seen = Vec::new();
        let p = OcrPipeline::load_with(
            &paths,
            &mut |path| {
                seen.push(path.file_name().unwrap().to_string_lossy().to_string());
                Ok(fake_det())
            },
            OcrOptions::default(),
        )
        .unwrap();
        assert_eq!(seen, vec!["det.mnn", "rec.mnn", "cls.mnn"]);
        assert!(p.cls.is_some());
        // 字典缺失报配置错误
        std::fs::remove_file(dir.join(OCR_DICT_FILE)).unwrap();
        let r = OcrPipeline::load_with(&paths, &mut |_| Ok(fake_det()), OcrOptions::default());
        assert!(matches!(r, Err(AiError::InvalidConfig(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 方向分类输出解析() {
        let t = |a: f32, b: f32| Tensor::new(vec![1, 2], vec![a, b]).unwrap();
        assert!(is_rotated(&t(0.05, 0.95), 0.9).unwrap());
        assert!(!is_rotated(&t(0.2, 0.8), 0.9).unwrap());
        assert!(!is_rotated(&t(0.95, 0.05), 0.9).unwrap());
        assert!(is_rotated(&Tensor::new(vec![1, 3], vec![0.0; 3]).unwrap(), 0.9).is_err());
    }
}
