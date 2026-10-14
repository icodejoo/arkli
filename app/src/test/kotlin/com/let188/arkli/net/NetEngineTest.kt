package com.let188.arkli.net

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** 联网引擎测试：用假解析器 / 假传输层 / 假套接字走完重定向链、拒绝、截断、取消等路径（真实 I/O 线程，用 runBlocking） */
class NetEngineTest {
    private companion object {
        /** 点分 IPv4 字面量 */
        val LITERAL_V4 = Regex("""^\d+(\.\d+){3}$""")
    }

    /** 假解析器：未登记的主机按 IP 字面量解析，登记过的返回指定地址 */
    private class FakeResolver(private val map: Map<String, List<String>> = emptyMap()) : Resolver {
        /** 被解析过的主机 */
        val asked = mutableListOf<String>()

        override fun resolve(host: String): List<InetAddress> {
            asked += host
            val ips = map[host] ?: if (host.contains(':') || LITERAL_V4.matches(host)) listOf(host) else throw UnknownHostException(host)
            return ips.map { InetAddress.getByName(it) }
        }
    }

    /** 一条预设响应 */
    private class Reply(val status: Int, val headers: Map<String?, List<String>> = emptyMap(), val body: ByteArray = ByteArray(0), val failure: IOException? = null)

    /** 假 HTTP 传输：按 URL 取预设响应，记录访问序列与请求头 */
    private class FakeHttp(private val replies: Map<String, Reply>) : HttpTransport {
        /** 访问过的 URL（按顺序） */
        val visited = mutableListOf<String>()

        /** 最近一次请求头 */
        var lastHeaders: Map<String, String> = emptyMap()

        override fun newCall(uri: URI, method: String, headers: Map<String, String>, timeoutMs: Int): HttpCall {
            visited += uri.toString()
            lastHeaders = headers
            val r = replies[uri.toString()] ?: Reply(404)
            return object : HttpCall {
                override fun execute(): HttpHead {
                    r.failure?.let { throw it }
                    return HttpHead(r.status, "OK", r.headers)
                }

                override fun body(): InputStream = ByteArrayInputStream(r.body)
                override fun close() = Unit
            }
        }
    }

    /** 假 TCP 拨号器：按 IP 决定连接结果，记录收发 */
    private class FakeDialer(private val onConnect: (InetAddress, Int) -> Unit = { _, _ -> }, private val response: (String) -> ByteArray = { ByteArray(0) }) : TcpDialer {
        /** 连接过的 `ip:port` */
        val connected = mutableListOf<String>()

        /** 收到的查询行 */
        val sent = mutableListOf<String>()

        override fun newSocket(): TcpSocket = object : TcpSocket {
            /** 本套接字写出的内容 */
            private val out = ByteArrayOutputStream()

            override fun connect(address: InetAddress, port: Int, timeoutMs: Int) {
                connected += "${address.hostAddress}:$port"
                onConnect(address, port)
            }

            override val input: InputStream get() = ByteArrayInputStream(response(out.toString("UTF-8").trim().also { sent += it }))
            override val output: OutputStream get() = out
            override fun close() = Unit
        }
    }

    /** 构造引擎 */
    private fun engine(resolver: Resolver = FakeResolver(), http: HttpTransport = FakeHttp(emptyMap()), dialer: TcpDialer = FakeDialer()) =
        NetEngine(resolver, http, dialer, { java.util.Base64.getEncoder().encodeToString(it) })

    /** 解析 http 参数 */
    private fun httpParams(json: String) = NetParams.http(JSONObject(json))

    /** 重定向头 */
    private fun redirect(status: Int, location: String) = Reply(status, mapOf("Location" to listOf(location)))

    /** 期望抛指定错误码 */
    private fun assertCode(code: String, block: suspend () -> Unit) {
        val e = assertThrows(BridgeException::class.java) { runBlocking { block() } }
        assertEquals(code, e.code)
    }

