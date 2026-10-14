package com.let188.arkli.tts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** 文字转语音的参数校验、语言规范化、分段 */
class TtsPolicyTest {
    @Test
    fun langNormalization() {
        assertEquals("zh-CN", TtsPolicy.normalizeLang(null))
        assertEquals("zh-CN", TtsPolicy.normalizeLang("  "))
        assertEquals("zh-CN", TtsPolicy.normalizeLang("zh_cn"))
        assertEquals("en-US", TtsPolicy.normalizeLang("EN-us"))
        assertEquals("ja", TtsPolicy.normalizeLang("JA"))
        assertEquals("zh-Hans", TtsPolicy.normalizeLang("zh-hans"))
        assertThrows(IllegalArgumentException::class.java) { TtsPolicy.normalizeLang("chinese") }
        assertThrows(IllegalArgumentException::class.java) { TtsPolicy.normalizeLang("zh-CN-x") }
        assertThrows(IllegalArgumentException::class.java) { TtsPolicy.normalizeLang("z") }
    }

    @Test
    fun factorRange() {
        assertEquals(1f, TtsPolicy.factor("rate", null), 0f)
        assertEquals(0.5f, TtsPolicy.factor("rate", 0.5), 0f)
        assertEquals(2f, TtsPolicy.factor("pitch", 2.0), 0f)
        assertThrows(IllegalArgumentException::class.java) { TtsPolicy.factor("rate", 0.4) }
        assertThrows(IllegalArgumentException::class.java) { TtsPolicy.factor("rate", 2.1) }
        assertThrows(IllegalArgumentException::class.java) { TtsPolicy.factor("rate", Double.NaN) }
    }

    @Test
    fun parseValidatesText() {
        val spec = TtsPolicy.parse("你好", null, 1.5, null)
        assertEquals(TtsSpec("你好", "zh-CN", 1.5f, 1f), spec)
        assertThrows(IllegalArgumentException::class.java) { TtsPolicy.parse("   ", null, null, null) }
        assertThrows(IllegalArgumentException::class.java) { TtsPolicy.parse("a".repeat(TtsPolicy.MAX_TEXT + 1), null, null, null) }
        TtsPolicy.parse("a".repeat(TtsPolicy.MAX_TEXT), null, null, null)
    }

    @Test
    fun chunkShortTextIsOnePiece() {
        assertEquals(listOf("你好"), TtsPolicy.chunk("你好", 10))
    }

    @Test
    fun chunkBreaksAtSentenceEnds() {
        val parts = TtsPolicy.chunk("第一句。第二句。第三句。", 7)
        assertEquals(listOf("第一句。", "第二句。", "第三句。"), parts)
    }

    @Test
    fun chunkFallsBackToWhitespaceThenHardCut() {
        assertEquals(listOf("hello ", "world ", "again"), TtsPolicy.chunk("hello world again", 7))
        val hard = TtsPolicy.chunk("abcdefghij", 4)
        assertEquals(listOf("abcd", "efgh", "ij"), hard)
    }

    @Test
    fun chunkNeverExceedsMaxAndKeepsContent() {
        val text = ("这是一个很长的句子，没有结尾" + "。").repeat(50) + "尾巴"
        val parts = TtsPolicy.chunk(text, 40)
        assertTrue(parts.all { it.length <= 40 })
        assertEquals(text, parts.joinToString(""))
    }

    @Test
    fun chunkDoesNotSplitSurrogatePair() {
        val parts = TtsPolicy.chunk("ab😀cd", 3)
        assertTrue(parts.all { !it.endsWith("\uD83D") })
        assertEquals("ab😀cd", parts.joinToString(""))
    }

    @Test
    fun chunkRejectsBadMax() {
        assertThrows(IllegalArgumentException::class.java) { TtsPolicy.chunk("abc", 0) }
    }

    @Test
    fun languageUsableByCode() {
        assertTrue(TtsPolicy.languageUsable(0))
        assertTrue(TtsPolicy.languageUsable(1))
        assertFalse(TtsPolicy.languageUsable(-1))
        assertFalse(TtsPolicy.languageUsable(-2))
    }

    @Test
    fun cleanLangsDedupesAndSorts() {
        assertEquals(listOf("en-US", "zh-CN"), TtsPolicy.cleanLangs(listOf("zh-CN", "en-US", "zh-CN", "", "und")))
    }

    @Test
    fun utteranceIds() {
        val id = TtsIds.of("s3", 2)
        assertEquals("s3#2", id)
        assertEquals("s3", TtsIds.jobOf(id))
        assertEquals(2, TtsIds.indexOf(id))
        assertEquals(-1, TtsIds.indexOf("save1"))
    }
}
