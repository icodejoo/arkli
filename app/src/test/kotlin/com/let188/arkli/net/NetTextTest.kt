package com.let188.arkli.net

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException

/** 重定向解析、Whois 解析、解码、限量读取、错误映射、参数校验的纯逻辑测试 */
class NetTextTest {
    @Test
    fun redirect_resolves_relative_and_absolute() {
        val base = URI("https://a.com/x/y?q=1")
        assertEquals("https://a.com/z", RedirectResolver.resolve(base, "/z").toString())
        assertEquals("https://a.com/x/w", RedirectResolver.resolve(base, "w").toString())
        assertEquals("http://b.org/p", RedirectResolver.resolve(base, "http://b.org/p").toString())
        assertEquals("https://c.com/", RedirectResolver.resolve(base, "//c.com/").toString())
    }

    @Test
    fun redirect_rejects_bad_locations() {
        val base = URI("https://a.com/")
        assertNull(RedirectResolver.resolve(base, ""))
        assertNull(RedirectResolver.resolve(base, "ftp://a.com/x"))
        assertNull(RedirectResolver.resolve(base, "javascript:alert(1)"))
        assertNull(RedirectResolver.resolve(base, "http://exa mple.com"))
    }

    @Test
    fun whois_referral_parsing() {
        assertEquals("whois.verisign-grs.com", WhoisParser.referral("% IANA\n\nrefer:        whois.verisign-grs.com\n\ndomain: COM"))
        assertEquals("whois.arin.net", WhoisParser.referral("ReferralServer: whois://whois.arin.net:43\n"))
        assertEquals("whois.example.org", WhoisParser.referral("whois: WHOIS.Example.org"))
        assertNull(WhoisParser.referral("Registrar WHOIS Server: whois.markmonitor.com"))
        assertNull(WhoisParser.referral("refer: 10.0.0.1"))
        assertNull(WhoisParser.referral("refer: bad host!"))
        assertNull(WhoisParser.referral(""))
    }

    @Test
    fun charset_extraction() {
        assertEquals(charset("GBK"), HttpBodyDecoder.charsetOf("text/html; charset=gbk"))
        assertEquals(Charsets.UTF_8, HttpBodyDecoder.charsetOf(null))
        assertEquals(Charsets.UTF_8, HttpBodyDecoder.charsetOf("text/html"))
        assertEquals(Charsets.UTF_8, HttpBodyDecoder.charsetOf("text/html; charset=nope-9"))
        assertEquals(Charsets.ISO_8859_1, HttpBodyDecoder.charsetOf("text/plain; charset=\"ISO-8859-1\""))
    }

    @Test
    fun decode_uses_charset() {
        val gbk = "你好".toByteArray(charset("GBK"))
        assertEquals("你好", HttpBodyDecoder.decode(gbk, "text/html; charset=GBK"))
        assertEquals("你好", HttpBodyDecoder.decode("你好".toByteArray(), null))
    }

    @Test
    fun headers_normalized_and_merged() {
        val raw = linkedMapOf<String?, List<String>>(
            null to listOf("HTTP/1.1 200 OK"),
            "Content-Type" to listOf("text/html"),
            "Set-Cookie" to listOf("a=1", "b=2"),
            "set-cookie" to listOf("c=3"),
        )
        val out = HttpBodyDecoder.normalizeHeaders(raw)
        assertEquals(listOf("content-type", "set-cookie"), out.keys.toList())
        assertEquals("a=1, b=2, c=3", out["set-cookie"])
    }

    @Test
    fun readLimited_truncation() {
        val data = ByteArray(100) { it.toByte() }
        val full = BodyReader.readLimited(ByteArrayInputStream(data), 100)
        assertEquals(100, full.bytes.size)
        assertFalse(full.truncated)
        val cut = BodyReader.readLimited(ByteArrayInputStream(data), 99)
        assertEquals(99, cut.bytes.size)
        assertTrue(cut.truncated)
        assertEquals(0, BodyReader.readLimited(ByteArrayInputStream(ByteArray(0)), 10).bytes.size)
    }

    @Test
    fun error_classification() {
        assertEquals(BridgeErrors.TIMEOUT, NetErrors.classify(SocketTimeoutException()).first)
        assertEquals(BridgeErrors.NETWORK, NetErrors.classify(UnknownHostException("x")).first)
        assertEquals(BridgeErrors.NETWORK, NetErrors.classify(IOException()).first)
        assertEquals("连接超时", NetErrors.tcpReason(SocketTimeoutException()))
    }

