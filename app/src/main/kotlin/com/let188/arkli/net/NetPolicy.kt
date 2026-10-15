package com.let188.arkli.net

import java.net.URI

/** 出站白名单里的主机：目前只有维基媒体 REST（历史上的今天），精确匹配、不做后缀通配 */
internal const val HOST_WIKIMEDIA_API = "api.wikimedia.org"

/** 模型下载白名单：GitHub release 入口 */
internal const val HOST_GITHUB = "github.com"

/** 模型下载白名单：GitHub release 的 302 落点（旧域名） */
internal const val HOST_GITHUB_OBJECTS = "objects.githubusercontent.com"

/** 模型下载白名单：GitHub release 的 302 落点（2025 年起的新域名） */
internal const val HOST_GITHUB_RELEASE_ASSETS = "release-assets.githubusercontent.com"

/** 仅调试放行的回环主机（明文 http），release 里没有任何代码会打开这个开关 */
internal const val HOST_LOOPBACK = "127.0.0.1"

/** http 协议名 */
private const val SCHEME_HTTP = "http"

/** https 协议名 */
private const val SCHEME_HTTPS = "https"

/** https 默认端口，URL 里不写端口或显式写 443 才放行 */
private const val PORT_HTTPS = 443

/** 请求去向的判定结果 */
enum class NetVerdict {
    /** 应用内虚拟域名，走 AssetLoader / 文件接管 */
    APP,

    /** 白名单出站，交给 WebView 自己发（CORS 由浏览器处理） */
    ALLOW,

    /** 其余一律拦截 */
    BLOCK,
}

/**
 * 页面出站策略：白名单、CSP 头与请求去向判定，全部是纯函数，JVM 单测可直接跑。
 * 白名单是单一事实来源，CSP 的 connect-src 也从它生成，改域名只改 [ALLOWED_HOSTS]。
 */
object NetPolicy {

    /** 允许页面直接请求的主机（小写、精确匹配）。要求对方接口支持 CORS */
    val ALLOWED_HOSTS: Set<String> = setOf(HOST_WIKIMEDIA_API)

    /**
     * 原生模型下载器可访问的主机（小写、精确匹配）。**与页面出站白名单 [ALLOWED_HOSTS] 分开**：
     * 这些主机只给原生下载器用，不进 CSP，页面自己仍然连不上。每一跳重定向都要校验。
     */
    val DOWNLOAD_HOSTS: Set<String> = setOf(HOST_GITHUB, HOST_GITHUB_OBJECTS, HOST_GITHUB_RELEASE_ASSETS)

    /** 页面文档响应要带的 CSP 头名 */
    const val CSP_HEADER = "Content-Security-Policy"

    /**
     * 判断一个 URL 是否允许页面出站。
     *
     * 规则：必须是 https、无 userinfo、端口缺省或 443、主机（忽略大小写）精确命中白名单。
     * IP 字面量、punycode 变体、带尾点的主机都不在白名单里，自然被拒。
     *
     * @param url 完整 URL 字符串
     * @return 允许返回 true；解析失败或任一条件不满足返回 false
     * 示例：`NetPolicy.isAllowedOutbound("https://api.wikimedia.org/feed/v1")` 为 true
     */
    fun isAllowedOutbound(url: String): Boolean {
        val u = parse(url) ?: return false
        if (u.scheme?.lowercase() != SCHEME_HTTPS) return false
        if (u.rawUserInfo != null) return false
        if (u.port != -1 && u.port != PORT_HTTPS) return false
        val host = u.host?.lowercase() ?: return false
        return host in ALLOWED_HOSTS
    }

    /**
     * 判断一个 URL 能否被原生模型下载器访问（初始 URL 与每一跳重定向目标都用它校验）。
     *
     * 规则：https、无 userinfo、端口缺省或 443、主机精确命中 [DOWNLOAD_HOSTS]；
     * 仅当 [allowLoopbackHttp] 为 true（只有 debug 构建会打开）时，额外放行 `http://127.0.0.1:<任意端口>`。
     *
     * @param url 完整 URL 字符串
     * @param allowLoopbackHttp 是否放行回环明文，release 恒为 false
     * @return 允许返回 true
     * 示例：`NetPolicy.isAllowedDownload("https://github.com/a/b/releases/download/v1/x.onnx")` 为 true
     */
    fun isAllowedDownload(url: String, allowLoopbackHttp: Boolean = false): Boolean {
        val u = parse(url) ?: return false
        if (u.rawUserInfo != null) return false
        val host = u.host?.lowercase() ?: return false
        return when (u.scheme?.lowercase()) {
            SCHEME_HTTPS -> (u.port == -1 || u.port == PORT_HTTPS) && host in DOWNLOAD_HOSTS
            SCHEME_HTTP -> allowLoopbackHttp && host == HOST_LOOPBACK
            else -> false
        }
    }

    /**
     * 判定一次请求的去向。
     *
     * @param url 请求 URL
     * @param appHost 应用内虚拟域名（如 appassets.androidplatform.net）
     * @return [NetVerdict.APP] 为应用内 https 域；[NetVerdict.ALLOW] 为白名单；否则 [NetVerdict.BLOCK]
     */
    fun classify(url: String, appHost: String): NetVerdict {
        val u = parse(url) ?: return NetVerdict.BLOCK
        if (u.scheme?.lowercase() == SCHEME_HTTPS && u.rawUserInfo == null && u.host == appHost) return NetVerdict.APP
        return if (isAllowedOutbound(url)) NetVerdict.ALLOW else NetVerdict.BLOCK
    }

    /**
     * 生成页面 CSP 头的值。
     *
     * @param extraConnect 额外放进 connect-src 的来源，仅开发期热更新用（如 `ws://127.0.0.1:5173`），默认没有
     * @return 形如 `default-src 'self'; connect-src 'self' https://api.wikimedia.org; ...`
     */
    fun contentSecurityPolicy(extraConnect: List<String> = emptyList()): String {
        val connect = (listOf("'self'") + ALLOWED_HOSTS.sorted().map { "$SCHEME_HTTPS://$it" } + extraConnect).joinToString(" ")
        return listOf(
            "default-src 'self'",
            "connect-src $connect",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            "style-src 'self' 'unsafe-inline'",
            "script-src 'self'",
            "font-src 'self' data:",
            "frame-src 'none'",
            "object-src 'none'",
            "base-uri 'self'",
        ).joinToString("; ")
    }

    /**
     * 去掉查询串与片段，供日志使用，避免输出敏感参数。
     *
     * @param url 原始 URL
     * @return 只剩协议、主机、路径的字符串；解析失败返回 `<invalid>`
     */
    fun redact(url: String): String {
        val u = parse(url) ?: return "<invalid>"
        val port = if (u.port == -1) "" else ":${u.port}"
        return "${u.scheme}://${u.host}$port${u.rawPath.orEmpty()}"
    }

    /** 解析 URL，失败（含反斜杠、空格等非法字符）返回 null */
    private fun parse(url: String): URI? = try {
        URI(url)
    } catch (e: Exception) {
        null
    }
}
