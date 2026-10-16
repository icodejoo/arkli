package com.let188.arkli.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 页面出站放行规则、去向判定与 CSP 拼装测试 */
class NetPolicyTest {
    private val appHost = "appassets.androidplatform.net"

    @Test
    fun allowsAnyHttpsHost() {
        assertTrue(NetPolicy.isAllowedOutbound("https://api.wikimedia.org/feed/v1/wikipedia/zh/onthisday/events/09/17"))
        assertTrue(NetPolicy.isAllowedOutbound("https://fonts.googleapis.com/css2?family=Ma+Shan+Zheng&display=swap"))
        assertTrue(NetPolicy.isAllowedOutbound("https://fonts.gstatic.com/s/mashanzheng/v18/x.woff2"))
        assertTrue(NetPolicy.isAllowedOutbound("HTTPS://Example.COM:8443/x?a=1"))
    }

    @Test
    fun rejectsNonHttps() {
        assertFalse(NetPolicy.isAllowedOutbound("http://example.com/x"))
        assertFalse(NetPolicy.isAllowedOutbound("ftp://example.com/x"))
        assertFalse(NetPolicy.isAllowedOutbound("//example.com/x"))
        assertFalse(NetPolicy.isAllowedOutbound("file:///etc/hosts"))
    }

    @Test
    fun rejectsUserinfoTrick() {
        assertFalse(NetPolicy.isAllowedOutbound("https://good.com@evil.com/x"))
        assertFalse(NetPolicy.isAllowedOutbound("https://user:pw@example.com/x"))
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
        assertEquals(NetVerdict.ALLOW, NetPolicy.classify("https://example.com/", appHost))
        assertEquals(NetVerdict.BLOCK, NetPolicy.classify("http://example.com/", appHost))
        assertEquals(NetVerdict.BLOCK, NetPolicy.classify("http://$appHost/assets/web/index.html", appHost))
        assertEquals(NetVerdict.BLOCK, NetPolicy.classify("https://$appHost@evil.com/", appHost))
    }

    @Test
    fun cspContainsExpectedDirectives() {
        val parts = NetPolicy.contentSecurityPolicy().split("; ")
        assertTrue("default-src 'self'" in parts)
        assertTrue("connect-src 'self' https:" in parts)
        assertTrue("img-src 'self' data: blob: https:" in parts)
        assertTrue("media-src 'self' blob: https:" in parts)
        assertTrue("style-src 'self' 'unsafe-inline' https:" in parts)
        // 脚本仍只允许同源：放开出站不等于加载远程代码
        assertTrue("script-src 'self'" in parts)
        assertTrue("font-src 'self' data: https:" in parts)
        assertTrue("frame-src 'none'" in parts)
        assertTrue("object-src 'none'" in parts)
        assertTrue("base-uri 'self'" in parts)
        assertEquals(10, parts.size)
    }

    @Test
    fun cspExtraConnectOnlyAppendsToConnectSrc() {
        val parts = NetPolicy.contentSecurityPolicy(listOf("ws://127.0.0.1:5173")).split("; ")
        assertTrue("connect-src 'self' https: ws://127.0.0.1:5173" in parts)
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
