package com.let188.arkli.net

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.URI
import java.net.UnknownHostException
import java.util.concurrent.atomic.AtomicLong

/** 纳秒换毫秒 */
private const val NANOS_PER_MS = 1_000_000L

/** 毫秒换秒 */
private const val MS_PER_SECOND = 1000L

/** 一个字节的位数 */
private const val BITS_PER_BYTE = 8L

/** 测速读块大小 */
private const val SPEED_CHUNK_BYTES = 64 * 1024

/** 一跳的结果 */
private class HopResult(val head: HttpHead, val body: ByteArray, val truncated: Boolean)

/** 持有「当前正在连的套接字」，让取消时能关到它 */
private class SocketHolder : Closeable {
    /** 当前套接字 */
    @Volatile
    var current: TcpSocket? = null

    /** 关闭当前套接字 */
    override fun close() {
        current?.close()
    }
}

/**
 * 联网核心逻辑：HTTP（手动重定向 + 逐跳目标校验）、测速、TCP 探测、Whois、DNS 解析。
 * 网络与 DNS 通过接口注入，处理器与单测都走它。所有方法可取消，取消时关闭底层连接。
 *
 * @param resolver DNS 解析器
 * @param http HTTP 传输层
 * @param dialer TCP 套接字工厂
 * @param base64 字节转 base64（Android 用 android.util.Base64，单测用 java.util.Base64）
 * @param clock 纳秒时钟，单测可替换
 */
