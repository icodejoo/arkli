package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.model.ModelManifestParser
import com.let188.arkli.model.ModelStateInfo
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** 本地文本模型服务与提供者：就绪判断、懒加载、重载、任务分发、可用性判定、随包清单 */
class QwenServiceTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 记录调用的引擎替身 */
    private class FakeBackend(private val reply: String = "  回答  ") : QwenBackend {
        val calls = mutableListOf<String>()
        var lastPrompt = ""
        var lastSystem = ""
        var lastMax = -1
        var lastSampling: Sampling? = null
        override fun load(configPath: String) { calls += "load:${File(configPath).name}" }
        override fun unload() { calls += "unload" }
        override fun generate(system: String, prompt: String, maxNewTokens: Int, sampling: Sampling): String {
            lastSampling = sampling
            lastPrompt = prompt
            lastSystem = system
            lastMax = maxNewTokens
            calls += "generate"
            return reply
        }
    }

    /** 以临时目录为模型目录的环境 */
    private fun env(dir: File) = object : QwenEnv {
        override fun modelDir() = dir
    }

    /** 写齐全部必需文件 */
    private fun fillModel(dir: File) {
        dir.mkdirs()
        QwenService.REQUIRED_FILES.forEach { File(dir, it).writeText("x") }
    }

    @Test
    fun notReady_whenFilesMissing() {
        val dir = tmp.newFolder("m")
        val b = FakeBackend()
        val s = QwenService(env(dir), b)
        assertFalse(s.isModelReady())
        val e = assertThrows(BridgeException::class.java) { runBlocking { s.run(AiTask.PROMPT, "hi") } }
        assertEquals(BridgeErrors.NOT_READY, e.code)
        assertTrue(b.calls.isEmpty())
    }

    @Test
    fun notReady_whenOneFileMissingOrEmpty() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val s = QwenService(env(dir), FakeBackend())
        assertTrue(s.isModelReady())
        File(dir, "llm.mnn.weight").writeText("")
        assertFalse(s.isModelReady())
        File(dir, "llm.mnn.weight").delete()
        assertFalse(s.isModelReady())
    }

    @Test
    fun run_lazyLoadsOnce_passesConfigAndCleansOutput() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        val s = QwenService(env(dir), b)
        assertEquals("回答", runBlocking { s.run(AiTask.PROMPT, "你好") })
        runBlocking { s.run(AiTask.PROMPT, "再来") }
        assertEquals(listOf("load:config.json", "generate", "generate"), b.calls)
        assertEquals(AiQwenPolicy.MAX_NEW_TOKENS, b.lastMax)
    }

    @Test
    fun translate_maxTokens_followsInputLength() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        val s = QwenService(env(dir), b)
        runBlocking { s.translate("hi", "en", "zh-CN") }
        assertEquals(AiQwenPolicy.MIN_TRANSLATE_TOKENS, b.lastMax)
        runBlocking { s.translate("x".repeat(100), "en", "zh-CN") }
        assertEquals(200, b.lastMax)
        runBlocking { s.translate("x".repeat(AiQwenPolicy.MAX_TRANSLATE_CHARS), "en", "zh-CN") }
        assertEquals(AiQwenPolicy.MAX_TRANSLATE_TOKENS, b.lastMax)
        assertEquals(AiQwenPolicy.MAX_TRANSLATE_TOKENS, AiQwenPolicy.translateMaxTokens(100_000))
        assertEquals(AiQwenPolicy.MIN_TRANSLATE_TOKENS, AiQwenPolicy.translateMaxTokens(0))
    }

    @Test
    fun generateInternalError_discardsSession_nextCallReloads() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = object : QwenBackend {
            val calls = mutableListOf<String>()
            var fail = true
            override fun load(configPath: String) { calls += "load" }
            override fun unload() { calls += "unload" }
            override fun generate(system: String, prompt: String, maxNewTokens: Int, sampling: Sampling): String {
                calls += "generate"
                if (fail) {
                    fail = false
                    throw BridgeException(BridgeErrors.INTERNAL, "MNN 会话已失效，请重新加载")
                }
                return "好"
            }
        }
        val s = QwenService(env(dir), b)
        val e = assertThrows(BridgeException::class.java) { runBlocking { s.run(AiTask.SUMMARIZE, "x") } }
        assertEquals(BridgeErrors.INTERNAL, e.code)
        // 失败后会话被卸掉，下一次调用重新 load 再 generate
        assertEquals("好", runBlocking { s.run(AiTask.SUMMARIZE, "x") })
        assertEquals(listOf("load", "generate", "unload", "load", "generate"), b.calls)
    }

    @Test
    fun run_buildsPromptByTask() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        val s = QwenService(env(dir), b)
        runBlocking { s.run(AiTask.SUMMARIZE, "长文") }
        assertEquals(AiQwenPolicy.buildPrompt(AiTask.SUMMARIZE, "长文"), b.lastPrompt)
    }

    @Test
    fun run_defaultSampling_greedyForTextTools_sampledForPrompt() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        val s = QwenService(env(dir), b)
        listOf(AiTask.SUMMARIZE, AiTask.PROOFREAD, AiTask.REWRITE).forEach {
            runBlocking { s.run(it, "x") }
            assertEquals("${it.wire} 默认贪心", Sampling.GREEDY, b.lastSampling)
            assertTrue(b.lastSampling!!.isGreedy)
        }
        runBlocking { s.run(AiTask.PROMPT, "x") }
        assertEquals(Sampling(0.7f, 20), b.lastSampling)
        assertEquals(AiQwenPolicy.PROMPT_SAMPLING, b.lastSampling)
        runBlocking { s.translate("hi", "en", "zh-CN") }
        assertTrue("翻译固定贪心", b.lastSampling!!.isGreedy)
    }

    @Test
    fun run_pageOptions_overridePresetAndSampling() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        val s = QwenService(env(dir), b)
        // 摘要任务改用 rewrite 预设：指令、system 跟预设走
        runBlocking { s.run(AiTask.SUMMARIZE, "x", AiGenOptions(preset = AiPreset.REWRITE)) }
        assertEquals(AiQwenPolicy.buildPrompt(AiPreset.REWRITE, "x"), b.lastPrompt)
        assertTrue(b.lastSystem.contains("只输出结果"))
        // 贪心预设上只传 topK：仍贪心；传了温度则带上缺省 topK
        runBlocking { s.run(AiTask.PROOFREAD, "x", AiGenOptions(sampling = AiSamplingParams(topK = 5))) }
        assertTrue(b.lastSampling!!.isGreedy)
        runBlocking { s.run(AiTask.PROOFREAD, "x", AiGenOptions(sampling = AiSamplingParams(temperature = 0.4f))) }
        assertEquals(Sampling(0.4f, Sampling.DEFAULT_TOP_K), b.lastSampling)
        // prompt 预设：温度 0 变贪心；额外 system 原样送给模型
        runBlocking { s.run(AiTask.PROMPT, "x", AiGenOptions(system = "你是海盗", sampling = AiSamplingParams(temperature = 0f))) }
        assertTrue(b.lastSampling!!.isGreedy)
        assertEquals("你是海盗", b.lastSystem)
        runBlocking { s.run(AiTask.PROMPT, "x", AiGenOptions(sampling = AiSamplingParams(topK = 50))) }
        assertEquals(Sampling(0.7f, 50), b.lastSampling)
        assertEquals("", b.lastSystem)
    }

    @Test
    fun provider_generate_sameAsRunWhenNoOptions_andRejectsTranslate() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend("ok")
        val p = LocalQwenProvider(QwenService(env(dir), b))
        runBlocking { p.run(AiTask.PROMPT, "x") }
        assertEquals(AiQwenPolicy.PROMPT_SAMPLING, b.lastSampling)
        val e = assertThrows(BridgeException::class.java) { runBlocking { p.generate(AiTask.TRANSLATE, "x", AiGenOptions.NONE) } }
        assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        // 文本任务都带生成约束，翻译带语言约束
        p.offers().forEach {
            if (it.task == AiTask.TRANSLATE) assertTrue(it.constraints is AiConstraints.Translate)
            else assertEquals(AiQwenPolicy.OFFER_GENERATE, it.constraints)
        }
    }

    @Test
    fun translate_usesTranslateSystemPromptAndRawText() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend("Hello, world")
        val s = QwenService(env(dir), b)
        assertEquals("Hello, world", runBlocking { s.translate("你好世界", "zh-CN", "en") })
        assertEquals("你好世界", b.lastPrompt)
        assertEquals(AiQwenPolicy.translateSystemPrompt("中文", "英文"), b.lastSystem)
    }

    @Test
    fun provider_translate_fillsResult_autoHasNoDetected() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val p = LocalQwenProvider(QwenService(env(dir), FakeBackend("ok")))
        val r = runBlocking { p.translate(AiTranslateRequest("hi", "auto", "zh-CN", null, LocalQwenProvider.ID)) }
        assertEquals("ok", r.text)
        assertEquals(QwenService.MODEL_ID, r.modelId)
        assertEquals(emptyList<String>(), r.detectedSrc)
        val r2 = runBlocking { p.translate(AiTranslateRequest("hi", "en", "zh-CN", null)) }
        assertEquals(listOf("en"), r2.detectedSrc)
    }

    @Test
    fun run_unsupportedTask_failsBeforeLoading() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        val e = assertThrows(BridgeException::class.java) { runBlocking { QwenService(env(dir), b).run(AiTask.TRANSLATE, "x") } }
        assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        assertTrue(b.calls.isEmpty())
    }

    @Test
    fun run_reloadsWhenModelFileChanges() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        val s = QwenService(env(dir), b)
        runBlocking { s.run(AiTask.PROMPT, "a") }
        File(dir, "tokenizer.txt").writeText("longer content")
        runBlocking { s.run(AiTask.PROMPT, "b") }
        assertEquals(listOf("load:config.json", "generate", "unload", "load:config.json", "generate"), b.calls)
    }

    @Test
    fun unload_reportsWhetherLoaded_andReloadsOnNextRun() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        val s = QwenService(env(dir), b)
        assertFalse(runBlocking { s.unload() })
        runBlocking { s.run(AiTask.PROMPT, "a") }
        assertTrue(runBlocking { s.unload() })
        assertFalse(runBlocking { s.unload() })
        runBlocking { s.run(AiTask.PROMPT, "b") }
        assertEquals(2, b.calls.count { it.startsWith("load") })
    }

    @Test
    fun warmup_loadsWithoutGenerating_andIsIdempotent() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        var t = 0L
        val s = QwenService(env(dir), b) { t.also { t += 10 } }
        val r = runBlocking { s.warmup() }
        assertEquals(LocalQwenProvider.ID, r.provider)
        runBlocking { s.warmup() }
        assertEquals(listOf("load:config.json"), b.calls)
    }

    @Test
    fun warmup_notReady_throwsNotReady() {
        val e = assertThrows(BridgeException::class.java) {
            runBlocking { QwenService(env(tmp.newFolder("m")), FakeBackend()).warmup() }
        }
        assertEquals(BridgeErrors.NOT_READY, e.code)
    }

    @Test
    fun provider_runReturnsTextResult_andDeclaresTasks() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val p = LocalQwenProvider(QwenService(env(dir), FakeBackend()))
        assertEquals("local-qwen", p.id)
        // 能力 = run 承接的四类 + 专用翻译端口；run 承接的恰好就是 SUPPORTED_TASKS
        assertEquals(AiQwenPolicy.SUPPORTED_TASKS + AiTask.TRANSLATE, p.capabilities())
        assertEquals(AiQwenPolicy.SUPPORTED_TASKS, AiRouter.runTasks(p))
        assertEquals(AiRunResult.Text("回答"), runBlocking { p.run(AiTask.REWRITE, "文") })
    }

    @Test
    fun provider_runTranslate_isBadParamsPointingToTranslate_withoutLoading() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        val p = LocalQwenProvider(QwenService(env(dir), b))
        val e = assertThrows(BridgeException::class.java) { runBlocking { p.run(AiTask.TRANSLATE, "hi") } }
        assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        assertTrue(e.message!!.contains(AiModule.METHOD_TRANSLATE))
        assertTrue(b.calls.isEmpty())
    }

    @Test
    fun provider_availability_followsFilesWhenNoStateSource() {
        val dir = tmp.newFolder("m")
        val p = LocalQwenProvider(QwenService(env(dir), FakeBackend()))
        assertEquals(AiAvailability.unavailable(AiUnavailableReason.NOT_INSTALLED), p.availability())
        assertNull(p.modelInfo())
        fillModel(dir)
        assertEquals(AiAvailability.AVAILABLE, p.availability())
    }

    @Test
    fun provider_availability_followsModelStateSourceWhenGiven() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        var installed = false
        val models = com.let188.arkli.model.ModelStateSource { ModelStateInfo(installed, 123L, false) }
        val p = LocalQwenProvider(QwenService(env(dir), FakeBackend()), models)
        // 文件齐全但清单状态说没装好（比如校验没过）：以清单为准
        assertEquals(AiAvailability.unavailable(AiUnavailableReason.NOT_INSTALLED), p.availability())
        installed = true
        assertEquals(AiAvailability.AVAILABLE, p.availability())
        assertEquals(AiModelInfo(QwenService.MODEL_ID, true, 123L, false), p.modelInfo())
    }

    @Test
    fun fingerprint_changesWithAnyRequiredFile() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val a = QwenService.fingerprint(dir)
        File(dir, "config.json").writeText("changed")
        assertTrue(a != QwenService.fingerprint(dir))
    }

    @Test
    fun bundledManifest_hasQwenEntryMatchingRequiredFiles() {
        val text = File("src/main/assets/ai/models.json").readText()
        val entry = ModelManifestParser.parse(text).find(QwenService.MODEL_ID)
        assertNotNull("随包清单要有 ${QwenService.MODEL_ID}", entry)
        assertEquals(QwenService.REQUIRED_FILES.toSet(), entry!!.files.map { it.name }.toSet())
        assertEquals(QWEN_MODEL_DIR, entry.dir)
        assertEquals(entry.files.sumOf { it.bytes }, entry.totalBytes)
        assertTrue(entry.files.all { f -> f.urls.all { it.startsWith("https://github.com/icodejoo/arkli/releases/download/qwen35-mnn-v1/") } })
        assertTrue(JSONObject(text).getJSONArray("models").length() >= 3)
    }
}
