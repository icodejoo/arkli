package com.let188.arkli.ai

import android.content.Context
import android.util.Log
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.image.AndroidImageCodec
import kotlinx.coroutines.CancellationException
import uniffi.arkli_ffi.OcrFfiException
import uniffi.arkli_ffi.ocrCancel
import uniffi.arkli_ffi.ocrLoad
import uniffi.arkli_ffi.ocrRecognize
import uniffi.arkli_ffi.ocrUnload
import java.io.File

/** 文字识别日志 tag */
private const val OCR_LOG_TAG = "ArkliOcr"

/** 纳秒转毫秒 */
private const val OCR_NANOS_PER_MS = 1_000_000L

/** 模型目录（相对 filesDir），与 `assets/ai/models.json` 里 ppocrv6-small 条目的 dir 一致 */
const val OCR_MODEL_DIR = "models/ppocrv6-small-mnn-fp16"

/**
 * 安卓实现的文件环境：模型在 `filesDir/models/...`。
 *
 * @param context 应用上下文
 */
internal class AndroidOcrEnv(context: Context) : OcrEnv {
    /** 应用上下文 */
    private val ctx = context.applicationContext

    /** 模型目录位置 */
    override fun modelDir(): File = File(ctx.filesDir, OCR_MODEL_DIR)
}

/**
 * 基于 UniFFI 的真实引擎。Rust 侧对调用加锁串行；这里把 Rust 的错误翻译成桥错误码。
 *
 * @param store 参数持久化存储
 */
internal class UniffiOcrBackend(private val store: AiParamStore) : OcrBackend {
    /** 加载 MNN 运行库与模型目录（先确保 so 已载入，Rust 按裸名 dlopen），顺带记录加载耗时 */
    override fun load(modelDir: String): Unit = guard {
        val t0 = System.nanoTime()
        MnnNative.ensureLoaded()
        ocrLoad(MNN_RUNTIME_LIB, modelDir, AiMnnParams.threads(store))
        Log.i(OCR_LOG_TAG, "模型加载完成 ${(System.nanoTime() - t0) / OCR_NANOS_PER_MS} ms")
        Unit
    }

    /** 释放模型会话 */
    override fun unload() = ocrUnload()

    /** 识别 */
    override fun recognize(width: Int, height: Int, rgb: ByteArray): OcrOutcome = guard {
        val r = ocrRecognize(width.toUInt(), height.toUInt(), rgb)
        OcrOutcome(
            r.width.toInt(),
            r.height.toInt(),
            r.lines.map { l -> OcrLine(l.points.map { OcrPoint(it.x, it.y) }, l.text, l.score) },
            r.elapsedMs.toLong(),
        )
    }

    /** 打断识别 */
    override fun cancel() = ocrCancel()

    /** 把 Rust 错误翻译成桥错误；被取消翻成协程取消，桥会回 CANCELLED */
    private fun <T> guard(block: () -> T): T = try {
        block()
    } catch (e: OcrFfiException.NotLoaded) {
        throw BridgeException(BridgeErrors.NOT_READY, e.message.orEmpty())
    } catch (e: OcrFfiException.InvalidInput) {
        throw BridgeException(BridgeErrors.BAD_PARAMS, e.message.orEmpty())
    } catch (e: OcrFfiException.Cancelled) {
        throw CancellationException(e.message)
    } catch (e: OcrFfiException) {
        Log.e(OCR_LOG_TAG, "Rust 识别失败", e)
        throw BridgeException(BridgeErrors.INTERNAL, e.message.orEmpty())
    }
}

/**
 * 进程内唯一的文字识别服务（Rust 侧会话也是进程级单例，WebView 重建时不能重复创建）。
 */
internal object OcrRuntime {
    /** 单例，首次使用时创建 */
    @Volatile
    private var service: OcrService? = null

    /**
     * 取文字识别服务。
     *
     * @param context 应用上下文
     * @return 进程内唯一的服务
     */
    fun get(context: Context): OcrService = service ?: synchronized(this) {
        service ?: run {
            val store = AiParamStores.get(context)
            OcrService(
                AndroidOcrEnv(context),
                UniffiOcrBackend(store),
                AndroidImageCodec(),
                // LocalOcrProvider 未实现 AiTunable，无自身可调参数，故传 emptyList()
                settingsKey = { AiMnnParams.fingerprint(LocalOcrProvider.ID, emptyList(), store) },
            ).also { service = it }
        }
    }
}
