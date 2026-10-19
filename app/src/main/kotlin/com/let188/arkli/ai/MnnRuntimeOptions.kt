package com.let188.arkli.ai

import uniffi.arkli_ffi.mnnSetRuntimeOptions

/**
 * 把「MNN 公用参数」里的性能模式推给 Rust 核心（进程级），之后新加载的 Rust 侧模型生效。
 * Qwen 不走这里（它经 JNI，用包装 config 带上它）。
 *
 * 使用示例：`MnnRuntimeOptions.apply(store)`，须在各 `*Load` 之前调用。
 */
internal object MnnRuntimeOptions {
    /**
     * 读取当前设置并下发。
     *
     * @param store 参数持久化存储
     * @example `MnnRuntimeOptions.apply(store)`
     */
    fun apply(store: AiParamStore) {
        mnnSetRuntimeOptions(AiMnnParams.power(store))
    }
}
