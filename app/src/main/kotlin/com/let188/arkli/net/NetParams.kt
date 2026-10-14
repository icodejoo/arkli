package com.let188.arkli.net

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import java.net.URI
import java.net.URISyntaxException

/** 允许的 HTTP 方法 */
internal val HTTP_METHODS = setOf("GET", "HEAD")

/** 允许的目标端口（URL 里显式写了端口时才检查） */
internal val ALLOWED_PORTS = setOf(80, 443, 8080, 8443)

/** 放行的请求头（小写） */
internal val ALLOWED_REQUEST_HEADERS = setOf("accept", "accept-language", "user-agent")

/** 默认 User-Agent：常见移动浏览器串 */
internal const val DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"

/** 默认 Accept */
internal const val DEFAULT_ACCEPT = "*/*"

/** HTTP 默认超时（毫秒） */
internal const val HTTP_DEFAULT_TIMEOUT_MS = 10_000

/** HTTP 超时上限（毫秒） */
internal const val HTTP_MAX_TIMEOUT_MS = 20_000

/** 响应体上限与默认值（字节，2MB） */
internal const val HTTP_MAX_BODY_BYTES = 2 * 1024 * 1024

/** 默认最大重定向次数 */
internal const val HTTP_DEFAULT_REDIRECTS = 5

/** 重定向次数上限 */
internal const val HTTP_MAX_REDIRECTS = 10

/** TCP 默认超时（毫秒） */
internal const val TCP_DEFAULT_TIMEOUT_MS = 5_000

/** TCP 超时上限（毫秒） */
internal const val TCP_MAX_TIMEOUT_MS = 15_000

/** 测速默认字节数（25MB） */
internal const val SPEED_DEFAULT_BYTES = 25L * 1024 * 1024

/** 测速字节数上限（50MB） */
internal const val SPEED_MAX_BYTES = 50L * 1024 * 1024

/** 测速默认时长（毫秒） */
internal const val SPEED_DEFAULT_MS = 8_000

/** 测速时长上限（毫秒） */
internal const val SPEED_MAX_MS = 15_000

/** 测速最多跟随的重定向次数 */
internal const val SPEED_MAX_REDIRECTS = 3

/** Whois 默认起始服务器 */
internal const val WHOIS_DEFAULT_SERVER = "whois.iana.org"

/** Whois 端口 */
internal const val WHOIS_PORT = 43

/** Whois 单次超时（毫秒） */
internal const val WHOIS_TIMEOUT_MS = 8_000

/** Whois 文本上限（字节） */
internal const val WHOIS_MAX_BYTES = 64 * 1024

/** Whois 最多跟随的引荐级数 */
internal const val WHOIS_MAX_REFERRALS = 2

/** HTTP 请求参数（已校验） */
internal class HttpRequestParams(
    val uri: URI,
    val method: String,
    val headers: Map<String, String>,
    val followRedirects: Boolean,
    val maxRedirects: Int,
    val timeoutMs: Int,
    val maxBytes: Int,
    val base64: Boolean,
)

/** 测速参数（已校验） */
internal class SpeedRequestParams(val uri: URI, val maxBytes: Long, val durationMs: Int)

/** TCP 参数（已校验） */
internal class TcpRequestParams(val host: String, val port: Int, val timeoutMs: Int)

/** Whois 参数（已校验） */
internal class WhoisRequestParams(val query: String, val server: String)

/**
 * `native.net.*` 的参数解析与校验：不合法统一抛 BAD_PARAMS。纯函数，可单测。
 */
internal object NetParams {
    /** Whois 查询串允许的字符：字母数字与 `.-:` */
    private val QUERY_REGEX = Regex("""^[A-Za-z0-9.:\-]+$""")

    /** 抛 BAD_PARAMS */
    private fun bad(msg: String): Nothing = throw BridgeException(BridgeErrors.BAD_PARAMS, msg)

    /** 读可选整数：缺省返回默认值，非整数或越界抛 BAD_PARAMS */
    private fun int(p: JSONObject, key: String, def: Long, min: Long, max: Long): Long {
        val v = p.opt(key)
        if (v == null || v == JSONObject.NULL) return def
        val n = v as? Number ?: bad("$key 必须是数字")
        val d = n.toDouble()
        if (d != Math.floor(d) || d.isInfinite()) bad("$key 必须是整数")
        val l = n.toLong()
        if (l < min || l > max) bad("$key 超出范围（$min~$max）")
        return l
    }

    /** 读必填字符串 */
    private fun str(p: JSONObject, key: String): String {
        val v = p.opt(key)
        return (v as? String)?.takeIf { it.isNotBlank() } ?: bad("缺少 $key")
    }

    /** 读可选字符串，缺省 / null / 空串返回 null */
    private fun strOrNull(p: JSONObject, key: String): String? {
        val v = p.opt(key)
        if (v == null || v == JSONObject.NULL) return null
        return (v as? String ?: bad("$key 必须是字符串")).takeIf { it.isNotBlank() }
    }

