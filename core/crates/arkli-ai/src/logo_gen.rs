//! SDXS（Stable Diffusion 一步文生图）生成引擎模块。
//!
//! 本模块负责从文本提示词与随机种子生成 512x512 RGB 图像，包含以下步骤：
//! 1. 文本分词：使用 CLIP 分词器（固定 77 个 token，开头 49406，结尾与填充 49407）；
//! 2. 文本特征编码：运行 `text_encoder.mnn` 获取 `last_hidden_state` [1, 77, 768]；
//! 3. UNet 一步推理：固定时间步 999，输入初始噪声与文本嵌入，预测噪声残差 eps [1, 4, 64, 64]；
//! 4. 一步采样：基于 DEIS 一阶算法推导系数，计算 `latent = C1 * x - C2 * eps`；
//! 5. 潜空间解码：运行 TAESD `vae_decoder.mnn` 解码 latent 为 [-1, 1] 图像 [1, 3, 512, 512]；
//! 6. 格式转换：转换并夹取为 0..255 的 HWC 布局 RGB 图像（512*512*3 字节）。

use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::time::Instant;

use tokenizers::Tokenizer;

use crate::backend::{GraphSession, GraphValue};
use crate::error::{AiError, Result};
use crate::logo_post::{process_symbol, SymbolOutcome};
use crate::task::CancelToken;

/// 文本编码器模型文件名。
pub const MODEL_TEXT_ENCODER: &str = "text_encoder.mnn";
/// UNet 噪声预测模型文件名。
pub const MODEL_UNET: &str = "unet.mnn";
/// TAESD VAE 解码器模型文件名。
pub const MODEL_VAE_DECODER: &str = "vae_decoder.mnn";
/// 分词器配置文件名。
pub const FILE_TOKENIZER_JSON: &str = "tokenizer.json";

/// 文本编码器输入节点名。
pub const INPUT_IDS: &str = "input_ids";
/// 文本编码器输出节点名。
pub const OUTPUT_LAST_HIDDEN_STATE: &str = "last_hidden_state";

/// UNet 样本输入节点名（初始噪声或潜变量）。
pub const INPUT_SAMPLE: &str = "sample";
/// UNet 文本隐状态输入节点名。
pub const INPUT_ENCODER_HIDDEN_STATES: &str = "encoder_hidden_states";
/// UNet 噪声预测输出节点名。
pub const OUTPUT_OUT_SAMPLE: &str = "out_sample";

/// VAE 解码器潜变量输入节点名。
pub const INPUT_LATENT_SAMPLE: &str = "latent_sample";
/// VAE 解码器图像输出节点名。
pub const OUTPUT_SAMPLE: &str = "sample";

/// CLIP 文本序列固定长度（含首尾特殊标记）。
pub const TOKEN_LEN: usize = 77;
/// CLIP 起始特殊标记 BOS。
pub const TOKEN_BOS: i32 = 49406;
/// CLIP 终止与补齐特殊标记 EOS/PAD。
pub const TOKEN_EOS: i32 = 49407;
/// BOS 文本符号。
pub const STR_BOS_TOKEN: &str = "<|startoftext|>";
/// EOS 文本符号。
pub const STR_EOS_TOKEN: &str = "<|endoftext|>";

/// 文本隐藏层特征维度。
pub const TEXT_EMBED_DIM: usize = 768;
/// 文本嵌入张量总元素数（77 * 768 = 59136）。
pub const TEXT_EMBED_ELEMS: usize = TOKEN_LEN * TEXT_EMBED_DIM;

/// 潜空间通道数。
pub const LATENT_CHANNELS: usize = 4;
/// 潜空间单边长。
pub const LATENT_SIDE: usize = 64;
/// 潜空间总元素数（4 * 64 * 64 = 16384）。
pub const LATENT_ELEMS: usize = LATENT_CHANNELS * LATENT_SIDE * LATENT_SIDE;

/// 生成图像边长（512）。
pub const IMAGE_SIDE: usize = 512;
/// 生成图像通道数（RGB 3 通道）。
pub const IMAGE_CHANNELS: usize = 3;
/// 生成图像单平面像素数（512 * 512 = 262144）。
pub const IMAGE_PLANE_ELEMS: usize = IMAGE_SIDE * IMAGE_SIDE;
/// 生成图像总元素数（3 * 512 * 512 = 786432）。
pub const IMAGE_ELEMS: usize = IMAGE_CHANNELS * IMAGE_PLANE_ELEMS;

/// 调度器训练时间步总数（来自 scheduler_config.json 的 num_train_timesteps）。
pub const NUM_TRAIN_TIMESTEPS: usize = 1000;
/// 调度器起始噪声方差（来自 scheduler_config.json 的 beta_start）。
pub const BETA_START: f64 = 0.00085;
/// 调度器终止噪声方差（来自 scheduler_config.json 的 beta_end）。
pub const BETA_END: f64 = 0.012;
/// 一步采样的起始时间步索引（t=999）。
pub const STEP_TIMESTEP_START: usize = 999;
/// 一步采样的目标时间步索引（t=0）。
pub const STEP_TIMESTEP_TARGET: usize = 0;

/// 潜空间张量形状 `[1, 4, 64, 64]`。
const LATENT_SHAPE: [i64; 4] = [1, LATENT_CHANNELS as i64, LATENT_SIDE as i64, LATENT_SIDE as i64];
/// 错误文案：常驻模型未就绪。
const ERR_RESIDENT_NOT_READY: &str = "常驻模型未就绪";
/// 错误文案：文本编码器没有输出。
const ERR_NO_TEXT_ENCODER_OUTPUT: &str = "文本编码器未产生输出";
/// 错误文案：UNet 没有输出。
const ERR_NO_UNET_OUTPUT: &str = "UNet 未产生输出";
/// 错误文案：VAE 解码器没有输出。
const ERR_NO_VAE_OUTPUT: &str = "VAE 解码器未产生输出";

/// 浮点数比较容差。
const EPSILON: f64 = 1e-12;
/// SplitMix64 乘法常量 1。
const SPLITMIX_GAMMA: u64 = 0x9E3779B97F4A7C15;
/// SplitMix64 混合乘数 A。
const SPLITMIX_MUL_A: u64 = 0xBF58476D1CE4E5B9;
/// SplitMix64 混合乘数 B。
const SPLITMIX_MUL_B: u64 = 0x94D049BB133111EB;
/// 2 的 53 次方（用于将 53 位随机整数映射到 (0, 1) 的 f64）。
const TWO_POW_53: f64 = 9007199254740992.0;

/// 模型图加载器 trait：根据路径和输入输出名称加载图会话。
pub trait GraphLoader: Send {
    /// 产生的图会话类型。
    type G: GraphSession;

    /// 按名加载图会话。
    ///
    /// # 参数
    /// - `model`: 模型文件路径
    /// - `inputs`: 输入节点名称列表
    /// - `outputs`: 输出节点名称列表
    ///
    /// # 返回
    /// 成功时返回已就绪的图会话
    fn load(&self, model: &Path, inputs: &[&str], outputs: &[&str]) -> Result<Self::G>;

    /// 会话释放后归还内存（MNN 要丢缓存缓冲并让分配器退页）；默认什么都不做。
    ///
    /// `PerStage` 每段释放之后与 [`LogoGenerator::unload`] 都会调用它。
    fn release_memory(&self) {}
}

/// 内存驻留模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Residency {
    /// 三张图加载后常驻内存（速度最快，真机峰值约 1.3GB）。
    Resident,
    /// 每阶段用完立即释放会话（真机峰值降至约 720MB，低内存兜底），下次调用时重新加载。
    PerStage,
}

/// 文生图阶段枚举，用于执行进度回调。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogoStage {
    /// 文本分词
    Tokenize,
    /// 文本特征编码
    TextEncode,
    /// UNet 噪声预测（一步）
    Unet,
    /// TAESD 潜空间解码
    Decode,
    /// 后处理（二值化、符号提取、闸门、描摹），仅 [`LogoGenerator::generate`] 会上报
    Post,
}

