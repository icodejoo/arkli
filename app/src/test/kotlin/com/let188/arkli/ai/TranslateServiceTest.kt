package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.model.ModelManifestParser
import com.let188.arkli.model.ModelStateInfo
import com.let188.arkli.net.NetPolicy
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** 本地翻译服务与提供者：就绪判断、懒加载、重载、结果组装、可用性判定、随包清单 */
class TranslateServiceTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 记录调用的引擎替身 */
    private class FakeBackend : TranslateBackend {
        val calls = mutableListOf<String>()
        var lastBeams = -1
        override fun load(modelDir: String) { calls += "load" }
        override fun unload() { calls += "unload" }
        override fun translate(text: String, src: String, tgt: String, numBeams: Int): TranslateOutcome {
            lastBeams = numBeams
            calls += "translate:$src>$tgt"
            return TranslateOutcome("译:$text", 7)
        }
    }

    /** 以临时目录为模型目录的环境 */
    private fun env(dir: File) = object : TranslateEnv {
        override fun modelDir() = dir
    }

    /** 写齐全部必需文件 */
    private fun fillModel(dir: File) {
        dir.mkdirs()
        TranslateService.REQUIRED_FILES.forEach { File(dir, it).writeText("x") }
    }

    /** 一个固定请求 */
    private val req = AiTranslateRequest("你好", "zh-CN", "en", null)

    @Test
    fun notReady_whenFilesMissing() {
        val dir = tmp.newFolder("m")
        val b = FakeBackend()
        val s = TranslateService(env(dir), b)
        assertFalse(s.isModelReady())
        val e = assertThrows(BridgeException::class.java) { runBlocking { s.translate(req) } }
        assertEquals(BridgeErrors.NOT_READY, e.code)
        assertTrue(b.calls.isEmpty())
    }

    @Test
    fun notReady_whenOneFileMissingOrEmpty() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val s = TranslateService(env(dir), FakeBackend())
        assertTrue(s.isModelReady())
        File(dir, "decoder_step.mnn.weight").writeText("")
        assertFalse(s.isModelReady())
        File(dir, "decoder_step.mnn.weight").delete()
        assertFalse(s.isModelReady())
    }

    @Test
    fun translate_lazyLoadsOnce_andBuildsResult() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        var t = 100L
        val s = TranslateService(env(dir), b) { t.also { t += 50 } }
        val r1 = runBlocking { s.translate(req) }
        assertEquals(TranslateResult("译:你好", 50, TranslateService.MODEL_ID, "zh-CN", "en"), r1)
        runBlocking { s.translate(AiTranslateRequest("hi", "en", "fr", 3)) }
        assertEquals(listOf("load", "translate:zh-CN>en", "translate:en>fr"), b.calls)
        assertEquals(3, b.lastBeams)
    }

    @Test
    fun translate_auto_passesThroughDetectedAndUnrecognized() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val backend = object : TranslateBackend {
            override fun load(modelDir: String) {}
            override fun unload() {}
            override fun translate(text: String, src: String, tgt: String, numBeams: Int) =
                TranslateOutcome("out", 3, listOf("fr", "zh-CN"), true)
        }
        val s = TranslateService(env(dir), backend)
        val auto = runBlocking { s.translate(AiTranslateRequest("x", "auto", "en", null)) }
        assertEquals(listOf("fr", "zh-CN"), auto.detectedSrc)
        assertTrue(auto.unrecognized)
        assertEquals("auto", auto.src)
        // 非 auto：契约恒为 [src] / false，不看后端回传
        val fixed = runBlocking { s.translate(AiTranslateRequest("x", "fr", "en", null)) }
        assertEquals(listOf("fr"), fixed.detectedSrc)
        assertFalse(fixed.unrecognized)
    }

    @Test
    fun translate_nullBeams_passesZeroForModelDefault() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        runBlocking { TranslateService(env(dir), b).translate(req) }
        assertEquals(0, b.lastBeams)
    }

    @Test
    fun translate_reloadsWhenModelFileChanges() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        val s = TranslateService(env(dir), b)
        runBlocking { s.translate(req) }
        File(dir, "encoder.mnn").writeText("longer content")
        runBlocking { s.translate(req) }
        assertEquals(listOf("load", "translate:zh-CN>en", "unload", "load", "translate:zh-CN>en"), b.calls)
    }

    @Test
    fun unload_thenTranslate_loadsAgain() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        val s = TranslateService(env(dir), b)
        runBlocking { s.translate(req) }
        runBlocking { s.unload() }
        runBlocking { s.translate(req) }
        assertEquals(listOf("load", "translate:zh-CN>en", "unload", "load", "translate:zh-CN>en"), b.calls)
    }

    @Test
    fun warmup_loadsWithoutTranslating_andIsIdempotent() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val b = FakeBackend()
        val s = TranslateService(env(dir), b)
        val r1 = runBlocking { s.warmup() }
        runBlocking { s.warmup() }
        assertEquals(LocalNllbProvider.ID, r1.provider)
        assertEquals(listOf("load"), b.calls)
        // 预热后首句翻译不再加载
        runBlocking { s.translate(req) }
        assertEquals(listOf("load", "translate:zh-CN>en"), b.calls)
    }

    @Test
    fun warmup_notReady_whenFilesMissing() {
        val b = FakeBackend()
        val s = TranslateService(env(tmp.newFolder("m")), b)
        val e = assertThrows(BridgeException::class.java) { runBlocking { s.warmup() } }
        assertEquals(BridgeErrors.NOT_READY, e.code)
        assertTrue(b.calls.isEmpty())
    }

    @Test
    fun warmup_cancelledDuringLoad_unloadsAndLeavesNothingLoaded() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        lateinit var job: kotlinx.coroutines.Job
        val b = object : TranslateBackend {
            val calls = mutableListOf<String>()
            override fun load(modelDir: String) {
                calls += "load"
                job.cancel() // 模拟加载进行中被取消
            }
            override fun unload() { calls += "unload" }
            override fun translate(text: String, src: String, tgt: String, numBeams: Int) = TranslateOutcome("x", 1)
        }
        val s = TranslateService(env(dir), b)
        runBlocking {
            job = launch(start = kotlinx.coroutines.CoroutineStart.LAZY) { s.warmup() }
            job.start()
            job.join()
        }
        assertEquals(listOf("load", "unload"), b.calls)
        // 状态已清：下一次翻译会重新加载
        runBlocking { s.translate(req) }
        assertEquals(listOf("load", "unload", "load"), b.calls)
    }

    @Test
    fun unload_returnsWhetherWasLoaded() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val s = TranslateService(env(dir), FakeBackend())
        assertFalse(runBlocking { s.unload() })
        runBlocking { s.warmup() }
        assertTrue(runBlocking { s.unload() })
        assertFalse(runBlocking { s.unload() })
    }

    @Test
    fun fingerprint_changesWithFileLength() {
        val dir = tmp.newFolder("m")
        fillModel(dir)
        val a = TranslateService.fingerprint(dir)
        File(dir, "tokenizer.json").writeText("xxxxxxxx")
        assertNotEquals(a, TranslateService.fingerprint(dir))
    }

    @Test
    fun provider_availability_followsModelStateSource() {
        val dir = tmp.newFolder("m")
        val svc = TranslateService(env(dir), FakeBackend())
        var info = ModelStateInfo(false, 0, false)
        val p = LocalNllbProvider(svc) { id -> if (id == TranslateService.MODEL_ID) info else ModelStateInfo(false, 0, false) }
        assertEquals(setOf(AiTask.TRANSLATE), p.capabilities())
        assertEquals(AiAvailability.unavailable(AiUnavailableReason.NOT_INSTALLED), p.availability())
        info = ModelStateInfo(true, 404_501_627, false)
        assertEquals(AiAvailability.AVAILABLE, p.availability())
        assertEquals(AiModelInfo(TranslateService.MODEL_ID, true, 404_501_627, false), p.modelInfo())
        info = ModelStateInfo(false, 1000, true)
        assertEquals(AiModelInfo(TranslateService.MODEL_ID, false, 1000, true), p.modelInfo())
    }

    @Test
    fun provider_withoutModelSource_usesFiles_andHasNoModelInfo() {
        val dir = tmp.newFolder("m")
        val p = LocalNllbProvider(TranslateService(env(dir), FakeBackend()))
        assertEquals(AiUnavailableReason.NOT_INSTALLED, p.availability().reason)
        assertNull(p.modelInfo())
        fillModel(dir)
        assertTrue(p.availability().available)
    }

    @Test
    fun provider_textRun_isBadParams() {
        val p = LocalNllbProvider(TranslateService(env(tmp.newFolder("m")), FakeBackend()))
        val e = assertThrows(BridgeException::class.java) { runBlocking { p.run(AiTask.TRANSLATE, "hi") } }
        assertEquals(BridgeErrors.BAD_PARAMS, e.code)
    }

    @Test
    fun provider_inProvidersJson_carriesModelFields() {
        val svc = TranslateService(env(tmp.newFolder("m")), FakeBackend())
        val p = LocalNllbProvider(svc) { ModelStateInfo(false, 0, true) }
        val o: JSONObject = AiPolicy.providerJson(p)
        assertEquals("local-nllb", o.getString("id"))
        assertFalse(o.getBoolean("available"))
        assertEquals("not_installed", o.getString("reason"))
        assertEquals(TranslateService.MODEL_ID, o.getString("modelId"))
        assertTrue(o.getBoolean("downloading"))
        assertEquals("translate", o.getJSONArray("tasks").getString(0))
    }

    @Test
    fun shippedManifest_hasNllbEntryMatchingConvention() {
        val m = ModelManifestParser.parse(File("src/main/assets/ai/models.json").readText())
        val e = m.find(TranslateService.MODEL_ID)
        assertNotNull(e)
        assertEquals(TRANSLATE_MODEL_DIR, e!!.dir)
        assertEquals("cc-by-nc-4.0", e.license)
        assertEquals(TranslateService.REQUIRED_FILES.toSet(), e.files.map { it.name }.toSet())
        assertEquals(392_177_035L, e.totalBytes)
        assertEquals(e.totalBytes, e.files.sumOf { it.bytes })
        assertEquals(
            "09e231235a3938d40c86d7a9bcb09db096669c927613c036f4b2f1a44e838f5d",
            e.files.first { it.name == "decoder_step.mnn" }.sha256,
        )
        // model.json 的 num_beams 已改 1 并重新登记（待用户上传的就是这一份）
        assertEquals(
            "1db584251cde24fc8570f393f019ede6e7c6d58225b40ed0e71c330e16a14d36",
            e.files.first { it.name == "model.json" }.sha256,
        )
        assertTrue(e.files.all { f -> f.urls.all { NetPolicy.isAllowedDownload(it) } })
    }

    @Test
    fun requiredFiles_areMnnSplitSet_noOnnx() {
        val f = TranslateService.REQUIRED_FILES
        assertEquals(12, f.size)
        assertEquals(f.size, f.toSet().size)
        assertTrue(f.containsAll(listOf("encoder.mnn", "cross_kv.mnn", "decoder_step.mnn", "embed.i8", "embed.scale", "model.json")))
        assertTrue(f.none { it.endsWith(".onnx") || it.endsWith(".onnx_data") })
        assertEquals("nllb600m-un6-mnn-w6", TranslateService.MODEL_ID)
        assertEquals("models/nllb600m-un6-mnn-w6", TRANSLATE_MODEL_DIR)
    }

    @Test
    fun translate_withoutModel_throwsNotReady() {
        val s = TranslateService(env(tmp.newFolder("empty")), FakeBackend())
        val e = assertThrows(BridgeException::class.java) { runBlocking { s.translate(req) } }
        assertEquals(BridgeErrors.NOT_READY, e.code)
    }

    @Test
    fun shippedManifest_keepsOldOnnxEntry_notRetired() {
        val m = ModelManifestParser.parse(File("src/main/assets/ai/models.json").readText())
        val old = m.find("nllb600m-un6-ccm-int4")
        assertNotNull(old)
        assertTrue(old!!.displayName.contains("旧 ONNX 版"))
        assertTrue(m.retired.none { it.id == "nllb600m-un6-ccm-int4" })
    }
}
