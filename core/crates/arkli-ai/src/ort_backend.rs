//! 基于 `ort`（load-dynamic）的真实推理后端。仅在 feature `ort-backend` 下编译。
//!
//! 运行时通过 [`OrtBackend::load`] 指定 `libonnxruntime.so`（APK 里用裸名即可与 sherpa 共享同一份）。
//! 宿主机没有该库，所以本模块只做编译检查；需要真库的测试标了 `#[ignore]`。

use std::ffi::CStr;
use std::path::Path;

use ort::environment::Environment;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session as OrtSession;
use ort::value::Tensor as OrtTensor;

use crate::backend::{InferenceBackend, Session, Tensor};
use crate::error::{AiError, Result};
use crate::provider::SessionOptions;

/// ORT 后端。持有环境句柄。
pub struct OrtBackend {
    /// ORT 全局环境（会话创建需要）
    env: Environment,
}

/// 把 ort 的错误统一转成 [`AiError::Backend`]。
fn be<E: std::fmt::Display>(e: E) -> AiError {
    AiError::Backend(e.to_string())
}

impl OrtBackend {
    /// 动态加载 ORT 库并初始化环境。
    ///
    /// - `dylib_path`：`libonnxruntime.so`（或 Windows 上的 `onnxruntime.dll`）路径
    /// - 版本不匹配时返回 [`AiError::Backend`]（运行期 `BadVersion`，不会崩溃）
    pub fn load(dylib_path: impl AsRef<Path>) -> Result<Self> {
        let env = ort::init_from(dylib_path)
            .map_err(be)?
            .build()
            .map_err(be)?;
        Ok(Self { env })
    }
}

impl InferenceBackend for OrtBackend {
    fn available_providers(&self) -> Result<Vec<String>> {
        let api = ort::api();
        let mut list: *mut *mut std::os::raw::c_char = std::ptr::null_mut();
        let mut n: std::os::raw::c_int = 0;
        // SAFETY：按 ORT C API 约定传出参数；返回的数组用 ReleaseAvailableProviders 释放。
        unsafe {
            let status = (api.GetAvailableProviders)(&mut list, &mut n);
            if !status.0.is_null() {
                (api.ReleaseStatus)(status.0);
                return Err(AiError::Backend("GetAvailableProviders 失败".into()));
            }
            let names = (0..n as isize)
                .map(|i| {
                    CStr::from_ptr(*list.offset(i))
                        .to_string_lossy()
                        .into_owned()
                })
                .collect();
            let status = (api.ReleaseAvailableProviders)(list, n);
            if !status.0.is_null() {
                (api.ReleaseStatus)(status.0);
            }
            Ok(names)
        }
    }

    fn load_model(&self, model_path: &Path, options: &SessionOptions) -> Result<Box<dyn Session>> {
        // 目前只有 CPU 路径：该 ORT 无 XNNPACK，NNAPI 默认不开。
        // 允许 NNAPI 需要打开 ort 的 `nnapi` 特性并在此注册，留待真机验证后再接。
        let mut builder = OrtSession::builder(&self.env)
            .map_err(be)?
            .with_optimization_level(GraphOptimizationLevel::All)
            .map_err(be)?
            .with_intra_threads(options.intra_threads as usize)
            .map_err(be)?
            .with_inter_threads(1)
            .map_err(be)?;
        let session = builder.commit_from_file(model_path).map_err(be)?;
        Ok(Box::new(OrtModel { session }))
    }
}

/// 一个已加载的 ORT 会话。
struct OrtModel {
    /// ort 会话
    session: OrtSession,
}

impl Session for OrtModel {
    fn run(&mut self, input: Tensor) -> Result<Tensor> {
        let name = self.session.inputs()[0].name().to_string();
        let value = OrtTensor::from_array((input.shape, input.data)).map_err(be)?;
        let outputs = self
            .session
            .run(ort::inputs![name.as_str() => value])
            .map_err(be)?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(be)?;
        Tensor::new(shape.iter().copied().collect(), data.to_vec())
    }

