package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** AI 提供者抽象的纯逻辑：参数校验、能力合并、序列化、登记处、交接提供者 */
class AiPolicyTest {
    /** 可控的平台替身 */
    private class FakePlatform(var hasHandler: Boolean, var sendOk: Boolean = true) : HandoffPlatform {
        /** 最近一次交出的文本 */
        var sent: String? = null
        override fun hasProcessTextHandler() = hasHandler
        override fun sendProcessText(text: String): Boolean {
            sent = text
            return sendOk
        }
    }

    /** 固定能力与可用性的提供者替身 */
    private class FakeProvider(
        override val id: String,
        private val tasks: Set<AiTask>,
        private val avail: AiAvailability,
        private val result: AiRunResult = AiRunResult.Text("ok"),
    ) : AiProvider {
        override val displayName = "假 $id"
        override val layer = AiLayer.L3
        override fun capabilities() = tasks
        override fun availability() = avail
        override suspend fun run(task: AiTask, input: String) = result
    }

    /** 造参数对象 */
    private fun params(provider: Any? = "p", task: Any? = "translate", input: Any? = "hi") =
        JSONObject().apply {
            if (provider != null) put("provider", provider)
            if (task != null) put("task", task)
            if (input != null) put("input", input)
        }

    /** 断言抛 BAD_PARAMS */
    private fun assertBad(block: () -> Unit) {
        val e = assertThrows(BridgeException::class.java) { block() }
        assertEquals(BridgeErrors.BAD_PARAMS, e.code)
    }

    @Test
    fun taskWireRoundTrip() {
        AiTask.values().forEach { assertEquals(it, AiTask.fromWire(it.wire)) }
        assertNull(AiTask.fromWire("nope"))
        assertEquals(AiTask.DESCRIBE_IMAGE, AiTask.fromWire("describeImage"))
    }

    @Test
    fun parseRun_ok() {
        val r = AiPolicy.parseRun(params(input = " 你好 "))
        assertEquals(AiRunRequest("p", AiTask.TRANSLATE, " 你好 "), r)
    }

    @Test
    fun parseRun_rejectsBadFields() {
        assertBad { AiPolicy.parseRun(params(provider = null)) }
        assertBad { AiPolicy.parseRun(params(provider = "")) }
        assertBad { AiPolicy.parseRun(params(provider = "x".repeat(AiPolicy.MAX_ID + 1))) }
        assertBad { AiPolicy.parseRun(params(provider = 5)) }
        assertBad { AiPolicy.parseRun(params(task = null)) }
        assertBad { AiPolicy.parseRun(params(task = "dance")) }
        assertBad { AiPolicy.parseRun(params(input = null)) }
        assertBad { AiPolicy.parseRun(params(input = "   ")) }
        assertBad { AiPolicy.parseRun(params(input = "a".repeat(AiPolicy.MAX_INPUT + 1))) }
        // 看图任务当前要非文本输入，文本入口拒绝
        assertBad { AiPolicy.parseRun(params(task = "describeImage")) }
    }

    @Test
    fun parseRun_inputUpperBoundAllowed() {
        AiPolicy.parseRun(params(input = "a".repeat(AiPolicy.MAX_INPUT)))
    }

    @Test
    fun mergeCapabilities_onlyAvailableAndOrdered() {
        val a = FakeProvider("a", setOf(AiTask.TRANSLATE, AiTask.SUMMARIZE), AiAvailability.AVAILABLE)
        val b = FakeProvider("b", setOf(AiTask.PROMPT), AiAvailability.unavailable(AiUnavailableReason.NOT_CONFIGURED))
        val c = FakeProvider("c", setOf(AiTask.SUMMARIZE, AiTask.REWRITE), AiAvailability.AVAILABLE)
        assertEquals(listOf(AiTask.SUMMARIZE, AiTask.REWRITE, AiTask.TRANSLATE), AiPolicy.mergeCapabilities(listOf(a, b, c)))
        assertTrue(AiPolicy.mergeCapabilities(emptyList()).isEmpty())
    }

    @Test
    fun providerJson_hasReasonOnlyWhenUnavailable() {
        val off = FakeProvider("off", setOf(AiTask.TRANSLATE), AiAvailability.unavailable(AiUnavailableReason.UNSUPPORTED_DEVICE))
        val j = AiPolicy.providerJson(off)
        assertEquals("off", j.getString("id"))
        assertFalse(j.getBoolean("available"))
        assertEquals("unsupported_device", j.getString("reason"))
        assertEquals("translate", j.getJSONArray("tasks").getString(0))
        val on = AiPolicy.providerJson(FakeProvider("on", setOf(AiTask.PROMPT), AiAvailability.AVAILABLE))
        assertTrue(on.getBoolean("available"))
        assertFalse(on.has("reason"))
    }

