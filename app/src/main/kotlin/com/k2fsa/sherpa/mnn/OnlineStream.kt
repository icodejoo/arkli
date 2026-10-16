// 取自 sherpa-mnn（MNN 提交 478c10e 的 apps/frameworks/sherpa-mnn/sherpa-mnn/kotlin-api/OnlineStream.kt），Apache-2.0。
// 原版权：Copyright (c) 2022-2023 Xiaomi Corporation；Copyright (c) 2025 MNN Team。许可证全文见 native/mnn/THIRD_PARTY_SHERPA_MNN_LICENSE。
// 包名与类名必须与 libsherpa-mnn-jni.so 导出的 JNI 符号（Java_com_k2fsa_sherpa_mnn_*）一致，不要改。
// 改动：无。
package com.k2fsa.sherpa.mnn

class OnlineStream(var ptr: Long = 0) {
    fun acceptWaveform(samples: FloatArray, sampleRate: Int) =
        acceptWaveform(ptr, samples, sampleRate)

    fun inputFinished() = inputFinished(ptr)

    protected fun finalize() {
        if (ptr != 0L) {
            delete(ptr)
            ptr = 0
        }
    }

    fun release() = finalize()

    fun use(block: (OnlineStream) -> Unit) {
        try {
            block(this)
        } finally {
            release()
        }
    }

    private external fun acceptWaveform(ptr: Long, samples: FloatArray, sampleRate: Int)
    private external fun inputFinished(ptr: Long)
    private external fun delete(ptr: Long)


    companion object {
        init {
            System.loadLibrary("sherpa-mnn-jni")
        }
    }
}
