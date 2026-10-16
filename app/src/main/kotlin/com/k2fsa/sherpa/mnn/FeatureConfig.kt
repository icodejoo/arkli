// 取自 sherpa-mnn（MNN 提交 478c10e 的 apps/frameworks/sherpa-mnn/sherpa-mnn/kotlin-api/FeatureConfig.kt），Apache-2.0。
// 原版权：Copyright (c) 2022-2023 Xiaomi Corporation；Copyright (c) 2025 MNN Team。许可证全文见 native/mnn/THIRD_PARTY_SHERPA_MNN_LICENSE。
// 包名与类名必须与 libsherpa-mnn-jni.so 导出的 JNI 符号（Java_com_k2fsa_sherpa_mnn_*）一致，不要改。
// 改动：无。
package com.k2fsa.sherpa.mnn

data class FeatureConfig(
    var sampleRate: Int = 16000,
    var featureDim: Int = 80,
)

fun getFeatureConfig(sampleRate: Int, featureDim: Int): FeatureConfig {
    return FeatureConfig(sampleRate = sampleRate, featureDim = featureDim)
}