    @Test
    fun http_plain_get_decodes_text_and_headers() = runBlocking {
        val body = "你好".toByteArray(charset("GBK"))
        val http = FakeHttp(mapOf("https://example.com/" to Reply(200, mapOf(null to listOf("HTTP/1.1 200 OK"), "Content-Type" to listOf("text/html; charset=GBK")), body)))
        val r = engine(FakeResolver(mapOf("example.com" to listOf("93.184.216.34"))), http).http(httpParams("""{"url":"https://example.com/"}"""))
        assertEquals(200, r.getInt("status"))
        assertEquals("你好", r.getString("body"))
        assertEquals("text", r.getString("bodyEncoding"))
        assertFalse(r.getBoolean("truncated"))
        assertEquals(0, r.getJSONArray("redirects").length())
        assertEquals("text/html; charset=GBK", r.getJSONObject("headers").getString("content-type"))
        assertEquals(DEFAULT_USER_AGENT, http.lastHeaders["user-agent"])
    }

    @Test
    fun http_base64_and_truncation() = runBlocking {
        val body = ByteArray(10) { it.toByte() }
        val http = FakeHttp(mapOf("https://example.com/" to Reply(200, body = body)))
        val e = engine(FakeResolver(mapOf("example.com" to listOf("93.184.216.34"))), http)
        val r = e.http(httpParams("""{"url":"https://example.com/","responseType":"base64","maxBytes":4}"""))
        assertEquals(java.util.Base64.getEncoder().encodeToString(body.copyOf(4)), r.getString("body"))
        assertEquals("base64", r.getString("bodyEncoding"))
        assertTrue(r.getBoolean("truncated"))
    }

    @Test
    fun http_follows_redirect_chain_with_relative_and_downgrade() = runBlocking {
        val http = FakeHttp(
            mapOf(
                "https://a.com/start" to redirect(301, "/next"),
                "https://a.com/next" to redirect(302, "http://b.com/final"),
                "http://b.com/final" to Reply(200, body = "ok".toByteArray()),
            ),
        )
        val resolver = FakeResolver(mapOf("a.com" to listOf("1.1.1.1"), "b.com" to listOf("2.2.2.2")))
        val r = engine(resolver, http).http(httpParams("""{"url":"https://a.com/start"}"""))
        assertEquals("http://b.com/final", r.getString("url"))
        assertEquals("ok", r.getString("body"))
        val hops = r.getJSONArray("redirects")
        assertEquals(2, hops.length())
        assertEquals("https://a.com/start", hops.getJSONObject(0).getString("url"))
        assertEquals(301, hops.getJSONObject(0).getInt("status"))
        assertEquals("/next", hops.getJSONObject(0).getString("location"))
        assertEquals("http://b.com/final", hops.getJSONObject(1).getString("location"))
        assertEquals(listOf("a.com", "a.com", "b.com"), resolver.asked)
    }

    @Test
    fun http_loop_stops_at_max_redirects_and_returns_last_response() = runBlocking {
        val http = FakeHttp(mapOf("https://a.com/x" to redirect(302, "/x")))
        val r = engine(FakeResolver(mapOf("a.com" to listOf("1.1.1.1"))), http).http(httpParams("""{"url":"https://a.com/x","maxRedirects":3}"""))
        assertEquals(302, r.getInt("status"))
        assertEquals(3, r.getJSONArray("redirects").length())
        assertEquals(4, http.visited.size)
    }

    @Test
    fun http_followRedirects_false_returns_first_response() = runBlocking {
        val http = FakeHttp(mapOf("https://a.com/x" to redirect(302, "/y")))
        val r = engine(FakeResolver(mapOf("a.com" to listOf("1.1.1.1"))), http).http(httpParams("""{"url":"https://a.com/x","followRedirects":false}"""))
        assertEquals(302, r.getInt("status"))
        assertEquals(0, r.getJSONArray("redirects").length())
        assertEquals("/y", r.getJSONObject("headers").getString("location"))
        assertEquals(1, http.visited.size)
    }

