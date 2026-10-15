package com.let188.arkli.speech

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** 语音转文字策略与文本合并的单测 */
class SpeechPolicyTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 全部文件达标的大小表 */
    private fun fullSizes() = mapOf(
        SpeechConst.FILE_ENCODER to SpeechConst.MIN_ENCODER_BYTES,
        SpeechConst.FILE_DECODER to SpeechConst.MIN_DECODER_BYTES,
        SpeechConst.FILE_JOINER to SpeechConst.MIN_JOINER_BYTES,
        SpeechConst.FILE_TOKENS to SpeechConst.MIN_TOKENS_BYTES,
    )

    /** 断言抛 BAD_PARAMS */
    private fun assertBadParams(params: String) {
        try {
            SpeechPolicy.parseStart(JSONObject(params))
            fail("应当抛 BAD_PARAMS")
        } catch (e: BridgeException) {
            assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        }
    }

    /** lang 缺省或为 zh-en 都通过 */
    @Test
    fun parseStart_defaultsAndValid() {
        assertEquals("zh-en", SpeechPolicy.parseStart(JSONObject("{}")))
        assertEquals("zh-en", SpeechPolicy.parseStart(JSONObject("""{"lang":"zh-en"}""")))
        assertEquals("zh-en", SpeechPolicy.parseStart(JSONObject("""{"lang":null}""")))
    }

    /** 不支持的 lang 或类型错误 */
    @Test
    fun parseStart_rejectsBad() {
        assertBadParams("""{"lang":"ja"}""")
        assertBadParams("""{"lang":3}""")
    }

    /** 文件齐全时无缺失 */
    @Test
    fun missingFiles_complete() {
        assertTrue(SpeechPolicy.missingFiles(fullSizes()).isEmpty())
    }

    /** 缺失与残缺文件都被列出 */
    @Test
    fun missingFiles_missingAndTruncated() {
        val sizes = fullSizes().toMutableMap()
        sizes.remove(SpeechConst.FILE_TOKENS)
        sizes[SpeechConst.FILE_ENCODER] = SpeechConst.MIN_ENCODER_BYTES - 1
        assertEquals(listOf(SpeechConst.FILE_ENCODER, SpeechConst.FILE_TOKENS), SpeechPolicy.missingFiles(sizes))
    }

    /** 目录版：空目录全缺，目录里放小文件算残缺 */
    @Test
    fun missingFiles_dir() {
        val dir = tmp.newFolder("m")
        assertEquals(4, SpeechPolicy.missingFiles(dir).size)
        File(dir, SpeechConst.FILE_TOKENS).writeBytes(ByteArray(SpeechConst.MIN_TOKENS_BYTES.toInt()))
        assertFalse(SpeechConst.FILE_TOKENS in SpeechPolicy.missingFiles(dir))
        assertEquals(3, SpeechPolicy.missingFiles(dir).size)
    }

    /** 原因判定：缺文件优先，其次库，最后可用 */
    @Test
    fun reasonOf_priority() {
        assertTrue(SpeechPolicy.reasonOf(listOf("a"), false)!!.contains("a"))
        assertEquals("语音识别引擎无法加载", SpeechPolicy.reasonOf(emptyList(), false))
        assertNull(SpeechPolicy.reasonOf(emptyList(), true))
    }

    /** 状态载荷：可用时无 reason；不可用时 modelReady 与 reason 正确 */
    @Test
    fun statusJson_shapes() {
        val ok = SpeechPolicy.statusJson(emptyList(), true)
        assertTrue(ok.getBoolean("available"))
        assertTrue(ok.getBoolean("modelReady"))
        assertEquals("local-zipformer", ok.getString("engine"))
        assertFalse(ok.has("reason"))
        val noModel = SpeechPolicy.statusJson(listOf("x"), true)
        assertFalse(noModel.getBoolean("available"))
        assertFalse(noModel.getBoolean("modelReady"))
        assertTrue(noModel.has("reason"))
        val noLib = SpeechPolicy.statusJson(emptyList(), false)
        assertFalse(noLib.getBoolean("available"))
        assertTrue(noLib.getBoolean("modelReady"))
    }

    /** 事件载荷与 PCM 转换 */
    @Test
    fun payloadAndPcm() {
        assertEquals("你好", SpeechPolicy.textPayload("你好").getString("text"))
        val f = SpeechPolicy.pcmToFloat(shortArrayOf(0, 16384, -32768, 99), 3)
        assertEquals(3, f.size)
        assertEquals(0.5f, f[1], 1e-6f)
        assertEquals(-1f, f[2], 1e-6f)
    }

    /** partial 只在变化时返回 true，full 含中间结果 */
    @Test
    fun merger_partial() {
        val m = TranscriptMerger()
        assertTrue(m.partial("你"))
        assertFalse(m.partial("你"))
        assertTrue(m.partial("你好"))
        assertEquals("你好", m.full())
        assertEquals("", m.committedText())
    }

    /** 定稿后中间结果清空，多句相接，中文直连、英文补空格 */
    @Test
    fun merger_commitJoin() {
        val m = TranscriptMerger()
        assertEquals("你好。", m.commit("你好。"))
        m.partial("hello")
        assertEquals("你好。hello", m.full())
        m.commit("hello")
        m.partial("world")
        assertEquals("你好。hello world", m.full())
        assertEquals("你好。hello", m.committedText())
    }

    /** 空白定稿被忽略，但仍清掉中间结果 */
    @Test
    fun merger_blankCommit() {
        val m = TranscriptMerger()
        m.partial("x")
        assertNull(m.commit("  "))
        assertEquals("", m.full())
    }
}
