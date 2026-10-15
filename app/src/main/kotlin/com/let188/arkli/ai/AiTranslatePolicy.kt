package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一次 `native.ai.translate` 校验通过的请求。
 *
 * @property text 原文（1~[AiTranslatePolicy.MAX_TEXT] 字符，非全空白）
 * @property src 源语言码，取自 [AiTranslatePolicy.LANGS]，或 [AiTranslatePolicy.AUTO]（按句自动识别）
 * @property tgt 目标语言码，取自 [AiTranslatePolicy.LANGS]，且不等于 [src]
 * @property numBeams 束宽 1~[AiTranslatePolicy.MAX_BEAMS]；null 表示用模型缺省
 */
data class AiTranslateRequest(val text: String, val src: String, val tgt: String, val numBeams: Int?)

/**
 * 一次翻译的完整结果，交给 [AiTranslatePolicy.resultJson] 序列化。
 *
 * @property text 译文
 * @property elapsedMs 总耗时（毫秒，首次使用时含模型加载）
 * @property modelId 模型标识
 * @property src 请求的源语言码（可能是 auto）
 * @property tgt 目标语言码
 * @property detectedSrc 识别出的源语言码（按出现顺序去重）；src 不是 auto 时恒为 `[src]`，没识别出为空
 * @property unrecognized 有句子因无法识别而原样放进译文；src 不是 auto 时恒为 false
 */
data class TranslateResult(
    val text: String,
    val elapsedMs: Long,
    val modelId: String,
    val src: String,
    val tgt: String,
    val detectedSrc: List<String> = listOf(src),
    val unrecognized: Boolean = false,
)

/**
 * 能翻译文本的提供者（`translate` 任务，带语言对）。与 [AiProvider.run] 分开，因为需要源/目标语言参数。
 *
 * 使用示例：`(registry.get("local-nllb") as TextTranslator).translate(req)`
 */
interface TextTranslator {
    /**
     * 翻译一段文本。
     *
     * @param req 已校验的请求
     * @return 翻译结果
     * @throws com.let188.arkli.bridge.BridgeException NOT_READY（模型未就绪）、BAD_PARAMS（Rust 拒绝的语言对或束宽）、INTERNAL
     */
    suspend fun translate(req: AiTranslateRequest): TranslateResult
}

/**
 * 本地翻译的纯逻辑：参数校验、提供者选择、结果序列化。无 Android 依赖，可单测。
 *
 * 使用示例：`AiTranslatePolicy.parse(JSONObject("""{"text":"hi","src":"en","tgt":"zh-CN"}"""))`
 */
object AiTranslatePolicy {
    /** 原文长度上限（字符数） */
    const val MAX_TEXT = 2000

    /** 束宽下限 */
    const val MIN_BEAMS = 1

    /** 束宽上限 */
    const val MAX_BEAMS = 4

    /** 源语言取此值表示自动识别（只对 src 合法，tgt 不可以） */
    const val AUTO = "auto"

    /** 支持的应用语言码（NLLB 裁剪包的六种联合国语言） */
    val LANGS: List<String> = listOf("zh-CN", "en", "fr", "es", "ru", "ar")

    /**
     * 解析并校验 `native.ai.translate` 的参数。
     *
     * @param params `{ text: string, src: string | 'auto', tgt: string, numBeams?: number }`
     * @return 校验通过的请求
     * @throws BridgeException BAD_PARAMS：文本缺失/为空/过长、tgt 不在 [LANGS]（含 auto）、src 不在 [LANGS] 且不是 [AUTO]、src 等于 tgt、numBeams 不是 1~[MAX_BEAMS] 的整数
     */
    fun parse(params: JSONObject): AiTranslateRequest {
        val text = params.opt("text") as? String ?: throw bad("text 需要是字符串")
        if (text.isBlank()) throw bad("text 不能为空")
        if (text.length > MAX_TEXT) throw bad("text 最多 $MAX_TEXT 字符")
        val src = lang(params, "src", allowAuto = true)
        val tgt = lang(params, "tgt")
        if (src == tgt) throw bad("src 与 tgt 不能相同")
        val beams = when (val b = params.opt("numBeams")) {
            null, JSONObject.NULL -> null
            is Int -> b
            is Long -> if (b in MIN_BEAMS.toLong()..MAX_BEAMS.toLong()) b.toInt() else throw bad("numBeams 需要 $MIN_BEAMS~$MAX_BEAMS")
            else -> throw bad("numBeams 需要是整数")
        }
        if (beams != null && beams !in MIN_BEAMS..MAX_BEAMS) throw bad("numBeams 需要 $MIN_BEAMS~$MAX_BEAMS")
        return AiTranslateRequest(text, src, tgt, beams)
    }

    /**
     * 选出执行翻译的本地提供者并检查可用性：取第一个声明 `translate` 且实现了 [TextTranslator] 的提供者。
     *
     * @param providers 全部提供者（注册顺序）
     * @return 可用的翻译提供者
     * @throws BridgeException BAD_PARAMS（没有这样的提供者）、NOT_READY（当前不可用，message 带 reason）
     */
    fun requireTranslator(providers: List<AiProvider>): TextTranslator {
        val provider = providers.firstOrNull { AiTask.TRANSLATE in it.capabilities() && it is TextTranslator }
            ?: throw bad("没有支持语言对翻译的 provider")
        val a = provider.availability()
        if (!a.available) throw BridgeException(BridgeErrors.NOT_READY, "${provider.id} 当前不可用：${a.reason?.wire}")
        return provider as TextTranslator
    }

    /**
     * 序列化翻译结果。
     *
     * @param r 翻译结果
     * @return `{ text, elapsedMs, modelId, src, tgt, detectedSrc: string[], unrecognized: boolean }`
     */
    fun resultJson(r: TranslateResult): JSONObject =
        JSONObject().put("text", r.text).put("elapsedMs", r.elapsedMs).put("modelId", r.modelId).put("src", r.src).put("tgt", r.tgt)
            .put("detectedSrc", JSONArray(r.detectedSrc)).put("unrecognized", r.unrecognized)

    /** 取语言码参数并校验在支持列表里；[allowAuto] 为真时额外放行 [AUTO] */
    private fun lang(params: JSONObject, key: String, allowAuto: Boolean = false): String {
        val v = params.opt(key) as? String ?: throw bad("$key 需要是字符串")
        if (allowAuto && v == AUTO) return v
        if (v !in LANGS) throw bad("$key 不支持：$v，可选 ${LANGS.joinToString("/")}")
        return v
    }

    /** 造 BAD_PARAMS 异常 */
    private fun bad(msg: String) = BridgeException(BridgeErrors.BAD_PARAMS, msg)
}
