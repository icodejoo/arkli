//! MNN 真库测试（全部 `#[ignore]`）：真 `arkli-mnn.dll` + M6a 产出的 NLLB MNN 模型 + Python 参考数据。
//!
//! 运行：
//! ```text
//! ARKLI_MNN_DYLIB=<arkli-mnn.dll>            （同目录要有 MNN.dll）
//! ARKLI_MNN_NLLB_DIR=<nllb600m-un6-mnn-w6>   （M6a 产物目录）
//! ARKLI_MNN_NLLB_REF=<参考数据目录>            （含 tok_ref.json、greedy_ref.json，由 ref_gen.py 生成）
//! cargo test -p arkli-ai --features mnn-backend -- --ignored --nocapture mnn真库
//! ```
//! 参考数据：`tok_ref.json` 是 Python `tokenizers==0.23.3` 对 592 句的分词 id；`greedy_ref.json` 是 `eval_nllb.py`
//! 同一份 MNN 产物（memory=low、int8 嵌入表）贪心解码得到的译文与 token 序列。

use std::path::PathBuf;
use std::time::Instant;

use serde_json::Value;

use super::engine::load_tokenizer;
use super::*;

/// 环境变量：MNN 运行库。
const ENV_DYLIB: &str = "ARKLI_MNN_DYLIB";
/// 环境变量：NLLB MNN 模型目录。
const ENV_NLLB_DIR: &str = "ARKLI_MNN_NLLB_DIR";
/// 环境变量：参考数据目录。
const ENV_NLLB_REF: &str = "ARKLI_MNN_NLLB_REF";
/// 贪心一致率门槛（与方案第 7 节一致）。
const MIN_AGREE: f64 = 0.96;
/// 与 `eval_nllb.py` 对齐的最大生成 token 数。
const REF_MAX_NEW: usize = 64;
/// 已知的退化“万能句”片段。
const DEGENERATE_MARKS: [&str; 1] = ["to be a little late"];
/// 连续重复同一字符达到该次数视为退化。
const REPEAT_CHARS: usize = 8;
/// 线程数。
const THREADS: u32 = 4;
/// 束宽 4 的测试只取前这么多句（每步 4 次解码器，太慢）。
const BEAM4_SENTENCES: usize = 30;

/// 读必需的环境变量。
fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("未设置 {name}"))
}

/// 读参考 JSON 数组。
fn read_ref(name: &str) -> Vec<Value> {
    let p = PathBuf::from(env(ENV_NLLB_REF)).join(name);
    serde_json::from_slice::<Value>(&std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display())))
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

/// 加载运行库与翻译器。
fn load_real() -> (MnnRuntime, Translator) {
    let rt = MnnRuntime::load(env(ENV_DYLIB)).unwrap();
    let t = Translator::load_mnn(&rt, &PathBuf::from(env(ENV_NLLB_DIR)), THREADS).unwrap();
    (rt, t)
}

/// 取 MNN 引擎（测试直接调内部的整句解码）。
fn mnn_engine(t: &mut Translator) -> &mut engine::Engine<mnn_runner::MnnRunner<MnnNet>> {
    match &mut t.inner {
        Inner::Mnn(e) => e,
        #[cfg(feature = "ort-backend")]
        _ => panic!("不是 MNN 引擎"),
    }
}

/// 是否退化：空输出、含万能句、或连续重复同一字符过多。
fn is_degenerate(out: &str) -> bool {
    if out.trim().is_empty() || DEGENERATE_MARKS.iter().any(|m| out.contains(m)) {
        return true;
    }
    let chars: Vec<char> = out.chars().collect();
    chars.windows(REPEAT_CHARS).any(|w| w.iter().all(|&c| c == w[0] && !c.is_whitespace()))
}

/// 进程内存：`(当前工作集, 峰值工作集)` 字节；仅 Windows 有值。
#[cfg(windows)]
fn process_memory() -> Option<(usize, usize)> {
    use std::ffi::c_void;
    /// `PROCESS_MEMORY_COUNTERS`（psapi）。
    #[repr(C)]
    struct Counters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set: usize,
        working_set: usize,
        quota_peak_paged: usize,
        quota_paged: usize,
        quota_peak_non_paged: usize,
        quota_non_paged: usize,
        pagefile: usize,
        peak_pagefile: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
    }
    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(h: *mut c_void, c: *mut Counters, cb: u32) -> i32;
    }
    let mut c = Counters {
        cb: std::mem::size_of::<Counters>() as u32,
        page_fault_count: 0,
        peak_working_set: 0,
        working_set: 0,
        quota_peak_paged: 0,
        quota_paged: 0,
        quota_peak_non_paged: 0,
        quota_non_paged: 0,
        pagefile: 0,
        peak_pagefile: 0,
    };
    // SAFETY：结构体布局与 Win32 `PROCESS_MEMORY_COUNTERS` 一致，cb 如实填写。
    let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    (ok != 0).then_some((c.working_set, c.peak_working_set))
}

