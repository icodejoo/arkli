package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

/** 抠图的纯逻辑：参数校验、模式与提供者对应、尺寸收敛、结果序列化 */
class AiMattingPolicyTest {
    /** 断言抛 BAD_PARAMS */
    private fun assertBad(block: () -> Unit) {
        assertEquals(BridgeErrors.BAD_PARAMS, assertThrows(BridgeException::class.java) { block() }.code)
    }

    @Test
    fun parse_fillsProviderFromMode() {
        val r = AiMattingPolicy.parse(JSONObject().put("path", "cache/pick/a.jpg").put("mode", "portrait"))
        assertEquals(AiMattingRequest("local-matting-portrait", "cache/pick/a.jpg", MattingMode.PORTRAIT), r)
        assertEquals("local-matting-general", AiMattingPolicy.parse(JSONObject().put("path", "p").put("mode", "general")).provider)
    }

    @Test
    fun parse_acceptsMatchingProvider_rejectsMismatch() {
        val ok = AiMattingPolicy.parse(JSONObject().put("path", "p").put("mode", "general").put("provider", "local-matting-general"))
        assertEquals(MattingMode.GENERAL, ok.mode)
        // provider 为 null 视同没传
        val nul = AiMattingPolicy.parse(JSONObject().put("path", "p").put("mode", "general").put("provider", JSONObject.NULL))
        assertEquals("local-matting-general", nul.provider)
        assertBad { AiMattingPolicy.parse(JSONObject().put("path", "p").put("mode", "general").put("provider", "local-matting-portrait")) }
        assertBad { AiMattingPolicy.parse(JSONObject().put("path", "p").put("mode", "general").put("provider", "local-ocr")) }
    }

    @Test
    fun parse_rejectsBadInput() {
        assertBad { AiMattingPolicy.parse(JSONObject()) }
        assertBad { AiMattingPolicy.parse(JSONObject().put("path", "p")) }
        assertBad { AiMattingPolicy.parse(JSONObject().put("path", "p").put("mode", 1)) }
        assertBad { AiMattingPolicy.parse(JSONObject().put("path", "p").put("mode", "auto")) }
        assertBad { AiMattingPolicy.parse(JSONObject().put("mode", "portrait")) }
        assertBad { AiMattingPolicy.parse(JSONObject().put("path", "  ").put("mode", "portrait")) }
        assertBad { AiMattingPolicy.parse(JSONObject().put("path", "a".repeat(AiPolicy.MAX_PATH + 1)).put("mode", "portrait")) }
        assertBad { AiMattingPolicy.parse(JSONObject().put("path", "p").put("mode", "portrait").put("provider", 3)) }
    }

    @Test
    fun modes_haveDistinctWireProviderModelAndDir() {
        val all = MattingMode.values()
        assertEquals(all.size, all.map { it.wire }.toSet().size)
        assertEquals(all.size, all.map { it.providerId }.toSet().size)
        assertEquals(all.size, all.map { it.modelId }.toSet().size)
        assertEquals(all.size, all.map { it.modelDir }.toSet().size)
        all.forEach { assertEquals(it, MattingMode.fromWire(it.wire)) }
        assertNull(MattingMode.fromWire("nope"))
    }

    @Test
    fun fitSize_onlyShrinksOversizedImages_keepingAspect() {
        assertNull(AiMattingPolicy.fitSize(1080, 2400))
        assertNull(AiMattingPolicy.fitSize(AiMattingPolicy.MAX_EDGE, 10))
        assertEquals(3072 to 1536, AiMattingPolicy.fitSize(6144, 3072))
        assertEquals(1024 to 3072, AiMattingPolicy.fitSize(2048, 6144))
        assertEquals(3072 to 1, AiMattingPolicy.fitSize(100_000, 1))
    }

    @Test
    fun maxEdge_staysWithinEngineLimit() {
        // Rust 引擎上限 4096，原生收敛上限不能超过它
        assertTrue(AiMattingPolicy.MAX_EDGE <= 4096)
    }

    @Test
    fun resultJson_hasAllFields() {
        val j = AiMattingPolicy.resultJson(MattingResult("cache/out/m.png", 640, 480, MattingMode.GENERAL, "m", 900, 700, 120))
        assertEquals("cache/out/m.png", j.getString("path"))
        assertEquals(640, j.getInt("width"))
        assertEquals(480, j.getInt("height"))
        assertEquals("general", j.getString("mode"))
        assertEquals(900L, j.getLong("elapsedMs"))
        assertEquals(700L, j.getLong("inferMs"))
        assertEquals(120L, j.getLong("refineMs"))
        assertEquals("m", j.getString("modelId"))
    }
}
