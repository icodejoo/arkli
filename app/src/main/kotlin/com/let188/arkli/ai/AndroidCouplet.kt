package com.let188.arkli.ai

import android.content.Context
import android.util.Log
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CancellationException
import uniffi.arkli_ffi.CoupletFfiException
import uniffi.arkli_ffi.coupletCancel
import uniffi.arkli_ffi.coupletGenerate
import uniffi.arkli_ffi.coupletLoad
import uniffi.arkli_ffi.coupletUnload
import java.io.File

/** 对联日志 tag */
private const val COUPLET_LOG_TAG = "ArkliCouplet"

/** Rust 算子线程数（与其他 MNN 模型一致取 4） */
private const val COUPLET_THREADS = 4u

/** 纳秒转毫秒 */
private const val COUPLET_NANOS_PER_MS = 1_000_000L

/** 模型目录（相对 filesDir），与 `assets/ai/models.json` 里对联条目的 dir 一致 */
const val COUPLET_MODEL_DIR = "models/couplet-gpt2-mnn-w6"

/**
 * 安卓实现的文件环境：模型在 `filesDir/models/...`。
 *
 * @param context 应用上下文
 */
internal class AndroidCoupletEnv(context: Context) : CoupletEnv {
    /** 应用上下文 */
    private val ctx = context.applicationContext

    /** 模型目录位置 */
    override fun modelDir(): File = File(ctx.filesDir, COUPLET_MODEL_DIR)
}

/**
 * 基于 UniFFI 的真实引擎。Rust 侧对调用加锁串行；这里把 Rust 的错误翻译成桥错误码。
 */
internal class UniffiCoupletBackend : CoupletBackend {
    /** 加载 MNN 运行库与模型目录（先确保 so 已载入，Rust 按裸名 dlopen），顺带记录加载耗时 */
    override fun load(modelDir: String): Unit = guard {
        val t0 = System.nanoTime()
        MnnNative.ensureLoaded()
        coupletLoad(MNN_RUNTIME_LIB, modelDir, COUPLET_THREADS)
        Log.i(COUPLET_LOG_TAG, "模型加载完成 ${(System.nanoTime() - t0) / COUPLET_NANOS_PER_MS} ms")
        Unit
    }

    /** 释放模型会话 */
    override fun unload() = coupletUnload()

    /** 生成 */
    override fun generate(req: AiCoupletRequest): CoupletOutcome = guard {
        val r = coupletGenerate(req.text, req.temperature, req.topK?.toUInt(), req.seed?.toULong())
        CoupletOutcome(r.text, r.elapsedMs.toLong())
    }

    /** 打断生成 */
    override fun cancel() = coupletCancel()

    /** 把 Rust 错误翻译成桥错误；被取消翻成协程取消，桥会回 CANCELLED */
    private fun <T> guard(block: () -> T): T = try {
        block()
    } catch (e: CoupletFfiException.NotLoaded) {
        throw BridgeException(BridgeErrors.NOT_READY, e.message.orEmpty())
    } catch (e: CoupletFfiException.InvalidInput) {
        throw BridgeException(BridgeErrors.BAD_PARAMS, e.message.orEmpty())
    } catch (e: CoupletFfiException.Cancelled) {
        throw CancellationException(e.message)
    } catch (e: CoupletFfiException) {
        Log.e(COUPLET_LOG_TAG, "Rust 生成失败", e)
        throw BridgeException(BridgeErrors.INTERNAL, e.message.orEmpty())
    }
}

/**
 * 进程内唯一的对联服务（Rust 侧会话也是进程级单例，WebView 重建时不能重复创建）。
 */
internal object CoupletRuntime {
    /** 单例，首次使用时创建 */
    @Volatile
    private var service: CoupletService? = null

    /**
     * 取对联服务。
     *
     * @param context 应用上下文
     * @return 进程内唯一的服务
     */
    fun get(context: Context): CoupletService = service ?: synchronized(this) {
        service ?: CoupletService(AndroidCoupletEnv(context), UniffiCoupletBackend()).also { service = it }
    }
}
