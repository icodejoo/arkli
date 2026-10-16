package com.let188.arkli.speech

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import java.io.File

/** 语音转文字常量 */
object SpeechConst {
    /** 引擎标识 */
    const val ENGINE = "local-zipformer"

    /** 模型清单 id（models.json 里的条目，目录名与它相同） */
    const val MODEL_ID = "asr-zipformer-zh-en-mnn-w8"

    /** 模型目录名（位于 filesDir/models/ 下） */
    const val MODEL_DIR = MODEL_ID

    /** 编码器文件名 */
    const val FILE_ENCODER = "encoder.mnn"

    /** 解码器文件名 */
    const val FILE_DECODER = "decoder.mnn"

    /** 连接器文件名 */
    const val FILE_JOINER = "joiner.mnn"

    /** 词表文件名 */
    const val FILE_TOKENS = "tokens.txt"

    /** 编码器最小字节数（MNN int8 仅权重，实际 155,527,912 B，低于此视为未传完） */
    const val MIN_ENCODER_BYTES = 120_000_000L

    /** 解码器最小字节数（实际 10,603,880 B） */
    const val MIN_DECODER_BYTES = 8_000_000L

    /** 连接器最小字节数（实际 2,623,028 B） */
    const val MIN_JOINER_BYTES = 2_000_000L

    /** 词表最小字节数（实际 58,806 B） */
    const val MIN_TOKENS_BYTES = 10_000L

    /** 采样率（Hz） */
    const val SAMPLE_RATE = 16_000

    /** 每次读取的采样数（100ms） */
    const val CHUNK_SAMPLES = 1_600

    /** 结尾补静音的秒数，让模型把最后几个字吐出来 */
    const val TAIL_PADDING_SEC = 0.66f

    /** 支持的语言：中英混合 */
    const val LANG_ZH_EN = "zh-en"

    /** 事件：中间结果 */
    const val EVENT_PARTIAL = "speech.partial"

    /** 事件：一句话定稿 */
    const val EVENT_FINAL = "speech.final"

    /** 字段 key：lang */
    const val KEY_LANG = "lang"

    /** 字段 key：text */
    const val KEY_TEXT = "text"

    /** 字段 key：available */
    const val KEY_AVAILABLE = "available"

    /** 字段 key：engine */
    const val KEY_ENGINE = "engine"

    /** 字段 key：modelReady */
    const val KEY_MODEL_READY = "modelReady"

    /** 字段 key：reason */
    const val KEY_REASON = "reason"

    /** 空闲多久后释放识别器（毫秒） */
    const val IDLE_UNLOAD_MS = 60_000L

    /** 停止时最多等待冲刷完成的毫秒数 */
    const val STOP_WAIT_MS = 8_000L

    /** 识别线程数 */
    const val NUM_THREADS = 2

    /** 端点规则 1：没说话时的最小静音（秒） */
    const val ENDPOINT_RULE1_SEC = 2.4f

    /** 端点规则 2：说过话后的最小静音（秒） */
    const val ENDPOINT_RULE2_SEC = 1.2f

    /** 端点规则 3：一句话最长时长（秒） */
    const val ENDPOINT_RULE3_SEC = 20.0f
}

/**
 * 语音转文字策略纯逻辑：参数校验、模型齐全性检查、状态判定、事件载荷。
 * 不依赖 Android 与 sherpa-mnn，可 JVM 单测。
 *
 * 使用示例：
 * ```
 * val lang = SpeechPolicy.parseStart(params)
 * val status = SpeechPolicy.statusJson(SpeechPolicy.reasonOf(dir, libOk))
 * ```
 */
object SpeechPolicy {
    /** 模型必须文件及其最小字节数 */
    private val REQUIRED = linkedMapOf(
        SpeechConst.FILE_ENCODER to SpeechConst.MIN_ENCODER_BYTES,
        SpeechConst.FILE_DECODER to SpeechConst.MIN_DECODER_BYTES,
        SpeechConst.FILE_JOINER to SpeechConst.MIN_JOINER_BYTES,
        SpeechConst.FILE_TOKENS to SpeechConst.MIN_TOKENS_BYTES,
    )

    /**
     * 校验并解析 `native.speech.start` 入参。
     *
     * @param params 页面参数，`lang` 可省（默认 zh-en）
     * @return 语言标识
     * @throws BridgeException lang 不是字符串或不受支持时抛 BAD_PARAMS
     */
    fun parseStart(params: JSONObject): String {
        if (!params.has(SpeechConst.KEY_LANG) || params.isNull(SpeechConst.KEY_LANG)) return SpeechConst.LANG_ZH_EN
        val lang = params.opt(SpeechConst.KEY_LANG)
        if (lang !is String || lang != SpeechConst.LANG_ZH_EN) {
            throw BridgeException(BridgeErrors.BAD_PARAMS, "lang 只支持 ${SpeechConst.LANG_ZH_EN}")
        }
        return lang
    }