/// 各阶段耗时统计（单位：毫秒）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GenTimings {
    /// 文本分词耗时。
    pub tokenize_ms: u64,
    /// 文本编码器推理耗时。
    pub text_ms: u64,
    /// UNet 单步推理耗时。
    pub unet_ms: u64,
    /// 一步采样公式计算耗时。
    pub step_ms: u64,
    /// TAESD 解码器推理耗时。
    pub vae_ms: u64,
    /// 模型加载耗时（PerStage 累加每阶段加载耗时，Resident 为重新加载耗时）。
    pub load_ms: u64,
    /// 总耗时。
    pub total_ms: u64,
}

/// 生成结果图像。
#[derive(Debug, Clone, PartialEq)]
pub struct RenderedImage {
    /// 生成的 512x512 RGB 像素字节，HWC 布局，长度 512*512*3 字节。
    pub rgb: Vec<u8>,
    /// 一步采样后的潜空间向量（长度 16384），供对拍比对使用。
    pub latent: Vec<f32>,
    /// 各阶段耗时明细。
    pub timings: GenTimings,
}

/// 常驻模式下的三个模型会话。
struct ResidentNets<G> {
    /// 文本编码器
    text_encoder: G,
    /// UNet
    unet: G,
    /// VAE 解码器
    vae_decoder: G,
}

/// 分段模式下的临时会话守卫：离开作用域时先销毁会话，再让加载器归还内存。
///
/// 无论正常返回还是中途 `?` 提前返回都会触发，保证低内存兜底模式出错也不漏归还。
struct StageGuard<'a, L: GraphLoader> {
    /// 临时会话（用 Option 是为了在 `drop` 里先于 `release_memory` 销毁它）
    session: Option<L::G>,
    /// 模型加载器
    loader: &'a L,
}

impl<L: GraphLoader> Drop for StageGuard<'_, L> {
    /// 先销毁会话，再调用 `release_memory`。
    fn drop(&mut self) {
        self.session = None;
        self.loader.release_memory();
    }
}

/// SDXS 一步生成引擎。
pub struct LogoGenerator<L: GraphLoader> {
    /// 模型加载器
    loader: L,
    /// 模型所在目录
    dir: PathBuf,
    /// 内存驻留模式
    residency: Residency,
    /// CLIP 分词器
    tokenizer: Tokenizer,
    /// 常驻会话（仅在 Resident 模式下持有，调用 `unload` 后清空）
    resident_nets: Option<ResidentNets<L::G>>,
}

impl<L: GraphLoader> std::fmt::Debug for LogoGenerator<L> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LogoGenerator")
            .field("dir", &self.dir)
            .field("residency", &self.residency)
            .field("is_loaded", &self.is_loaded())
            .finish()
    }
}

impl<L: GraphLoader> LogoGenerator<L> {
    /// 创建生成器实例。
    ///
    /// # 参数
    /// - `loader`: 图加载器实现
    /// - `dir`: 模型文件所在目录（包含 `tokenizer.json` 与三个 `.mnn` 文件）
    /// - `residency`: 驻留模式；`Resident` 立即加载三张图，`PerStage` 仅检查三个模型文件存在
    ///
    /// # 返回
    /// 成功返回生成器实例；配置不合法或文件缺失返回 [`AiError::InvalidConfig`]
    ///
    /// # 示例
    /// ```ignore
    /// let gen = LogoGenerator::new(loader, PathBuf::from("models/sdxs"), Residency::Resident)?;
    /// ```
    pub fn new(loader: L, dir: PathBuf, residency: Residency) -> Result<Self> {
        let tok_path = dir.join(FILE_TOKENIZER_JSON);
        let tokenizer = load_tokenizer(&tok_path)?;

        check_models_exist(&dir)?;

        let resident_nets = match residency {
            Residency::Resident => {
                let nets = load_all_nets(&loader, &dir)?;
                Some(nets)
            }
            Residency::PerStage => None,
        };

        Ok(Self {
            loader,
            dir,
            residency,
            tokenizer,
            resident_nets,
        })
    }

    /// 获取当前的内存驻留模式。
    pub fn residency(&self) -> Residency {
        self.residency
    }

    /// 查询模型当前是否已常驻加载在内存中。
    pub fn is_loaded(&self) -> bool {
        self.resident_nets.is_some()
    }

    /// 释放常驻模型占用的内存。
    ///
    /// 分词器依然保留；若后续再次调用 `render`，将自动重新加载模型。
    pub fn unload(&mut self) {
        self.resident_nets = None;
        self.loader.release_memory();
    }

    /// 跑一段模型：常驻模式用已加载的会话，分段模式临时加载、用完立即销毁并归还内存（出错也归还）。
    ///
    /// 参数：`model_name` 模型文件名；`inputs`/`outputs` 节点名；`load_ms` 累加加载耗时；
    /// `pick` 从常驻会话里挑出本段的会话；`run` 在会话上做实际推理并返回结果。
    fn run_stage<R>(
        &mut self,
        model_name: &str,
        inputs: &[&str],
        outputs: &[&str],
        load_ms: &mut u64,
        pick: impl FnOnce(&mut ResidentNets<L::G>) -> &mut L::G,
        run: impl FnOnce(&mut L::G) -> Result<R>,
    ) -> Result<R> {
        match self.residency {
            Residency::Resident => {
                let nets = self
                    .resident_nets
                    .as_mut()
                    .ok_or_else(|| AiError::Backend(ERR_RESIDENT_NOT_READY.into()))?;
                run(pick(nets))
            }
            Residency::PerStage => {
                let t_load = Instant::now();
                let sess = self.loader.load(&self.dir.join(model_name), inputs, outputs)?;
                *load_ms += t_load.elapsed().as_millis() as u64;
                let mut guard = StageGuard { session: Some(sess), loader: &self.loader };
                let sess = guard.session.as_mut().expect("会话刚创建");
                run(sess)
            }
        }
    }