    @Test
    fun http_redirect_without_location_is_final() = runBlocking {
        val http = FakeHttp(mapOf("https://a.com/x" to Reply(302)))
        val r = engine(FakeResolver(mapOf("a.com" to listOf("1.1.1.1"))), http).http(httpParams("""{"url":"https://a.com/x"}"""))
        assertEquals(302, r.getInt("status"))
    }

    @Test
    fun http_denies_internal_target_before_any_request() {
        val http = FakeHttp(emptyMap())
        assertCode(BridgeErrors.PERMISSION_DENIED) { engine(http = http).http(httpParams("""{"url":"http://127.0.0.1/"}""")) }
        assertCode(BridgeErrors.PERMISSION_DENIED) { engine(http = http).http(httpParams("""{"url":"http://localhost/"}""")) }
        assertCode(BridgeErrors.PERMISSION_DENIED) { engine(http = http).http(httpParams("""{"url":"https://[::1]/"}""")) }
        assertCode(BridgeErrors.PERMISSION_DENIED) { engine(FakeResolver(mapOf("evil.com" to listOf("8.8.8.8", "192.168.0.1"))), http).http(httpParams("""{"url":"https://evil.com/"}""")) }
        assertTrue(http.visited.isEmpty())
    }

    @Test
    fun http_denies_redirect_to_internal_target() {
        val http = FakeHttp(mapOf("https://a.com/x" to redirect(302, "http://169.254.169.254/latest/meta-data")))
        assertCode(BridgeErrors.PERMISSION_DENIED) { engine(FakeResolver(mapOf("a.com" to listOf("1.1.1.1"))), http).http(httpParams("""{"url":"https://a.com/x"}""")) }
        assertEquals(listOf("https://a.com/x"), http.visited)
    }

    @Test
    fun http_denies_redirect_to_disallowed_port() {
        val http = FakeHttp(mapOf("https://a.com/x" to redirect(302, "https://a.com:22/")))
        assertCode(BridgeErrors.PERMISSION_DENIED) { engine(FakeResolver(mapOf("a.com" to listOf("1.1.1.1"))), http).http(httpParams("""{"url":"https://a.com/x"}""")) }
    }

    @Test
    fun http_maps_errors() {
        val resolver = FakeResolver(mapOf("a.com" to listOf("1.1.1.1")))
        assertCode(BridgeErrors.TIMEOUT) {
            engine(resolver, FakeHttp(mapOf("https://a.com/" to Reply(0, failure = SocketTimeoutException())))).http(httpParams("""{"url":"https://a.com/"}"""))
        }
        assertCode(BridgeErrors.NETWORK) {
            engine(resolver, FakeHttp(mapOf("https://a.com/" to Reply(0, failure = IOException("reset"))))).http(httpParams("""{"url":"https://a.com/"}"""))
        }
        assertCode(BridgeErrors.NETWORK) { engine(FakeResolver()).http(httpParams("""{"url":"https://nonexistent.example/"}""")) }
    }

    @Test
    fun http_cancel_closes_blocked_connection() = runBlocking {
        val closed = AtomicBoolean(false)
        val entered = CountDownLatch(1)
        val gate = CountDownLatch(1)
        val http = HttpTransport { _, _, _, _ ->
            object : HttpCall {
                override fun execute(): HttpHead {
                    entered.countDown()
                    gate.await(10, TimeUnit.SECONDS)
                    if (closed.get()) throw IOException("closed")
                    return HttpHead(200, "OK", emptyMap())
                }

                override fun body(): InputStream = ByteArrayInputStream(ByteArray(0))
                override fun close() {
                    closed.set(true)
                    gate.countDown()
                }
            }
        }
        val job = async(Dispatchers.Default) { engine(FakeResolver(mapOf("a.com" to listOf("1.1.1.1"))), http).http(httpParams("""{"url":"https://a.com/"}""")) }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        job.cancel()
        val start = System.nanoTime()
        assertThrows(CancellationException::class.java) { runBlocking { job.await() } }
        assertTrue("取消应尽快返回", System.nanoTime() - start < TimeUnit.SECONDS.toNanos(3))
        assertTrue(closed.get())
    }

