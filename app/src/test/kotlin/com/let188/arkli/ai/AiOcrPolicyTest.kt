package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/** 文字识别的纯逻辑：参数校验、尺寸收敛、结果序列化 */
class AiOcrPolicyTest {
    /** 断言抛 BAD_PARAMS */
    private fun assertBad(block: () -> Unit) {
        assertEquals(BridgeErrors.BAD_PARAMS, assertThrows(BridgeException::class.java) { block() }.code)
    }

    @Test
    fun parse_acceptsPathAndOptionalProvider_ignoresLegacyLang() {
        val r = AiOcrPolicy.parse(JSONObject().put("path", "cache/pick/a.jpg").put("lang", "zh"))
        assertEquals(AiOcrRequest(null, "cache/pick/a.jpg"), r)
        assertEquals("local-ocr", AiOcrPolicy.parse(JSONObject().put("path", "p").put("provider", "local-ocr")).provider)
        assertNull(AiOcrPolicy.parse(JSONObject().put("path", "p").put("provider", JSONObject.NULL)).provider)
    }

    @Test
    fun parse_rejectsBadInput() {
        assertBad { AiOcrPolicy.parse(JSONObject()) }
        assertBad { AiOcrPolicy.parse(JSONObject().put("path", 1)) }
        assertBad { AiOcrPolicy.parse(JSONObject().put("path", "  ")) }
        assertBad { AiOcrPolicy.parse(JSONObject().put("path", "a".repeat(AiPolicy.MAX_PATH + 1))) }
        assertBad { AiOcrPolicy.parse(JSONObject().put("path", "p").put("provider", "")) }
        assertBad { AiOcrPolicy.parse(JSONObject().put("path", "p").put("provider", 3)) }
    }

    @Test
    fun fitSize_onlyShrinksOversizedImages_keepingAspect() {
        assertNull(AiOcrPolicy.fitSize(1080, 2400))
        assertNull(AiOcrPolicy.fitSize(AiOcrPolicy.MAX_EDGE, 10))
        assertEquals(4096 to 2048, AiOcrPolicy.fitSize(8192, 4096))
        assertEquals(1024 to 4096, AiOcrPolicy.fitSize(2048, 8192))
        assertEquals(4096 to 1, AiOcrPolicy.fitSize(100_000, 1))
    }

    @Test
    fun resultJson_roundsAndFlattensBox() {
        val line = OcrLine(listOf(OcrPoint(1.234f, 2f), OcrPoint(9f, 2f), OcrPoint(9f, 8.06f), OcrPoint(1f, 8f)), "Hi 你好", 0.123456f)
        val j = AiOcrPolicy.resultJson(OcrResult(OcrOutcome(640, 480, listOf(line), 7), "m", 30, 7))
        val b = j.getJSONArray("blocks").getJSONObject(0)
        assertEquals("Hi 你好", b.getString("text"))
        assertEquals(0.1235, b.getDouble("score"), 1e-9)
        val box = b.getJSONArray("box")
        assertEquals(8, box.length())
        assertEquals(1.2, box.getDouble(0), 1e-9)
        assertEquals(8.1, box.getDouble(5), 1e-9)
        assertEquals(640, j.getInt("width"))
        assertEquals(480, j.getInt("height"))
        assertEquals(30L, j.getLong("elapsedMs"))
        assertEquals(7L, j.getLong("inferMs"))
        assertEquals("m", j.getString("modelId"))
    }

    @Test
    fun resultJson_emptyLinesGivesEmptyBlocks() {
        val j = AiOcrPolicy.resultJson(OcrResult(OcrOutcome(10, 10, emptyList(), 0), "m", 1, 0))
        assertEquals(0, j.getJSONArray("blocks").length())
    }
}