    /**
     * 检查模型文件齐全性：缺失或小于最小字节数的文件名列表。
     *
     * @param sizes 文件名 -> 实际字节数（不存在的文件不放进去或填 0）
     * @return 缺失或残缺的文件名，空表示齐全
     */
    fun missingFiles(sizes: Map<String, Long>): List<String> =
        REQUIRED.filter { (name, min) -> (sizes[name] ?: 0L) < min }.keys.toList()

    /**
     * 读取模型目录并检查齐全性。
     *
     * @param dir 模型目录
     * @return 缺失或残缺的文件名，空表示齐全
     */
    fun missingFiles(dir: File): List<String> =
        missingFiles(REQUIRED.keys.associateWith { File(dir, it).let { f -> if (f.isFile) f.length() else 0L } })

    /**
     * 判定不可用的原因。
     *
     * @param missing 缺失文件列表
     * @param libOk sherpa-mnn 库是否能加载
     * @return 不可用原因（中文）；可用返回 null
     */
    fun reasonOf(missing: List<String>, libOk: Boolean): String? = when {
        missing.isNotEmpty() -> "语音识别模型未就绪，缺少或不完整：${missing.joinToString("、")}"
        !libOk -> "语音识别引擎无法加载"
        else -> null
    }

    /**
     * 组装 `native.speech.status` 返回。
     *
     * @param missing 缺失文件列表
     * @param libOk sherpa-mnn 库是否能加载
     * @return `{ available, engine, modelReady, reason? }`
     */
    fun statusJson(missing: List<String>, libOk: Boolean): JSONObject {
        val reason = reasonOf(missing, libOk)
        return JSONObject().apply {
            put(SpeechConst.KEY_AVAILABLE, reason == null)
            put(SpeechConst.KEY_ENGINE, SpeechConst.ENGINE)
            put(SpeechConst.KEY_MODEL_READY, missing.isEmpty())
            if (reason != null) put(SpeechConst.KEY_REASON, reason)
        }
    }

    /**
     * 组装事件载荷 `{ text }`。
     *
     * @param text 文本
     * @return JSON 对象
     */
    fun textPayload(text: String): JSONObject = JSONObject().put(SpeechConst.KEY_TEXT, text)

    /**
     * 16 位 PCM 转 [-1, 1) 浮点。
     *
     * @param src 16 位采样
     * @param n 有效采样数
     * @return 浮点数组
     */
    fun pcmToFloat(src: ShortArray, n: Int): FloatArray = FloatArray(n) { src[it] / PCM_SCALE }

    /** 16 位 PCM 的归一化系数 */
    private const val PCM_SCALE = 32768f
}

/**
 * 把流式解码的"定稿句 + 当前中间结果"合并成整段文本。
 * 两段之间：双方交界处都是字母数字时补一个空格（英文单词不粘连），其余直接相接。
 *
 * 使用示例：
 * ```
 * val m = TranscriptMerger()
 * m.partial("你好"); m.commit("你好。"); m.partial("hello"); m.full() // "你好。hello"
 * ```
 */
class TranscriptMerger {
    /** 已定稿的文本 */
    private var committed = ""

    /** 当前未定稿的中间结果 */
    private var current = ""

    /**
     * 更新中间结果。
     *
     * @param text 当前这句的最新文本
     * @return 文本相对上次有变化返回 true
     */
    fun partial(text: String): Boolean {
        if (text == current) return false
        current = text
        return true
    }

    /**
     * 一句话定稿：并入已定稿文本并清空中间结果。空白文本被忽略。
     *
     * @param text 本句定稿文本
     * @return 实际并入的文本；被忽略时为 null
     */
    fun commit(text: String): String? {
        current = ""
        val t = text.trim()
        if (t.isEmpty()) return null
        committed = join(committed, t)
        return t
    }

    /**
     * 当前整段文本（定稿 + 中间结果）。
     *
     * @return 合并后的文本
     */
    fun full(): String = join(committed, current.trim())

    /**
     * 只含定稿句的文本。
     *
     * @return 已定稿文本
     */
    fun committedText(): String = committed

    /** 把两段文本相接，交界处两侧都是字母数字时补空格 */
    private fun join(a: String, b: String): String {
        if (a.isEmpty()) return b
        if (b.isEmpty()) return a
        val gap = a.last().isAsciiAlnum() && b.first().isAsciiAlnum()
        return if (gap) "$a $b" else a + b
    }

    /** 是否 ASCII 字母或数字 */
    private fun Char.isAsciiAlnum(): Boolean = this in 'a'..'z' || this in 'A'..'Z' || this in '0'..'9'
}
