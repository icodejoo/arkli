package com.let188.arkli.tts

/**
 * 校验通过的朗读请求。
 *
 * @property text 文本
 * @property lang 规范化后的语言标签，如 `zh-CN`
 * @property rate 语速
 * @property pitch 音调
 */
internal data class TtsSpec(val text: String, val lang: String, val rate: Float, val pitch: Float)

/**
 * 文字转语音的参数校验、语言码规范化与分段，纯函数，可单测。
 *
 * 使用示例：`TtsPolicy.parse("你好", "zh_cn", null, null)` -> `TtsSpec("你好", "zh-CN", 1f, 1f)`
 */
internal object TtsPolicy {
    /** 文本长度上限 */
    const val MAX_TEXT = 8000

    /** 缺省语言 */
    const val DEFAULT_LANG = "zh-CN"

    /** 语速、音调下限 */
    const val MIN_FACTOR = 0.5

    /** 语速、音调上限 */
    const val MAX_FACTOR = 2.0

    /** 语速、音调缺省值 */
    const val DEFAULT_FACTOR = 1.0

    /** 语言标签：2~3 位语言，可带 2~4 位地区/文字，分隔符 - 或 _ */
    private val LANG_REGEX = Regex("^([a-zA-Z]{2,3})(?:[-_]([a-zA-Z0-9]{2,4}))?$")

    /** 句末标点，分段时优先在这里断开 */
    private val SENTENCE_ENDS = "。！？!?；;.\n"

    /**
     * 规范化语言码：下划线换成连字符，语言小写、地区大写。
     *
     * @param raw 页面给的语言码，可空；空则用缺省
     * @return 规范化标签，如 `zh-CN`、`en-US`、`ja`
     * @throws IllegalArgumentException 格式不对
     */
    fun normalizeLang(raw: String?): String {
        val v = raw?.trim().orEmpty()
        if (v.isEmpty()) return DEFAULT_LANG
        val m = LANG_REGEX.matchEntire(v) ?: throw IllegalArgumentException("lang 格式不对：$v")
        val lang = m.groupValues[1].lowercase()
        val region = m.groupValues[2]
        return if (region.isEmpty()) lang else "$lang-${if (region.length == 4) region.replaceFirstChar { it.uppercase() } else region.uppercase()}"
    }

    /**
     * 校验数值参数（语速、音调）。
     *
     * @param name 参数名，用于报错
     * @param value 值，可空；空则用缺省 1.0
     * @return 合法的浮点数
     * @throws IllegalArgumentException 不在 0.5~2 内
     */
    fun factor(name: String, value: Double?): Float {
        val v = value ?: DEFAULT_FACTOR
        require(!v.isNaN() && v >= MIN_FACTOR && v <= MAX_FACTOR) { "$name 需要在 $MIN_FACTOR~$MAX_FACTOR 之间" }
        return v.toFloat()
    }

    /**
     * 校验整个朗读请求。
     *
     * @param text 文本，1~[MAX_TEXT] 字符，不能全是空白
     * @param lang 语言码，可空
     * @param rate 语速，可空
     * @param pitch 音调，可空
     * @return 规范化后的请求
     * @throws IllegalArgumentException 任一参数不合法
     */
    fun parse(text: String, lang: String?, rate: Double?, pitch: Double?): TtsSpec {
        require(text.isNotBlank()) { "text 不能为空" }
        require(text.length <= MAX_TEXT) { "text 超过 $MAX_TEXT 字符" }
        return TtsSpec(text, normalizeLang(lang), factor("rate", rate), factor("pitch", pitch))
    }

    /**
     * 把长文本切成不超过 [max] 字符的若干段，尽量在句末标点处断开，其次在空白处，实在没有才硬切。
     * 引擎对单次输入有长度上限（通常约 4000），超了要分段排队。
     *
     * @param text 文本
     * @param max 单段上限，必须大于 0
     * @return 非空分段列表，拼起来等于原文（除去纯空白的段）
     */
    fun chunk(text: String, max: Int): List<String> {
        require(max > 0) { "max 必须大于 0" }
        if (text.length <= max) return listOf(text)
        val out = ArrayList<String>()
        var start = 0
        while (start < text.length) {
            if (text.length - start <= max) {
                out.add(text.substring(start))
                break
            }
            val end = cutPoint(text, start, start + max)
            out.add(text.substring(start, end))
            start = end
        }
        return out.filter { it.isNotBlank() }
    }

    /** 在 (start, limit] 内找最合适的断点：句末标点之后 > 空白之后 > limit 本身（避开代理对中间） */
    private fun cutPoint(text: String, start: Int, limit: Int): Int {
        var i = limit
        while (i > start) {
            if (text[i - 1] in SENTENCE_ENDS) return i
            i--
        }
        i = limit
        while (i > start) {
            if (text[i - 1].isWhitespace()) return i
            i--
        }
        return if (Character.isHighSurrogate(text[limit - 1])) limit - 1 else limit
    }

    /**
     * 引擎的语言支持程度是否可用：`TextToSpeech.setLanguage` 的返回值 >= 0（LANG_AVAILABLE 等）才行，
     * 负数是 LANG_MISSING_DATA(-1) / LANG_NOT_SUPPORTED(-2)。
     *
     * @param code `setLanguage` 的返回值
     * @return 可用返回 true
     */
    fun languageUsable(code: Int): Boolean = code >= 0

    /**
     * 把引擎可用的语言整理成去重排序的标签列表。
     *
     * @param tags 各 Locale 的语言标签（`Locale.toLanguageTag()`）
     * @return 去重、去空、排序后的标签
     */
    fun cleanLangs(tags: Collection<String>): List<String> = tags.filter { it.isNotBlank() && it != "und" }.distinct().sorted()
}
