package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一次 `native.ai.translate` 校验通过的请求。
 *
 * @property text 原文（1~[AiTranslatePolicy.MAX_TEXT] 字符，非全空白）
 * @property src 源语言码，或 [AiTranslatePolicy.AUTO]（按句自动识别）；是否支持按选中提供者的约束查
 * @property tgt 目标语言码，不等于 [src]、不能是 auto；是否支持按选中提供者的约束查
 * @property numBeams 束宽 1~[AiTranslatePolicy.MAX_BEAMS]；null 表示用模型缺省
 * @property provider 指定翻译提供者 id；null 表示用默认的本地翻译模型（NLLB）
 */
data class AiTranslateRequest(val text: String, val src: String, val tgt: String, val numBeams: Int?, val provider: String? = null)

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
 * 翻译的纯逻辑（选提供者归 [AiRouter]）：参数校验、结果序列化。无 Android 依赖，可单测。
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

    /** 应用认识的翻译语言码（NLLB 裁剪包的六种联合国语言）；各提供者的报价只能从中选（契约测试检查），入口按报价校验 */
    val LANGS: List<String> = listOf("zh-CN", "en", "fr", "es", "ru", "ar")

    /**
     * 翻译报价的约束：[LANGS] 六种语言、源语言可写 auto。本地 NLLB 与 Qwen 支持的语言相同，共用这一份，
     * 是前端语言清单的唯一来源（经 `native.ai.providers` 的 offers 下发）。
     */
    val OFFER_CONSTRAINTS = AiConstraints.Translate(LANGS, sourceAuto = true)

    /**
     * 解析并做结构校验 `native.ai.translate` 的参数。**语言是否支持不在这里查**：要等选出提供者后，
     * 按它报价里的约束查（[checkLanguages]，经 [AiConstraints.Translate.check]），不同提供者语言可以不同。
     *
     * @param params `{ text: string, src: string | 'auto', tgt: string, numBeams?: number, provider?: string }`
     * @return 结构合法的请求
     * @throws BridgeException BAD_PARAMS：文本缺失/为空/过长、src/tgt 不是非空字符串、tgt 是 auto、src 等于 tgt、numBeams 不是 1~[MAX_BEAMS] 的整数
     */
    fun parse(params: JSONObject): AiTranslateRequest {
        val text = params.opt("text") as? String ?: throw bad("text 需要是字符串")
        if (text.isBlank()) throw bad("text 不能为空")
        if (text.length > MAX_TEXT) throw bad("text 最多 $MAX_TEXT 字符")
        val src = lang(params, "src")
        val tgt = lang(params, "tgt")
        if (tgt == AUTO) throw bad("tgt 不能是 $AUTO")
        if (src == tgt) throw bad("src 与 tgt 不能相同")
        val beams = when (val b = params.opt("numBeams")) {
            null, JSONObject.NULL -> null
            is Int -> b
            is Long -> if (b in MIN_BEAMS.toLong()..MAX_BEAMS.toLong()) b.toInt() else throw bad("numBeams 需要 $MIN_BEAMS~$MAX_BEAMS")
            else -> throw bad("numBeams 需要是整数")
        }
        if (beams != null && beams !in MIN_BEAMS..MAX_BEAMS) throw bad("numBeams 需要 $MIN_BEAMS~$MAX_BEAMS")
        val provider = AiPolicy.providerId(params.opt(AiPolicy.KEY_PROVIDER), required = false)
        return AiTranslateRequest(text, src, tgt, beams, provider)
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

    /**
     * 按某提供者的翻译约束校验语言对（选中提供者之后调用）。
     *
     * @param req 结构已校验的请求
     * @param languages 该提供者支持的语言码
     * @param sourceAuto 源语言可否为 [AUTO]
     * @throws BridgeException BAD_PARAMS：tgt 不在 [languages]、src 不在 [languages] 且不是被允许的 [AUTO]
     * @example `checkLanguages(req, LANGS, sourceAuto = true)`
     */
    fun checkLanguages(req: AiTranslateRequest, languages: List<String>, sourceAuto: Boolean) {
        if (!(sourceAuto && req.src == AUTO)) requireLang("src", req.src, languages)
        requireLang("tgt", req.tgt, languages)
    }

    /** 语言码不在清单里就报 BAD_PARAMS，message 列出可选值 */
    private fun requireLang(key: String, v: String, languages: List<String>) {
        if (v !in languages) throw bad("$key 不支持：$v，可选 ${languages.joinToString("/")}")
    }

    /** 取语言码参数：必须是非空字符串（是否支持由 [checkLanguages] 按提供者约束查） */
    private fun lang(params: JSONObject, key: String): String {
        val v = params.opt(key) as? String ?: throw bad("$key 需要是字符串")
        if (v.isEmpty()) throw bad("$key 不能为空")
        return v
    }

    /** 造 BAD_PARAMS 异常 */
    private fun bad(msg: String) = BridgeException(BridgeErrors.BAD_PARAMS, msg)
}