    @Test
    fun resolve_returns_addresses_even_for_internal() = runBlocking {
        val r = engine(FakeResolver(mapOf("intra.example.com" to listOf("10.0.0.5", "2001:db8::1", "10.0.0.5")))).resolve("intra.example.com")
        val arr = r.getJSONArray("addresses")
        assertEquals(2, arr.length())
        assertEquals("10.0.0.5", arr.getJSONObject(0).getString("ip"))
        assertEquals(4, arr.getJSONObject(0).getInt("family"))
        assertEquals(6, arr.getJSONObject(1).getInt("family"))
    }

    @Test
    fun resolve_unknown_host_is_network_error() {
        assertCode(BridgeErrors.NETWORK) { engine(FakeResolver()).resolve("nope.example.com") }
    }

    @Test
    fun tcp_success_failure_and_denied() = runBlocking {
        val resolver = FakeResolver(mapOf("a.com" to listOf("1.1.1.1")))
        val ok = engine(resolver, dialer = FakeDialer()).tcp(NetParams.tcp(JSONObject("""{"host":"a.com","port":443}""")))
        assertTrue(ok.getBoolean("ok"))
        assertFalse(ok.has("error"))
        val bad = engine(resolver, dialer = FakeDialer({ _, _ -> throw IOException("Connection refused") })).tcp(NetParams.tcp(JSONObject("""{"host":"a.com","port":443}""")))
        assertFalse(bad.getBoolean("ok"))
        assertEquals("Connection refused", bad.getString("error"))
        val timeout = engine(resolver, dialer = FakeDialer({ _, _ -> throw SocketTimeoutException() })).tcp(NetParams.tcp(JSONObject("""{"host":"a.com","port":443}""")))
        assertEquals("连接超时", timeout.getString("error"))
        val unknown = engine(FakeResolver()).tcp(NetParams.tcp(JSONObject("""{"host":"nope.example.com","port":80}""")))
        assertFalse(unknown.getBoolean("ok"))
        assertCode(BridgeErrors.PERMISSION_DENIED) { engine().tcp(NetParams.tcp(JSONObject("""{"host":"192.168.1.1","port":80}"""))) }
    }

    @Test
    fun tcp_tries_next_address_after_failure() = runBlocking {
        val resolver = FakeResolver(mapOf("a.com" to listOf("1.1.1.1", "2.2.2.2")))
        val dialer = FakeDialer({ addr, _ -> if (addr.hostAddress == "1.1.1.1") throw IOException("no route") })
        val r = engine(resolver, dialer = dialer).tcp(NetParams.tcp(JSONObject("""{"host":"a.com","port":80}""")))
        assertTrue(r.getBoolean("ok"))
        assertEquals(listOf("1.1.1.1:80", "2.2.2.2:80"), dialer.connected)
    }

    @Test
    fun tcp_overall_timeout_returns_not_ok() = runBlocking {
        val resolver = FakeResolver(mapOf("a.com" to listOf("1.1.1.1")))
        val latch = CountDownLatch(1)
        val dialer = TcpDialer {
            object : TcpSocket {
                override fun connect(address: InetAddress, port: Int, timeoutMs: Int) {
                    latch.await(5, TimeUnit.SECONDS)
                    throw IOException("closed")
                }

                override val input: InputStream get() = ByteArrayInputStream(ByteArray(0))
                override val output: OutputStream get() = ByteArrayOutputStream()
                override fun close() = latch.countDown()
            }
        }
        val start = System.nanoTime()
        val r = engine(resolver, dialer = dialer).tcp(NetParams.tcp(JSONObject("""{"host":"a.com","port":80,"timeoutMs":200}""")))
        assertTrue(System.nanoTime() - start < TimeUnit.SECONDS.toNanos(3))
        assertFalse(r.getBoolean("ok"))
        assertEquals("连接超时", r.getString("error"))
    }

