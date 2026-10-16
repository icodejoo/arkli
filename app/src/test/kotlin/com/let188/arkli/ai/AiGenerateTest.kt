package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.image.SourceResolver
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** 文本生成的预设、system、采样：解析、约束、分派、非生成式提供者拒绝 */
class AiGenerateTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 记录每次生成采样与 system 的引擎替身 */
    private class Rec : QwenBackend {
        var sampling: Sampling? = null
        var system: String? = null
        var prompt: String? = null
        override fun load(configPath: String) {}
        override fun unload() {}
        override fun generate(system: String, prompt: String, maxNewTokens: Int, sampling: Sampling): String {
            this.sampling = sampling
            this.system = system
            this.prompt = prompt
            return "ok"
        }
        override fun cancel() {}
    }

    /** 真提供者（Qwen + 交接）与分派器 */
    private fun setup(): Pair<AiInvoker, Rec> {
        val dir = tmp.newFolder()
        QwenService.REQUIRED_FILES.forEach { File(dir, it).writeText("x") }
        val rec = Rec()
        val qwen = LocalQwenProvider(QwenService(object : QwenEnv { override fun modelDir() = dir }, rec))
        val all = listOf<AiProvider>(IntentHandoffProvider(AiFixtures.OkHandoff()), qwen)
        return AiInvoker({ all }, SourceResolver { null }) to rec
    }

    /** 拼 invoke 参数，options 里的键值成对给出 */
    private fun params(task: String, provider: String, vararg opts: Pair<String, Any>): JSONObject {
        val o = JSONObject()
        opts.forEach { (k, v) -> o.put(k, v) }
        val p = JSONObject().put("task", task).put("provider", provider).put("input", JSONObject().put("text", "hi"))
        return if (opts.isEmpty()) p else p.put("options", o)
    }

    /** 跑 invoke 并返回 BAD_PARAMS 的文案；没报错或码不对就失败 */
    private fun badParams(inv: AiInvoker, p: JSONObject): String = try {
        runBlocking { inv.invoke(p) }
        fail("应当 BAD_PARAMS")
        ""
    } catch (e: BridgeException) {
        assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        e.message.orEmpty()
    }

    @Test
    fun parse_emptyAndTyped() {
        assertTrue(AiGeneratePolicy.parse(JSONObject()).isEmpty)
        val o = AiGeneratePolicy.parse(JSONObject("{\"preset\":\"prompt\",\"system\":\"s\",\"temperature\":0.5,\"topK\":7}"))
        assertEquals(AiGenOptions(AiPreset.PROMPT, "s", AiSamplingParams(0.5f, 7)), o)
        assertNull(AiGeneratePolicy.parse(JSONObject("{\"temperature\":null}")).sampling)
        assertEquals(AiSamplingParams(0f, null), AiGeneratePolicy.parse(JSONObject("{\"temperature\":0}")).sampling)
    }

    @Test
    fun parse_rejectsBadShapes() {
        listOf(
            "{\"preset\":\"nope\"}", "{\"preset\":1}", "{\"system\":\"\"}", "{\"system\":\"  \"}", "{\"system\":5}",
            "{\"temperature\":\"hot\"}", "{\"topK\":1.5}", "{\"topK\":\"3\"}",
        ).forEach {
            val e = runCatching { AiGeneratePolicy.parse(JSONObject(it)) }.exceptionOrNull()
            assertTrue("$it 应 BAD_PARAMS", e is BridgeException && e.code == BridgeErrors.BAD_PARAMS)
        }
        val long = "x".repeat(AiGeneratePolicy.MAX_SYSTEM + 1)
        assertTrue(runCatching { AiGeneratePolicy.parse(JSONObject().put("system", long)) }.isFailure)
    }

    @Test
    fun constraints_ranges() {
        val g = AiQwenPolicy.OFFER_GENERATE
        assertEquals(0f..1.5f, g.temperature)
        assertEquals(1..100, g.topK)
        assertEquals(AiPreset.values().toList(), g.presets)
        assertTrue(g.allowSystem)
        val json = g.toJson()
        assertEquals(1.5, json.getJSONObject("temperature").getDouble("max"), 0.0)
        assertEquals(100, json.getJSONObject("topK").getInt("max"))
        assertEquals(4, json.getJSONArray("presets").length())
        /** 造一次带采样参数的 run 调用 */
        fun call(t: Float? = null, k: Int? = null) = AiCall.Run(AiTask.PROMPT, null, "x", sampling = AiSamplingParams(t, k))
        g.check(call(0f, 1))
        g.check(call(1.5f, 100))
        listOf(call(-0.1f), call(1.51f), call(k = 0), call(k = 101)).forEach {
            assertTrue(runCatching { g.check(it) }.exceptionOrNull() is BridgeException)
        }
        // 与生成无关的调用放行
        g.check(AiCall.Translate(AiTranslateRequest("hi", "en", "fr", null)))
        // 不允许 system / 限制预设的约束
        val strict = AiConstraints.Generate(listOf(AiPreset.PROMPT), 0f..1f, 1..10, allowSystem = false)
        assertTrue(runCatching { strict.check(AiCall.Run(AiTask.PROMPT, null, "x", system = "s")) }.isFailure)
        assertTrue(runCatching { strict.check(AiCall.Run(AiTask.SUMMARIZE, null, "x", AiPreset.SUMMARIZE)) }.isFailure)
    }

    @Test
    fun invoke_presetSystemAndSamplingReachBackend() {
        val (inv, rec) = setup()
        runBlocking { inv.invoke(params("prompt", LocalQwenProvider.ID, "system" to "你是海盗", "temperature" to 0.3, "topK" to 9)) }
        assertEquals("你是海盗", rec.system)
        assertEquals(Sampling(0.3f, 9), rec.sampling)
        // 不传选项：与旧行为一致（prompt 默认采样、摘要贪心）
        runBlocking { inv.invoke(params("prompt", LocalQwenProvider.ID)) }
        assertEquals(AiQwenPolicy.PROMPT_SAMPLING, rec.sampling)
        runBlocking { inv.invoke(params("summarize", LocalQwenProvider.ID)) }
        assertTrue(rec.sampling!!.isGreedy)
        // 任务 summarize 改用 prompt 预设，允许 system
        runBlocking { inv.invoke(params("summarize", LocalQwenProvider.ID, "preset" to "prompt", "system" to "s")) }
        assertEquals("s", rec.system)
        assertEquals("hi", rec.prompt)
    }

    @Test
    fun invoke_systemOnlyForPromptPreset() {
        val (inv, rec) = setup()
        for (task in listOf("summarize", "proofread", "rewrite")) {
            val msg = badParams(inv, params(task, LocalQwenProvider.ID, "system" to "s"))
            assertTrue(msg, msg.contains("prompt"))
        }
        // 预设写成非 prompt，即使 task 是 prompt 也不行
        badParams(inv, params("prompt", LocalQwenProvider.ID, "preset" to "rewrite", "system" to "s"))
        assertNull(rec.system)
    }

    @Test
    fun invoke_outOfRangeSamplingAndUnknownPreset() {
        val (inv, _) = setup()
        badParams(inv, params("prompt", LocalQwenProvider.ID, "temperature" to 2.0))
        badParams(inv, params("prompt", LocalQwenProvider.ID, "temperature" to -1))
        badParams(inv, params("prompt", LocalQwenProvider.ID, "topK" to 0))
        badParams(inv, params("prompt", LocalQwenProvider.ID, "topK" to 101))
        badParams(inv, params("prompt", LocalQwenProvider.ID, "preset" to "translate"))
    }

    @Test
    fun invoke_nonGenerativeProviderRejectsOptions_notSilent() {
        val (inv, _) = setup()
        for (opt in listOf("preset" to "prompt", "system" to "s", "temperature" to 0.5, "topK" to 5)) {
            val msg = badParams(inv, params("translate", IntentHandoffProvider.ID, opt))
            assertTrue(msg, msg.contains(IntentHandoffProvider.ID))
        }
        // 不带选项照常交接
        val r = runBlocking { inv.invoke(params("translate", IntentHandoffProvider.ID)) }
        assertTrue(r.getBoolean("handoff"))
    }

    @Test
    fun legacyRun_unchanged_noOptions() {
        val (inv, rec) = setup()
        val r = runBlocking { inv.dispatch(AiCall.Run(AiTask.PROMPT, LocalQwenProvider.ID, "hi")) }
        assertEquals("ok", r.getString("text"))
        assertEquals(AiQwenPolicy.PROMPT_SAMPLING, rec.sampling)
        assertTrue(AiCall.Run(AiTask.PROMPT, null, "x").gen.isEmpty)
    }
}
