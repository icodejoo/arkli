package com.let188.arkli.ai

import android.app.ActivityManager
import android.content.Context
import android.util.Log
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CancellationException
import uniffi.arkli_ffi.LogoFfiException
import uniffi.arkli_ffi.LogoFfiResidency
import uniffi.arkli_ffi.logoCancel
import uniffi.arkli_ffi.logoGenerate
import uniffi.arkli_ffi.logoLoad
import uniffi.arkli_ffi.logoUnload
import java.io.File

/** logo 日志 tag */
private const val LOGO_LOG_TAG = "ArkliLogo"

/** 纳秒转毫秒 */
private const val LOGO_NANOS_PER_MS = 1_000_000L

/** 模型目录（相对 filesDir），与 `assets/ai/models.json` 里 logo 条目的 dir 一致 */
const val LOGO_MODEL_DIR = "models/sdxs512-mnn-w8"

/** 一兆字节 */
private const val BYTES_PER_MB = 1024L * 1024L

/** 推理线程数固定 4：真机 8 线程反而慢约 15%（大小核混用），所以不跟随 AiMnnParams */
private const val LOGO_THREADS = 4u

/**
 * 安卓实现的文件环境：模型在 `filesDir/models/...`。
 *
 * @param context 应用上下文
 */
internal class AndroidLogoEnv(context: Context) : LogoEnv {
    /** 应用上下文 */
    private val ctx = context.applicationContext

    /** 模型目录位置 */
    override fun modelDir(): File = File(ctx.filesDir, LOGO_MODEL_DIR)
}

/** 转成 Rust 侧的驻留方式枚举 */
private fun LogoResidency.toFfi(): LogoFfiResidency = when (this) {
    LogoResidency.RESIDENT -> LogoFfiResidency.RESIDENT
    LogoResidency.PER_STAGE -> LogoFfiResidency.PER_STAGE
}

/**
 * 基于 UniFFI 的真实引擎。Rust 侧对调用加锁串行；这里把 Rust 的错误翻译成桥错误码。
 *
 * @param store 参数持久化存储
 */
internal class UniffiLogoBackend(private val store: AiParamStore) : LogoBackend {
    /** 加载 MNN 运行库与模型目录（先确保 so 已载入，Rust 按裸名 dlopen），顺带记录加载耗时 */
    override fun load(modelDir: String, residency: LogoResidency): Unit = guard {
        val t0 = System.nanoTime()
        MnnNative.ensureLoaded()
        MnnRuntimeOptions.apply(store)
        logoLoad(MNN_RUNTIME_LIB, modelDir, LOGO_THREADS, residency.toFfi())
        Log.i(LOGO_LOG_TAG, "模型加载完成（${residency.wire}）${(System.nanoTime() - t0) / LOGO_NANOS_PER_MS} ms")
        Unit
    }

    /** 释放模型会话 */
    override fun unload() = logoUnload()

    /** 生成（不要二值位图） */
    override fun generate(req: AiLogoRequest, seed: Long): LogoOutcome = guard {
        val r = logoGenerate(req.prompt, seed.toULong(), req.removeRing, false)
        val f = r.features
        val t = r.timings
        LogoOutcome(
            r.svgPaths, r.pathCount.toInt(), r.gateOk, r.gateReasons, r.ringDetected,
            LogoFeatures(f.inkCanvas, f.rotIou, f.comps.toInt(), f.specks.toInt(), f.sizeRel, f.off, f.fillBbox, f.empty),
            LogoTimings(
                t.tokenizeMs.toLong(), t.textMs.toLong(), t.unetMs.toLong(), t.stepMs.toLong(), t.vaeMs.toLong(), t.loadMs.toLong(),
                t.extractMs.toLong(), t.featuresMs.toLong(), t.gateMs.toLong(), t.traceMs.toLong(), t.totalMs.toLong(),
            ),
        )
    }

    /** 打断生成（段间生效） */
    override fun cancel() = logoCancel()

    /** 把 Rust 错误翻译成桥错误；被取消翻成协程取消，桥会回 CANCELLED */
    private fun <T> guard(block: () -> T): T = try {
        block()
    } catch (e: LogoFfiException.NotLoaded) {
        throw BridgeException(BridgeErrors.NOT_READY, e.message.orEmpty())
    } catch (e: LogoFfiException.InvalidInput) {
        throw BridgeException(BridgeErrors.BAD_PARAMS, e.message.orEmpty())
    } catch (e: LogoFfiException.Cancelled) {
        throw CancellationException(e.message)
    } catch (e: LogoFfiException) {
        Log.e(LOGO_LOG_TAG, "Rust 生成失败", e)
        throw BridgeException(BridgeErrors.INTERNAL, e.message.orEmpty())
    }
}

/**
 * 进程内唯一的 logo 服务（Rust 侧会话也是进程级单例，WebView 重建时不能重复创建）。
 */
internal object LogoRuntime {
    /** 单例，首次使用时创建 */
    @Volatile
    private var service: LogoService? = null

    /**
     * 取 logo 服务。加载前会让位：经 [AiRecycle.releaseExcept] 卸掉其他已常驻的模型。
     *
     * @param context 应用上下文
     * @return 进程内唯一的服务
     */
    fun get(context: Context): LogoService = service ?: synchronized(this) {
        service ?: run {
            val app = context.applicationContext
            val am = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            LogoService(
                AndroidLogoEnv(app),
                UniffiLogoBackend(AiParamStores.get(app)),
                availMem = {
                    // 加载前取一次，日志里留证据，便于核对驻留方式的选择
                    ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }.availMem.also { Log.i(LOGO_LOG_TAG, "可用内存 ${it / BYTES_PER_MB} MB") }
                },
                evictOthers = { AiRecycle.releaseExcept(LocalLogoProvider.ID) },
            ).also { service = it }
        }
    }
}
