//! UniFFI 绑定生成器入口，由构建脚本调用。

/// 转交给 uniffi 官方命令行。
fn main() {
    uniffi::uniffi_bindgen_main()
}
