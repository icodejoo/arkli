package com.let188.arkli.ai

import android.content.Context
import android.util.Log
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CancellationException
import uniffi.arkli_ffi.TranslateFfiException
import uniffi.arkli_ffi.translateCancel
import uniffi.arkli_ffi.translateLoad
import uniffi.arkli_ffi.translateRun
import uniffi.arkli_ffi.translateUnload
import java.io.File

/** 翻译日志 tag */
private const val TRANSLATE_LOG_TAG = "ArkliTranslate"

/** Rust 算子线程数（与识物一致取 4） */
private const val TRANSLATE_THREADS = 4u

/** 模型目录（相对 filesDir），与 `assets/ai/models.json` 里 nllb 条目的 dir 一致 */
const val TRANSLATE_MODEL_DIR = "models/nllb600m-un6-mnn-w6"

/**
 * 安卓实现的文件环境：模型在 `filesDir/models/...`。
 *
 * @param context 应用上下文
 */
internal class AndroidTranslateEnv(context: Context) : TranslateEnv {
    /** 应用上下文 */
    private val ctx = context.applicationContext

    /** 模型目录位置 */
    override fun modelDir(): File = File(ctx.filesDir, TRANSLATE_MODEL_DIR)
}

/**
 * 基于 UniFFI 的真实引擎。Rust 侧对调用加锁串行；这里把 Rust 的错误翻译成桥错误码。
 */
internal class UniffiTranslateBackend : TranslateBackend {
    /** 加载 MNN 运行库与模型（先确保 so 已载入，Rust 按裸名 dlopen；`model.json` 的 format 为 mnn-split），顺带记录加载耗时 */
    override fun load(modelDir: String): Unit = guard {
        val t0 = System.nanoTime()
        MnnNative.ensureLoaded()
        translateLoad(MNN_RUNTIME_LIB, modelDir, TRANSLATE_THREADS)
        Log.i(TRANSLATE_LOG_TAG, "模型加载完成 ${(System.nanoTime() - t0) / NANOS_PER_MS} ms")
        Unit
    }

    /** 释放模型会话 */
    override fun unload() = translateUnload()

    /** 翻译 */
    override fun translate(text: String, src: String, tgt: String, numBeams: Int): TranslateOutcome = guard {
        val r = translateRun(text, src, tgt, numBeams.toUInt())
        TranslateOutcome(r.text, r.elapsedMs.toLong(), r.detected, r.unrecognized)
    }

    /** 打断翻译：置 Rust 侧取消标志，下一个解码步前生效 */
    override fun cancel() = translateCancel()

    /** 把 Rust 错误翻译成桥错误；被取消翻成协程取消，桥会回 CANCELLED */
    private fun <T> guard(block: () -> T): T = try {
        block()
    } catch (e: TranslateFfiException.NotLoaded) {
        throw BridgeException(BridgeErrors.NOT_READY, e.message.orEmpty())
    } catch (e: TranslateFfiException.InvalidInput) {
        throw BridgeException(BridgeErrors.BAD_PARAMS, e.message.orEmpty())
    } catch (e: TranslateFfiException.Cancelled) {
        throw CancellationException(e.message)
    } catch (e: TranslateFfiException) {
        Log.e(TRANSLATE_LOG_TAG, "Rust 翻译失败", e)
        throw BridgeException(BridgeErrors.INTERNAL, e.message.orEmpty())
    }

    private companion object {
        /** 纳秒转毫秒 */
        const val NANOS_PER_MS = 1_000_000L
    }
}

/**
 * 进程内唯一的翻译服务（Rust 侧会话也是进程级单例，WebView 重建时不能重复创建）。
 */
internal object TranslateRuntime {
    /** 单例，首次使用时创建 */
    @Volatile
    private var service: TranslateService? = null

    /**
     * 取翻译服务。
     *
     * @param context 应用上下文
     * @return 进程内唯一的服务
     */
    fun get(context: Context): TranslateService = service ?: synchronized(this) {
        service ?: TranslateService(AndroidTranslateEnv(context), UniffiTranslateBackend()).also { service = it }
    }
}
