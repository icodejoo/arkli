package com.let188.arkli.ai

import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * [AiParamDefaults] 的测试：优先级（显式 > 用户设置 > 内置默认）、prompt 以外预设不吃用户温度、各通道的映射。
 */
class AiParamDefaultsTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 取已注册提供者 */
    private fun provider(id: String): AiProvider = AiFixtures.registered(tmp).first { it.id == id }

    /** 存一个用户设置值 */
    private fun AiParamStore.put(p: AiProvider, key: String, v: Double) = set(p.id, key, v)

    @Test
    fun noUserSettings_callIsReturnedUntouched() {
        val q = provider(LocalQwenProvider.ID)
        val call = AiCall.Run(AiTask.PROMPT, null, "hi")
        assertSame(call, AiParamDefaults.fill(call, q, InMemoryAiParamStore()))
    }

    @Test
    fun nonTunableProvider_isNeverTouched() {
        val h = provider(IntentHandoffProvider.ID)
        val store = InMemoryAiParamStore().also { it.set(h.id, "temperature", 1.0) }
        val call = AiCall.Run(AiTask.PROMPT, null, "hi")
        assertSame(call, AiParamDefaults.fill(call, h, store))
    }

    @Test
    fun explicit_beatsUserSetting_beatsBuiltinDefault() {
        val q = provider(LocalQwenProvider.ID)
        val store = InMemoryAiParamStore().also {
            it.put(q, AiGeneratePolicy.KEY_TEMPERATURE, 1.2)
            it.put(q, AiGeneratePolicy.KEY_TOP_K, 50.0)
        }
        // 用户设置补进没传的
        val filled = AiParamDefaults.fill(AiCall.Run(AiTask.PROMPT, null, "hi"), q, store)
        assertEquals(AiSamplingParams(1.2f, 50), filled.sampling)
        // 显式传的温度不被覆盖，topK 仍由用户设置补
        val explicit = AiParamDefaults.fill(AiCall.Run(AiTask.PROMPT, null, "hi", sampling = AiSamplingParams(temperature = 0.1f)), q, store)
        assertEquals(AiSamplingParams(0.1f, 50), explicit.sampling)
        // 用户没改过的 key 不补：回到内置默认（采样为空）
        val none = AiParamDefaults.fill(AiCall.Run(AiTask.PROMPT, null, "hi"), q, InMemoryAiParamStore())
        assertNull(none.sampling)
    }

    @Test
    fun nonPromptPresets_neverTakeUserTemperature() {
        val q = provider(LocalQwenProvider.ID)
        val store = InMemoryAiParamStore().also {
            it.put(q, AiGeneratePolicy.KEY_TEMPERATURE, 1.2)
            it.put(q, AiGeneratePolicy.KEY_TOP_K, 50.0)
        }
        listOf(AiTask.SUMMARIZE, AiTask.PROOFREAD, AiTask.REWRITE).forEach { t ->
            assertNull("$t", AiParamDefaults.fill(AiCall.Run(t, null, "hi"), q, store).sampling)
        }
        // 任务是摘要但显式改用 prompt 预设：算 prompt，吃用户温度
        val asPrompt = AiParamDefaults.fill(AiCall.Run(AiTask.SUMMARIZE, null, "hi", AiPreset.PROMPT), q, store)
        assertEquals(1.2f, asPrompt.sampling!!.temperature)
    }

    @Test
    fun maxTokens_appliesToTextPresets_usesRealValue() {
        val q = provider(LocalQwenProvider.ID)
        val store = InMemoryAiParamStore().also { it.put(q, AiParamDefaults.KEY_MAX_TOKENS, 512.0) }
        listOf(AiTask.SUMMARIZE, AiTask.PROOFREAD, AiTask.REWRITE, AiTask.PROMPT).forEach { t ->
            assertEquals(512, AiParamDefaults.fill(AiCall.Run(t, null, "hi"), q, store).maxTokens)
        }
        // 128 档
        store.put(q, AiParamDefaults.KEY_MAX_TOKENS, 128.0)
        assertEquals(128, AiParamDefaults.fill(AiCall.Run(AiTask.PROMPT, null, "hi"), q, store).maxTokens)
    }

    @Test
    fun maxTokens_reachesBackend_andTranslateIsUnaffected() {
        val seen = mutableListOf<Int>()
        val dir = tmp.newFolder()
        QwenService.REQUIRED_FILES.forEach { java.io.File(dir, it).writeText("x") }
        val backend = object : QwenBackend {
            override fun load(configPath: String) {}
            override fun unload() {}
            override fun generate(system: String, prompt: String, maxNewTokens: Int, sampling: Sampling): String {
                seen += maxNewTokens
                return "ok"
            }
            override fun cancel() {}
        }
        val provider = LocalQwenProvider(QwenService(object : QwenEnv { override fun modelDir() = dir }, backend))
        val store = InMemoryAiParamStore().also { it.set(provider.id, AiParamDefaults.KEY_MAX_TOKENS, 128.0) }
        val inv = AiInvoker({ listOf(provider) }, com.let188.arkli.image.SourceResolver { null }, store)
        runBlocking {
            inv.invoke(JSONObject().put("task", "summarize").put("input", JSONObject().put("text", "hi")))
            inv.invoke(JSONObject().put("task", "translate").put("input", JSONObject().put("text", "你好").put("src", "zh-CN").put("tgt", "en")))
        }
        assertEquals(128, seen[0])
        assertEquals(AiQwenPolicy.translateMaxTokens(2), seen[1])
    }

    @Test
    fun maxTokens_defaultMatchesLegacyConstant() {
        assertEquals(256, AiQwenPolicy.MAX_NEW_TOKENS)
        val spec = AiQwenPolicy.PARAM_SPECS.first { it.key == AiParamDefaults.KEY_MAX_TOKENS }
        assertEquals(AiQwenPolicy.MAX_NEW_TOKENS.toDouble(), spec.default, 0.0)
        assertTrue(spec.default in spec.optionValues)
    }

    @Test
    fun numBeams_usesRealValue_explicitWins() {
        val n = provider(LocalNllbProvider.ID)
        val store = InMemoryAiParamStore().also { it.put(n, AiParamDefaults.KEY_NUM_BEAMS, 4.0) }
        val c = AiCall.Translate(AiTranslateRequest("hi", "en", "fr", null))
        assertEquals(4, AiParamDefaults.fill(c, n, store).req.numBeams)
        val explicit = AiCall.Translate(AiTranslateRequest("hi", "en", "fr", 1))
        assertEquals(1, AiParamDefaults.fill(explicit, n, store).req.numBeams)
        // 用户没改（默认档 1 束）：不补
        assertNull(AiParamDefaults.fill(c, n, InMemoryAiParamStore()).req.numBeams)
    }

    @Test
    fun couplet_fillsOnlyMissingFields() {
        val c = provider(LocalCoupletProvider.ID)
        val store = InMemoryAiParamStore().also {
            it.put(c, AiGeneratePolicy.KEY_TEMPERATURE, 1.1)
            it.put(c, AiGeneratePolicy.KEY_TOP_K, 80.0)
        }
        val r = AiParamDefaults.fill(AiCall.Couplet(AiCoupletRequest(null, "春风", temperature = 0.3f)), c, store).req
        assertEquals(0.3f, r.temperature)
        assertEquals(80, r.topK)
        val full = AiParamDefaults.fill(AiCall.Couplet(AiCoupletRequest(null, "春风")), c, store).req
        assertEquals(1.1f, full.temperature)
    }

    @Test
    fun classify_fillsTopKOnlyWhenPageDidNotPassIt() {
        val c = provider(LocalClipProvider.ID)
        val store = InMemoryAiParamStore().also { it.put(c, AiGeneratePolicy.KEY_TOP_K, 7.0) }
        val implicit = AiClassifyPolicy.parse(JSONObject().put("path", "cache/pick/a.jpg"))
        assertNull(implicit.topK)
        assertEquals(7, AiParamDefaults.fill(AiCall.Classify(implicit), c, store).req.topK)
        val explicit = AiClassifyPolicy.parse(JSONObject().put("path", "cache/pick/a.jpg").put("topK", 2))
        assertEquals(2, AiParamDefaults.fill(AiCall.Classify(explicit), c, store).req.topK)
    }

    @Test
    fun fill_snapshotIsNotAffectedByLaterChanges() {
        val q = provider(LocalQwenProvider.ID)
        val store = InMemoryAiParamStore().also { it.put(q, AiGeneratePolicy.KEY_TEMPERATURE, 1.0) }
        val filled = AiParamDefaults.fill(AiCall.Run(AiTask.PROMPT, null, "hi"), q, store)
        store.put(q, AiGeneratePolicy.KEY_TEMPERATURE, 0.2)
        assertEquals(1.0f, filled.sampling!!.temperature)
    }
}