internal class NetEngine(
    private val resolver: Resolver,
    private val http: HttpTransport,
    private val dialer: TcpDialer,
    private val base64: (ByteArray) -> String,
    private val clock: () -> Long = System::nanoTime,
) {
    /** 把底层异常统一转成 BridgeException；取消异常原样抛出 */
    private suspend fun <T> mapped(block: suspend () -> T): T = try {
        block()
    } catch (e: TargetDeniedException) {
        throw BridgeException(BridgeErrors.PERMISSION_DENIED, NetTargetPolicy.DENIED_MESSAGE)
    } catch (e: TimeoutCancellationException) {
        throw BridgeException(BridgeErrors.TIMEOUT, "请求超时")
    } catch (e: CancellationException) {
        throw e
    } catch (e: BridgeException) {
        throw e
    } catch (e: IOException) {
        currentCoroutineContext().ensureActive()
        val (code, msg) = NetErrors.classify(e)
        throw BridgeException(code, msg)
    }

    /** 从起点算起过去了多少毫秒 */
    private fun elapsedMs(start: Long): Long = (clock() - start) / NANOS_PER_MS

    /** 校验目标（解析 + 逐地址判断），在 IO 线程执行 */
    private suspend fun checkTarget(host: String): List<InetAddress> =
        withContext(Dispatchers.IO) { NetTargetPolicy.check(host, resolver) }

    /** 取响应头里的 Location（不区分大小写） */
    private fun locationOf(head: HttpHead): String? =
        head.headers.entries.firstOrNull { it.key.equals("location", ignoreCase = true) }?.value?.firstOrNull()

    /** 重定向目标的端口也要在白名单内 */
    private fun requirePortAllowed(uri: URI) {
        if (uri.port != -1 && uri.port !in ALLOWED_PORTS) throw TargetDeniedException()
    }

    /**
     * 发一跳请求（不跟随重定向）。
     *
     * @param wantBody 看完响应头后是否需要读响应体
     */
    private suspend fun hop(
        uri: URI,
        method: String,
        headers: Map<String, String>,
        timeoutMs: Int,
        maxBytes: Int,
        wantBody: (HttpHead) -> Boolean,
    ): HopResult = withTimeout(timeoutMs.toLong()) {
        val call = http.newCall(uri, method, headers, timeoutMs)
        withClosing(call) {
            val head = call.execute()
            if (method == "HEAD" || !wantBody(head)) {
                HopResult(head, ByteArray(0), false)
            } else {
                val r = BodyReader.readLimited(call.body(), maxBytes)
                HopResult(head, r.bytes, r.truncated)
            }
        }
    }

    /**
     * 执行 `native.net.http`。
     *
     * @param p 已校验的参数
     * @return 响应 JSON：status / statusText / url / redirects / headers / body / bodyEncoding / truncated / elapsedMs
     * @throws BridgeException PERMISSION_DENIED（目标被拒）、TIMEOUT、NETWORK
     */
    suspend fun http(p: HttpRequestParams): JSONObject = mapped {
        val start = clock()
        var cur = p.uri
        val redirects = JSONArray()
        while (true) {
            checkTarget(cur.host)
            val canFollow = p.followRedirects && redirects.length() < p.maxRedirects
            var next: URI? = null
            var rawLocation: String? = null
            val r = hop(cur, p.method, p.headers, p.timeoutMs, p.maxBytes) { head ->
                if (canFollow && head.status in REDIRECT_STATUSES) {
                    rawLocation = locationOf(head)
                    next = rawLocation?.let { RedirectResolver.resolve(cur, it) }
                }
                next == null
            }
            val target = next
            if (target != null) {
                requirePortAllowed(target)
                redirects.put(JSONObject().put("url", cur.toString()).put("status", r.head.status).put("location", rawLocation))
                cur = target
                continue
            }
            val headers = HttpBodyDecoder.normalizeHeaders(r.head.headers)
            val body = if (p.base64) base64(r.body) else HttpBodyDecoder.decode(r.body, headers["content-type"])
            return@mapped JSONObject()
                .put("status", r.head.status)
                .put("statusText", r.head.statusText)
                .put("url", cur.toString())
                .put("redirects", redirects)
                .put("headers", JSONObject(headers))
                .put("body", body)
                .put("bodyEncoding", if (p.base64) "base64" else "text")
                .put("truncated", r.truncated)
                .put("elapsedMs", elapsedMs(start))
        }
        throw IllegalStateException("循环不会正常退出")
    }

    /**
     * 执行 `native.net.speed`：流式下载并丢弃内容，到量或到时即停。
     * 耗时从响应头到达后开始算（只计传输，不含建连与握手）。
     *
     * @param p 已校验的参数
     * @return `{ bytes, elapsedMs, bps }`
     * @throws BridgeException PERMISSION_DENIED、TIMEOUT、NETWORK（含非 2xx 状态）
     */
    suspend fun speed(p: SpeedRequestParams): JSONObject = mapped {
        var cur = p.uri
        var redirects = 0
        val headers = mapOf("user-agent" to DEFAULT_USER_AGENT, "accept" to DEFAULT_ACCEPT)
        while (true) {
            checkTarget(cur.host)
            val call = http.newCall(cur, "GET", headers, p.durationMs)
            try {
                val head = withTimeout(p.durationMs.toLong()) { withClosing(call, closeOnSuccess = false) { call.execute() } }
                val next = if (head.status in REDIRECT_STATUSES && redirects < SPEED_MAX_REDIRECTS) {
                    locationOf(head)?.let { RedirectResolver.resolve(cur, it) }
                } else {
                    null
                }
                if (next != null) {
                    requirePortAllowed(next)
                    cur = next
                    redirects++
                    continue
                }
                if (head.status !in 200..299) throw BridgeException(BridgeErrors.NETWORK, "服务器返回 HTTP ${head.status}")
                return@mapped drain(call, p)
            } finally {
                call.close()
            }
        }
        throw IllegalStateException("循环不会正常退出")
    }

    /** 读空响应体并计数，到量或到时即停，返回测速结果 */
    private suspend fun drain(call: HttpCall, p: SpeedRequestParams): JSONObject {
        val counter = AtomicLong(0)
        val t0 = clock()
        val deadline = t0 + p.durationMs * NANOS_PER_MS
        withTimeoutOrNull(p.durationMs.toLong()) {
            withClosing(call) {
                val buf = ByteArray(SPEED_CHUNK_BYTES)
                try {
                    val input = call.body()
                    while (counter.get() < p.maxBytes && clock() < deadline) {
                        val want = minOf(buf.size.toLong(), p.maxBytes - counter.get()).toInt()
                        val n = input.read(buf, 0, want)
                        if (n < 0) break
                        counter.addAndGet(n.toLong())
                    }
                } catch (e: IOException) {
                    if (counter.get() == 0L) throw e
                }
            }
        }
        val elapsed = maxOf(elapsedMs(t0), 1L)
        val bytes = counter.get()
        return JSONObject().put("bytes", bytes).put("elapsedMs", elapsed).put("bps", bytes * BITS_PER_BYTE * MS_PER_SECOND / elapsed)
    }

    /**
     * 执行 `native.net.resolve`：只解析，不做内网判断，原样返回。
     *
     * @param host 已校验的主机
     * @return `{ addresses: [{ ip, family }], elapsedMs }`
     * @throws BridgeException NETWORK（解析失败）
     */
    suspend fun resolve(host: String): JSONObject = mapped {
        val start = clock()
        val list = runInterruptible(Dispatchers.IO) { resolver.resolve(host) }
        val arr = JSONArray()
        list.map { it.hostAddress.orEmpty().substringBefore('%') to if (NetTargetPolicy.isV4(it)) 4 else 6 }
            .distinct()
            .forEach { (ip, family) -> arr.put(JSONObject().put("ip", ip).put("family", family)) }
        JSONObject().put("addresses", arr).put("elapsedMs", elapsedMs(start))
    }

    /**
     * 执行 `native.net.tcp`：连上即成功；连不上或超时返回 `ok:false`，不抛错。目标在内网时抛 PERMISSION_DENIED。
     *
     * @param p 已校验的参数
     * @return `{ ok, elapsedMs, error? }`
     */
    suspend fun tcp(p: TcpRequestParams): JSONObject = mapped {
        val start = clock()
        val addrs = try {
            checkTarget(p.host)
        } catch (e: UnknownHostException) {
            return@mapped tcpResult(false, elapsedMs(start), "域名无法解析")
        }
        var lastError = "连接失败"
        val holder = SocketHolder()
        val ok = withTimeoutOrNull(p.timeoutMs.toLong()) {
            withClosing(holder) {
                for (addr in addrs) {
                    val s = dialer.newSocket()
                    holder.current = s
                    try {
                        s.connect(addr, p.port, p.timeoutMs)
                        return@withClosing true
                    } catch (e: IOException) {
                        lastError = NetErrors.tcpReason(e)
                    } finally {
                        s.close()
                    }
                }
                false
            }
        }
        when (ok) {
            true -> tcpResult(true, elapsedMs(start), null)
            false -> tcpResult(false, elapsedMs(start), lastError)
            null -> tcpResult(false, elapsedMs(start), "连接超时")
        }
    }

    /** 拼 TCP 结果 */
    private fun tcpResult(ok: Boolean, elapsed: Long, error: String?): JSONObject {
        val o = JSONObject().put("ok", ok).put("elapsedMs", elapsed)
        if (error != null) o.put("error", error)
        return o
    }

    /**
     * 执行 `native.net.whois`：向 43 端口发查询，按 `refer:` / `whois:` 行最多再跟随 2 级。
     * 后续级失败（被拒、超时、连不上）时回退到上一级的结果。
     *
     * @param p 已校验的参数
     * @return `{ server, text, truncated }`
     * @throws BridgeException 第一级失败时的 PERMISSION_DENIED / TIMEOUT / NETWORK
     */
    suspend fun whois(p: WhoisRequestParams): JSONObject = mapped {
        var server = p.server
        var result = queryWhois(server, p.query)
        var level = 0
        while (level < WHOIS_MAX_REFERRALS) {
            val next = WhoisParser.referral(result.first)?.takeIf { !it.equals(server, ignoreCase = true) } ?: break
            val r = try {
                queryWhois(next, p.query)
            } catch (e: TargetDeniedException) {
                break
            } catch (e: TimeoutCancellationException) {
                break
            } catch (e: IOException) {
                break
            }
            server = next
            result = r
            level++
        }
        JSONObject().put("server", server).put("text", result.first).put("truncated", result.second)
    }

    /** 查询一台 Whois 服务器，返回（文本，是否截断） */
    private suspend fun queryWhois(server: String, query: String): Pair<String, Boolean> {
        val addrs = checkTarget(server)
        val holder = SocketHolder()
        return withTimeout(WHOIS_TIMEOUT_MS.toLong()) {
            withClosing(holder) {
                var failure: IOException? = null
                for (addr in addrs) {
                    val s = dialer.newSocket()
                    holder.current = s
                    try {
                        s.connect(addr, WHOIS_PORT, WHOIS_TIMEOUT_MS)
                        s.output.write("$query\r\n".toByteArray(Charsets.UTF_8))
                        s.output.flush()
                        val r = BodyReader.readLimited(s.input, WHOIS_MAX_BYTES)
                        return@withClosing String(r.bytes, Charsets.UTF_8) to r.truncated
                    } catch (e: IOException) {
                        failure = e
                        s.close()
                    }
                }
                throw failure ?: IOException("Whois 服务器无可用地址")
            }
        }
    }
}
