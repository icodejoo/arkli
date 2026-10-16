package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** 预热/卸载纯逻辑：参数校验、选会话、批量卸载、响应组装、trim 判定（预热选提供者见 AiRouterTest） */
class AiLifecyclePolicyTest {
    /** 断言抛指定错误码 */
    private fun assertCode(code: String, block: () -> Unit) {
        val e = assertThrows(BridgeException::class.java) { block() }
        assertEquals(code, e.code)
    }

    /** 持有会话的提供者替身 */
    private class Sess(
        override val id: String,
        private val avail: AiAvailability = AiAvailability.AVAILABLE,
        var loaded: Boolean = false,
        private val failUnload: Boolean = false,
    ) : AiProvider, AiSessionControl {
        override val displayName = "会话"
        override val layer = AiLayer.L3
        override fun capabilities() = setOf(AiTask.TRANSLATE)
        override fun availability() = avail
        override suspend fun run(task: AiTask, input: String): AiRunResult = AiRunResult.Text("")
        override suspend fun warmup(): WarmupResult = WarmupResult(id, 0)
        override suspend fun unloadSession(): Boolean {
            if (failUnload) throw IllegalStateException("boom")
            return loaded.also { loaded = false }
        }
    }

    /** 不持有会话的提供者替身 */
    private class Plain : AiProvider {
        override val id = "handoff"
        override val displayName = "交接"
        override val layer = AiLayer.L3
        override fun capabilities() = setOf(AiTask.PROMPT)
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult = AiRunResult.Handoff(true)
    }

    @Test
    fun parseWarmup_requiresStringProvider() {
        assertEquals("local-nllb", AiLifecyclePolicy.parseWarmup(JSONObject("""{"provider":"local-nllb"}""")))
        assertCode(BridgeErrors.BAD_PARAMS) { AiLifecyclePolicy.parseWarmup(JSONObject("{}")) }
        assertCode(BridgeErrors.BAD_PARAMS) { AiLifecyclePolicy.parseWarmup(JSONObject("""{"provider":1}""")) }
        assertCode(BridgeErrors.BAD_PARAMS) { AiLifecyclePolicy.parseWarmup(JSONObject("""{"provider":null}""")) }
    }

    @Test
    fun parseUnload_missingOrNullMeansAll() {
        assertNull(AiLifecyclePolicy.parseUnload(JSONObject("{}")))
        assertNull(AiLifecyclePolicy.parseUnload(JSONObject("""{"provider":null}""")))
        assertEquals("local-clip", AiLifecyclePolicy.parseUnload(JSONObject("""{"provider":"local-clip"}""")))
        assertCode(BridgeErrors.BAD_PARAMS) { AiLifecyclePolicy.parseUnload(JSONObject("""{"provider":3}""")) }
    }

    @Test
    fun selectSessions_allOrOne() {
        val a = Sess("local-nllb")
        val b = Sess("local-clip")
        val all = AiLifecyclePolicy.selectSessions(listOf(Plain(), a, b), null)
        assertEquals(listOf("local-nllb", "local-clip"), all.map { it.first })
        assertEquals(listOf("local-clip"), AiLifecyclePolicy.selectSessions(listOf(a, b), "local-clip").map { it.first })
        assertCode(BridgeErrors.BAD_PARAMS) { AiLifecyclePolicy.selectSessions(listOf(a), "nope") }
        assertCode(BridgeErrors.BAD_PARAMS) { AiLifecyclePolicy.selectSessions(listOf(Plain()), "handoff") }
    }

    @Test
    fun unloadAll_onlyListsActuallyLoaded_andIsIdempotent() {
        val a = Sess("local-nllb", loaded = true)
        val b = Sess("local-clip", loaded = false)
        val sessions = listOf("local-nllb" to a, "local-clip" to b)
        assertEquals(listOf("local-nllb"), runBlocking { AiLifecyclePolicy.unloadAll(sessions) })
        assertEquals(emptyList<String>(), runBlocking { AiLifecyclePolicy.unloadAll(sessions) })
    }

    @Test
    fun unloadAll_oneFailureDoesNotBlockOthers() {
        val bad = Sess("local-nllb", loaded = true, failUnload = true)
        val ok = Sess("local-clip", loaded = true)
        val r = runBlocking { AiLifecyclePolicy.unloadAll(listOf("local-nllb" to bad, "local-clip" to ok)) }
        assertEquals(listOf("local-clip"), r)
    }

    @Test
    fun json_shapes() {
        val w = AiLifecyclePolicy.warmupJson(WarmupResult("local-nllb", 2800))
        assertEquals("local-nllb", w.getString("provider"))
        assertTrue(w.getBoolean("loaded"))
        assertEquals(2800L, w.getLong("elapsedMs"))
        val u = AiLifecyclePolicy.unloadJson(listOf("local-nllb", "local-clip"))
        assertEquals(2, u.getJSONArray("unloaded").length())
        assertEquals(0, AiLifecyclePolicy.unloadJson(emptyList()).getJSONArray("unloaded").length())
    }

    @Test
    fun shouldReleaseOnTrim_onlyCriticalOrComplete() {
        assertTrue(AiLifecyclePolicy.shouldReleaseOnTrim(15)) // RUNNING_CRITICAL
        assertTrue(AiLifecyclePolicy.shouldReleaseOnTrim(80)) // COMPLETE
        assertFalse(AiLifecyclePolicy.shouldReleaseOnTrim(20)) // UI_HIDDEN：每次退后台都会来
        assertFalse(AiLifecyclePolicy.shouldReleaseOnTrim(5)) // RUNNING_MODERATE
        assertFalse(AiLifecyclePolicy.shouldReleaseOnTrim(40)) // BACKGROUND
        assertFalse(AiLifecyclePolicy.shouldReleaseOnTrim(60)) // MODERATE
    }
}
