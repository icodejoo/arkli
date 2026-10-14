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
 * 校验通过的工具快捷方式请求。
 *
 * @property id 快捷方式标识（带 tool- 前缀）
 * @property label 桌面显示名
 * @property icon 图标 emoji
 * @property route 页面内路由，形如 /tool/ruler
 */
internal data class ToolShortcutSpec(val id: String, val label: String, val icon: String, val route: String)

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

    /** 工具路由格式：/tool/ 加小写字母、数字、连字符 */
    val TOOL_ROUTE = Regex("^/tool/[a-z0-9][a-z0-9-]{0,63}$")

    /** 图标字符串长度上限（够放带肤色/ZWJ 的 emoji） */
    const val MAX_ICON_LENGTH = 16

    /** 工具快捷方式标识前缀 */
    const val TOOL_ID_PREFIX = "tool-"

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
     * 校验工具快捷方式请求。路由只允许 /tool/<id>，防止被外部 Intent 带到别处。
     *
     * @param label 名称
     * @param icon 图标 emoji
     * @param route 页面内路由
     * @return 规范化后的请求
     * @throws IllegalArgumentException 名称、图标或路由不合法
     */
    fun parseTool(label: String, icon: String, route: String): ToolShortcutSpec {
        val cleanLabel = label.trim()
        require(cleanLabel.isNotEmpty()) { "label 不能为空" }
        require(cleanLabel.length <= MAX_LABEL_LENGTH) { "label 超过 $MAX_LABEL_LENGTH 字符" }
        val cleanIcon = icon.trim()
        require(cleanIcon.isNotEmpty()) { "icon 不能为空" }
        require(cleanIcon.length <= MAX_ICON_LENGTH) { "icon 超过 $MAX_ICON_LENGTH 字符" }
        require(isToolRoute(route)) { "route 不合法" }
        return ToolShortcutSpec(TOOL_ID_PREFIX + route.removePrefix("/tool/"), cleanLabel, cleanIcon, route)
    }

    /**
     * 判断是否合法的工具路由。
     *
     * @param route 待判断的路由
     * @return 合法返回 true
     */
    fun isToolRoute(route: String?): Boolean = route != null && TOOL_ROUTE.matches(route)

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
