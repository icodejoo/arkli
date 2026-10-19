package com.let188.arkli.ai

import android.content.Context
import android.util.Log
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CancellationException
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** 文本模型日志 tag */
private const val QWEN_LOG_TAG = "ArkliQwen"

/** 运行时动态生成的配置文件名（写入 cacheDir 下覆盖写） */
private const val RUNTIME_CONFIG_FILE = "qwen_runtime_config.json"

/** 模型目录（相对 filesDir），与 `assets/ai/models.json` 里 qwen 条目的 dir 一致 */
const val QWEN_MODEL_DIR = "models/qwen35-0.8b-mnn-q4"

/**
 * 安卓实现的文件环境：模型在 `filesDir/models/...`。
 *
 * @param context 应用上下文
 */
internal class AndroidQwenEnv(context: Context) : QwenEnv {
    /** 应用上下文 */
    private val ctx = context.applicationContext

    /** 模型目录位置 */
    override fun modelDir(): File = File(ctx.filesDir, QWEN_MODEL_DIR)
}

/**
 * 基于 JNI 的真实引擎。把原生层的异常翻译成桥错误码。
 *
 * @param context 安卓应用上下文
 * @param store 参数持久化存储
 */
internal class MnnQwenBackend(
    private val context: Context,
    private val store: AiParamStore,
) : QwenBackend {
    /** 会话句柄，0 表示未加载 */
    private var handle = 0L

    /** 加载会话，顺带记录加载耗时 */
    override fun load(configPath: String) {
        val t0 = System.nanoTime()
        val configFile = File(configPath)
        val originalJson = JSONObject(configFile.readText(Charsets.UTF_8))
        val modelDir = configFile.parentFile?.absolutePath ?: configFile.parent.orEmpty()
        val threads = AiMnnParams.threads(store).toInt()
        val wrapped = QwenConfigWrapper.wrap(
            originalJson,
            modelDir,
            threads,
            power = AiMnnParams.power(store),
            topP = AiQwenPolicy.topP(store),
            penalty = AiQwenPolicy.repetitionPenalty(store),
        )
        val runtimeConfig = File(context.cacheDir, RUNTIME_CONFIG_FILE)
        runtimeConfig.writeText(wrapped.toString(), Charsets.UTF_8)
        handle = guard { MnnNative.nativeCreate(runtimeConfig.absolutePath.toByteArray(Charsets.UTF_8)) }
        Log.i(QWEN_LOG_TAG, "模型加载完成 ${(System.nanoTime() - t0) / NANOS_PER_MS} ms")
    }

    /** 释放会话 */
    override fun unload() {
        val h = handle
        handle = 0L
        if (h != 0L) MnnNative.nativeDestroy(h)
    }

    /** 单轮生成；采样变化时原生层会重建会话（比普通生成慢一次加载的时间） */
    override fun generate(system: String, prompt: String, maxNewTokens: Int, sampling: Sampling): String {
        val h = handle
        if (h == 0L) throw BridgeException(BridgeErrors.NOT_READY, "文本模型会话未加载")
        val bytes = guard {
            MnnNative.nativeGenerate(
                h, system.toByteArray(Charsets.UTF_8), prompt.toByteArray(Charsets.UTF_8), maxNewTokens, sampling.temperature, sampling.topK,
            )
        }
        return decodeLenient(bytes)
    }

    /** 打断生成：置原生层取消标志，下一个 token 处生效 */
    override fun cancel() = MnnNative.nativeCancel()

    /** 把原生层异常翻译成桥错误；取消原样放行（它是 IllegalStateException 的子类，必须排在前面），桥会回 CANCELLED */
    private fun <T> guard(block: () -> T): T = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: IllegalStateException) {
        Log.e(QWEN_LOG_TAG, "MNN 失败", e)
        throw BridgeException(BridgeErrors.INTERNAL, e.message.orEmpty())
    } catch (e: UnsatisfiedLinkError) {
        Log.e(QWEN_LOG_TAG, "MNN 动态库加载失败", e)
        throw BridgeException(BridgeErrors.INTERNAL, "文本模型运行库不可用：${e.message}")
    } catch (e: ExceptionInInitializerError) {
        Log.e(QWEN_LOG_TAG, "MNN 动态库初始化失败", e)
        throw BridgeException(BridgeErrors.INTERNAL, "文本模型运行库不可用：${e.cause?.message ?: e.message}")
    }

    private companion object {
        /** 纳秒转毫秒 */
        const val NANOS_PER_MS = 1_000_000L
    }
}

/**
 * 把 UTF-8 字节解码成字符串，遇到被截断的半个字用替换符，不抛异常。
 *
 * @param bytes 引擎输出的字节
 * @return 解码后的文本
 */
internal fun decodeLenient(bytes: ByteArray): String =
    Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPLACE)
        .onUnmappableCharacter(CodingErrorAction.REPLACE)
        .decode(ByteBuffer.wrap(bytes))
        .toString()

/**
 * 进程内唯一的文本模型服务（会话占内存大，WebView 重建时不能重复创建）。
 */
internal object QwenRuntime {
    /** 单例，首次使用时创建 */
    @Volatile
    private var service: QwenService? = null

    /**
     * 取文本模型服务。
     *
     * @param context 应用上下文
     * @return 进程内唯一的服务
     */
    fun get(context: Context): QwenService = service ?: synchronized(this) {
        service ?: run {
            val store = AiParamStores.get(context)
            QwenService(
                AndroidQwenEnv(context),
                MnnQwenBackend(context.applicationContext, store),
                settingsKey = { AiMnnParams.fingerprint(LocalQwenProvider.ID, AiQwenPolicy.PARAM_SPECS, store) },
            ).also { service = it }
        }
    }
}
