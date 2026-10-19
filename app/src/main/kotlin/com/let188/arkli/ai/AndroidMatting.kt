package com.let188.arkli.ai

import android.content.Context
import android.util.Log
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.files.FileConst
import com.let188.arkli.image.AndroidImageCodec
import com.let188.arkli.image.ImageConst
import kotlinx.coroutines.CancellationException
import uniffi.arkli_ffi.MattingFfiException
import uniffi.arkli_ffi.MattingFfiMode
import uniffi.arkli_ffi.MattingFfiRefine
import uniffi.arkli_ffi.mattingCancel
import uniffi.arkli_ffi.mattingLoad
import uniffi.arkli_ffi.mattingRun
import uniffi.arkli_ffi.mattingUnload
import java.io.File

/** 抠图日志 tag */
private const val MATTING_LOG_TAG = "ArkliMatting"

/** Rust 算子线程数（与识物、OCR 一致取 4） */
private const val MATTING_THREADS = 4u

/** 纳秒转毫秒 */
private const val MATTING_NANOS_PER_MS = 1_000_000L

/**
 * 安卓实现的文件环境：模型在 `filesDir/models/...`，成品写进 `cacheDir/arkli/out`。
 *
 * @param context 应用上下文
 * @param mode 模式，决定模型目录
 */
internal class AndroidMattingEnv(context: Context, private val mode: MattingMode) : MattingEnv {
    /** 应用上下文 */
    private val ctx = context.applicationContext

    /** 模型目录位置 */
    override fun modelDir(): File = File(ctx.filesDir, mode.modelDir)

    /** 成品目录：缓存根下的 out/，随缓存清理策略回收 */
    override fun outDir(): File = File(File(ctx.cacheDir, FileConst.CACHE_ROOT_DIR), FileConst.DIR_OUT)

    /** 页面路径：`cache/out/<文件名>` */
    override fun pagePath(file: File): String = "${ImageConst.OUT_PAGE_PREFIX}/${file.name}"
}

/** 转成 Rust 侧的细化强度枚举 */
private fun MattingRefine.toFfi(): MattingFfiRefine = when (this) {
    MattingRefine.OFF -> MattingFfiRefine.OFF
    MattingRefine.LIGHT -> MattingFfiRefine.LIGHT
    MattingRefine.STANDARD -> MattingFfiRefine.STANDARD
    MattingRefine.STRONG -> MattingFfiRefine.STRONG
}

/**
 * 基于 UniFFI 的真实引擎，一个实例对应一种模式。Rust 侧对调用加锁串行；这里把 Rust 的错误翻译成桥错误码。
 *
 * @param mode 模式
 */
internal class UniffiMattingBackend(private val mode: MattingMode) : MattingBackend {
    /** Rust 侧的模式枚举 */
    private val ffiMode: MattingFfiMode =
        if (mode == MattingMode.PORTRAIT) MattingFfiMode.PORTRAIT else MattingFfiMode.GENERAL

    /** 加载 MNN 运行库与模型文件（先确保 so 已载入，Rust 按裸名 dlopen），顺带记录加载耗时 */
    override fun load(modelPath: String): Unit = guard {
        val t0 = System.nanoTime()
        MnnNative.ensureLoaded()
        mattingLoad(MNN_RUNTIME_LIB, ffiMode, modelPath, MATTING_THREADS)
        Log.i(MATTING_LOG_TAG, "${mode.wire} 模型加载完成 ${(System.nanoTime() - t0) / MATTING_NANOS_PER_MS} ms")
        Unit
    }

    /** 释放本模式的模型会话 */
    override fun unload() = mattingUnload(ffiMode)

    /** 抠图 */
    override fun matte(width: Int, height: Int, rgb: ByteArray, refine: MattingRefine): MattingOutcome = guard {
        val r = mattingRun(ffiMode, width.toUInt(), height.toUInt(), rgb, refine.toFfi())
        MattingOutcome(r.width.toInt(), r.height.toInt(), r.alpha, r.fg, r.elapsedMs.toLong(), r.refineMs.toLong())
    }

    /** 打断抠图（前向跑完才生效） */
    override fun cancel() = mattingCancel()

    /** 把 Rust 错误翻译成桥错误；被取消翻成协程取消，桥会回 CANCELLED */
    private fun <T> guard(block: () -> T): T = try {
        block()
    } catch (e: MattingFfiException.NotLoaded) {
        throw BridgeException(BridgeErrors.NOT_READY, e.message.orEmpty())
    } catch (e: MattingFfiException.InvalidInput) {
        throw BridgeException(BridgeErrors.BAD_PARAMS, e.message.orEmpty())
    } catch (e: MattingFfiException.Cancelled) {
        throw CancellationException(e.message)
    } catch (e: MattingFfiException) {
        Log.e(MATTING_LOG_TAG, "Rust 抠图失败", e)
        throw BridgeException(BridgeErrors.INTERNAL, e.message.orEmpty())
    }
}

/**
 * 进程内每种模式唯一的抠图服务（Rust 侧会话也是进程级单例，WebView 重建时不能重复创建）。
 */
internal object MattingRuntime {
    /** 各模式的单例，首次使用时创建 */
    private val services = HashMap<MattingMode, MattingService>()

    /**
     * 取某模式的抠图服务。
     *
     * @param context 应用上下文
     * @param mode 模式
     * @return 进程内唯一的服务
     */
    fun get(context: Context, mode: MattingMode): MattingService = synchronized(this) {
        services.getOrPut(mode) {
            MattingService(mode, AndroidMattingEnv(context, mode), UniffiMattingBackend(mode), AndroidImageCodec())
        }
    }
}
