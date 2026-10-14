package com.let188.arkli.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 出站白名单、去向判定与 CSP 拼装测试 */
class NetPolicyTest {
    private val appHost = "appassets.androidplatform.net"
    private val ok = "https://api.wikimedia.org/feed/v1/wikipedia/zh/onthisday/events/09/17"

    @Test
    fun allowsExactHost() {
        assertTrue(NetPolicy.isAllowedOutbound(ok))
        assertTrue(NetPolicy.isAllowedOutbound("https://api.wikimedia.org"))
        assertTrue(NetPolicy.isAllowedOutbound("https://api.wikimedia.org:443/x?a=1"))
    }

    @Test
    fun hostCaseInsensitive() {
        assertTrue(NetPolicy.isAllowedOutbound("https://API.Wikimedia.ORG/x"))
        assertTrue(NetPolicy.isAllowedOutbound("HTTPS://api.wikimedia.org/x"))
    }

    @Test
    fun rejectsSubdomainTricks() {
        assertFalse(NetPolicy.isAllowedOutbound("https://api.wikimedia.org.attacker.com/x"))
        assertFalse(NetPolicy.isAllowedOutbound("https://evil-api.wikimedia.org/x"))
        assertFalse(NetPolicy.isAllowedOutbound("https://x.api.wikimedia.org/x"))
        assertFalse(NetPolicy.isAllowedOutbound("https://wikimedia.org/x"))
        assertFalse(NetPolicy.isAllowedOutbound("https://api.wikimedia.org./x"))
    }

    @Test
    fun rejectsNonDefaultPort() {
        assertFalse(NetPolicy.isAllowedOutbound("https://api.wikimedia.org:8443/x"))
        assertFalse(NetPolicy.isAllowedOutbound("https://api.wikimedia.org:80/x"))
    }

    @Test
    fun rejectsUserinfoTricks() {
        assertFalse(NetPolicy.isAllowedOutbound("https://api.wikimedia.org@evil.com/x"))
        assertFalse(NetPolicy.isAllowedOutbound("https://evil.com@api.wikimedia.org/x"))
        assertFalse(NetPolicy.isAllowedOutbound("https://api.wikimedia.org:pw@evil.com/x"))
    }

    @Test
    fun rejectsNonHttps() {
        assertFalse(NetPolicy.isAllowedOutbound("http://api.wikimedia.org/x"))
        assertFalse(NetPolicy.isAllowedOutbound("ftp://api.wikimedia.org/x"))
        assertFalse(NetPolicy.isAllowedOutbound("//api.wikimedia.org/x"))
        assertFalse(NetPolicy.isAllowedOutbound("file:///etc/hosts"))
    }

    @Test
    fun rejectsIpAndPunycode() {
        assertFalse(NetPolicy.isAllowedOutbound("https://127.0.0.1/x"))
        assertFalse(NetPolicy.isAllowedOutbound("https://[::1]/x"))
        assertFalse(NetPolicy.isAllowedOutbound("https://208.80.154.224/x"))
        assertFalse(NetPolicy.isAllowedOutbound("https://xn--pi-wikimedia.org/x"))
        assertFalse(NetPolicy.isAllowedOutbound("https://api.wikimedia.org\\@evil.com/x"))
    }

    @Test
    fun rejectsGarbage() {
        assertFalse(NetPolicy.isAllowedOutbound(""))
        assertFalse(NetPolicy.isAllowedOutbound("not a url"))
        assertFalse(NetPolicy.isAllowedOutbound("https://"))
    }

    @Test
    fun classifyRoutes() {
        assertEquals(NetVerdict.APP, NetPolicy.classify("https://$appHost/assets/web/index.html", appHost))
        assertEquals(NetVerdict.ALLOW, NetPolicy.classify(ok, appHost))
        assertEquals(NetVerdict.BLOCK, NetPolicy.classify("https://example.com/", appHost))
        assertEquals(NetVerdict.BLOCK, NetPolicy.classify("http://$appHost/assets/web/index.html", appHost))
        assertEquals(NetVerdict.BLOCK, NetPolicy.classify("https://$appHost@evil.com/", appHost))
        assertEquals(NetVerdict.BLOCK, NetPolicy.classify("http://api.wikimedia.org/x", appHost))
    }

    @Test
    fun cspContainsExpectedDirectives() {
        val parts = NetPolicy.contentSecurityPolicy().split("; ")
        assertTrue("default-src 'self'" in parts)
        assertTrue("connect-src 'self' https://api.wikimedia.org" in parts)
        assertTrue("img-src 'self' data: blob:" in parts)
        assertTrue("media-src 'self' blob:" in parts)
        assertTrue("style-src 'self' 'unsafe-inline'" in parts)
        assertTrue("script-src 'self'" in parts)
        assertTrue("font-src 'self' data:" in parts)
        assertTrue("frame-src 'none'" in parts)
        assertTrue("object-src 'none'" in parts)
        assertTrue("base-uri 'self'" in parts)
        assertEquals(10, parts.size)
    }

    @Test
    fun cspExtraConnectOnlyAppendsToConnectSrc() {
        val parts = NetPolicy.contentSecurityPolicy(listOf("ws://127.0.0.1:5173")).split("; ")
        assertTrue("connect-src 'self' https://api.wikimedia.org ws://127.0.0.1:5173" in parts)
        // 其余指令与不带额外来源时一致，条数不变
        assertEquals(10, parts.size)
        assertEquals(NetPolicy.contentSecurityPolicy(), NetPolicy.contentSecurityPolicy(emptyList()))
    }

    @Test
    fun redactDropsQuery() {
        assertEquals("https://api.wikimedia.org/a/b", NetPolicy.redact("https://api.wikimedia.org/a/b?token=1#x"))
        assertEquals("<invalid>", NetPolicy.redact("not a url"))
    }
}
