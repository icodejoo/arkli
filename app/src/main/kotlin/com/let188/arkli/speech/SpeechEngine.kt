package com.let188.arkli.speech

import android.content.Context
import android.util.Log
import com.k2fsa.sherpa.onnx.EndpointConfig
import com.k2fsa.sherpa.onnx.EndpointRule
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.let188.arkli.ai.AiHeavyGate
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** 日志 tag */
private const val TAG = "ArkliSpeech"

/**
 * 一次解码一步的结果。
 *
 * @property text 当前这句的识别文本
 * @property endpoint 是否检测到一句话结束（此时流已被重置，下一步从新句开始）
 */
data class DecodeStep(val text: String, val endpoint: Boolean)

/**
 * 包住 sherpa 的一路在线识别流：喂音频、解码、取文本。麦克风与 debug 离线喂 wav 共用这一条解码路径。
 * 音频只在内存里流转，不落盘。
 *
 * @param rec 识别器（由 [SpeechService] 持有，本类不释放它）
 */
class SpeechDecoder internal constructor(private val rec: OnlineRecognizer) {
    /** 识别流 */
    private val stream: OnlineStream = rec.createStream("")

    /**
     * 喂一段音频并解码。
     *
     * @param samples 16kHz 单声道浮点采样
     * @return 当前这句的文本与是否到了句尾；到句尾时已重置流
     */
    fun feed(samples: FloatArray): DecodeStep {
        stream.acceptWaveform(samples, SpeechConst.SAMPLE_RATE)
        decodeReady()
        val text = rec.getResult(stream).text
        val ep = rec.isEndpoint(stream)
        if (ep) rec.reset(stream)
        return DecodeStep(text, ep)
    }

    /**
     * 结束输入：补一小段静音、冲刷剩余音频，返回最后一句（可能为空）。
     *
     * @return 最后一句文本
     */
    fun finish(): String {
        stream.acceptWaveform(FloatArray((SpeechConst.TAIL_PADDING_SEC * SpeechConst.SAMPLE_RATE).toInt()), SpeechConst.SAMPLE_RATE)
        stream.inputFinished()
        decodeReady()
        return rec.getResult(stream).text
    }

    /** 释放识别流 */
    fun release() = stream.release()

    /** 把已攒够的帧都解掉 */
    private fun decodeReady() {
        while (rec.isReady(stream)) rec.decode(stream)
    }
}

/**
 * 语音识别服务：识别器懒加载、可复用，空闲一段时间自动释放（模型约 170MB）。
 * 加载排在 [AiHeavyGate] 之后，避免和识物同时加载吃爆内存；会话期间不占闸门。
 *
 * 使用示例：`service.withDecoder { d -> d.feed(samples) }`
 *
 * @param context 应用上下文
 */
class SpeechService(context: Context) {
    /** 模型目录 */
    private val modelDir = File(context.applicationContext.filesDir, "models/${SpeechConst.MODEL_DIR}")

    /** 后台协程域，跑空闲释放计时 */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** 当前识别器；null 表示未加载 */
    @Volatile
    private var recognizer: OnlineRecognizer? = null

    /** 正在使用识别器的会话数 */
    private var active = 0

    /** 空闲释放计时任务 */
    private var idleJob: Job? = null

    /** 最近一次加载耗时（毫秒），0 表示还没加载过 */
    @Volatile
    var lastLoadMs: Long = 0
        private set

    /** sherpa 库能否加载（首次探测后缓存） */
    private val libOk: Boolean by lazy {
        runCatching { Class.forName(OnlineRecognizer::class.java.name) }
            .onFailure { Log.e(TAG, "sherpa 库加载失败", it) }
            .isSuccess
    }

    /**
     * 当前模型目录下缺失或残缺的文件。
     *
     * @return 文件名列表，空表示齐全
     */
    fun missingFiles(): List<String> = SpeechPolicy.missingFiles(modelDir)

    /**
     * 状态：模型文件齐全且库可加载才算可用。
     *
     * @return `native.speech.status` 的返回
     */
    fun status() = SpeechPolicy.statusJson(missingFiles(), libOk)

