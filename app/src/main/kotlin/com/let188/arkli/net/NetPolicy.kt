package com.let188.arkli.net

import java.net.URI

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
 * 页面出站策略：CSP 头与请求去向判定，全部是纯函数，JVM 单测可直接跑。
 * 页面出站不设主机白名单：任何 https 资源（接口、字体、图片、样式）都放行，明文 http 一律拒绝；
 * 脚本仍只允许同源（script-src 'self'），不加载远程代码。原生模型下载器的白名单 [DOWNLOAD_HOSTS] 另算。
 */
object NetPolicy {

    /**
     * 原生模型下载器可访问的主机（小写、精确匹配）。**与页面出站策略分开**：
     * 这些主机只给原生下载器用，页面出站虽然放行任意 https，但下载器仍只认这几个主机。每一跳重定向都要校验。
     */
    val DOWNLOAD_HOSTS: Set<String> = setOf(HOST_GITHUB, HOST_GITHUB_OBJECTS, HOST_GITHUB_RELEASE_ASSETS)

    /** 页面文档响应要带的 CSP 头名 */
    const val CSP_HEADER = "Content-Security-Policy"

    /**
     * 判断一个 URL 是否允许页面出站。
     *
     * 规则：必须是 https 且能解析出主机、无 userinfo（挡掉 `https://good.com@evil.com` 这类障眼法）；主机不限。
     *
     * @param url 完整 URL 字符串
     * @return 允许返回 true；明文 http、其他协议、解析失败返回 false
     * 示例：`NetPolicy.isAllowedOutbound("https://fonts.gstatic.com/a.woff2")` 为 true
     */
    fun isAllowedOutbound(url: String): Boolean {
        val u = parse(url) ?: return false
        return u.scheme?.lowercase() == SCHEME_HTTPS && u.rawUserInfo == null && u.host != null
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
     * @return [NetVerdict.APP] 为应用内 https 域；[NetVerdict.ALLOW] 为其他 https；否则 [NetVerdict.BLOCK]
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
     * @return 形如 `default-src 'self'; connect-src 'self' https:; ...`
     */
    fun contentSecurityPolicy(extraConnect: List<String> = emptyList()): String {
        val connect = (listOf("'self'", "$SCHEME_HTTPS:") + extraConnect).joinToString(" ")
        return listOf(
            "default-src 'self'",
            "connect-src $connect",
            "img-src 'self' data: blob: $SCHEME_HTTPS:",
            "media-src 'self' blob: $SCHEME_HTTPS:",
            "style-src 'self' 'unsafe-inline' $SCHEME_HTTPS:",
            "script-src 'self'",
            "font-src 'self' data: $SCHEME_HTTPS:",
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
