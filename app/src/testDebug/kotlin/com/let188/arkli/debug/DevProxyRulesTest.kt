package com.let188.arkli.debug

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 开发服务器代理的纯规则测试 */
class DevProxyRulesTest {

    @Test
    fun onlyPagePathsAreProxied() {
        assertTrue(DevProxyRules.isPagePath("/assets/web/index.html"))
        assertTrue(DevProxyRules.isPagePath("/assets/web/@vite/client"))
        // 缓存文件、其它前缀、空路径一律不碰
        assertFalse(DevProxyRules.isPagePath("/files/out/a.png"))
        assertFalse(DevProxyRules.isPagePath("/assets/other/x.js"))
        assertFalse(DevProxyRules.isPagePath("/assets/web"))
        assertFalse(DevProxyRules.isPagePath(null))
    }

    @Test
    fun upstreamUrlKeepsPathAndQuery() {
        assertEquals("http://127.0.0.1:5173/assets/web/index.html", DevProxyRules.upstreamUrl("/assets/web/index.html", null))
        assertEquals("http://127.0.0.1:5173/assets/web/index.html", DevProxyRules.upstreamUrl("/assets/web/index.html", ""))
        assertEquals(
            "http://127.0.0.1:5173/assets/web/src/main.ts?t=17&import",
            DevProxyRules.upstreamUrl("/assets/web/src/main.ts", "t=17&import"),
        )
    }

    @Test
    fun mimeAndCharsetFromContentType() {
        assertEquals("text/html", DevProxyRules.mimeOf("text/html; charset=utf-8"))
        assertEquals("text/javascript", DevProxyRules.mimeOf("text/javascript"))
        assertEquals("application/octet-stream", DevProxyRules.mimeOf(null))
        assertEquals("application/octet-stream", DevProxyRules.mimeOf("  "))
        assertEquals("utf-8", DevProxyRules.charsetOf("text/html; charset=utf-8"))
        assertEquals("UTF-8", DevProxyRules.charsetOf("text/css;Charset=UTF-8; x=1"))
        assertNull(DevProxyRules.charsetOf("image/png"))
        assertNull(DevProxyRules.charsetOf(null))
    }

    @Test
    fun redirectsAreNotForwarded() {
        assertTrue(DevProxyRules.isForwardable(200))
        assertTrue(DevProxyRules.isForwardable(404))
        assertTrue(DevProxyRules.isForwardable(504))
        // WebResourceResponse 不接受 3xx，304 也不转发（代理本身不发条件请求头）
        assertFalse(DevProxyRules.isForwardable(304))
        assertFalse(DevProxyRules.isForwardable(302))
        assertFalse(DevProxyRules.isForwardable(101))
    }
}