    /// 使用外部注入的噪声进行文生图渲染。
    ///
    /// # 参数
    /// - `prompt`: 文本提示词
    /// - `noise`: 外部指定的初始噪声（长度必须为 [`LATENT_ELEMS`]）
    /// - `cancel`: 取消令牌，在各阶段边界检查
    /// - `on_stage`: 阶段进度回调
    ///
    /// # 返回
    /// 生成的 512x512 RGB 图像及采样中间数据
    ///
    /// # 示例
    /// ```ignore
    /// let img = gen.render("a cat", &noise, &CancelToken::new(), &mut |_| {})?;
    /// ```
    pub fn render(
        &mut self,
        prompt: &str,
        noise: &[f32],
        cancel: &CancelToken,
        on_stage: &mut dyn FnMut(LogoStage),
    ) -> Result<RenderedImage> {
        if noise.len() != LATENT_ELEMS {
            return Err(AiError::InvalidConfig(format!(
                "初始噪声长度必须为 {LATENT_ELEMS}，实际 {}",
                noise.len()
            )));
        }

        let total_start = Instant::now();
        let mut timings = GenTimings::default();

        cancel.check()?;

        // 若为 Resident 模式且先前被 unload，惰性重新加载三张图
        if self.residency == Residency::Resident && self.resident_nets.is_none() {
            let t_load = Instant::now();
            let nets = load_all_nets(&self.loader, &self.dir)?;
            timings.load_ms += t_load.elapsed().as_millis() as u64;
            self.resident_nets = Some(nets);
        }

        // 阶段 1：分词
        cancel.check()?;
        on_stage(LogoStage::Tokenize);
        let t_tok = Instant::now();
        let token_ids = tokenize(&self.tokenizer, prompt)?;
        timings.tokenize_ms = t_tok.elapsed().as_millis() as u64;

        // 阶段 2：文本特征编码
        cancel.check()?;
        on_stage(LogoStage::TextEncode);
        let t_text = Instant::now();
        let emb = self.run_stage(
            MODEL_TEXT_ENCODER,
            &[INPUT_IDS],
            &[OUTPUT_LAST_HIDDEN_STATE],
            &mut timings.load_ms,
            |nets| &mut nets.text_encoder,
            |sess| {
                let val_ids = sess.value_i32(&[1, TOKEN_LEN as i64], &token_ids)?;
                let outs = sess.run(&[&val_ids])?;
                let out_first = outs
                    .first()
                    .ok_or_else(|| AiError::BadModelOutput(ERR_NO_TEXT_ENCODER_OUTPUT.into()))?;
                out_first.to_f32()
            },
        )?;

        if emb.len() != TEXT_EMBED_ELEMS {
            return Err(AiError::BadModelOutput(format!(
                "文本嵌入长度不符：预期 {TEXT_EMBED_ELEMS}，实际 {}",
                emb.len()
            )));
        }
        timings.text_ms = t_text.elapsed().as_millis() as u64;

        // 阶段 3：UNet 一步预测噪声
        cancel.check()?;
        on_stage(LogoStage::Unet);
        let t_unet = Instant::now();
        let eps = self.run_stage(
            MODEL_UNET,
            &[INPUT_SAMPLE, INPUT_ENCODER_HIDDEN_STATES],
            &[OUTPUT_OUT_SAMPLE],
            &mut timings.load_ms,
            |nets| &mut nets.unet,
            |sess| {
                let v_sample = sess.value_f32(&LATENT_SHAPE, noise)?;
                let v_emb = sess.value_f32(&[1, TOKEN_LEN as i64, TEXT_EMBED_DIM as i64], &emb)?;
                let outs = sess.run(&[&v_sample, &v_emb])?;
                let out_first = outs
                    .first()
                    .ok_or_else(|| AiError::BadModelOutput(ERR_NO_UNET_OUTPUT.into()))?;
                out_first.to_f32()
            },
        )?;

        if eps.len() != LATENT_ELEMS {
            return Err(AiError::BadModelOutput(format!(
                "UNet 噪声预测长度不符：预期 {LATENT_ELEMS}，实际 {}",
                eps.len()
            )));
        }
        timings.unet_ms = t_unet.elapsed().as_millis() as u64;

        // 一步采样计算
        let t_step = Instant::now();
        let (c1, c2) = step_coeffs();
        let latent = apply_step(noise, &eps, c1, c2);
        timings.step_ms = t_step.elapsed().as_millis() as u64;

        // 阶段 4：TAESD 解码
        cancel.check()?;
        on_stage(LogoStage::Decode);
        let t_vae = Instant::now();
        let img_sample = self.run_stage(
            MODEL_VAE_DECODER,
            &[INPUT_LATENT_SAMPLE],
            &[OUTPUT_SAMPLE],
            &mut timings.load_ms,
            |nets| &mut nets.vae_decoder,
            |sess| {
                let v_latent = sess.value_f32(&LATENT_SHAPE, &latent)?;
                let outs = sess.run(&[&v_latent])?;
                let out_first = outs
                    .first()
                    .ok_or_else(|| AiError::BadModelOutput(ERR_NO_VAE_OUTPUT.into()))?;
                out_first.to_f32()
            },
        )?;

        if img_sample.len() != IMAGE_ELEMS {
            return Err(AiError::BadModelOutput(format!(
                "VAE 输出长度不符：预期 {IMAGE_ELEMS}，实际 {}",
                img_sample.len()
            )));
        }

        cancel.check()?;

        let rgb = image_to_rgb_u8(&img_sample);
        timings.vae_ms = t_vae.elapsed().as_millis() as u64;
        timings.total_ms = total_start.elapsed().as_millis() as u64;

        Ok(RenderedImage {
            rgb,
            latent,
            timings,
        })
    }

    /// 使用随机种子生成噪声并执行文生图渲染。
    ///
    /// # 参数
    /// - `prompt`: 文本提示词
    /// - `seed`: PRNG 随机种子
    /// - `cancel`: 取消令牌
    /// - `on_stage`: 阶段进度回调
    ///
    /// # 返回
    /// 生成的 512x512 RGB 图像及采样中间数据
    ///
    /// # 示例
    /// ```ignore
    /// let img = gen.generate_noise_render("a house", 42, &CancelToken::new(), &mut |_| {})?;
    /// ```
    pub fn generate_noise_render(
        &mut self,
        prompt: &str,
        seed: u64,
        cancel: &CancelToken,
        on_stage: &mut dyn FnMut(LogoStage),
    ) -> Result<RenderedImage> {
        let noise = noise_from_seed(seed);
        self.render(prompt, &noise, cancel, on_stage)
    }

    /// 出图并做后处理（二值化、符号提取、闸门、描摹）。
    ///
    /// # 参数
    /// - `prompt`: 已拼好的英文提示词
    /// - `noise`: 初始噪声（长度 [`LATENT_ELEMS`]）；一般用 [`noise_from_seed`]，对拍时注入外部噪声
    /// - `remove_ring`: 后处理是否去掉模型自画的外圈
    /// - `cancel`: 取消令牌，分词、文本编码、UNet、解码、后处理各段之间都会检查
    /// - `on_stage`: 阶段回调，依次收到 Tokenize / TextEncode / Unet / Decode / Post
    ///
    /// # 返回
    /// 生成图（含各段耗时）与后处理结果；闸门没过时 `symbol.svg` 仍可能有值，由调用方看 `symbol.gate.ok` 取舍
    ///
    /// # 示例
    /// ```ignore
    /// let out = gen.generate_with_noise(prompt, &noise_from_seed(1), true, &CancelToken::new(), &mut |_| {})?;
    /// ```
    pub fn generate_with_noise(
        &mut self,
        prompt: &str,
        noise: &[f32],
        remove_ring: bool,
        cancel: &CancelToken,
        on_stage: &mut dyn FnMut(LogoStage),
    ) -> Result<LogoOutput> {
        let render = self.render(prompt, noise, cancel, on_stage)?;
        cancel.check()?;
        on_stage(LogoStage::Post);
        let symbol = process_symbol(&render.rgb, remove_ring, cancel)?;
        Ok(LogoOutput { render, symbol })
    }

    /// 同 [`Self::generate_with_noise`]，噪声由种子确定性生成。
    ///
    /// # 示例
    /// ```ignore
    /// let out = gen.generate(prompt, 1, true, &CancelToken::new(), &mut |_| {})?;
    /// ```
    pub fn generate(
        &mut self,
        prompt: &str,
        seed: u64,
        remove_ring: bool,
        cancel: &CancelToken,
        on_stage: &mut dyn FnMut(LogoStage),
    ) -> Result<LogoOutput> {
        self.generate_with_noise(prompt, &noise_from_seed(seed), remove_ring, cancel, on_stage)
    }
}

/// 一次完整生成的结果：位图与后处理。
#[derive(Debug, Clone, PartialEq)]
pub struct LogoOutput {
    /// 生成的 512x512 位图、latent 与出图耗时
    pub render: RenderedImage,
    /// 后处理结果（掩码、特征、闸门、SVG path 与耗时）
    pub symbol: SymbolOutcome,
}

/// 检查目录下三个 .mnn 模型文件是否存在。
fn check_models_exist(dir: &Path) -> Result<()> {
    for name in [MODEL_TEXT_ENCODER, MODEL_UNET, MODEL_VAE_DECODER] {
        let path = dir.join(name);
        if !path.is_file() {
            return Err(AiError::InvalidConfig(format!(
                "缺失模型文件：{}",
                path.display()
            )));
        }
    }
    Ok(())
}