    /** 期望抛 BAD_PARAMS */
    private fun assertBad(block: () -> Unit) {
        val e = assertThrows(BridgeException::class.java) { block() }
        assertEquals(BridgeErrors.BAD_PARAMS, e.code)
    }

    @Test
    fun http_params_defaults_and_headers() {
        val p = NetParams.http(JSONObject("""{"url":"https://example.com/a","headers":{"Accept":"application/json","Cookie":"x=1","X-Evil":"1","Accept-Language":"zh"}}"""))
        assertEquals("GET", p.method)
        assertTrue(p.followRedirects)
        assertEquals(5, p.maxRedirects)
        assertEquals(10_000, p.timeoutMs)
        assertEquals(2 * 1024 * 1024, p.maxBytes)
        assertFalse(p.base64)
        assertEquals(setOf("accept", "accept-language", "user-agent"), p.headers.keys)
        assertEquals("application/json", p.headers["accept"])
        assertEquals(DEFAULT_USER_AGENT, p.headers["user-agent"])
    }

    @Test
    fun http_params_rejections() {
        assertBad { NetParams.http(JSONObject("{}")) }
        assertBad { NetParams.http(JSONObject("""{"url":"ftp://a.com"}""")) }
        assertBad { NetParams.http(JSONObject("""{"url":"https://a.com:22/"}""")) }
        assertBad { NetParams.http(JSONObject("""{"url":"https://u:p@a.com/"}""")) }
        assertBad { NetParams.http(JSONObject("""{"url":"https://a.com","method":"POST"}""")) }
        assertBad { NetParams.http(JSONObject("""{"url":"https://a.com","maxRedirects":11}""")) }
        assertBad { NetParams.http(JSONObject("""{"url":"https://a.com","timeoutMs":20001}""")) }
        assertBad { NetParams.http(JSONObject("""{"url":"https://a.com","maxBytes":2097153}""")) }
        assertBad { NetParams.http(JSONObject("""{"url":"https://a.com","responseType":"hex"}""")) }
        assertBad { NetParams.http(JSONObject("""{"url":"https://a.com","headers":{"accept":"a\r\nX: y"}}""")) }
        assertBad { NetParams.http(JSONObject("""{"url":"https://a.com","timeoutMs":1.5}""")) }
    }

    @Test
    fun http_params_allowed_ports() {
        listOf(80, 443, 8080, 8443).forEach { NetParams.http(JSONObject("""{"url":"http://a.com:$it/"}""")) }
    }

    @Test
    fun tcp_resolve_whois_speed_params() {
        val t = NetParams.tcp(JSONObject("""{"host":"example.com","port":443}"""))
        assertEquals(5000, t.timeoutMs)
        assertBad { NetParams.tcp(JSONObject("""{"host":"example.com","port":0}""")) }
        assertBad { NetParams.tcp(JSONObject("""{"host":"example.com"}""")) }
        assertBad { NetParams.tcp(JSONObject("""{"host":"example.com","port":80,"timeoutMs":15001}""")) }
        assertBad { NetParams.resolveHost(JSONObject("""{"host":"a b"}""")) }
        assertEquals("::1", NetParams.resolveHost(JSONObject("""{"host":"[::1]"}""")))
        val w = NetParams.whois(JSONObject("""{"query":"example.com"}"""))
        assertEquals("whois.iana.org", w.server)
        assertBad { NetParams.whois(JSONObject("""{"query":"a b;c"}""")) }
        assertBad { NetParams.whois(JSONObject("""{"query":"a.com","server":"bad host"}""")) }
        assertBad { NetParams.whois(JSONObject("""{"query":"${"a".repeat(254)}"}""")) }
        val s = NetParams.speed(JSONObject("""{"url":"https://a.com/f"}"""))
        assertEquals(26214400L, s.maxBytes)
        assertEquals(8000, s.durationMs)
        assertBad { NetParams.speed(JSONObject("""{"url":"https://a.com/f","maxBytes":52428801}""")) }
        assertBad { NetParams.speed(JSONObject("""{"url":"https://a.com/f","durationMs":15001}""")) }
    }
}
