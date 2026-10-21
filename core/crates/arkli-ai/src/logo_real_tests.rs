//! logo 符号生成的真库 / 真模型测试（全部 `#[ignore]`）：真 `arkli-mnn.dll` + SDXS 三个 MNN 模型 + 桌面原型的参考输出。
//!
//! 运行：
//! ```text
//! ARKLI_MNN_DYLIB=<arkli-mnn.dll>          （同目录要有 MNN.dll）
//! ARKLI_LOGO_DIR=<模型目录>                 （text_encoder.mnn / unet.mnn / vae_decoder.mnn / tokenizer.json，推荐档：text w8 + unet w8 + vae fp32）
//! ARKLI_LOGO_SPIKE=<sdxs-mnn 原型目录>      （in/<id>_ids.bin、in/<id>_noise.bin、out/int8/<id>_latent.bin|_img.bin、out/ref/<id>_latent.npy）
//! ARKLI_LOGO_GOLDEN=<golden.json>           （sdxs_prepare.py --golden 的输出，已提交一份：testdata/logo_clip_golden.json）
//! ARKLI_LOGO_POST_REF=<目录>                （<tag>_<id>.rgb 与 post_ref.json：Python symbol.py / gate.py 在同一批图上的特征与闸门）
//! cargo test -p arkli-ai --features mnn-backend --release -- --ignored --nocapture logo真
//! ```
//! 各测试只读自己需要的环境变量，缺哪个就 panic 说明哪个。

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::AiError;
use crate::logo_gen::{noise_from_seed, tokenize, LogoStage, Residency, LATENT_ELEMS};
use crate::logo_post::{process_symbol, SYMBOL_CANVAS};
use crate::mnn::MnnRuntime;
use crate::task::CancelToken;

/// 线程数（真机实测 4 线程最优）。
const THREADS: u32 = 4;
/// P7 提示词模板（sdxs_lib.py 的 P7，`{c}` 换成概念）。
const PROMPT_P7_PREFIX: &str = "flat pictogram glyph of ";
/// P7 提示词模板后半段。
const PROMPT_P7_SUFFIX: &str = ", solid black emoji silhouette, bold simple shape, minimalist icon, white background";
/// 8 个对拍用例：(id, 概念)，与 sdxs_lib.py 的 CASES 一致。
const CASES: [(&str, &str); 8] = [
    ("bubbletea", "a bubble tea cup with a straw"),
    ("yoga", "a meditating person in lotus pose"),
    ("startup", "a rocket"),
    ("farm", "a carrot"),
    ("photo", "a camera"),
    ("cathead", "a cat head"),
    ("kettlebell", "a kettlebell"),
    ("homestay", "a house with a heart"),
];
/// 与桌面 MNN 同模型同噪声时 latent 余弦的下限（同一份 MNN 内核，应几乎逐位一致）。
const MIN_COS_VS_DESKTOP: f64 = 0.999;
/// 与桌面 MNN 同模型同噪声时图像 PSNR 的下限（dB）。
const MIN_PSNR_VS_DESKTOP: f64 = 40.0;
/// 特征数值对拍的容差：旋转对称 IoU（我们是最近邻旋转，不与 scipy 逐像素一致）。
const TOL_ROT_IOU: f64 = 0.08;
/// 特征数值对拍的容差：比例类特征。
const TOL_RATIO: f64 = 0.01;
/// 后处理闸门结论允许与 Python 不一致的最多张数（旋转实现不同可能让边缘样本翻转）。
const MAX_GATE_MISMATCH: usize = 2;
/// 后处理对拍：掩码像素数允许与 Python 相差的最大值（边缘连通块过滤的浮点取整差异）。
const MAX_MASK_DIFF: i64 = 16;
/// 分词对拍里 id 的补齐长度。
const TOKENS: usize = 77;

/// 读必需的环境变量。
fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("未设置 {name}"))
}

/// 拼 P7 提示词。
fn prompt_of(concept: &str) -> String {
    format!("{PROMPT_P7_PREFIX}{concept}{PROMPT_P7_SUFFIX}")
}

/// 读小端 f32 文件。
fn read_f32(p: &Path) -> Vec<f32> {
    std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display())).chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

