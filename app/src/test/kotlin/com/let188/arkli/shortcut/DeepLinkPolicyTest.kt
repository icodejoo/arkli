package com.let188.arkli.shortcut

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 深链接路由策略单测。
 *
 * 验证 HTTPS 与 arkli 协议的链接解析、非法字符拦截及边界条件。
 */
class DeepLinkPolicyTest {
    /** 测试常量：尺子工具路由 */
    private val expectedRulerRoute = "/tool/ruler"

    /** 测试常量：标准 HTTPS 尺子链接 */
    private val httpsRulerUrl = "https://icodejoo.github.io/arkli/t/ruler"

    /** 测试常量：标准 Arkli 协议尺子链接 */
    private val arkliRulerUrl = "arkli://tool/ruler"

    /** 验证两种协议的合法链接正常解析 */
    @Test
    fun routeOfAcceptsValidSchemes() {
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf(httpsRulerUrl))
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf(arkliRulerUrl))
    }

    /** 验证路径末尾斜杠允许存在并被正确移除 */
    @Test
    fun routeOfAllowsTrailingSlash() {
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf("$httpsRulerUrl/"))
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf("$arkliRulerUrl/"))
    }

    /** 验证协议与域名大小写不敏感，但 id 大写必须拒绝 */
    @Test
    fun routeOfHandlesCaseSensitivity() {
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf("HTTPS://ICODEJOO.GITHUB.IO/arkli/t/ruler"))
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf("ARKLI://TOOL/ruler"))
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf("Https://Icodejoo.Github.Io/arkli/t/ruler"))
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf("Arkli://Tool/ruler"))

        assertNull(DeepLinkPolicy.routeOf("https://icodejoo.github.io/arkli/t/Ruler"))
        assertNull(DeepLinkPolicy.routeOf("arkli://tool/Ruler"))
        assertNull(DeepLinkPolicy.routeOf("https://icodejoo.github.io/arkli/t/rulerA"))
    }

    /** 验证多余路径段及连续斜杠会被拒绝 */
    @Test
    fun routeOfRejectsExtraPathSegments() {
        assertNull(DeepLinkPolicy.routeOf("https://icodejoo.github.io/arkli/t/ruler/sub"))
        assertNull(DeepLinkPolicy.routeOf("https://icodejoo.github.io/arkli/t/a/b"))
        assertNull(DeepLinkPolicy.routeOf("arkli://tool/ruler/sub"))
        assertNull(DeepLinkPolicy.routeOf("arkli://tool/a/b"))
        assertNull(DeepLinkPolicy.routeOf("$httpsRulerUrl//"))
        assertNull(DeepLinkPolicy.routeOf("$arkliRulerUrl//"))
    }

    /** 验证查询参数与片段标识会被忽略并不影响正常解析 */
    @Test
    fun routeOfIgnoresQueryParamsAndFragments() {
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf("$httpsRulerUrl?utm=1"))
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf("$httpsRulerUrl#section"))
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf("$httpsRulerUrl?utm=1#section"))
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf("$httpsRulerUrl/?utm=1#section"))
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf("$arkliRulerUrl?x=1&y=2"))
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf("$arkliRulerUrl#anchor"))
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf("$arkliRulerUrl/?x=1#anchor"))
    }

    /** 验证非法字符（空格、%2e、下划线、中文、路径回溯符、连字符开头等）均被拒绝 */
    @Test
    fun routeOfRejectsIllegalCharacters() {
        val badUrls = listOf(
            "https://icodejoo.github.io/arkli/t/a b",
            "https://icodejoo.github.io/arkli/t/ ruler",
            "https://icodejoo.github.io/arkli/t/%2e%2e",
            "https://icodejoo.github.io/arkli/t/ruler%20",
            "https://icodejoo.github.io/arkli/t/tool_1",
            "arkli://tool/tool_1",
            "https://icodejoo.github.io/arkli/t/尺子",
            "arkli://tool/尺子",
            "https://icodejoo.github.io/arkli/t/../ruler",
            "https://icodejoo.github.io/arkli/t/..",
            "https://icodejoo.github.io/arkli/t/ruler.html",
            "https://icodejoo.github.io/arkli/t/-ruler",
            "arkli://tool/-ruler",
        )
        for (badUrl in badUrls) {
            assertNull("应当拒绝非法链接: $badUrl", DeepLinkPolicy.routeOf(badUrl))
        }
    }

    /** 验证 id 长度边界：64 字符合法，65 字符非法 */
    @Test
    fun routeOfValidatesIdLength() {
        val id64 = "a" + "b".repeat(63)
        assertEquals("/tool/$id64", DeepLinkPolicy.routeOf("https://icodejoo.github.io/arkli/t/$id64"))
        assertEquals("/tool/$id64", DeepLinkPolicy.routeOf("arkli://tool/$id64"))

        val id65 = "a" + "b".repeat(64)
        assertNull(DeepLinkPolicy.routeOf("https://icodejoo.github.io/arkli/t/$id65"))
        assertNull(DeepLinkPolicy.routeOf("arkli://tool/$id65"))
    }

    /** 验证错误的主机名、端口及用户信息均被拒绝 */
    @Test
    fun routeOfRejectsWrongHost() {
        val badHosts = listOf(
            "https://icodejoo.github.io.evil.com/arkli/t/ruler",
            "https://evil.com/icodejoo.github.io/arkli/t/ruler",
            "https://icodejoo.github.io:443/arkli/t/ruler",
            "https://icodejoo.github.io:80/arkli/t/ruler",
            "https://icodejoo.github.io@evil.com/arkli/t/x",
            "https://user:pass@icodejoo.github.io/arkli/t/ruler",
            "arkli://evil/ruler",
            "arkli://tool:8080/ruler",
            "arkli://user@tool/ruler",
        )
        for (badHost in badHosts) {
            assertNull("应当拒绝错误的主机链接: $badHost", DeepLinkPolicy.routeOf(badHost))
        }
    }

    /** 验证非法的协议名（如 HTTP、FTP、FILE）被拒绝 */
    @Test
    fun routeOfRejectsHttpAndOtherSchemes() {
        assertNull(DeepLinkPolicy.routeOf("http://icodejoo.github.io/arkli/t/ruler"))
        assertNull(DeepLinkPolicy.routeOf("ftp://icodejoo.github.io/arkli/t/ruler"))
        assertNull(DeepLinkPolicy.routeOf("file:///arkli/t/ruler"))
    }

    /** 验证错误的前缀或缺少斜杠被拒绝 */
    @Test
    fun routeOfRejectsWrongPathPrefixOrMissingSlash() {
        assertNull(DeepLinkPolicy.routeOf("https://icodejoo.github.io/arkli/x/ruler"))
        assertNull(DeepLinkPolicy.routeOf("https://icodejoo.github.io/arkli/t"))
        assertNull(DeepLinkPolicy.routeOf("https://icodejoo.github.io/arkli/t/"))
        assertNull(DeepLinkPolicy.routeOf("arkli://tool"))
        assertNull(DeepLinkPolicy.routeOf("arkli://tool/"))
    }

    /** 验证 null、空串及超长网址被拒绝 */
    @Test
    fun routeOfRejectsNullEmptyAndOverLength() {
        assertNull(DeepLinkPolicy.routeOf(null))
        assertNull(DeepLinkPolicy.routeOf(""))

        val prefix = "$httpsRulerUrl?"
        val exact512 = prefix + "x".repeat(DeepLinkPolicy.MAX_URL_LENGTH - prefix.length)
        assertEquals(expectedRulerRoute, DeepLinkPolicy.routeOf(exact512))
        assertNull(DeepLinkPolicy.routeOf(exact512 + "x"))
    }
}
