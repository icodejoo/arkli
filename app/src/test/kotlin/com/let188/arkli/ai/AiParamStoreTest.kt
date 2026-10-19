package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 参数存储与桥方法纯逻辑的测试：往返、重置、越界不改值、落库值越界回落默认并删键、只存非默认值。
 */
class AiParamStoreTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 一个简单的可调提供者：温度滑块（默认 0.8，0~1.5）与档位选择 */
    private class Tunable : AiProvider, AiTunable {
        override val id = "t"
        override val displayName = "t"
        override val layer = AiLayer.L3
        override fun capabilities() = setOf(AiTask.SUMMARIZE)
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult = AiRunResult.Text("")
        override fun paramSpecs() = listOf(SLIDER, SELECT)
    }

    private val all: List<AiProvider> = listOf(Tunable())
    private val store = InMemoryAiParamStore()

    /** 造 set 请求 */
    private fun set(vararg kv: Pair<String, Number>) =
        JSONObject().put("provider", "t").put("values", JSONObject().also { o -> kv.forEach { o.put(it.first, it.second) } })

    /** 读当前值 */
    private fun values() = AiParams.handleGet(JSONObject().put("provider", "t"), all, store).getJSONObject("values")

    /** 断言 block 以 BAD_PARAMS 拒绝 */
    private fun assertBad(block: () -> Unit) {
        val e = runCatching(block).exceptionOrNull()
        assertTrue("应 BAD_PARAMS，实际 $e", e is BridgeException && e.code == BridgeErrors.BAD_PARAMS)
    }

    @Test
    fun get_returnsDefaultsAndSpecs() {
        val r = AiParams.handleGet(JSONObject().put("provider", "t"), all, store)
        assertEquals(2, r.getJSONArray("specs").length())
        assertEquals(0.8, r.getJSONObject("values").getDouble("temperature"), 1e-9)
        assertEquals(1.0, r.getJSONObject("values").getDouble("level"), 1e-9)
    }

    @Test
    fun set_roundTrips_andOnlyStoresNonDefault() {
        AiParams.handleSet(set("temperature" to 1.2, "level" to 2), all, store)
        assertEquals(1.2, values().getDouble("temperature"), 1e-9)
        assertEquals(2.0, values().getDouble("level"), 1e-9)
        assertEquals(1.2, store.get("t", "temperature")!!, 1e-9)
        // 改回默认：删键而不是存默认
        AiParams.handleSet(set("temperature" to 0.8), all, store)
        assertNull(store.get("t", "temperature"))
    }

    @Test
    fun set_isAtomic_andRejectsUnknownOutOfRangeMisalignedBadIndex() {
        AiParams.handleSet(set("temperature" to 1.0), all, store)
        listOf(
            set("temperature" to 1.1, "nope" to 1),
            set("temperature" to 9.0),
            set("temperature" to -0.1),
            set("temperature" to 0.83),
            set("level" to 3),
            set("level" to 0.5),
            set("level" to -1),
        ).forEach { assertBad { AiParams.handleSet(it, all, store) } }
        assertBad { AiParams.handleSet(JSONObject().put("provider", "t").put("values", JSONObject().put("temperature", "hot")), all, store) }
        assertEquals("被拒绝的批次不能改任何值", 1.0, values().getDouble("temperature"), 1e-9)
    }

    @Test
    fun reset_specificKeysOrAll() {
        AiParams.handleSet(set("temperature" to 1.0, "level" to 2), all, store)
        AiParams.handleReset(JSONObject().put("provider", "t").put("keys", org.json.JSONArray().put("temperature")), all, store)
        assertEquals(0.8, values().getDouble("temperature"), 1e-9)
        assertEquals(2.0, values().getDouble("level"), 1e-9)
        assertBad { AiParams.handleReset(JSONObject().put("provider", "t").put("keys", org.json.JSONArray().put("nope")), all, store) }
        AiParams.handleReset(JSONObject().put("provider", "t"), all, store)
        assertEquals(1.0, values().getDouble("level"), 1e-9)
    }

    @Test
    fun storedValueOutOfCurrentRange_fallsBackToDefault_andDeletesKey() {
        store.set("t", "temperature", 9.9)
        store.set("t", "level", 7.0)
        assertEquals(0.8, values().getDouble("temperature"), 1e-9)
        assertEquals(1.0, values().getDouble("level"), 1e-9)
        assertNull(store.get("t", "temperature"))
        assertNull(store.get("t", "level"))
    }

    @Test
    fun unknownOrUntunableProvider_isBadParams() {
        assertBad { AiParams.handleGet(JSONObject().put("provider", "x"), all, store) }
        assertBad { AiParams.handleGet(JSONObject(), all, store) }
        assertBad { AiParams.handleGet(JSONObject().put("provider", IntentHandoffProvider.ID), listOf(IntentHandoffProvider(AiFixtures.OkHandoff())), store) }
    }

    @Test
    fun storesAreIsolatedPerProvider() {
        store.set("a", "temperature", 1.0)
        store.set("b", "temperature", 0.2)
        store.clearProvider("a")
        assertNull(store.get("a", "temperature"))
        assertEquals(0.2, store.get("b", "temperature")!!, 1e-9)
    }

    @Test
    fun sessionFingerprint_emptyWithoutSessionSpecs_andChangesWithValue() {
        val specs = listOf(SLIDER, SESSION)
        val st = InMemoryAiParamStore()
        val before = AiParams.sessionFingerprint("t", specs, st)
        st.set("t", "threads", 6.0)
        assertTrue(before != AiParams.sessionFingerprint("t", specs, st))
        assertEquals("", AiParams.sessionFingerprint("t", listOf(SLIDER), st))
        // CALL 级改值不影响指纹
        val f = AiParams.sessionFingerprint("t", specs, st)
        st.set("t", "temperature", 1.4)
        assertEquals(f, AiParams.sessionFingerprint("t", specs, st))
    }

    @Test
    fun spec_validation_edgeCases() {
        assertTrue(SLIDER.isValidValue(0.0))
        assertTrue(SLIDER.isValidValue(1.5))
        assertTrue(!SLIDER.isValidValue(Double.NaN))
        assertTrue(!SLIDER.isValidValue(Double.POSITIVE_INFINITY))
    }

    @Test
    fun selectWithOptionValues_validatesAgainstRealValues_andSerializes() {
        assertTrue(BEAMS.isValidValue(4.0))
        assertTrue(BEAMS.isValidValue(1.0))
        // 3 在 min~max 之间但不是档位真实值；0 越界
        assertTrue(!BEAMS.isValidValue(3.0))
        assertTrue(!BEAMS.isValidValue(0.0))
        assertTrue(!BEAMS.isValidValue(Double.NaN))
        val j = BEAMS.toJson()
        assertEquals(3, j.getJSONArray("optionValues").length())
        assertEquals(4.0, j.getJSONArray("optionValues").getDouble(2), 0.0)
        // 没有 optionValues 的 select 不下发该字段
        assertTrue(!SELECT.toJson().has("optionValues"))
    }

    private companion object {
        /** 带真实值的三档选择：1/2/4，默认 1 */
        val BEAMS = AiParamSpec(
            "beams", "束宽", "d", AiParamKind.SELECT, 1.0, 1.0, 4.0, 1.0,
            options = listOf("a", "b", "c"), optionValues = listOf(1.0, 2.0, 4.0),
        )

        /** 温度滑块：0~1.5，步进 0.05，默认 0.8 */
        val SLIDER = AiParamSpec("temperature", "温度", "d", AiParamKind.SLIDER, 0.8, 0.0, 1.5, 0.05)

        /** 三档选择：默认下标 1 */
        val SELECT = AiParamSpec("level", "档位", "d", AiParamKind.SELECT, 1.0, 0.0, 2.0, 1.0, options = listOf("a", "b", "c"))

        /** 会话级线程数 */
        val SESSION = AiParamSpec("threads", "线程", "d", AiParamKind.STEPPER, 4.0, 1.0, 6.0, 1.0, scope = AiParamScope.SESSION)
    }

    /** spec 里的温度默认值要是干净的十进制数，否则页面判“已修改”会出错 */
    @Test
    fun floatDefaultsAreCleanDecimals() {
        assertEquals(0.7, 0.7f.toSpecDouble(), 0.0)
        val qwen = AiQwenPolicy.PARAM_SPECS.first { it.key == AiGeneratePolicy.KEY_TEMPERATURE }
        val couplet = AiCoupletPolicy.PARAM_SPECS.first { it.key == AiGeneratePolicy.KEY_TEMPERATURE }
        assertEquals(AiQwenPolicy.DEFAULT_TEMPERATURE.toString(), qwen.default.toString())
        assertEquals(AiCoupletPolicy.DEFAULT_TEMPERATURE.toString(), couplet.default.toString())
    }
}