/// 一次性加载全部三个模型。
fn load_all_nets<L: GraphLoader>(loader: &L, dir: &Path) -> Result<ResidentNets<L::G>> {
    let text_encoder = loader.load(
        &dir.join(MODEL_TEXT_ENCODER),
        &[INPUT_IDS],
        &[OUTPUT_LAST_HIDDEN_STATE],
    )?;
    let unet = loader.load(
        &dir.join(MODEL_UNET),
        &[INPUT_SAMPLE, INPUT_ENCODER_HIDDEN_STATES],
        &[OUTPUT_OUT_SAMPLE],
    )?;
    let vae_decoder = loader.load(
        &dir.join(MODEL_VAE_DECODER),
        &[INPUT_LATENT_SAMPLE],
        &[OUTPUT_SAMPLE],
    )?;
    Ok(ResidentNets {
        text_encoder,
        unet,
        vae_decoder,
    })
}

/// 从文件加载分词器并校验 BOS/EOS 标记 ID。
fn load_tokenizer(path: &Path) -> Result<Tokenizer> {
    let bytes = fs::read(path).map_err(|e| {
        AiError::InvalidConfig(format!("读取分词器文件 {} 失败：{e}", path.display()))
    })?;

    let tk = match catch_unwind(AssertUnwindSafe(|| Tokenizer::from_bytes(bytes))) {
        Ok(Ok(tk)) => tk,
        Ok(Err(e)) => return Err(AiError::InvalidConfig(format!("分词器解析失败：{e}"))),
        Err(_) => return Err(AiError::InvalidConfig("分词器解析时发生异常".into())),
    };

    if tk.token_to_id(STR_BOS_TOKEN) != Some(TOKEN_BOS as u32) {
        return Err(AiError::InvalidConfig(format!(
            "分词器 BOS 符号 {STR_BOS_TOKEN} 的 id 与预期 {TOKEN_BOS} 不符"
        )));
    }
    if tk.token_to_id(STR_EOS_TOKEN) != Some(TOKEN_EOS as u32) {
        return Err(AiError::InvalidConfig(format!(
            "分词器 EOS 符号 {STR_EOS_TOKEN} 的 id 与预期 {TOKEN_EOS} 不符"
        )));
    }

    Ok(tk)
}

/// 对 token id 序列进行补齐或截断到固定长度 77。
///
/// - 超过 77：保留前 76 个，第 77 个强制替换为 EOS 符号（49407，符合 HF CLIPTokenizer 行为）；
/// - 不足 77：末尾用 EOS/PAD 符号（49407）补齐。
///
/// # 参数
/// - `ids`: 原始 token id 切片
///
/// # 返回
/// 长度固定为 77 的 i32 数组
///
/// # 示例
/// ```ignore
/// let ids = pad_or_truncate(&[49406, 12, 49407]);
/// assert_eq!(ids.len(), 77);
/// ```
pub fn pad_or_truncate(ids: &[u32]) -> [i32; TOKEN_LEN] {
    let mut out = [TOKEN_EOS; TOKEN_LEN];
    if ids.len() > TOKEN_LEN {
        for (i, &id) in ids[..TOKEN_LEN - 1].iter().enumerate() {
            out[i] = id as i32;
        }
        out[TOKEN_LEN - 1] = TOKEN_EOS;
    } else {
        for (i, &id) in ids.iter().enumerate() {
            out[i] = id as i32;
        }
    }
    out
}

/// 对输入文本进行分词，并格式化为固定的 77 维序列。
///
/// # 参数
/// - `tokenizer`: CLIP 分词器
/// - `prompt`: 输入文本
///
/// # 返回
/// 成功返回固定长度为 77 的 token id 数组
///
/// # 示例
/// ```ignore
/// let ids = tokenize(&tk, "a bubble tea")?;
/// ```
pub fn tokenize(tokenizer: &Tokenizer, prompt: &str) -> Result<[i32; TOKEN_LEN]> {
    let enc = tokenizer
        .encode(prompt, true)
        .map_err(|e| AiError::InvalidConfig(format!("分词失败：{e}")))?;
    Ok(pad_or_truncate(enc.get_ids()))
}

/// SplitMix64 伪随机数发生器。
struct SplitMix64 {
    /// 内部 64 位状态
    state: u64,
}

impl SplitMix64 {
    /// 以指定种子初始化发生器。
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    /// 生成下一个 64 位无符号随机整数。
    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(SPLITMIX_GAMMA);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(SPLITMIX_MUL_A);
        z = (z ^ (z >> 27)).wrapping_mul(SPLITMIX_MUL_B);
        z ^ (z >> 31)
    }

    /// 生成 (0, 1) 区间内的双精度浮点数（排除 0.0 与 1.0）。
    fn next_f64(&mut self) -> f64 {
        loop {
            let u = self.next_u64();
            let val = ((u >> 11) as f64) / TWO_POW_53;
            if val > 0.0 && val < 1.0 {
                return val;
            }
        }
    }
}

/// 根据随机种子生成确定性的潜变量高斯白噪声。
///
/// 算法：SplitMix64 生成均匀伪随机数，经 Box-Muller 变换生成标准正态分布 N(0, 1)。
///
/// # 参数
/// - `seed`: 64 位随机种子
///
/// # 返回
/// 长度为 [`LATENT_ELEMS`] (16384) 的单精度浮点向量
///
/// # 示例
/// ```ignore
/// let noise = noise_from_seed(1);
/// assert_eq!(noise.len(), 16384);
/// ```
pub fn noise_from_seed(seed: u64) -> Vec<f32> {
    let mut rng = SplitMix64::new(seed);
    let mut out = Vec::with_capacity(LATENT_ELEMS);
    let pairs = LATENT_ELEMS / 2;

    for _ in 0..pairs {
        let u1 = rng.next_f64();
        let u2 = rng.next_f64();
        let r = (-2.0 * u1.ln()).sqrt();
        let theta = 2.0 * std::f64::consts::PI * u2;
        let z0 = r * theta.cos();
        let z1 = r * theta.sin();
        out.push(z0 as f32);
        out.push(z1 as f32);
    }

    out
}

/// 计算 scaled_linear 噪声表的累计乘积序列 `alphas_cumprod`。
///
/// 算法与来源：
/// 来源自 diffusers 库 `DEISMultistepScheduler` 与 `EulerDiscreteScheduler`（`beta_schedule="scaled_linear"`）。
/// `betas = linspace(sqrt(beta_start), sqrt(beta_end), n)^2`
/// `alphas = 1.0 - betas`
/// `alphas_cumprod = cumprod(alphas)`
/// diffusers 在初始化时以单精度浮点进行 linspace 与 cumprod 计算，再转为双精度。
///
/// # 参数
/// - `n`: 训练时间步总数（通常为 1000）
/// - `beta_start`: 起始 beta 值（0.00085）
/// - `beta_end`: 终止 beta 值（0.012）
///
/// # 返回
/// 长度为 `n` 的双精度 `alphas_cumprod` 序列
///
/// # 示例
/// ```ignore
/// let ac = scheduler_alphas_cumprod(1000, 0.00085, 0.012);
/// assert_eq!(ac.len(), 1000);
/// ```
pub fn scheduler_alphas_cumprod(n: usize, beta_start: f64, beta_end: f64) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        let beta = beta_start as f32;
        return vec![(1.0f32 - beta) as f64];
    }

    let b_start = beta_start.sqrt() as f32;
    let b_end = beta_end.sqrt() as f32;
    let denom = (n - 1) as f32;

    let mut ac = Vec::with_capacity(n);
    let mut prod = 1.0f32;
    for i in 0..n {
        let b = b_start + (i as f32 / denom) * (b_end - b_start);
        let beta = b * b;
        prod *= 1.0f32 - beta;
        ac.push(prod as f64);
    }
    ac
}

