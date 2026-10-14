package com.let188.arkli.shortcut

import com.let188.arkli.system.IntentPolicy

/**
 * 校验通过的固定快捷方式请求。
 *
 * @property id 快捷方式标识
 * @property label 桌面显示名
 * @property url 规范化后的网址（http / https）
 */
internal data class ShortcutSpec(val id: String, val label: String, val url: String)

/**
 * 网页快捷方式的参数校验与图标取色，纯函数，可单测。
 *
 * 使用示例：`ShortcutPolicy.parse("a", "知乎", "https://zhihu.com")`
 */
internal object ShortcutPolicy {
    /** 标识长度上限 */
    const val MAX_ID_LENGTH = 64

    /** 名称长度上限 */
    const val MAX_LABEL_LENGTH = 24

    /** 取不到首字时的占位 */
    const val FALLBACK_GLYPH = "#"

    /** 图标底色色板（ARGB），明度偏低，白字清晰 */
    val PALETTE: IntArray = intArrayOf(
        0xFF1E88E5.toInt(), 0xFF43A047.toInt(), 0xFFE53935.toInt(), 0xFF8E24AA.toInt(),
        0xFFF4511E.toInt(), 0xFF00897B.toInt(), 0xFF3949AB.toInt(), 0xFF6D4C41.toInt(),
        0xFFD81B60.toInt(), 0xFF546E7A.toInt(),
    )

    /**
     * 校验请求。网址只允许 http / https，复用 [IntentPolicy] 的规则。
     *
     * @param id 标识
     * @param label 名称
     * @param url 网址
     * @return 规范化后的请求
     * @throws IllegalArgumentException 标识、名称或网址不合法
     */
    fun parse(id: String, label: String, url: String): ShortcutSpec {
        val cleanId = id.trim()
        require(cleanId.isNotEmpty()) { "id 不能为空" }
        require(cleanId.length <= MAX_ID_LENGTH) { "id 超过 $MAX_ID_LENGTH 字符" }
        require(cleanId.none { it.code < 0x20 || it.code == 0x7f }) { "id 含控制字符" }
        val cleanLabel = label.trim()
        require(cleanLabel.isNotEmpty()) { "label 不能为空" }
        require(cleanLabel.length <= MAX_LABEL_LENGTH) { "label 超过 $MAX_LABEL_LENGTH 字符" }
        val target = IntentPolicy.validate("url", url)
        return ShortcutSpec(cleanId, cleanLabel, target.uri)
    }

    /**
     * 取名称的第一个字（按码点，emoji 等代理对不会被劈开），字母转大写。
     *
     * @param label 名称
     * @return 首字；名称为空白返回 [FALLBACK_GLYPH]
     */
    fun glyphOf(label: String): String {
        val s = label.trim()
        if (s.isEmpty()) return FALLBACK_GLYPH
        return String(Character.toChars(s.codePointAt(0))).uppercase()
    }

    /**
     * 按名称哈希从色板取色，同名总是同色。
     *
     * @param label 名称
     * @return ARGB 颜色
     */
    fun colorOf(label: String): Int = PALETTE[(label.trim().hashCode() and Int.MAX_VALUE) % PALETTE.size]
}