/// 读小端 i32 文件。
fn read_i32(p: &Path) -> Vec<i32> {
    std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display())).chunks_exact(4).map(|b| i32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

/// 读 numpy v1 的 float32 `.npy`（只支持 C 序小端，够用即可）。
fn read_npy_f32(p: &Path) -> Vec<f32> {
    let raw = std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    let header_len = u16::from_le_bytes([raw[8], raw[9]]) as usize;
    raw[10 + header_len..].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

/// 余弦相似度。
fn cosine(a: &[f32], b: &[f32]) -> f64 {
    let dot: f64 = a.iter().zip(b).map(|(&x, &y)| x as f64 * y as f64).sum();
    let na: f64 = a.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
    let nb: f64 = b.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
    dot / (na * nb)
}

/// 两张 u8 图的 PSNR（dB），完全相同返回无穷大。
fn psnr(a: &[u8], b: &[u8]) -> f64 {
    let mse = a.iter().zip(b).map(|(&x, &y)| (x as f64 - y as f64).powi(2)).sum::<f64>() / a.len() as f64;
    if mse == 0.0 {
        f64::INFINITY
    } else {
        10.0 * (255.0f64 * 255.0 / mse).log10()
    }
}

/// 原型 `_img.bin`（float32 NCHW，[-1,1]）转 HWC 的 u8，公式同 sdxs_lib.to_uint8。
fn spike_img_to_u8(chw: &[f32]) -> Vec<u8> {
    let plane = SYMBOL_CANVAS * SYMBOL_CANVAS;
    let mut out = vec![0u8; plane * 3];
    for i in 0..plane {
        for c in 0..3 {
            out[i * 3 + c] = ((chw[c * plane + i] / 2.0 + 0.5).clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
    out
}

/// 字节序列的确定性校验和（DefaultHasher::new 固定密钥，同输入同输出），用来证明重构前后逐位一致。
fn checksum(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// 加载 MNN 运行库。
fn runtime() -> MnnRuntime {
    MnnRuntime::load(env("ARKLI_MNN_DYLIB")).unwrap()
}

#[test]
#[ignore = "需要 ARKLI_LOGO_DIR / ARKLI_LOGO_GOLDEN"]
fn logo真_分词与transformers的id逐条一致() {
    let dir = PathBuf::from(env("ARKLI_LOGO_DIR"));
    let tk = tokenizers::Tokenizer::from_file(dir.join("tokenizer.json")).unwrap();
    let golden: Value = serde_json::from_slice(&std::fs::read(env("ARKLI_LOGO_GOLDEN")).unwrap()).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let text = c["text"].as_str().unwrap();
        let want: Vec<i32> = c["ids"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap() as i32).collect();
        assert_eq!(want.len(), TOKENS);
        let got = tokenize(&tk, text).unwrap();
        assert_eq!(got.to_vec(), want, "提示词分词不一致：{text:?}");
    }
    println!("分词对拍 {} 条全部一致", cases.len());
}

#[test]
#[ignore = "需要 ARKLI_LOGO_SPIKE / ARKLI_LOGO_DIR，且提示词分词要等于原型 ids.bin"]
fn logo真_提示词分词等于原型ids() {
    let spike = PathBuf::from(env("ARKLI_LOGO_SPIKE"));
    let tk = tokenizers::Tokenizer::from_file(PathBuf::from(env("ARKLI_LOGO_DIR")).join("tokenizer.json")).unwrap();
    for (id, concept) in CASES {
        let want = read_i32(&spike.join("in").join(format!("{id}_ids.bin")));
        assert_eq!(tokenize(&tk, &prompt_of(concept)).unwrap().to_vec(), want, "{id}");
    }
}

#[test]
#[ignore = "需要 ARKLI_LOGO_POST_REF"]
fn logo真_后处理与python特征闸门对拍() {
    let dir = PathBuf::from(env("ARKLI_LOGO_POST_REF"));
    let refs: Value = serde_json::from_slice(&std::fs::read(dir.join("post_ref.json")).unwrap()).unwrap();
    let mut mismatch = 0;
    for (key, r) in refs.as_object().unwrap() {
        let rgb = std::fs::read(dir.join(format!("{key}.rgb"))).unwrap();
        let out = process_symbol(&rgb, true, &CancelToken::new()).unwrap();
        let f = &out.features;
        let rf = &r["feats"];
        let num = |k: &str| rf[k].as_f64().unwrap();
        let want_ok = r["ok"].as_bool().unwrap();
        let want_why: Vec<String> = r["why"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        let got_why: Vec<&str> = out.gate.reasons.iter().map(|x| x.code()).collect();
        println!(
            "{key:18} ring={}/{} ink={:.4}/{:.4} rot={:.3}/{:.3} comps={}/{} specks={}/{} size={:.3}/{:.3} off={:.4}/{:.4} gate={}/{} {:?}/{:?} paths={}/{}",
            out.ring_detected, r["ring"], f.ink_canvas, num("ink_canvas"), f.rot_iou, num("rot_iou"), f.comps, num("comps"), f.specks, num("specks"),
            f.size_rel, num("size_rel"), f.off, num("off"), out.gate.ok, want_ok, got_why, want_why, out.svg.as_ref().map_or(0, |s| s.path_count), r["n_paths"]
        );
        // 二值化与连通域逻辑是确定的，必须逐项一致
        assert_eq!(out.ring_detected, r["ring"].as_bool().unwrap(), "{key} 外圈检测");
        let mask_sum = out.mask.iter().filter(|&&m| m).count() as i64;
        let want_sum = r["mask_sum"].as_i64().unwrap();
        println!("{key:18} 掩码像素 {mask_sum} / Python {want_sum}（差 {}）", mask_sum - want_sum);
        assert!((mask_sum - want_sum).abs() <= MAX_MASK_DIFF, "{key} 掩码像素数");
        assert_eq!((f.comps as f64, f.specks as f64), (num("comps"), num("specks")), "{key} 连通域");
        assert!((f.size_rel as f64 - num("size_rel")).abs() < TOL_RATIO, "{key} size_rel");
        assert!((f.off as f64 - num("off")).abs() < TOL_RATIO, "{key} off");
        assert!((f.rot_iou as f64 - num("rot_iou")).abs() < TOL_ROT_IOU, "{key} rot_iou");
        if out.gate.ok != want_ok || got_why != want_why.iter().map(String::as_str).collect::<Vec<_>>() {
            mismatch += 1;
        }
    }
    println!("闸门结论与 Python 不一致：{mismatch}/{}", refs.as_object().unwrap().len());
    assert!(mismatch <= MAX_GATE_MISMATCH, "闸门不一致过多");
}

#[test]
#[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_LOGO_DIR / ARKLI_LOGO_SPIKE，可选 ARKLI_LOGO_POST_REF"]
fn logo真_同噪声对拍桌面mnn并测取消与分段模式() {
    let rt = runtime();
    let dir = PathBuf::from(env("ARKLI_LOGO_DIR"));
    let spike = PathBuf::from(env("ARKLI_LOGO_SPIKE"));
    let ref_rgb_dir = std::env::var("ARKLI_LOGO_POST_REF").ok().map(PathBuf::from);
    let mut gen = rt.load_logo_gen(&dir, THREADS, Residency::Resident).unwrap();
    let (mut sum_cos, mut sum_psnr, mut sum_cos_ref, mut sum_psnr_ref) = (0.0, 0.0, 0.0, 0.0);
    let mut n_ref_psnr = 0;
    let mut first_rgb = Vec::new();
    for (id, concept) in CASES {
        let noise = read_f32(&spike.join("in").join(format!("{id}_noise.bin")));
        assert_eq!(noise.len(), LATENT_ELEMS);
        let img = gen.render(&prompt_of(concept), &noise, &CancelToken::new(), &mut |_| {}).unwrap();
        let want_latent = read_f32(&spike.join("out/int8").join(format!("{id}_latent.bin")));
        let want_img = spike_img_to_u8(&read_f32(&spike.join("out/int8").join(format!("{id}_img.bin"))));
        let cos = cosine(&img.latent, &want_latent);
        let p = psnr(&img.rgb, &want_img);
        let ref_latent = read_npy_f32(&spike.join("out/ref").join(format!("{id}_latent.npy")));
        let cos_ref = cosine(&img.latent, &ref_latent);
        let mut psnr_ref = f64::NAN;
        if let Some(d) = &ref_rgb_dir {
            let r = std::fs::read(d.join(format!("ref_{id}.rgb"))).unwrap();
            psnr_ref = psnr(&img.rgb, &r);
            sum_psnr_ref += psnr_ref;
            n_ref_psnr += 1;
        }
        let t = img.timings;
        println!(
            "{id:11} 桌面int8: latent余弦 {cos:.6} PSNR {p:.1}dB | PyTorch: latent余弦 {cos_ref:.4} PSNR {psnr_ref:.1}dB | text {}ms unet {}ms step {}ms vae {}ms 总 {}ms",
            t.text_ms, t.unet_ms, t.step_ms, t.vae_ms, t.total_ms
        );
        assert!(cos > MIN_COS_VS_DESKTOP && p > MIN_PSNR_VS_DESKTOP, "{id} 与桌面 MNN 参考对不上");
        sum_cos += cos;
        sum_psnr += p;
        sum_cos_ref += cos_ref;
        if first_rgb.is_empty() {
            first_rgb = img.rgb.clone();
        }
    }
    let n = CASES.len() as f64;
    println!("均值：对桌面int8 余弦 {:.6} PSNR {:.1}dB；对PyTorch 余弦 {:.4} PSNR {:.1}dB", sum_cos / n, sum_psnr / n, sum_cos_ref / n, sum_psnr_ref / n_ref_psnr.max(1) as f64);

    // 取消：已取消的令牌立刻返回；换新令牌后同一个引擎还能出图，且结果与取消前逐位一致
    let (id0, c0) = CASES[0];
    let noise0 = read_f32(&spike.join("in").join(format!("{id0}_noise.bin")));
    let t = CancelToken::new();
    t.cancel();
    assert_eq!(gen.render(&prompt_of(c0), &noise0, &t, &mut |_| {}).map(|_| ()), Err(AiError::Cancelled));
    let again = gen.render(&prompt_of(c0), &noise0, &CancelToken::new(), &mut |_| {}).unwrap();
    assert_eq!(again.rgb, first_rgb, "取消后再生成的结果应与之前逐位一致");

    // 执行中取消：进入 UNet 阶段时触发，一次前向不可打断，应在 UNet 后、解码前的检查点退出，且随后可再生成
    let t2 = CancelToken::new();
    let t2c = t2.clone();
    let started = std::time::Instant::now();
    let r = gen.render(&prompt_of(c0), &noise0, &t2, &mut |st| {
        if st == LogoStage::Unet {
            t2c.cancel();
        }
    });
    println!("执行中取消：{:?}，用时 {}ms", r.as_ref().map(|_| "未被打断").map_err(|e| e.to_string()), started.elapsed().as_millis());
    assert_eq!(r.map(|_| ()), Err(AiError::Cancelled), "执行中取消应返回 Cancelled");
    let after = gen.render(&prompt_of(c0), &noise0, &CancelToken::new(), &mut |_| {}).unwrap();
    assert_eq!(after.rgb, first_rgb, "执行中取消后再生成的结果应与之前逐位一致");

    // 分段卸载模式：结果应与常驻逐位一致
    drop(gen);
    let mut staged = rt.load_logo_gen(&dir, THREADS, Residency::PerStage).unwrap();
    let s = staged.render(&prompt_of(c0), &noise0, &CancelToken::new(), &mut |_| {}).unwrap();
    println!("分段卸载模式：总 {}ms（含加载 {}ms）", s.timings.total_ms, s.timings.load_ms);
    assert_eq!(s.rgb, first_rgb, "分段卸载与常驻应逐位一致");
    // 分段模式下的执行中取消也应返回 Cancelled，且之后可再生成
    let t3 = CancelToken::new();
    let t3c = t3.clone();
    let r3 = staged.render(&prompt_of(c0), &noise0, &t3, &mut |st| {
        if st == LogoStage::Unet {
            t3c.cancel();
        }
    });
    assert_eq!(r3.map(|_| ()), Err(AiError::Cancelled), "分段模式执行中取消应返回 Cancelled");
    let s2 = staged.render(&prompt_of(c0), &noise0, &CancelToken::new(), &mut |_| {}).unwrap();
    assert_eq!(s2.rgb, first_rgb, "分段模式取消后再生成应逐位一致");
    let sg = staged.generate(&prompt_of(c0), 1, true, &CancelToken::new(), &mut |_| {}).unwrap();
    println!("分段全流程 rgb#{:016x} svg#{:016x}", checksum(&sg.render.rgb), checksum(sg.symbol.svg.as_ref().map_or("", |x| x.paths.as_str()).as_bytes()));
}

#[test]
#[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_LOGO_DIR"]
fn logo真_种子出图全流程() {
    let rt = runtime();
    let mut gen = rt.load_logo_gen(&PathBuf::from(env("ARKLI_LOGO_DIR")), THREADS, Residency::Resident).unwrap();
    let mut stages = Vec::new();
    for (id, concept) in CASES {
        let out = gen.generate(&prompt_of(concept), 1, true, &CancelToken::new(), &mut |s| stages.push(s)).unwrap();
        let sym = &out.symbol;
        println!(
            "{id:11} rgb#{:016x} svg#{:016x} 闸门 {} {:?} 墨量 {:.3} paths {} svg {}B 耗时 出图{}ms 提取{}ms 特征{}ms 描摹{}ms",
            checksum(&out.render.rgb),
            checksum(sym.svg.as_ref().map_or("", |s| s.paths.as_str()).as_bytes()),
            sym.gate.ok,
            sym.gate.reasons.iter().map(|r| r.code()).collect::<Vec<_>>(),
            sym.features.ink_canvas,
            sym.svg.as_ref().map_or(0, |s| s.path_count),
            sym.svg.as_ref().map_or(0, |s| s.paths.len()),
            out.render.timings.total_ms,
            sym.timings.extract_ms,
            sym.timings.features_ms,
            sym.timings.trace_ms
        );
        assert_eq!(out.render.rgb.len(), SYMBOL_CANVAS * SYMBOL_CANVAS * 3);
    }
    assert!(!stages.is_empty());
    // 相同种子相同输出
    let a = noise_from_seed(1);
    assert_eq!(a, noise_from_seed(1));
}