    /**
     * 占用识别器跑一段逻辑；必要时先加载。
     *
     * @param block 拿到一路新的解码器；结束后流自动释放
     * @return block 的返回值
     * @throws BridgeException NOT_READY（模型缺失或加载失败）
     */
    suspend fun <T> withDecoder(block: suspend (SpeechDecoder) -> T): T {
        val rec = acquire()
        val decoder = try {
            SpeechDecoder(rec)
        } catch (e: Throwable) {
            release()
            throw BridgeException(BridgeErrors.INTERNAL, "创建识别流失败：${e.message}")
        }
        try {
            return block(decoder)
        } finally {
            runCatching { decoder.release() }
            release()
        }
    }

    /** 立即释放识别器（有会话在用时不释放） */
    fun unload() {
        synchronized(this) {
            if (active > 0) return
            idleJob?.cancel()
            recognizer?.let { runCatching { it.release() } }
            recognizer = null
        }
    }

    /** 取得识别器并登记占用，未加载则在后台线程加载 */
    private suspend fun acquire(): OnlineRecognizer {
        synchronized(this) {
            idleJob?.cancel()
            active++
            recognizer?.let { return it }
        }
        try {
            val missing = missingFiles()
            if (missing.isNotEmpty()) throw BridgeException(BridgeErrors.NOT_READY, SpeechPolicy.reasonOf(missing, true) ?: "模型未就绪")
            if (!libOk) throw BridgeException(BridgeErrors.NOT_READY, "语音识别引擎无法加载")
            return AiHeavyGate.run { withContext(Dispatchers.Default) { loadLocked() } }
        } catch (e: Throwable) {
            release()
            throw e
        }
    }

    /** 闸门内加载（已被别处加载则复用） */
    private fun loadLocked(): OnlineRecognizer {
        synchronized(this) { recognizer?.let { return it } }
        val t0 = System.nanoTime()
        val rec = try {
            OnlineRecognizer(config = buildConfig())
        } catch (e: Throwable) {
            throw BridgeException(BridgeErrors.NOT_READY, "语音识别模型加载失败：${e.message}")
        }
        lastLoadMs = (System.nanoTime() - t0) / NANOS_PER_MS
        Log.i(TAG, "识别器已加载 ${lastLoadMs}ms")
        synchronized(this) { recognizer = rec }
        return rec
    }

    /** 登记占用结束；全部结束后起空闲释放计时 */
    private fun release() {
        synchronized(this) {
            active--
            if (active > 0) return
            idleJob?.cancel()
            idleJob = scope.launch {
                delay(SpeechConst.IDLE_UNLOAD_MS)
                unload()
            }
        }
    }

    /** 拼识别器配置：zipformer2 transducer，贪心解码，开启端点检测 */
    private fun buildConfig(): OnlineRecognizerConfig {
        fun path(name: String) = File(modelDir, name).path
        return OnlineRecognizerConfig(
            featConfig = FeatureConfig(sampleRate = SpeechConst.SAMPLE_RATE, featureDim = FEATURE_DIM),
            modelConfig = OnlineModelConfig(
                transducer = OnlineTransducerModelConfig(
                    encoder = path(SpeechConst.FILE_ENCODER),
                    decoder = path(SpeechConst.FILE_DECODER),
                    joiner = path(SpeechConst.FILE_JOINER),
                ),
                tokens = path(SpeechConst.FILE_TOKENS),
                numThreads = SpeechConst.NUM_THREADS,
                provider = "cpu",
                modelType = "zipformer2",
            ),
            endpointConfig = EndpointConfig(
                rule1 = EndpointRule(false, SpeechConst.ENDPOINT_RULE1_SEC, 0.0f),
                rule2 = EndpointRule(true, SpeechConst.ENDPOINT_RULE2_SEC, 0.0f),
                rule3 = EndpointRule(false, 0.0f, SpeechConst.ENDPOINT_RULE3_SEC),
            ),
            enableEndpoint = true,
            decodingMethod = "greedy_search",
        )
    }

    private companion object {
        /** fbank 维度 */
        const val FEATURE_DIM = 80

        /** 纳秒换毫秒 */
        const val NANOS_PER_MS = 1_000_000L
    }
}

/** 进程级单例持有者：识别器在整个进程内只有一份 */
object SpeechRuntime {
    /** 单例 */
    @Volatile
    private var instance: SpeechService? = null

    /**
     * 取（或创建）服务。
     *
     * @param context 任意上下文
     * @return 进程内唯一的 [SpeechService]
     */
    fun get(context: Context): SpeechService =
        instance ?: synchronized(this) { instance ?: SpeechService(context).also { instance = it } }
}