/// 计算一步采样公式的五个中间物理常数 `(αs, σs, αn, σn, h)`。
///
/// 来源：`sdxs_lib.py::schedule_consts` 与 `results.md` 第 2 节。
///
/// # 参数
/// - `ac_start`: 采样起始时间步（t=999）的 alphas_cumprod
/// - `ac_end`: 采样终止时间步（t=0）的 alphas_cumprod
///
/// # 返回
/// `(alpha_s, sigma_s, alpha_n, sigma_n, h)`
pub fn one_step_constants(ac_start: f64, ac_end: f64) -> (f64, f64, f64, f64, f64) {
    let (ac_s, ac_n) = (ac_start, ac_end);

    let s0 = ((1.0 - ac_s) / ac_s.max(EPSILON)).sqrt();
    let s1 = ((1.0 - ac_n) / ac_n.max(EPSILON)).sqrt();
    let alpha_s = 1.0 / (s0 * s0 + 1.0).sqrt();
    let alpha_n = 1.0 / (s1 * s1 + 1.0).sqrt();
    let sigma_s = s0 * alpha_s;
    let sigma_n = s1 * alpha_n;
    let h = (alpha_n.ln() - sigma_n.ln()) - (alpha_s.ln() - sigma_s.ln());

    (alpha_s, sigma_s, alpha_n, sigma_n, h)
}

/// 计算 DEIS 一阶（等价 DDIM）的一步采样系数 `(C1, C2)`。
///
/// 公式：
/// `latent = C1 * noise - C2 * eps`
/// 其中：
/// `C1 = αn / αs`
/// `C2 = σn * (e^h - 1)`
///
/// # 参数
/// - `ac_start`: 采样起始时间步（t=999）的 alphas_cumprod
/// - `ac_end`: 采样终止时间步（t=0）的 alphas_cumprod
///
/// # 返回
/// 一步采样系数 `(C1, C2)`（双精度）
///
/// # 示例
/// ```ignore
/// let (c1, c2) = one_step_coeffs(0.00466, 0.99915);
/// ```
pub fn one_step_coeffs(ac_start: f64, ac_end: f64) -> (f64, f64) {
    let (alpha_s, _, alpha_n, sigma_n, h) = one_step_constants(ac_start, ac_end);
    let c1 = alpha_n / alpha_s;
    let c2 = sigma_n * (h.exp() - 1.0);
    (c1, c2)
}

/// 获取当前 SDXS 一步采样的单精度缩放系数 `(C1, C2)`。
///
/// 基于默认的 1000 步训练噪声表与时间步 `999 -> 0` 推导得出，现算开销极低。
///
/// # 返回
/// `(C1, C2)`，单精度浮点数
///
/// # 示例
/// ```ignore
/// let (c1, c2) = step_coeffs();
/// ```
pub fn step_coeffs() -> (f32, f32) {
    let ac = scheduler_alphas_cumprod(NUM_TRAIN_TIMESTEPS, BETA_START, BETA_END);
    let ac_start = ac[STEP_TIMESTEP_START];
    let ac_end = ac[STEP_TIMESTEP_TARGET];
    let (c1, c2) = one_step_coeffs(ac_start, ac_end);
    (c1 as f32, c2 as f32)
}

/// 执行一步采样公式：`latent = c1 * noise - c2 * eps`。
///
/// # 参数
/// - `noise`: 初始噪声向量，长度为 [`LATENT_ELEMS`]
/// - `eps`: UNet 预测的噪声残差向量，长度为 [`LATENT_ELEMS`]
/// - `c1`: 噪声缩放系数 C1
/// - `c2`: 残差缩放系数 C2
///
/// # 返回
/// 采样后的潜变量向量，长度与输入相同
///
/// # 示例
/// ```ignore
/// let latent = apply_step(&noise, &eps, 14.6444, 14.6040);
/// ```
pub fn apply_step(noise: &[f32], eps: &[f32], c1: f32, c2: f32) -> Vec<f32> {
    noise
        .iter()
        .zip(eps.iter())
        .map(|(&n, &e)| c1 * n - c2 * e)
        .collect()
}