    @Test
    fun whois_follows_referral_up_to_two_levels() = runBlocking {
        val resolver = FakeResolver(mapOf("whois.iana.org" to listOf("1.1.1.1"), "whois.tld.example" to listOf("2.2.2.2"), "whois.reg.example" to listOf("3.3.3.3"), "whois.deep.example" to listOf("4.4.4.4")))
        val dialer = FakeDialer(response = { _ ->
            ByteArray(0)
        })
        // 按连接顺序给不同应答
        val answers = ArrayDeque(listOf("refer: whois.tld.example\n", "Domain: X\nwhois: whois.reg.example\n", "Final answer\nrefer: whois.deep.example\n"))
        val seq = object : TcpDialer {
            override fun newSocket(): TcpSocket {
                val inner = dialer.newSocket()
                val text = answers.removeFirst()
                return object : TcpSocket by inner {
                    override val input: InputStream get() = inner.input.let { ByteArrayInputStream(text.toByteArray()) }
                }
            }
        }
        val r = engine(resolver, dialer = seq).whois(NetParams.whois(JSONObject("""{"query":"example.com"}""")))
        assertEquals("whois.reg.example", r.getString("server"))
        assertTrue(r.getString("text").startsWith("Final answer"))
        assertEquals(listOf("1.1.1.1:43", "2.2.2.2:43", "3.3.3.3:43"), dialer.connected)
        assertEquals(listOf("example.com", "example.com", "example.com"), dialer.sent)
    }

    @Test
    fun whois_referral_to_internal_server_is_not_followed() = runBlocking {
        val resolver = FakeResolver(mapOf("whois.iana.org" to listOf("1.1.1.1"), "evil.example" to listOf("10.0.0.9")))
        val dialer = FakeDialer(response = { "refer: evil.example\nbody" .toByteArray() })
        val r = engine(resolver, dialer = dialer).whois(NetParams.whois(JSONObject("""{"query":"example.com"}""")))
        assertEquals("whois.iana.org", r.getString("server"))
        assertTrue(r.getString("text").contains("body"))
        assertEquals(1, dialer.connected.size)
    }

    @Test
    fun whois_followup_failure_falls_back_and_first_failure_throws() {
        val resolver = FakeResolver(mapOf("whois.iana.org" to listOf("1.1.1.1"), "whois.next.example" to listOf("2.2.2.2")))
        val dialer = FakeDialer(onConnect = { addr, _ -> if (addr.hostAddress == "2.2.2.2") throw IOException("down") }, response = { "refer: whois.next.example\n".toByteArray() })
        val r = runBlocking { engine(resolver, dialer = dialer).whois(NetParams.whois(JSONObject("""{"query":"example.com"}"""))) }
        assertEquals("whois.iana.org", r.getString("server"))
        val down = FakeDialer(onConnect = { _, _ -> throw IOException("down") })
        assertCode(BridgeErrors.NETWORK) { engine(resolver, dialer = down).whois(NetParams.whois(JSONObject("""{"query":"example.com"}"""))) }
        assertCode(BridgeErrors.PERMISSION_DENIED) { engine(resolver, dialer = down).whois(NetParams.whois(JSONObject("""{"query":"a.com","server":"10.0.0.1"}"""))) }
    }