/// 非 Windows 无数据。
#[cfg(not(windows))]
fn process_memory() -> Option<(usize, usize)> {
    None
}

/// 打印内存快照（MB）。
fn print_mem(tag: &str) {
    match process_memory() {
        Some((ws, peak)) => println!("[内存] {tag}: 工作集 {:.0}MB 峰值 {:.0}MB", ws as f64 / 1048576.0, peak as f64 / 1048576.0),
        None => println!("[内存] {tag}: 本平台无数据"),
    }
}

/// 新 tokenizer.json（含 Replace 补丁）在 Rust tokenizers 下的分词与 Python 0.23.3 逐句逐 id 一致。
#[test]
#[ignore = "需要 ARKLI_MNN_NLLB_DIR 与 ARKLI_MNN_NLLB_REF"]
fn mnn真库_新词表分词与python一致() {
    let tk = load_tokenizer(&PathBuf::from(env(ENV_NLLB_DIR)).join("tokenizer.json")).unwrap();
    let refs = read_ref("tok_ref.json");
    let vocab = tk.get_vocab_size(true);
    println!("词表大小 {vocab}，参考句数 {}", refs.len());
    let mut bad = 0;
    for r in &refs {
        let text = r["text"].as_str().unwrap();
        let want: Vec<u32> = r["ids"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
        let got = tk.encode(text, false).unwrap().get_ids().to_vec();
        assert!(got.iter().all(|&i| (i as usize) < vocab));
        if got != want {
            bad += 1;
            println!("[分词不一致] {text:?}\n  rust  {got:?}\n  python {want:?}");
        }
    }
    println!("分词一致 {}/{}", refs.len() - bad, refs.len());
    assert_eq!(bad, 0);
}

/// 149 句贪心：与 Python MNN 参考的一致率、无退化句；打印逐句译文、耗时与内存。
#[test]
#[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_MNN_NLLB_DIR / ARKLI_MNN_NLLB_REF"]
fn mnn真库_贪心译文与python参考一致() {
    print_mem("加载前");
    let t0 = Instant::now();
    let (_rt, mut t) = load_real();
    println!("[加载] {} ms", t0.elapsed().as_millis());
    print_mem("加载后");
    let refs = read_ref("greedy_ref.json");
    let mut agree = 0;
    let mut degenerate = 0;
    let mut times = Vec::new();
    for (i, r) in refs.iter().enumerate() {
        let (src, tgt) = (r["src"].as_str().unwrap(), r["tgt"].as_str().unwrap());
        let (text, want) = (r["text"].as_str().unwrap(), r["out"].as_str().unwrap());
        let started = Instant::now();
        let e = mnn_engine(&mut t);
        let plan = e.plan_for(src, tgt).unwrap();
        let got = e.translate_segment(text, REF_MAX_NEW, 1, &plan).unwrap();
        let ms = started.elapsed().as_millis();
        times.push(ms);
        let same = got == want;
        agree += usize::from(same);
        if is_degenerate(&got) {
            degenerate += 1;
        }
        println!("[{i:03} {src}->{tgt} {ms}ms {}] {text} => {got}{}", if same { "=" } else { "!" }, if same { String::new() } else { format!("   (python: {want})") });
    }
    print_mem("149 句之后");
    let rate = agree as f64 / refs.len() as f64;
    let total: u128 = times.iter().sum();
    let mut sorted = times.clone();
    sorted.sort_unstable();
    println!(
        "贪心一致 {agree}/{} = {:.1}%，退化 {degenerate}，总耗时 {total}ms，均值 {}ms，中位 {}ms，最大 {}ms",
        refs.len(),
        rate * 100.0,
        total / refs.len() as u128,
        sorted[sorted.len() / 2],
        sorted[sorted.len() - 1]
    );
    assert_eq!(degenerate, 0);
    assert!(rate >= MIN_AGREE, "一致率 {rate}");
    t.unload();
}

/// 公共入口（分句、后处理）下 149 句：默认束宽 2 与贪心都不出空输出、无退化；记录耗时。
#[test]
#[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_MNN_NLLB_DIR / ARKLI_MNN_NLLB_REF"]
fn mnn真库_公共入口束搜索无退化() {
    let (_rt, mut t) = load_real();
    let refs = read_ref("greedy_ref.json");
    for beams in [1usize, 2, 4] {
        let mut degenerate = 0;
        let mut times = Vec::new();
        // 束宽 4 每步要跑 4 次解码器，只取前 BEAM4_SENTENCES 句
        let take = if beams == 4 { BEAM4_SENTENCES } else { refs.len() };
        for r in refs.iter().take(take) {
            let (src, tgt, text) = (r["src"].as_str().unwrap(), r["tgt"].as_str().unwrap(), r["text"].as_str().unwrap());
            let o = t.translate(text, src, tgt, Some(beams)).unwrap();
            times.push(o.elapsed_ms);
            if is_degenerate(&o.text) {
                degenerate += 1;
                println!("[退化 beams={beams} {src}->{tgt}] {text} => {:?}", o.text);
            }
        }
        let total: u64 = times.iter().sum();
        times.sort_unstable();
        println!(
            "[公共入口 beams={beams}] {} 句，退化 {degenerate}，总 {total}ms，均值 {}ms，中位 {}ms，最大 {}ms",
            take,
            total / take as u64,
            times[times.len() / 2],
            times[times.len() - 1]
        );
        print_mem(&format!("beams={beams} 之后"));
        assert_eq!(degenerate, 0, "beams={beams}");
    }
    t.unload();
}

/// 极短输入引号包裹法在 MNN 后端下同样生效；长句开关前后一致；其余公共 API 行为（空白、越界束宽、不支持语言对、auto）。
#[test]
#[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_MNN_NLLB_DIR"]
fn mnn真库_引号包裹法与公共接口() {
    let (_rt, mut t) = load_real();
    let cases = [
        ("你好", "zh-CN", "en", "Hello"),
        ("谢谢", "zh-CN", "en", "Thank you"),
        ("你好！", "zh-CN", "en", "Hello!"),
        ("Hello", "en", "zh-CN", "你好"),
    ];
    for (text, src, tgt, want) in cases {
        let o = t.translate(text, src, tgt, None).unwrap();
        println!("[wrap {src}->{tgt}] {text} => {} ({} ms)", o.text, o.elapsed_ms);
        assert_eq!(o.text, want);
    }
    let o = t.translate("你好", "auto", "en", None).unwrap();
    println!("[wrap auto->en] 你好 => {}", o.text);
    let long = "The quick brown fox jumps over the lazy dog. It was a sunny day in the city.";
    let on = t.translate(long, "en", "zh-CN", None).unwrap().text;
    t.set_short_phrase_wrap(false);
    let off = t.translate(long, "en", "zh-CN", None).unwrap().text;
    println!("[wrap long] on={on} off={off}");
    assert_eq!(on, off);
    // 关掉包裹法后，极短输入走普通路径（只打印，不断言内容）
    let o = t.translate("你好", "zh-CN", "en", None).unwrap();
    println!("[wrap 关闭] 你好 => {}", o.text);
    assert_eq!(t.translate("   ", "en", "fr", None).unwrap().text, "   ");
    assert_eq!(t.translate("Hi.", "en", "fr", Some(99)).unwrap_err().kind, ErrorKind::BadRequest);
    assert_eq!(t.translate("Hi.", "en", "en", None).unwrap_err().kind, ErrorKind::UnsupportedPair);
    assert_eq!(t.translate("Hi.", "en", "de", None).unwrap_err().kind, ErrorKind::UnsupportedPair);
    assert!(t.supports_pair("zh-CN", "ar"));
    assert!(!t.model_id().is_empty());
    t.unload();
}

/// 卸载后可重新加载（三图释放、归还内存、再建）；错误目录不影响后续加载。
#[test]
#[ignore = "需要 ARKLI_MNN_DYLIB / ARKLI_MNN_NLLB_DIR"]
fn mnn真库_卸载与重载() {
    let rt = MnnRuntime::load(env(ENV_DYLIB)).unwrap();
    let dir = PathBuf::from(env(ENV_NLLB_DIR));
    let bad = Translator::load_mnn(&rt, std::path::Path::new("Z:/definitely/not/here"), THREADS).err().unwrap();
    assert_eq!(bad.kind, ErrorKind::ModelMissing);
    for round in 0..2 {
        print_mem(&format!("第 {round} 轮加载前"));
        let mut t = Translator::load_mnn(&rt, &dir, THREADS).unwrap();
        let o = t.translate("Where is the nearest train station?", "en", "zh-CN", Some(1)).unwrap();
        println!("[重载 {round}] {} ({} ms)", o.text, o.elapsed_ms);
        assert!(!o.text.trim().is_empty());
        print_mem(&format!("第 {round} 轮翻译后"));
        t.unload();
        print_mem(&format!("第 {round} 轮卸载后"));
    }
}

/// 用同一份产物目录里的 model.json 校验清单 `format` 分派与 ORT 加载的互斥。
#[test]
#[ignore = "需要 ARKLI_MNN_NLLB_DIR"]
fn mnn真库_清单格式分派() {
    let dir = PathBuf::from(env(ENV_NLLB_DIR));
    assert_eq!(model_format(&dir).unwrap(), ModelFormat::MnnSplit);
}
