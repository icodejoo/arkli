package com.let188.arkli.shortcut

/**
 * 深链接路由策略，用于将外部深链接安全解析为前端工具页面路由。
 *
 * 使用示例：`DeepLinkPolicy.routeOf("arkli://tool/ruler")` 得到 `/tool/ruler`
 */
internal object DeepLinkPolicy {
    /** 网址最大允许长度（超长直接返回 null） */
    const val MAX_URL_LENGTH = 512

    /** 协议与主机部分的分隔符 */
    private const val SCHEME_DELIMITER = "://"

    /** 允许的 HTTPS 协议名称 */
    private const val SCHEME_HTTPS = "https"

    /** 允许的 Arkli 专属协议名称 */
    private const val SCHEME_ARKLI = "arkli"

    /** 允许的 HTTPS 主机域名 */
    private const val HOST_HTTPS = "icodejoo.github.io"

    /** 允许的 Arkli 协议主机名 */
    private const val HOST_ARKLI = "tool"

    /** HTTPS 协议下的路径前缀 */
    private const val HTTPS_PATH_PREFIX = "/arkli/t/"

    /** 单斜杠路径字符串 */
    private const val SLASH = "/"

    /** 单斜杠字符 */
    private const val SLASH_CHAR = '/'

    /** 查询参数起始标识字符 */
    private const val QUERY_CHAR = '?'

    /** 片段起始标识字符 */
    private const val FRAGMENT_CHAR = '#'

    /** 工具页面路由前缀 */
    private const val TOOL_ROUTE_PREFIX = "/tool/"

    /**
     * 将外部深链接解析为内部工具路由；查询参数与片段一律忽略，不参与结果。
     *
     * @param url 待解析的深链接网址字符串
     * @return 映射后的工具路由（如 /tool/ruler），非法网址返回 null
     */
    fun routeOf(url: String?): String? {
        if (url == null || url.isEmpty() || url.length > MAX_URL_LENGTH) {
            return null
        }
        val clean = url.substringBefore(QUERY_CHAR).substringBefore(FRAGMENT_CHAR)
        val schemeIndex = clean.indexOf(SCHEME_DELIMITER)
        if (schemeIndex <= 0) {
            return null
        }
        val scheme = clean.substring(0, schemeIndex).lowercase()
        val afterScheme = clean.substring(schemeIndex + SCHEME_DELIMITER.length)
        val firstSlash = afterScheme.indexOf(SLASH_CHAR)
        if (firstSlash <= 0) {
            return null
        }
        val host = afterScheme.substring(0, firstSlash).lowercase()
        val path = afterScheme.substring(firstSlash)

        val rawId = when (scheme) {
            SCHEME_HTTPS -> {
                if (host != HOST_HTTPS || !path.startsWith(HTTPS_PATH_PREFIX)) {
                    return null
                }
                path.removePrefix(HTTPS_PATH_PREFIX)
            }
            SCHEME_ARKLI -> {
                if (host != HOST_ARKLI || !path.startsWith(SLASH)) {
                    return null
                }
                path.removePrefix(SLASH)
            }
            else -> return null
        }

        val id = if (rawId.endsWith(SLASH_CHAR)) rawId.dropLast(1) else rawId
        if (id.isEmpty() || id.contains(SLASH_CHAR)) {
            return null
        }

        val route = "$TOOL_ROUTE_PREFIX$id"
        return if (ShortcutPolicy.isToolRoute(route)) route else null
    }
}
