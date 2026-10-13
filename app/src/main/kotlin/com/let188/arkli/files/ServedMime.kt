package com.let188.arkli.files

/**
 * `/files/` 响应的 mime 与安全头策略。
 *
 * 缓存里的文件可能来自用户选的任意文档，与应用页面同源；若被当文档导航加载，
 * html、脚本之类会拿到应用的权限。所以可执行或可解析为文档的类型一律降级成二进制流，
 * 再配 nosniff 与 CSP sandbox 兜底。SVG 保持原类型，`<img>` 引用要能显示，sandbox 已足以挡脚本。
 * 不依赖 android，纯 JVM 可测。
 */
object ServedMime {
    /** 兜底的二进制流类型 */
    const val OCTET_STREAM = "application/octet-stream"

    /** 要降级的 mime：浏览器会把它们当文档解析或当脚本执行 */
    private val DOWNGRADED = setOf(
        "text/html",
        "application/xhtml+xml",
        "text/xml",
        "application/xml",
        "text/javascript",
        "application/javascript",
        "application/x-javascript",
        "text/ecmascript",
        "application/ecmascript",
    )

    /** 所有 `/files/` 响应都加的安全头 */
    val SECURITY_HEADERS: Map<String, String> = mapOf(
        "X-Content-Type-Options" to "nosniff",
        "Content-Security-Policy" to "sandbox",
    )

    /**
     * 把按扩展名猜出的 mime 换成可安全下发的类型。
     *
     * @param mime 猜出的 mime，可为 null，可带参数（如 `; charset=utf-8`）
     * @return 可下发的 mime；null 与危险类型返回 [OCTET_STREAM]，其余原样返回
     */
    fun safe(mime: String?): String {
        if (mime.isNullOrBlank()) return OCTET_STREAM
        val bare = mime.substringBefore(';').trim().lowercase()
        return if (bare in DOWNGRADED) OCTET_STREAM else mime
    }
}
