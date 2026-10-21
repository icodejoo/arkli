package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** logo 符号纯逻辑测试：参数校验、驻留方式判据、结果序列化 */
class AiLogoPolicyTest {
    /** 合法的最小入参 */
    private fun ok() = JSONObject().put("prompt", "flat pictogram glyph of a carrot")

    /** 断言入参被拒为 BAD_PARAMS */
    private fun assertBad(p: JSONObject) {
        assertEquals(BridgeErrors.BAD_PARAMS, assertThrows(BridgeException::class.java) { AiLogoPolicy.parse(p) }.code)
    }

    @Test
    fun parse_minimalAndFull() {
        assertEquals(AiLogoRequest(null, "flat pictogram glyph of a carrot", null, true), AiLogoPolicy.parse(ok()))
        val r = AiLogoPolicy.parse(ok().put("prompt", "  cat  ").put("provider", "local-logo-sdxs").put("seed", 42).put("removeRing", false))
        assertEquals(AiLogoRequest("local-logo-sdxs", "cat", 42L, false), r)
        // 显式 null 当没传
        val n = AiLogoPolicy.parse(ok().put("seed", JSONObject.NULL).put("removeRing", JSONObject.NULL))
        assertNull(n.seed)
        assertTrue(n.removeRing)
    }

    @Test
    fun parse_rejectsBadPrompt() {
        assertBad(JSONObject())
        assertBad(JSONObject().put("prompt", 1))
        assertBad(JSONObject().put("prompt", "   "))
        assertEquals(AiLogoPolicy.MAX_PROMPT_BYTES, AiLogoPolicy.parse(JSONObject().put("prompt", "a".repeat(AiLogoPolicy.MAX_PROMPT_BYTES))).prompt.length)
        assertBad(JSONObject().put("prompt", "a".repeat(AiLogoPolicy.MAX_PROMPT_BYTES + 1)))
        // 按 UTF-8 字节而不是字符数：700 个汉字 = 2100 字节
        assertBad(JSONObject().put("prompt", "字".repeat(700)))
    }

    @Test
    fun parse_rejectsBadSeedAndRemoveRing() {
        assertBad(ok().put("seed", -1))
        assertBad(ok().put("seed", 1.5))
        assertBad(ok().put("seed", "1"))
        assertBad(ok().put("seed", AiLogoPolicy.MAX_SEED + 1))
        assertEquals(0L, AiLogoPolicy.parse(ok().put("seed", 0)).seed)
        assertEquals(AiLogoPolicy.MAX_SEED, AiLogoPolicy.parse(ok().put("seed", AiLogoPolicy.MAX_SEED)).seed)
        assertBad(ok().put("removeRing", "false"))
        assertBad(ok().put("removeRing", 0))
        assertBad(ok().put("provider", ""))
    }

    @Test
    fun chooseResidency_followsThreshold() {
        val need = AiLogoPolicy.RESIDENT_NEED_BYTES
        assertEquals(1307L * 1024 * 1024 + 512L * 1024 * 1024, need)
        assertEquals(LogoResidency.RESIDENT, AiLogoPolicy.chooseResidency(need))
        assertEquals(LogoResidency.PER_STAGE, AiLogoPolicy.chooseResidency(need - 1))
        assertEquals(LogoResidency.PER_STAGE, AiLogoPolicy.chooseResidency(0))
        assertEquals(LogoResidency.PER_STAGE, AiLogoPolicy.chooseResidency(-1))
    }

    @Test
    fun resultJson_shape() {
        val r = LogoResult(
            "<path/>", 1, false, listOf("small", "specks"), true,
            LogoFeatures(0.25f, 0.5f, 2, 1, 0.75f, 0.0f, 0.5f, false),
            LogoTimings(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 55),
            9L, LogoResidency.PER_STAGE, 1234L, "m",
        )
        val j = AiLogoPolicy.resultJson(r)
        assertEquals("<path/>", j.getString("svgPaths"))
        assertEquals(1, j.getInt("pathCount"))
        assertEquals(false, j.getBoolean("gateOk"))
        assertEquals("specks", j.getJSONArray("gateReasons").getString(1))
        assertEquals(true, j.getBoolean("ringDetected"))
        assertEquals(0.25, j.getJSONObject("features").getDouble("inkCanvas"), 1e-6)
        assertEquals(2, j.getJSONObject("features").getInt("comps"))
        assertEquals(3L, j.getJSONObject("timings").getLong("unetMs"))
        assertEquals(55L, j.getJSONObject("timings").getLong("totalMs"))
        assertEquals(9L, j.getLong("seed"))
        assertEquals("per_stage", j.getString("residency"))
        assertEquals(1234L, j.getLong("elapsedMs"))
        assertEquals("m", j.getString("modelId"))
        assertEquals(JSONObject.NULL, AiLogoPolicy.resultJson(r.copy(svgPaths = null)).get("svgPaths"))
    }
}
