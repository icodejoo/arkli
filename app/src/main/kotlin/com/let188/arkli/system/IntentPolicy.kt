package com.let188.arkli.system

import android.content.Intent

/**
 * 校验通过的外部跳转目标。
 *
 * @property action Intent Action
 * @property uri 规范化后的 URI 字符串
 */
internal data class IntentTarget(val action: String, val uri: String)

/**
 * `native.intent.open` 的校验：只放行少数几种 scheme，拒绝可执行或本地内容的 scheme。纯函数，可单测。
 *
 * 使用示例：`IntentPolicy.validate("dial", "10086")` -> `IntentTarget(ACTION_DIAL, "tel:10086")`
 */
internal object IntentPolicy {
    /** value 长度上限 */
    const val MAX_VALUE_LENGTH = 2000

    /** 明确禁止的 scheme，即使将来白名单误加也拦住 */
    private val FORBIDDEN = setOf("javascript", "file", "content", "intent", "data", "vbscript")

    /**
     * 一种跳转的规则。
     *
     * @property action 启动用的 Action
     * @property schemes 允许的 scheme（小写）
     * @property bareTemplate value 不带 scheme 时的补全模板，null 表示必须自带 scheme
     */
    private class Rule(val action: String, val schemes: Set<String>, val bareTemplate: String?)

    /** 种类白名单 */
    private val RULES: Map<String, Rule> = mapOf(
        "url" to Rule(Intent.ACTION_VIEW, setOf("https", "http"), null),
        "dial" to Rule(Intent.ACTION_DIAL, setOf("tel"), "tel:%s"),
        "sms" to Rule(Intent.ACTION_SENDTO, setOf("smsto"), "smsto:%s"),
        "mail" to Rule(Intent.ACTION_SENDTO, setOf("mailto"), "mailto:%s"),
        "map" to Rule(Intent.ACTION_VIEW, setOf("geo"), "geo:%s"),
        "market" to Rule(Intent.ACTION_VIEW, setOf("market"), "market://details?id=%s"),
    )

    /** 取 value 开头的 scheme */
    private val SCHEME_REGEX = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*):")

    /** 支持的种类名 */
    val KINDS: Set<String> get() = RULES.keys

    /**
     * 校验并规范化一次跳转请求。
     *
     * @param kind 种类：url / dial / sms / mail / map / market
     * @param value 目标；url 必须自带 http(s)://，其余种类可只写主体（如电话号码）
     * @return 校验通过的目标
     * @throws IllegalArgumentException 种类未知、过长、含控制字符或 scheme 不在白名单
     */
    fun validate(kind: String, value: String): IntentTarget {
        val rule = RULES[kind] ?: throw IllegalArgumentException("不支持的 kind：$kind")
        val v = value.trim()
        require(v.isNotEmpty()) { "value 不能为空" }
        require(v.length <= MAX_VALUE_LENGTH) { "value 超过 $MAX_VALUE_LENGTH 字符" }
        require(v.none { it.code < 0x20 || it.code == 0x7f }) { "value 含控制字符" }
        val scheme = SCHEME_REGEX.find(v)?.groupValues?.get(1)?.lowercase()
        require(scheme !in FORBIDDEN) { "禁止的 scheme：$scheme" }
        if (scheme != null) {
            require(scheme in rule.schemes) { "$kind 只允许 ${rule.schemes.joinToString("/")}，收到 $scheme" }
            return IntentTarget(rule.action, v)
        }
        val template = rule.bareTemplate ?: throw IllegalArgumentException("$kind 需要自带 ${rule.schemes.first()}:// 前缀")
        return IntentTarget(rule.action, template.format(v))
    }
}