    /**
     * 解析并校验一个 http/https URL：无 userinfo、有主机、端口缺省或在白名单。
     *
     * @param raw URL 文本
     * @return 解析后的 URI
     * @throws BridgeException BAD_PARAMS
     */
    fun parseUrl(raw: String): URI {
        val uri = try {
            URI(raw.trim())
        } catch (e: URISyntaxException) {
            bad("url 格式不对")
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") bad("url 只支持 http / https")
        if (uri.host.isNullOrEmpty()) bad("url 缺少主机")
        if (uri.rawUserInfo != null) bad("url 不能带用户名密码")
        if (uri.port != -1 && uri.port !in ALLOWED_PORTS) bad("端口只允许 ${ALLOWED_PORTS.sorted().joinToString("/")}")
        return uri
    }

    /**
     * 过滤请求头：只放行白名单里的键，键转小写；值含换行抛 BAD_PARAMS；补默认 UA 与 Accept。
     *
     * @param raw 页面传来的 headers 对象，可为 null
     * @return 最终要发的请求头
     */
    fun filterHeaders(raw: JSONObject?): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        raw?.keys()?.forEach { k ->
            val key = k.lowercase()
            if (key !in ALLOWED_REQUEST_HEADERS) return@forEach
            val v = raw.opt(k) as? String ?: bad("请求头 $k 必须是字符串")
            if (v.contains('\r') || v.contains('\n')) bad("请求头 $k 含非法字符")
            out[key] = v
        }
        out.putIfAbsent("user-agent", DEFAULT_USER_AGENT)
        out.putIfAbsent("accept", DEFAULT_ACCEPT)
        return out
    }

    /**
     * 解析 `native.net.http` 参数。
     *
     * @param p 页面参数
     * @return 校验后的请求
     * @throws BridgeException BAD_PARAMS
     */
    fun http(p: JSONObject): HttpRequestParams {
        val method = (strOrNull(p, "method") ?: "GET").uppercase()
        if (method !in HTTP_METHODS) bad("method 只支持 GET / HEAD")
        val type = strOrNull(p, "responseType") ?: "text"
        if (type != "text" && type != "base64") bad("responseType 只支持 text / base64")
        val follow = when (val f = p.opt("followRedirects")) {
            null, JSONObject.NULL -> true
            is Boolean -> f
            else -> bad("followRedirects 必须是布尔值")
        }
        val headers = p.opt("headers").let {
            when (it) {
                null, JSONObject.NULL -> null
                is JSONObject -> it
                else -> bad("headers 必须是对象")
            }
        }
        return HttpRequestParams(
            uri = parseUrl(str(p, "url")),
            method = method,
            headers = filterHeaders(headers),
            followRedirects = follow,
            maxRedirects = int(p, "maxRedirects", HTTP_DEFAULT_REDIRECTS.toLong(), 0, HTTP_MAX_REDIRECTS.toLong()).toInt(),
            timeoutMs = int(p, "timeoutMs", HTTP_DEFAULT_TIMEOUT_MS.toLong(), 1, HTTP_MAX_TIMEOUT_MS.toLong()).toInt(),
            maxBytes = int(p, "maxBytes", HTTP_MAX_BODY_BYTES.toLong(), 1, HTTP_MAX_BODY_BYTES.toLong()).toInt(),
            base64 = type == "base64",
        )
    }

    /**
     * 校验主机参数（域名或 IP，可带 IPv6 方括号），返回归一化后的主机。
     *
     * @param raw 主机文本
     * @return 归一化主机
     * @throws BridgeException BAD_PARAMS
     */
    fun host(raw: String): String {
        if (!NetTargetPolicy.isValidHost(raw)) bad("host 格式不对")
        return NetTargetPolicy.normalizeHost(raw)
    }

    /**
     * 解析 `native.net.resolve` 的 host。
     *
     * @param p 页面参数
     * @return 归一化主机
     */
    fun resolveHost(p: JSONObject): String = host(str(p, "host"))

    /**
     * 解析 `native.net.tcp` 参数。
     *
     * @param p 页面参数
     * @return 校验后的参数
     */
    fun tcp(p: JSONObject): TcpRequestParams = TcpRequestParams(
        host = host(str(p, "host")),
        port = int(p, "port", -1, 1, 65535).also { if (it < 0) bad("缺少 port") }.toInt(),
        timeoutMs = int(p, "timeoutMs", TCP_DEFAULT_TIMEOUT_MS.toLong(), 1, TCP_MAX_TIMEOUT_MS.toLong()).toInt(),
    )

    /**
     * 解析 `native.net.whois` 参数。
     *
     * @param p 页面参数
     * @return 校验后的参数
     */
    fun whois(p: JSONObject): WhoisRequestParams {
        val query = str(p, "query")
        if (query.length > NetTargetPolicy.MAX_HOST_LENGTH || !QUERY_REGEX.matches(query)) bad("query 只能是域名或 IP")
        val server = strOrNull(p, "server")
        return WhoisRequestParams(query, if (server == null) WHOIS_DEFAULT_SERVER else host(server))
    }

    /**
     * 解析 `native.net.speed` 参数。
     *
     * @param p 页面参数
     * @return 校验后的参数
     */
    fun speed(p: JSONObject): SpeedRequestParams = SpeedRequestParams(
        uri = parseUrl(str(p, "url")),
        maxBytes = int(p, "maxBytes", SPEED_DEFAULT_BYTES, 1, SPEED_MAX_BYTES),
        durationMs = int(p, "durationMs", SPEED_DEFAULT_MS.toLong(), 1, SPEED_MAX_MS.toLong()).toInt(),
    )
}