    @Test
    fun whois_truncates_at_64kb() = runBlocking {
        val resolver = FakeResolver(mapOf("whois.iana.org" to listOf("1.1.1.1")))
        val dialer = FakeDialer(response = { ByteArray(WHOIS_MAX_BYTES + 10) { 'a'.code.toByte() } })
        val r = engine(resolver, dialer = dialer).whois(NetParams.whois(JSONObject("""{"query":"example.com"}""")))
        assertEquals(WHOIS_MAX_BYTES, r.getString("text").length)
        assertTrue(r.getBoolean("truncated"))
    }

    @Test
    fun speed_counts_bytes_up_to_limit() = runBlocking {
        val http = FakeHttp(mapOf("https://s.com/f" to Reply(200, body = ByteArray(300_000))))
        val r = engine(FakeResolver(mapOf("s.com" to listOf("1.1.1.1"))), http).speed(NetParams.speed(JSONObject("""{"url":"https://s.com/f","maxBytes":100000}""")))
        assertEquals(100_000L, r.getLong("bytes"))
        assertTrue(r.getLong("elapsedMs") >= 1)
        assertTrue(r.getLong("bps") > 0)
    }

    @Test
    fun speed_follows_redirects_and_limits_hops() = runBlocking {
        val http = FakeHttp(mapOf("https://s.com/a" to redirect(302, "/b"), "https://s.com/b" to Reply(200, body = ByteArray(1000))))
        val e = engine(FakeResolver(mapOf("s.com" to listOf("1.1.1.1"))), http)
        assertEquals(1000L, e.speed(NetParams.speed(JSONObject("""{"url":"https://s.com/a"}"""))).getLong("bytes"))
        val loop = FakeHttp(mapOf("https://s.com/a" to redirect(302, "/a")))
        assertCode(BridgeErrors.NETWORK) { engine(FakeResolver(mapOf("s.com" to listOf("1.1.1.1"))), loop).speed(NetParams.speed(JSONObject("""{"url":"https://s.com/a"}"""))) }
        assertEquals(SPEED_MAX_REDIRECTS + 1, loop.visited.size)
    }

    @Test
    fun speed_denies_internal_and_reports_bad_status() {
        assertCode(BridgeErrors.PERMISSION_DENIED) { engine().speed(NetParams.speed(JSONObject("""{"url":"http://10.0.0.1/f"}"""))) }
        val http = FakeHttp(mapOf("https://s.com/f" to Reply(503)))
        assertCode(BridgeErrors.NETWORK) { engine(FakeResolver(mapOf("s.com" to listOf("1.1.1.1"))), http).speed(NetParams.speed(JSONObject("""{"url":"https://s.com/f"}"""))) }
    }

    @Test
    fun speed_stops_at_duration_when_stream_stalls() = runBlocking {
        val closed = CompletableDeferred<Unit>()
        val release = CountDownLatch(1)
        val http = HttpTransport { _, _, _, _ ->
            object : HttpCall {
                override fun execute() = HttpHead(200, "OK", emptyMap())
                override fun body(): InputStream = object : InputStream() {
                    /** 第一次给 1000 字节，之后一直卡住直到被关闭 */
                    private var first = true

                    override fun read(): Int = -1
                    override fun read(b: ByteArray, off: Int, len: Int): Int {
                        if (first) {
                            first = false
                            return minOf(1000, len)
                        }
                        release.await(10, TimeUnit.SECONDS)
                        throw IOException("closed")
                    }
                }

                override fun close() {
                    release.countDown()
                    closed.complete(Unit)
                }
            }
        }
        val start = System.nanoTime()
        val r = engine(FakeResolver(mapOf("s.com" to listOf("1.1.1.1"))), http).speed(NetParams.speed(JSONObject("""{"url":"https://s.com/f","durationMs":300}""")))
        assertEquals(1000L, r.getLong("bytes"))
        assertTrue("应在时长到点后很快结束", System.nanoTime() - start < TimeUnit.SECONDS.toNanos(5))
        delay(10)
        assertTrue(closed.isCompleted)
    }
}
