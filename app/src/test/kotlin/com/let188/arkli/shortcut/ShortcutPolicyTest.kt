package com.let188.arkli.shortcut

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

/** 网页快捷方式的参数校验与图标取色 */
class ShortcutPolicyTest {
    @Test
    fun parseAcceptsHttpAndHttps() {
        assertEquals(ShortcutSpec("a", "知乎", "https://zhihu.com"), ShortcutPolicy.parse(" a ", " 知乎 ", " https://zhihu.com "))
        assertEquals("http://x.cn/p?q=1", ShortcutPolicy.parse("a", "x", "http://x.cn/p?q=1").url)
    }

    @Test
    fun parseRejectsBadUrls() {
        for (bad in listOf("zhihu.com", "ftp://a.com", "javascript:alert(1)", "file:///etc/passwd", "tel:123", "")) {
            assertThrows(bad, IllegalArgumentException::class.java) { ShortcutPolicy.parse("a", "x", bad) }
        }
    }

    @Test
    fun parseChecksIdAndLabel() {
        assertThrows(IllegalArgumentException::class.java) { ShortcutPolicy.parse("", "x", "https://a.com") }
        assertThrows(IllegalArgumentException::class.java) { ShortcutPolicy.parse("a".repeat(65), "x", "https://a.com") }
        assertThrows(IllegalArgumentException::class.java) { ShortcutPolicy.parse("a", "  ", "https://a.com") }
        assertThrows(IllegalArgumentException::class.java) { ShortcutPolicy.parse("a", "n".repeat(25), "https://a.com") }
        ShortcutPolicy.parse("a", "n".repeat(24), "https://a.com")
    }

    @Test
    fun glyphUsesFirstCodePoint() {
        assertEquals("知", ShortcutPolicy.glyphOf("知乎日报"))
        assertEquals("A", ShortcutPolicy.glyphOf("  apple"))
        assertEquals("😀", ShortcutPolicy.glyphOf("😀笑"))
        assertEquals("#", ShortcutPolicy.glyphOf("   "))
    }

    @Test
    fun colorIsStableAndFromPalette() {
        assertEquals(ShortcutPolicy.colorOf("知乎"), ShortcutPolicy.colorOf(" 知乎 "))
        for (name in listOf("a", "知乎", "", "😀", "very long name here")) {
            assertTrue(ShortcutPolicy.colorOf(name) in ShortcutPolicy.PALETTE)
        }
        assertTrue(ShortcutPolicy.PALETTE.toSet().size == ShortcutPolicy.PALETTE.size)
    }
}
