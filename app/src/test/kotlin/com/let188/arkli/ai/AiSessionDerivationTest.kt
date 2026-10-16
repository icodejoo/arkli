package com.let188.arkli.ai

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.bridge.ReplyIo
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 第 4 步：生命周期从提供者派生。新增一个只实现 [AiSessionControl] 的提供者，除了把它放进提供者列表，
 * 不改任何别处，就能被预热、卸载、删模型前释放、进程级回收覆盖到。
 */
class AiSessionDerivationTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 替身会话依赖的清单模型 id */
    private val stubModel = "stub-model"

    /** 只持有会话的替身提供者：不做任何任务 */
    private inner class SessionOnly : AiProvider, AiSessionControl {
        /** 会话是否已加载 */
        var loaded = false
        override val id = "stub-session"
        override val displayName = "会话替身"
        override val layer = AiLayer.L1
        override val sessionModelId = stubModel
        override fun capabilities() = emptySet<AiTask>()
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult = throw AiRouter.notRunnable(id, task)
        override suspend fun warmup(): WarmupResult {
            loaded = true
            return WarmupResult(id, 0)
        }
        override suspend fun unloadSession(): Boolean = loaded.also { loaded = false }
    }

    /** 丢弃回传的通道 */
    private class NullIo : ReplyIo {
        override fun send(json: String) {}
    }

    /** 主 frame 的调用上下文 */
    private fun ctx() = CallContext(1, "t", true, ArkliBridge(1, NullIo()))

    /** 每条用例后清掉进程级登记，免得串到别的测试 */
    @After
    fun reset() = AiRecycle.attach(emptyList())

    @Test
    fun newSessionProvider_isRecycled() {
        val stub = SessionOnly()
        AiRecycle.attach(AiFixtures.registered(tmp) + stub)
        runBlocking { stub.warmup() }
        // 正式的会话没加载过，卸了也不算；替身被回收
        assertEquals(listOf(stub.id), runBlocking { AiRecycle.releaseNow() })
        assertEquals(false, stub.loaded)
        assertEquals(emptyList<String>(), runBlocking { AiRecycle.releaseNow() })
    }

    @Test
    fun releaseHooks_coverEveryModelBackedSession() {
        val stub = SessionOnly()
        val hooks = AiLifecyclePolicy.releaseHooks(AiFixtures.registered(tmp) + stub)
        assertEquals(setOf(ClipService.MODEL_ID, OcrService.MODEL_ID, TranslateService.MODEL_ID, QwenService.MODEL_ID, stubModel), hooks.keys)
        assertEquals(listOf(stub.id), hooks.getValue(stubModel).map { it.first })
        assertEquals(listOf(LocalQwenProvider.ID), hooks.getValue(QwenService.MODEL_ID).map { it.first })
    }

    @Test
    fun warmupAndUnloadHandlers_routeToNewSessionProvider() {
        val stub = SessionOnly()
        val registry = ProviderRegistry(AiFixtures.registered(tmp) + stub)
        val w = runBlocking { AiWarmupHandler(registry).handle(ctx(), JSONObject().put("provider", stub.id)) } as JSONObject
        assertEquals(stub.id, w.getString("provider"))
        assertTrue(stub.loaded)
        val one = runBlocking { AiUnloadHandler(registry).handle(ctx(), JSONObject().put("provider", stub.id)) } as JSONObject
        assertEquals(stub.id, one.getJSONArray("unloaded").getString(0))
        runBlocking { stub.warmup() }
        val all = runBlocking { AiUnloadHandler(registry).handle(ctx(), JSONObject()) } as JSONObject
        assertEquals(1, all.getJSONArray("unloaded").length())
        assertEquals(stub.id, all.getJSONArray("unloaded").getString(0))
    }

    @Test
    fun providersJson_marksSessionCapability() {
        val stub = SessionOnly()
        val arr = AiPolicy.providersJson(AiFixtures.registered(tmp) + stub).getJSONArray("providers")
        val session = (0 until arr.length()).map { arr.getJSONObject(it) }.associate { it.getString("id") to it.getBoolean("session") }
        assertEquals(
            mapOf(
                IntentHandoffProvider.ID to false,
                LocalClipProvider.ID to true,
                LocalOcrProvider.ID to true,
                LocalNllbProvider.ID to true,
                LocalQwenProvider.ID to true,
                stub.id to true,
            ),
            session,
        )
    }
}