/// 将 VAE 解码出的 NCHW `[1, 3, 512, 512]` 图像张量转换为 HWC 的 RGB 8 位图像字节。
///
/// 转换公式：`u8 = round(clamp(x / 2 + 0.5, 0, 1) * 255)`。
///
/// # 参数
/// - `chw`: VAE 解码器输出数据（顺序为 R 平面、G 平面、B 平面，长度为 3*512*512）
///
/// # 返回
/// 连续交错排布的 RGB 像素字节，长度为 512*512*3
///
/// # 示例
/// ```ignore
/// let rgb = image_to_rgb_u8(&sample);
/// assert_eq!(rgb.len(), 512 * 512 * 3);
/// ```
pub fn image_to_rgb_u8(chw: &[f32]) -> Vec<u8> {
    let plane_size = IMAGE_PLANE_ELEMS;
    if chw.len() < IMAGE_ELEMS {
        return Vec::new();
    }

    let r_plane = &chw[0..plane_size];
    let g_plane = &chw[plane_size..2 * plane_size];
    let b_plane = &chw[2 * plane_size..3 * plane_size];

    let mut out = vec![0u8; IMAGE_ELEMS];

    for i in 0..plane_size {
        let base = i * IMAGE_CHANNELS;
        let r = (r_plane[i] * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0;
        let g = (g_plane[i] * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0;
        let b = (b_plane[i] * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0;

        out[base] = (r + 0.5).floor() as u8;
        out[base + 1] = (g + 0.5).floor() as u8;
        out[base + 2] = (b + 0.5).floor() as u8;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// 极小 BPE 分词器配置 JSON，用于测试分词、补齐与特殊标记校验。
    const TINY_TOKENIZER_JSON: &str = r#"{
      "version": "1.0",
      "truncation": null,
      "padding": null,
      "added_tokens": [
        {
          "id": 49406,
          "content": "<|startoftext|>",
          "single_word": false,
          "lstrip": false,
          "rstrip": false,
          "normalized": false,
          "special": true
        },
        {
          "id": 49407,
          "content": "<|endoftext|>",
          "single_word": false,
          "lstrip": false,
          "rstrip": false,
          "normalized": false,
          "special": true
        }
      ],
      "normalizer": null,
      "pre_tokenizer": { "type": "Whitespace" },
      "post_processor": {
        "type": "RobertaProcessing",
        "sep": ["<|endoftext|>", 49407],
        "cls": ["<|startoftext|>", 49406],
        "trim_offsets": false,
        "add_prefix_space": false
      },
      "decoder": null,
      "model": {
        "type": "BPE",
        "dropout": null,
        "unk_token": null,
        "continuing_subword_prefix": null,
        "end_of_word_suffix": null,
        "fuse_unk": false,
        "byte_fallback": false,
        "vocab": {
          "a": 0,
          "b": 1,
          "<|startoftext|>": 49406,
          "<|endoftext|>": 49407
        },
        "merges": []
      }
    }"#;

    /// Mock 张量句柄。
    struct MockVal {
        shape: Vec<i64>,
        data_f32: Vec<f32>,
        data_i32: Vec<i32>,
    }

    impl GraphValue for MockVal {
        fn shape(&self) -> Vec<i64> {
            self.shape.clone()
        }
        fn to_f32(&self) -> Result<Vec<f32>> {
            if !self.data_f32.is_empty() {
                Ok(self.data_f32.clone())
            } else {
                Err(AiError::BadModelOutput("非 f32 张量".into()))
            }
        }
        fn to_i32(&self) -> Result<Vec<i32>> {
            if !self.data_i32.is_empty() {
                Ok(self.data_i32.clone())
            } else {
                Err(AiError::BadModelOutput("非 i32 张量".into()))
            }
        }
    }

    /// 单次前向调用记录。
    #[derive(Clone)]
    struct CallRecord {
        model_name: String,
        input_shapes: Vec<Vec<i64>>,
    }

    /// Mock 图会话。
    struct MockSession {
        name: String,
        ins: Vec<String>,
        outs: Vec<String>,
        active_counter: Arc<AtomicUsize>,
        records: Arc<Mutex<Vec<CallRecord>>>,
        cancel_token: Option<CancelToken>,
        bad_output_len: Option<usize>,
    }

    impl Drop for MockSession {
        fn drop(&mut self) {
            self.active_counter.fetch_sub(1, Ordering::SeqCst);
        }
    }

    impl GraphSession for MockSession {
        type Value = MockVal;

        fn input_names(&self) -> &[String] {
            &self.ins
        }

        fn output_names(&self) -> &[String] {
            &self.outs
        }

        fn value_f32(&self, shape: &[i64], data: &[f32]) -> Result<MockVal> {
            Ok(MockVal {
                shape: shape.to_vec(),
                data_f32: data.to_vec(),
                data_i32: Vec::new(),
            })
        }

        fn value_i32(&self, shape: &[i64], data: &[i32]) -> Result<MockVal> {
            Ok(MockVal {
                shape: shape.to_vec(),
                data_f32: Vec::new(),
                data_i32: data.to_vec(),
            })
        }

        fn run(&mut self, inputs: &[&MockVal]) -> Result<Vec<MockVal>> {
            if let Some(token) = &self.cancel_token {
                token.cancel();
            }

            self.records.lock().unwrap().push(CallRecord {
                model_name: self.name.clone(),
                input_shapes: inputs.iter().map(|v| v.shape.clone()).collect(),
            });

            if let Some(bad_len) = self.bad_output_len {
                return Ok(vec![MockVal {
                    shape: vec![bad_len as i64],
                    data_f32: vec![0.0; bad_len],
                    data_i32: Vec::new(),
                }]);
            }

            if self.name == MODEL_TEXT_ENCODER {
                Ok(vec![MockVal {
                    shape: vec![1, TOKEN_LEN as i64, TEXT_EMBED_DIM as i64],
                    data_f32: vec![1.0; TEXT_EMBED_ELEMS],
                    data_i32: Vec::new(),
                }])
            } else if self.name == MODEL_UNET {
                Ok(vec![MockVal {
                    shape: vec![1, 4, 64, 64],
                    data_f32: vec![0.0; LATENT_ELEMS],
                    data_i32: Vec::new(),
                }])
            } else if self.name == MODEL_VAE_DECODER {
                Ok(vec![MockVal {
                    shape: vec![1, 3, IMAGE_SIDE as i64, IMAGE_SIDE as i64],
                    data_f32: vec![0.0; IMAGE_ELEMS],
                    data_i32: Vec::new(),
                }])
            } else {
                Err(AiError::Unsupported("未知模型".into()))
            }
        }
    }

    /// Mock 模型加载器。
    #[derive(Clone)]
    struct MockLoader {
        load_count: Arc<AtomicUsize>,
        active_count: Arc<AtomicUsize>,
        records: Arc<Mutex<Vec<CallRecord>>>,
        cancel_in_model: Arc<Mutex<Option<(String, CancelToken)>>>,
        bad_output_model: Arc<Mutex<Option<(String, usize)>>>,
    }

    impl MockLoader {
        fn new() -> Self {
            Self {
                load_count: Arc::new(AtomicUsize::new(0)),
                active_count: Arc::new(AtomicUsize::new(0)),
                records: Arc::new(Mutex::new(Vec::new())),
                cancel_in_model: Arc::new(Mutex::new(None)),
                bad_output_model: Arc::new(Mutex::new(None)),
            }
        }
    }

    impl GraphLoader for MockLoader {
        type G = MockSession;

        fn load(&self, model: &Path, inputs: &[&str], outputs: &[&str]) -> Result<Self::G> {
            self.load_count.fetch_add(1, Ordering::SeqCst);
            self.active_count.fetch_add(1, Ordering::SeqCst);

            let model_name = model
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();

            let cancel = self.cancel_in_model.lock().unwrap().as_ref().and_then(|(m, t)| {
                if m == &model_name {
                    Some(t.clone())
                } else {
                    None
                }
            });

            let bad_len = self.bad_output_model.lock().unwrap().as_ref().and_then(|(m, len)| {
                if m == &model_name {
                    Some(*len)
                } else {
                    None
                }
            });

            Ok(MockSession {
                name: model_name,
                ins: inputs.iter().map(|&s| s.to_string()).collect(),
                outs: outputs.iter().map(|&s| s.to_string()).collect(),
                active_counter: self.active_count.clone(),
                records: self.records.clone(),
                cancel_token: cancel,
                bad_output_len: bad_len,
            })
        }
    }

    /// 创建包含极小 tokenizer.json 和三个空 .mnn 文件的临时测试目录。
    fn create_test_env(suffix: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("arkli_sdxs_test_{suffix}_{}_{}", std::process::id(), id));
        fs::create_dir_all(&dir).unwrap();

        fs::write(dir.join(FILE_TOKENIZER_JSON), TINY_TOKENIZER_JSON).unwrap();
        fs::write(dir.join(MODEL_TEXT_ENCODER), b"").unwrap();
        fs::write(dir.join(MODEL_UNET), b"").unwrap();
        fs::write(dir.join(MODEL_VAE_DECODER), b"").unwrap();

        dir
    }

    #[test]
    fn 一步采样调度器常数推导与七位已知值吻合() {
        let ac = scheduler_alphas_cumprod(NUM_TRAIN_TIMESTEPS, BETA_START, BETA_END);
        assert_eq!(ac.len(), 1000);

        let ac_start = ac[STEP_TIMESTEP_START];
        let ac_end = ac[STEP_TIMESTEP_TARGET];

        let (alpha_s, sigma_s, alpha_n, sigma_n, h) = one_step_constants(ac_start, ac_end);

        // 已知参考值（来自 results.md 第 2 节及 diffusers DEIS 实测）
        let ref_alpha_s = 0.0682649;
        let ref_sigma_s = 0.9976672;
        let ref_alpha_n = 0.9995749;
        let ref_sigma_n = 0.0291551;
        let ref_h = 6.216723;

        assert!((alpha_s - ref_alpha_s).abs() < 1e-6, "alpha_s 实际 {alpha_s}");
        assert!((sigma_s - ref_sigma_s).abs() < 1e-6, "sigma_s 实际 {sigma_s}");
        assert!((alpha_n - ref_alpha_n).abs() < 1e-6, "alpha_n 实际 {alpha_n}");
        assert!((sigma_n - ref_sigma_n).abs() < 1e-6, "sigma_n 实际 {sigma_n}");
        assert!((h - ref_h).abs() < 1e-6, "h 实际 {h}");

        let (c1, c2) = one_step_coeffs(ac_start, ac_end);
        let exact_c1 = 0.999574898724882 / 0.06826488913185079;
        let exact_c2 = 0.029155134010013496 * ((6.21672328553459f64).exp() - 1.0);

        let rel_err_c1 = ((c1 - exact_c1) / exact_c1).abs();
        let rel_err_c2 = ((c2 - exact_c2) / exact_c2).abs();

        assert!(rel_err_c1 < 1e-6, "C1 相对误差 {rel_err_c1}");
        assert!(rel_err_c2 < 1e-6, "C2 相对误差 {rel_err_c2}");
    }

    #[test]
    fn 一步采样公式计算() {
        let noise = vec![1.0, 2.0, -1.5];
        let eps = vec![0.0, 0.0, 0.0];
        let (c1, c2) = step_coeffs();

        let latent = apply_step(&noise, &eps, c1, c2);
        assert!((latent[0] - c1 * 1.0).abs() < 1e-5);
        assert!((latent[1] - c1 * 2.0).abs() < 1e-5);
        assert!((latent[2] - c1 * -1.5).abs() < 1e-5);
    }

    #[test]
    fn 图像格式转换与像素映射() {
        let plane_len = IMAGE_PLANE_ELEMS;
        let mut chw = vec![0.0f32; IMAGE_ELEMS];

        // 像素 0 设为 -1.0，像素 1 设为 1.0，像素 2 设为 0.0
        chw[0] = -1.0;
        chw[plane_len] = -1.0;
        chw[2 * plane_len] = -1.0;

        chw[1] = 1.0;
        chw[plane_len + 1] = 1.0;
        chw[2 * plane_len + 1] = 1.0;

        chw[2] = 0.0;
        chw[plane_len + 2] = 0.0;
        chw[2 * plane_len + 2] = 0.0;

        let rgb = image_to_rgb_u8(&chw);
        assert_eq!(rgb.len(), IMAGE_ELEMS);

        // -1 -> 0
        assert_eq!(rgb[0], 0);
        assert_eq!(rgb[1], 0);
        assert_eq!(rgb[2], 0);

        // 1 -> 255
        assert_eq!(rgb[3], 255);
        assert_eq!(rgb[4], 255);
        assert_eq!(rgb[5], 255);

        // 0 -> 128
        assert_eq!(rgb[6], 128);
        assert_eq!(rgb[7], 128);
        assert_eq!(rgb[8], 128);
    }

    #[test]
    fn 确定性噪声同种子复现与不同种子差异() {
        let n1 = noise_from_seed(42);
        let n2 = noise_from_seed(42);
        let n3 = noise_from_seed(12345);

        assert_eq!(n1.len(), LATENT_ELEMS);
        assert_eq!(n1, n2);
        assert_ne!(n1, n3);
        assert!(n1.iter().all(|x| x.is_finite()));

        let mean = n1.iter().map(|&x| x as f64).sum::<f64>() / (LATENT_ELEMS as f64);
        let var = n1.iter().map(|&x| (x as f64 - mean).powi(2)).sum::<f64>() / (LATENT_ELEMS as f64);

        assert!(mean.abs() < 0.03, "均值偏差过大: {mean}");
        assert!((var - 1.0).abs() < 0.05, "方差偏差过大: {var}");
    }

    #[test]
    fn 分词补齐与截断逻辑() {
        let short_ids = vec![49406, 10, 20, 49407];
        let padded = pad_or_truncate(&short_ids);
        assert_eq!(padded.len(), TOKEN_LEN);
        assert_eq!(&padded[0..4], &[49406, 10, 20, 49407]);
        assert!(padded[4..].iter().all(|&id| id == TOKEN_EOS));

        let exact_ids: Vec<u32> = (0..TOKEN_LEN as u32).collect();
        let unchanged = pad_or_truncate(&exact_ids);
        assert_eq!(unchanged[0], 0);
        assert_eq!(unchanged[TOKEN_LEN - 1], (TOKEN_LEN - 1) as i32);

        let long_ids: Vec<u32> = (0..100).collect();
        let truncated = pad_or_truncate(&long_ids);
        assert_eq!(truncated.len(), TOKEN_LEN);
        assert_eq!(truncated[0], 0);
        assert_eq!(truncated[75], 75);
        assert_eq!(truncated[76], TOKEN_EOS);
    }

    #[test]
    fn 极小分词器完整路径测试() {
        let dir = create_test_env("tok");
        let tk = load_tokenizer(&dir.join(FILE_TOKENIZER_JSON)).unwrap();

        let ids = tokenize(&tk, "a b").unwrap();
        assert_eq!(ids.len(), TOKEN_LEN);
        assert_eq!(ids[0], TOKEN_BOS);
        assert_eq!(ids[1], 0); // "a"
        assert_eq!(ids[2], 1); // "b"
        assert_eq!(ids[3], TOKEN_EOS);
        assert!(ids[4..].iter().all(|&id| id == TOKEN_EOS));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resident模式单次加载与unload重新加载() {
        let dir = create_test_env("resident");
        let loader = MockLoader::new();

        let mut gen = LogoGenerator::new(loader.clone(), dir.clone(), Residency::Resident).unwrap();
        assert_eq!(loader.load_count.load(Ordering::SeqCst), 3);
        assert_eq!(loader.active_count.load(Ordering::SeqCst), 3);
        assert!(gen.is_loaded());

        let cancel = CancelToken::new();
        let noise = noise_from_seed(1);
        let res1 = gen.render("hello", &noise, &cancel, &mut |_| {}).unwrap();
        assert_eq!(res1.rgb.len(), IMAGE_ELEMS);
        assert_eq!(loader.load_count.load(Ordering::SeqCst), 3);

        gen.unload();
        assert!(!gen.is_loaded());
        assert_eq!(loader.active_count.load(Ordering::SeqCst), 0);

        let res2 = gen.render("world", &noise, &cancel, &mut |_| {}).unwrap();
        assert_eq!(res2.rgb.len(), IMAGE_ELEMS);
        assert_eq!(loader.load_count.load(Ordering::SeqCst), 6);
        assert_eq!(loader.active_count.load(Ordering::SeqCst), 3);
        assert!(gen.is_loaded());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn perstage模式每段用完即释放() {
        let dir = create_test_env("perstage");
        let loader = MockLoader::new();

        let mut gen = LogoGenerator::new(loader.clone(), dir.clone(), Residency::PerStage).unwrap();
        assert_eq!(loader.load_count.load(Ordering::SeqCst), 0);
        assert_eq!(loader.active_count.load(Ordering::SeqCst), 0);
        assert!(!gen.is_loaded());

        let cancel = CancelToken::new();
        let noise = noise_from_seed(1);
        let res = gen.render("hello", &noise, &cancel, &mut |_| {}).unwrap();
        assert_eq!(res.rgb.len(), IMAGE_ELEMS);

        // 加载了 3 次，但调用完成后全部释放，活跃计数归零
        assert_eq!(loader.load_count.load(Ordering::SeqCst), 3);
        assert_eq!(loader.active_count.load(Ordering::SeqCst), 0);

        let records = loader.records.lock().unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(records[0].model_name, MODEL_TEXT_ENCODER);
        assert_eq!(records[0].input_shapes, vec![vec![1, TOKEN_LEN as i64]]);
        assert_eq!(records[1].model_name, MODEL_UNET);
        assert_eq!(
            records[1].input_shapes,
            vec![
                vec![1, LATENT_CHANNELS as i64, LATENT_SIDE as i64, LATENT_SIDE as i64],
                vec![1, TOKEN_LEN as i64, TEXT_EMBED_DIM as i64],
            ]
        );
        assert_eq!(records[2].model_name, MODEL_VAE_DECODER);
        assert_eq!(
            records[2].input_shapes,
            vec![vec![1, LATENT_CHANNELS as i64, LATENT_SIDE as i64, LATENT_SIDE as i64]]
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 各阶段边界取消与会话可复用() {
        let dir = create_test_env("cancel");
        let noise = noise_from_seed(1);

        // 1. 在分词前已取消
        {
            let loader = MockLoader::new();
            let mut gen = LogoGenerator::new(loader, dir.clone(), Residency::Resident).unwrap();
            let cancel = CancelToken::new();
            cancel.cancel();

            assert_eq!(
                gen.render("hello", &noise, &cancel, &mut |_| {}),
                Err(AiError::Cancelled)
            );

            // 换新令牌后同一 Generator 成功出图
            let new_cancel = CancelToken::new();
            assert!(gen.render("hello", &noise, &new_cancel, &mut |_| {}).is_ok());
        }

        // 2. 在文本编码中取消
        {
            let loader = MockLoader::new();
            let cancel = CancelToken::new();
            *loader.cancel_in_model.lock().unwrap() = Some((MODEL_TEXT_ENCODER.to_string(), cancel.clone()));

            let mut gen = LogoGenerator::new(loader.clone(), dir.clone(), Residency::PerStage).unwrap();
            assert_eq!(
                gen.render("hello", &noise, &cancel, &mut |_| {}),
                Err(AiError::Cancelled)
            );
            // 活跃会话已随退出而释放
            assert_eq!(loader.active_count.load(Ordering::SeqCst), 0);

            *loader.cancel_in_model.lock().unwrap() = None;
            let new_cancel = CancelToken::new();
            assert!(gen.render("hello", &noise, &new_cancel, &mut |_| {}).is_ok());
        }

        // 3. 在 UNet 中取消
        {
            let loader = MockLoader::new();
            let cancel = CancelToken::new();
            *loader.cancel_in_model.lock().unwrap() = Some((MODEL_UNET.to_string(), cancel.clone()));

            let mut gen = LogoGenerator::new(loader.clone(), dir.clone(), Residency::Resident).unwrap();
            assert_eq!(
                gen.render("hello", &noise, &cancel, &mut |_| {}),
                Err(AiError::Cancelled)
            );

            *loader.cancel_in_model.lock().unwrap() = None;
            let new_cancel = CancelToken::new();
            assert!(gen.render("hello", &noise, &new_cancel, &mut |_| {}).is_ok());
        }

        // 4. 在 VAE 解码中取消
        {
            let loader = MockLoader::new();
            let cancel = CancelToken::new();
            *loader.cancel_in_model.lock().unwrap() = Some((MODEL_VAE_DECODER.to_string(), cancel.clone()));

            let mut gen = LogoGenerator::new(loader.clone(), dir.clone(), Residency::PerStage).unwrap();
            assert_eq!(
                gen.render("hello", &noise, &cancel, &mut |_| {}),
                Err(AiError::Cancelled)
            );

            *loader.cancel_in_model.lock().unwrap() = None;
            let new_cancel = CancelToken::new();
            assert!(gen.render("hello", &noise, &new_cancel, &mut |_| {}).is_ok());
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 异常输入与模型错误处理() {
        let dir = create_test_env("error");
        let loader = MockLoader::new();

        let mut gen = LogoGenerator::new(loader.clone(), dir.clone(), Residency::Resident).unwrap();
        let cancel = CancelToken::new();

        // 1. 噪声长度不正确
        let bad_noise = vec![0.0f32; 100];
        assert!(matches!(
            gen.render("hello", &bad_noise, &cancel, &mut |_| {}),
            Err(AiError::InvalidConfig(_))
        ));

        // 2. 模型输出尺寸异常（在 PerStage 模式下触发）
        let mut gen_stage = LogoGenerator::new(loader.clone(), dir.clone(), Residency::PerStage).unwrap();
        *loader.bad_output_model.lock().unwrap() = Some((MODEL_TEXT_ENCODER.to_string(), 10));
        let noise = noise_from_seed(1);
        assert!(matches!(
            gen_stage.render("hello", &noise, &cancel, &mut |_| {}),
            Err(AiError::BadModelOutput(_))
        ));

        // 3. 缺失模型文件
        let missing_dir = dir.join("missing_sub");
        fs::create_dir_all(&missing_dir).unwrap();
        fs::write(missing_dir.join(FILE_TOKENIZER_JSON), TINY_TOKENIZER_JSON).unwrap();
        let err = LogoGenerator::new(loader, missing_dir.clone(), Residency::PerStage).unwrap_err();
        match err {
            AiError::InvalidConfig(msg) => {
                assert!(msg.contains(MODEL_TEXT_ENCODER), "错误信息未包含缺失模型名：{msg}");
            }
            _ => panic!("预期 InvalidConfig 错误"),
        }

        let _ = fs::remove_dir_all(&missing_dir);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn generate阶段顺序与空图后处理() {
        let dir = create_test_env("generate");
        let loader = MockLoader::new();
        let mut gen = LogoGenerator::new(loader, dir.clone(), Residency::Resident).unwrap();
        let mut stages = Vec::new();
        let out = gen.generate("hello", 7, true, &CancelToken::new(), &mut |s| stages.push(s)).unwrap();
        assert_eq!(stages, vec![LogoStage::Tokenize, LogoStage::TextEncode, LogoStage::Unet, LogoStage::Decode, LogoStage::Post]);
        // mock 的解码图是纯灰：后处理判空图，不描摹，闸门不过
        assert!(out.symbol.features.empty && out.symbol.svg.is_none() && !out.symbol.gate.ok);
        assert_eq!(out.render.rgb.len(), IMAGE_ELEMS);
        // 与 render 用同一噪声得到同一张图
        let again = gen.render("hello", &noise_from_seed(7), &CancelToken::new(), &mut |_| {}).unwrap();
        assert_eq!(again.rgb, out.render.rgb);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 后处理前已取消则不做后处理且可再生成() {
        let dir = create_test_env("postcancel");
        let loader = MockLoader::new();
        let cancel = CancelToken::new();
        *loader.cancel_in_model.lock().unwrap() = Some((MODEL_VAE_DECODER.to_string(), cancel.clone()));
        let mut gen = LogoGenerator::new(loader.clone(), dir.clone(), Residency::PerStage).unwrap();
        let mut stages = Vec::new();
        assert_eq!(gen.generate("hello", 1, true, &cancel, &mut |s| stages.push(s)).map(|_| ()), Err(AiError::Cancelled));
        assert!(!stages.contains(&LogoStage::Post));
        *loader.cancel_in_model.lock().unwrap() = None;
        assert!(gen.generate("hello", 1, true, &CancelToken::new(), &mut |_| {}).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 释放内存钩子在分段与卸载时被调用() {
        let dir = create_test_env("release");
        let released = Arc::new(AtomicUsize::new(0));
        struct Counting(MockLoader, Arc<AtomicUsize>);
        impl GraphLoader for Counting {
            type G = MockSession;
            fn load(&self, m: &Path, i: &[&str], o: &[&str]) -> Result<MockSession> {
                self.0.load(m, i, o)
            }
            fn release_memory(&self) {
                self.1.fetch_add(1, Ordering::SeqCst);
            }
        }
        let mut gen = LogoGenerator::new(Counting(MockLoader::new(), released.clone()), dir.clone(), Residency::PerStage).unwrap();
        gen.render("hello", &noise_from_seed(1), &CancelToken::new(), &mut |_| {}).unwrap();
        // 三段各释放一次
        assert_eq!(released.load(Ordering::SeqCst), 3);
        gen.unload();
        assert_eq!(released.load(Ordering::SeqCst), 4);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 分段模式某段出错也归还内存() {
        let dir = create_test_env("release_err");
        let released = Arc::new(AtomicUsize::new(0));
        struct Counting(MockLoader, Arc<AtomicUsize>);
        impl GraphLoader for Counting {
            type G = MockSession;
            fn load(&self, m: &Path, i: &[&str], o: &[&str]) -> Result<MockSession> {
                self.0.load(m, i, o)
            }
            fn release_memory(&self) {
                self.1.fetch_add(1, Ordering::SeqCst);
            }
        }
        let inner = MockLoader::new();
        // UNet 的输出是空张量：`to_f32` 在段内报错，走 `?` 提前返回
        *inner.bad_output_model.lock().unwrap() = Some((MODEL_UNET.to_string(), 0));
        let active = inner.active_count.clone();
        let mut gen = LogoGenerator::new(Counting(inner, released.clone()), dir.clone(), Residency::PerStage).unwrap();
        let err = gen.render("hello", &noise_from_seed(1), &CancelToken::new(), &mut |_| {}).unwrap_err();
        assert!(matches!(err, AiError::BadModelOutput(_)), "{err:?}");
        // 文本编码一次 + 出错的 UNet 一次
        assert_eq!(released.load(Ordering::SeqCst), 2);
        assert_eq!(active.load(Ordering::SeqCst), 0, "出错后不应残留会话");
        let _ = fs::remove_dir_all(&dir);
    }
}