    @Test
    fun providerJson_appendsLayerAndOffers_keepsOldFields() {
        val j = AiPolicy.providerJson(IntentHandoffProvider(FakePlatform(true)))
        // 旧字段原样保留
        assertEquals("系统应用交接", j.getString("displayName"))
        assertTrue(j.getJSONArray("tasks").length() > 0)
        // 新增：层与报价；交接的翻译经 run，没有约束
        assertEquals("L3", j.getString("layer"))
        val offers = j.getJSONArray("offers")
        assertEquals(j.getJSONArray("tasks").length(), offers.length())
        val tr = (0 until offers.length()).map { offers.getJSONObject(it) }.first { it.getString("task") == "translate" }
        assertEquals("native.ai.run", tr.getString("entry"))
        assertFalse(tr.has("constraints"))
    }

    @Test
    fun offersJson_translateConstraintsSerialized() {
        /** 带语言对接口与约束的翻译替身 */
        val p = object : AiProvider, TextTranslator {
            override val id = "tr"
            override val displayName = "翻译"
            override val layer = AiLayer.L1
            override fun capabilities() = setOf(AiTask.TRANSLATE)
            override fun offers() = listOf(AiOffer(AiTask.TRANSLATE, AiConstraints.Translate(listOf("en", "fr"), false)))
            override fun availability() = AiAvailability.AVAILABLE
            override suspend fun run(task: AiTask, input: String): AiRunResult = throw AiRouter.notRunnable(id, task)
            override suspend fun translate(req: AiTranslateRequest): TranslateResult = throw UnsupportedOperationException()
        }
        val o = AiPolicy.offersJson(p).getJSONObject(0)
        assertEquals("translate", o.getString("task"))
        assertEquals("native.ai.translate", o.getString("entry"))
        val c = o.getJSONObject("constraints")
        assertEquals(listOf("en", "fr"), (0 until c.getJSONArray("languages").length()).map { c.getJSONArray("languages").getString(it) })
        assertFalse(c.getBoolean("sourceAuto"))
    }

    @Test
    fun providersJson_listsAndMerges() {
        val j = AiPolicy.providersJson(listOf(FakeProvider("a", setOf(AiTask.PROOFREAD), AiAvailability.AVAILABLE)))
        assertEquals(1, j.getJSONArray("providers").length())
        assertEquals("proofread", j.getJSONArray("capabilities").getString(0))
    }

    @Test
    fun resultJson_shapes() {
        val h = AiPolicy.resultJson(AiRunResult.Handoff(false))
        assertTrue(h.getBoolean("handoff"))
        assertFalse(h.getBoolean("handled"))
        assertFalse(h.has("text"))
        val t = AiPolicy.resultJson(AiRunResult.Text("答案"))
        assertFalse(t.getBoolean("handoff"))
        assertTrue(t.getBoolean("handled"))
        assertEquals("答案", t.getString("text"))
    }

    @Test
    fun registry_registerReplaceGet() {
        val a1 = FakeProvider("a", setOf(AiTask.PROMPT), AiAvailability.AVAILABLE)
        val reg = ProviderRegistry(listOf(a1))
        val b = FakeProvider("b", setOf(AiTask.PROMPT), AiAvailability.AVAILABLE)
        reg.register(b)
        assertEquals(listOf("a", "b"), reg.all().map { it.id })
        val a2 = FakeProvider("a", setOf(AiTask.REWRITE), AiAvailability.AVAILABLE)
        reg.register(a2)
        assertEquals(listOf("b", "a"), reg.all().map { it.id })
        assertSame(a2, reg.get("a"))
        assertNull(reg.get("zzz"))
    }

    @Test
    fun handoff_capabilitiesAreTextTasksOnly() {
        val p = IntentHandoffProvider(FakePlatform(true))
        assertEquals(IntentHandoffProvider.ID, p.id)
        assertFalse(AiTask.DESCRIBE_IMAGE in p.capabilities())
        assertTrue(AiTask.values().filter { it.isText }.all { it in p.capabilities() })
    }

    @Test
    fun handoff_availabilityFollowsHandlerProbe() {
        val platform = FakePlatform(false)
        val p = IntentHandoffProvider(platform)
        assertEquals(AiAvailability.unavailable(AiUnavailableReason.NO_HANDLER), p.availability())
        platform.hasHandler = true
        assertEquals(AiAvailability.AVAILABLE, p.availability())
    }

    @Test
    fun handoff_runPassesTextAndReportsHandled() = runBlocking {
        val platform = FakePlatform(true, sendOk = true)
        val p = IntentHandoffProvider(platform)
        assertEquals(AiRunResult.Handoff(true), p.run(AiTask.SUMMARIZE, "长文本"))
        assertEquals("长文本", platform.sent)
        platform.sendOk = false
        assertEquals(AiRunResult.Handoff(false), p.run(AiTask.TRANSLATE, "x"))
    }
}
