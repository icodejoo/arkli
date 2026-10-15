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
        var lastMax = -1
        override fun load(configPath: String) { calls += "load:${File(configPath).name}" }
        override fun unload() { calls += "unload" }
        override fun generate(prompt: String, maxNewTokens: Int): String {
            lastPrompt = prompt
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
    fun run_buildsPromptByTask() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        val s = QwenService(env(dir), b)
        runBlocking { s.run(AiTask.SUMMARIZE, "长文") }
        assertEquals(AiQwenPolicy.buildPrompt(AiTask.SUMMARIZE, "长文"), b.lastPrompt)
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
        assertEquals(AiQwenPolicy.SUPPORTED_TASKS, p.capabilities())
        assertEquals(AiRunResult.Text("回答"), runBlocking { p.run(AiTask.REWRITE, "文") })
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