    fn run_named(&mut self, input: Tensor, output: &str) -> Result<Tensor> {
        let name = self.session.inputs()[0].name().to_string();
        let value = OrtTensor::from_array((input.shape, input.data)).map_err(be)?;
        let outputs = self
            .session
            .run(ort::inputs![name.as_str() => value])
            .map_err(be)?;
        let (shape, data) = outputs[output].try_extract_tensor::<f32>().map_err(be)?;
        Tensor::new(shape.iter().copied().collect(), data.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{Provider, CPU_PROVIDER_NAME};

    /// 指向 ORT 动态库的环境变量名。
    const ENV_DYLIB: &str = "ARKLI_ORT_DYLIB";
    /// 指向 PP-OCR 检测模型（ch_PP-OCRv5_det_mobile.onnx）的环境变量名。
    const ENV_DET_MODEL: &str = "ARKLI_OCR_DET_MODEL";

    /// 运行条件：设置 ARKLI_ORT_DYLIB 指向 onnxruntime 动态库（版本须 >= 1.17）。
    /// 命令：`cargo test -p arkli-ai --features ort-backend -- --ignored`
    #[test]
    #[ignore = "需要 ARKLI_ORT_DYLIB 指向 onnxruntime 动态库"]
    fn 真实ort能列出provider且含cpu() {
        let path = std::env::var(ENV_DYLIB).expect("未设置 ARKLI_ORT_DYLIB");
        let backend = OrtBackend::load(path).unwrap();
        let list = backend.available_providers().unwrap();
        assert!(list.iter().any(|n| n == CPU_PROVIDER_NAME), "{list:?}");
    }

    /// 运行条件：同上，另设置 ARKLI_OCR_DET_MODEL 指向检测模型文件。
    #[test]
    #[ignore = "需要 ARKLI_ORT_DYLIB 与 ARKLI_OCR_DET_MODEL"]
    fn 真实ort跑通检测模型() {
        let dylib = std::env::var(ENV_DYLIB).expect("未设置 ARKLI_ORT_DYLIB");
        let model = std::env::var(ENV_DET_MODEL).expect("未设置 ARKLI_OCR_DET_MODEL");
        let backend = OrtBackend::load(dylib).unwrap();
        let opts = SessionOptions {
            provider: Provider::Cpu,
            intra_threads: 2,
        };
        let mut s = backend.load_model(Path::new(&model), &opts).unwrap();
        let input = Tensor::new(vec![1, 3, 64, 64], vec![0.0; 3 * 64 * 64]).unwrap();
        let out = s.run(input).unwrap();
        assert_eq!(out.shape, vec![1, 1, 64, 64]);
    }
}

#[cfg(test)]
mod clip_tests {
    use super::*;
    use crate::clip::ClipEncoder;
    use crate::image::{PixelFormat, RawImage};
    use crate::provider::{Provider, SessionOptions};

    /// 读取环境变量，没设置就让测试失败并说明。
    fn env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("未设置 {name}"))
    }

    /// 运行条件：ARKLI_ORT_DYLIB（ORT 动态库）、ARKLI_CLIP_MODEL（q4_half.onnx）、
    /// ARKLI_CLIP_RGB（前 8 字节为小端 u32 宽高，其后是原图 RGB）、
    /// ARKLI_CLIP_EXPECT（PC 端 PIL 预处理得到的 768 个小端 f32 向量，已归一化）。
    /// 命令：`cargo test -p arkli-ai --features ort-backend -- --ignored clip`
    #[test]
    #[ignore = "需要 ARKLI_ORT_DYLIB / ARKLI_CLIP_MODEL / ARKLI_CLIP_RGB / ARKLI_CLIP_EXPECT"]
    fn 真实ort编码向量与pc参考接近() {
        let backend = OrtBackend::load(env("ARKLI_ORT_DYLIB")).unwrap();
        let opts = SessionOptions {
            provider: Provider::Cpu,
            intra_threads: 4,
        };
        let session = backend
            .load_model(Path::new(&env("ARKLI_CLIP_MODEL")), &opts)
            .unwrap();
        let raw = std::fs::read(env("ARKLI_CLIP_RGB")).unwrap();
        let w = u32::from_le_bytes(raw[0..4].try_into().unwrap());
        let h = u32::from_le_bytes(raw[4..8].try_into().unwrap());
        let img = RawImage::new(w, h, PixelFormat::Rgb, raw[8..].to_vec()).unwrap();
        let got = ClipEncoder::new(session).embed(&img).unwrap();
        let expect: Vec<f32> = std::fs::read(env("ARKLI_CLIP_EXPECT"))
            .unwrap()
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        assert_eq!(got.len(), expect.len());
        let cos: f32 = got.iter().zip(&expect).map(|(a, b)| a * b).sum();
        println!("与 PC 参考向量的余弦 = {cos}");
        assert!(cos > 0.999, "余弦 {cos}");
    }
}
