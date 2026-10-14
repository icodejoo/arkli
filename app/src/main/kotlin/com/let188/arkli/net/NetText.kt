package com.let188.arkli.net

import com.let188.arkli.bridge.BridgeErrors
import java.io.IOException
import java.io.InputStream
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException
import java.nio.charset.Charset
import javax.net.ssl.SSLException

/** 跟随重定向的状态码 */
internal val REDIRECT_STATUSES = setOf(301, 302, 303, 307, 308)

/** 读流时单块大小 */
private const val CHUNK_BYTES = 8 * 1024

/**
 * 重定向地址解析：按当前 URL 解析相对地址，只认 http / https。
 */
internal object RedirectResolver {
    /**
     * 解析 `Location`。
     *
     * @param base 当前请求的 URL
     * @param location 响应头里的 Location，可为相对地址
     * @return 绝对地址；为空、格式错、非 http/https 时返回 null
     * 示例：`resolve(URI("https://a.com/x/y"), "/z")` 得到 `https://a.com/z`
     */
    fun resolve(base: URI, location: String): URI? {
        val loc = location.trim()
        if (loc.isEmpty()) return null
        val next = try {
            base.resolve(loc)
        } catch (e: IllegalArgumentException) {
            return null
        }
        val scheme = next.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return null
        if (next.host.isNullOrEmpty()) return null
        return next.normalize()
    }
}

/**
 * Whois 应答解析：从文本里找下一级服务器（`refer:` / `whois:` / `ReferralServer:`）。
 */
internal object WhoisParser {
    /** 引荐行：键名不区分大小写，值取到行尾 */
    private val REFER_REGEX = Regex("""^\s*(?:refer|whois|referralserver)\s*:\s*(\S+)\s*$""", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE))

    /** 值里可能带的协议前缀 */
    private val SCHEME_PREFIX = Regex("""^[a-z]+://""", RegexOption.IGNORE_CASE)

    /**
     * 取第一个有效的下一级服务器名。
     *
     * @param text Whois 应答原文
     * @return 合法主机名（小写，去掉协议前缀与 :43 端口）；没有或不合法返回 null
     * 示例：`referral("refer: whois.verisign-grs.com")` 得到 `whois.verisign-grs.com`
     */
    fun referral(text: String): String? {
        for (m in REFER_REGEX.findAll(text)) {
            val host = m.groupValues[1].replace(SCHEME_PREFIX, "").substringBefore('/').removeSuffix(":43").lowercase()
            if (NetTargetPolicy.isValidHost(host) && !NetTargetPolicy.isIpLiteral(host)) return host
        }
        return null
    }
}

/**
 * 响应体解码与响应头归一化。
 */
internal object HttpBodyDecoder {
    /** 缺省字符集 */
    private val DEFAULT_CHARSET: Charset = Charsets.UTF_8

    /** Content-Type 里的 charset 参数 */
    private val CHARSET_REGEX = Regex("""charset\s*=\s*["']?([^\s;"']+)""", RegexOption.IGNORE_CASE)

    /**
     * 从 Content-Type 取字符集，缺省、未知或不支持时用 UTF-8。
     *
     * @param contentType Content-Type 头的值，可为 null
     * @return 字符集
     */
    fun charsetOf(contentType: String?): Charset {
        val name = contentType?.let { CHARSET_REGEX.find(it)?.groupValues?.get(1) } ?: return DEFAULT_CHARSET
        return try {
            Charset.forName(name)
        } catch (e: IllegalArgumentException) {
            DEFAULT_CHARSET
        }
    }

    /**
     * 按 Content-Type 解码成文本。
     *
     * @param bytes 响应体
     * @param contentType Content-Type 头的值
     * @return 文本
     */
    fun decode(bytes: ByteArray, contentType: String?): String = String(bytes, charsetOf(contentType))

    /**
     * 响应头归一化：键转小写，同名头用 `, ` 合并，跳过状态行（键为 null）。
     *
     * @param raw 原始响应头（键可能为 null）
     * @return 小写键、按首次出现顺序排列的响应头
     */
    fun normalizeHeaders(raw: Map<String?, List<String>>): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for ((k, values) in raw) {
            if (k == null) continue
            val key = k.lowercase()
            val joined = values.joinToString(", ")
            out[key] = out[key]?.let { "$it, $joined" } ?: joined
        }
        return out
    }
}

/**
 * 限量读取：读到上限为止，并判断是否还有剩余。
 */
internal object BodyReader {
    /** 读取结果 */
    class Result(val bytes: ByteArray, val truncated: Boolean)

    /**
     * 最多读 [limit] 字节；再多一个字节也读得到就判定截断。
     *
     * @param input 输入流（不负责关闭）
     * @param limit 字节上限
     * @return 读到的内容与是否截断
     */
    fun readLimited(input: InputStream, limit: Int): Result {
        val out = java.io.ByteArrayOutputStream(minOf(limit, CHUNK_BYTES * 4))
        val buf = ByteArray(CHUNK_BYTES)
        while (out.size() < limit) {
            val n = input.read(buf, 0, minOf(buf.size, limit - out.size()))
            if (n < 0) return Result(out.toByteArray(), false)
            out.write(buf, 0, n)
        }
        return Result(out.toByteArray(), input.read() >= 0)
    }
}

/**
 * 网络异常到桥错误的映射。
 */
internal object NetErrors {
    /**
     * 把底层异常转成「错误码 + 中文提示」。
     *
     * @param e 底层异常
     * @return 超时返回 TIMEOUT，其余网络问题返回 NETWORK
     */
    fun classify(e: Throwable): Pair<String, String> = when (e) {
        is SocketTimeoutException -> BridgeErrors.TIMEOUT to "请求超时"
        is UnknownHostException -> BridgeErrors.NETWORK to "域名无法解析"
        is SSLException -> BridgeErrors.NETWORK to "TLS 连接失败：${e.message ?: "未知原因"}"
        is IOException -> BridgeErrors.NETWORK to (e.message?.takeIf { it.isNotBlank() } ?: "网络连接失败")
        else -> BridgeErrors.NETWORK to (e.message ?: "网络错误")
    }

    /**
     * 给 TCP 探测用的一句话失败原因。
     *
     * @param e 底层异常
     * @return 中文原因
     */
    fun tcpReason(e: Throwable): String = if (e is SocketTimeoutException) "连接超时" else classify(e).second
}
