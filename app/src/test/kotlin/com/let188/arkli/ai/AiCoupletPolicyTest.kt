package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/** 对联的纯逻辑：参数校验、范围约束、结果序列化 */
class AiCoupletPolicyTest {
    /** 断言抛 BAD_PARAMS */
    private fun assertBad(block: () -> Unit) {
        assertEquals(BridgeErrors.BAD_PARAMS, assertThrows(BridgeException::class.java) { block() }.code)
    }

    @Test
    fun parse_acceptsTextAndOptionalFields() {
        assertEquals(AiCoupletRequest(null, "春风送暖入屠苏"), AiCoupletPolicy.parse(JSONObject().put("text", "春风送暖入屠苏")))
        val r = AiCoupletPolicy.parse(
            JSONObject().put("text", "山清水秀，人杰地灵").put("provider", "local-couplet")
                .put("temperature", 0).put("topK", 20).put("seed", 42),
        )
        assertEquals(AiCoupletRequest("local-couplet", "山清水秀，人杰地灵", 0f, 20, 42L), r)
        // null 视为没传
        val n = AiCoupletPolicy.parse(JSONObject().put("text", "春风").put("temperature", JSONObject.NULL).put("seed", JSONObject.NULL))
        assertNull(n.temperature)
        assertNull(n.seed)
    }

    @Test
    fun parse_rejectsBadShapeAndLength() {
        assertBad { AiCoupletPolicy.parse(JSONObject()) }
        assertBad { AiCoupletPolicy.parse(JSONObject().put("text", 1)) }
        assertBad { AiCoupletPolicy.parse(JSONObject().put("text", "")) }
        assertBad { AiCoupletPolicy.parse(JSONObject().put("text", "春".repeat(AiCoupletPolicy.MAX_CHARS + 1))) }
        AiCoupletPolicy.parse(JSONObject().put("text", "春".repeat(AiCoupletPolicy.MAX_CHARS)))
        assertBad { AiCoupletPolicy.parse(JSONObject().put("text", "春").put("provider", "")) }
    }

    @Test
    fun parse_rejectsBadOptions() {
        assertBad { AiCoupletPolicy.parse(JSONObject().put("text", "春").put("temperature", "hot")) }
        assertBad { AiCoupletPolicy.parse(JSONObject().put("text", "春").put("topK", 1.5)) }
        assertBad { AiCoupletPolicy.parse(JSONObject().put("text", "春").put("topK", "3")) }
        assertBad { AiCoupletPolicy.parse(JSONObject().put("text", "春").put("seed", -1)) }
        assertBad { AiCoupletPolicy.parse(JSONObject().put("text", "春").put("seed", 1.5)) }
        assertBad { AiCoupletPolicy.parse(JSONObject().put("text", "春").put("seed", 9_007_199_254_740_992L)) }
    }

    @Test
    fun checkConstraints_enforcesRanges() {
        val c = AiCoupletPolicy.OFFER_CONSTRAINTS
        AiCoupletPolicy.checkConstraints(AiCoupletRequest(null, "春", 0f, 1, 0L), c)
        AiCoupletPolicy.checkConstraints(AiCoupletRequest(null, "春", 2f, 200), c)
        assertBad { AiCoupletPolicy.checkConstraints(AiCoupletRequest(null, "春", -0.1f), c) }
        assertBad { AiCoupletPolicy.checkConstraints(AiCoupletRequest(null, "春", 2.1f), c) }
        assertBad { AiCoupletPolicy.checkConstraints(AiCoupletRequest(null, "春", topK = 0), c) }
        assertBad { AiCoupletPolicy.checkConstraints(AiCoupletRequest(null, "春", topK = 201), c) }
        assertBad { AiCoupletPolicy.checkConstraints(AiCoupletRequest(null, "春".repeat(15)), c) }
    }

    @Test
    fun offerConstraints_serializeToJson() {
        val j = AiCoupletPolicy.OFFER_CONSTRAINTS.toJson()
        assertEquals(14, j.getInt("maxChars"))
        assertEquals(2.0, j.getJSONObject("temperature").getDouble("max"), 0.0)
        assertEquals(200, j.getJSONObject("topK").getInt("max"))
        assertEquals(1, j.getJSONObject("topK").getInt("min"))
    }

    @Test
    fun resultJson_hasTextElapsedAndModelId() {
        val j = AiCoupletPolicy.resultJson(CoupletResult("春满乾坤福满门", 123, "couplet-gpt2-mnn-w6"))
        assertEquals("春满乾坤福满门", j.getString("text"))
        assertEquals(123L, j.getLong("elapsedMs"))
        assertEquals("couplet-gpt2-mnn-w6", j.getString("modelId"))
    }
}
