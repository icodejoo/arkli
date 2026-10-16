package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.image.CodecImage
import com.let188.arkli.image.ImageCodec
import com.let188.arkli.image.OutFormat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/** 识物服务：模型就绪判断、懒加载、重载、结果组装、重任务互斥 */
class ClipServiceTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 最小词表 JSON */
    private val vocabJson = """
        {"format":1,"note":"草稿","dtype":"f16le","dim":2,"count":1,"categories":{"R":"可回收物"},
         "items":[{"id":"a","nameZh":"甲","nameEn":"a","category":"R"}]}
    """.trimIndent()

    /** 记录调用的引擎替身 */
    private class FakeBackend : ClipBackend {
        val calls = mutableListOf<String>()
        var lastSize: Pair<Int, Int>? = null
        var lastRgbLen = 0
        override fun load(modelPath: String) { calls += "load:${File(modelPath).name}" }
        override fun unload() { calls += "unload" }
        override fun setVocab(meta: ClipVocabMeta, vectorsF16le: ByteArray) { calls += "vocab:${meta.items.size}" }
        override fun classify(width: Int, height: Int, rgb: ByteArray, topK: Int): ClassifyOutcome {
            lastSize = width to height
            lastRgbLen = rgb.size
            calls += "classify:$topK"
            return ClassifyOutcome(listOf(ClassifyHit(0, 0.5f)), listOf(CategoryProb("R", 1f)), 1f, false)
        }
    }

    /** 固定尺寸的解码替身 */
    private class FakeCodec(val w: Int = 2, val h: Int = 3) : ImageCodec {
        var closed = false
        override fun decode(file: File, maxEdge: Int?): CodecImage = object : CodecImage {
            override val width = w
            override val height = h
            override fun toArgb() = IntArray(w * h) { 0xFF000000.toInt() }
            override fun close() { closed = true }
        }
        override fun scale(src: CodecImage, width: Int, height: Int): CodecImage = src
        override fun encodeLossy(img: CodecImage, format: OutFormat, quality: Int) = ByteArray(0)
    }

    /** 文件环境替身 */
    private fun env(model: File) = object : ClipEnv {
        override fun modelFile() = model
        override fun readVocabJson() = vocabJson
        override fun readVocabVectors() = ByteArray(1 * 2 * 2)
    }

    @Test
    fun warmup_loadsVocabAndModel_idempotent_thenClassifyDoesNotReload() {
        val model = tmp.newFile("m.mnn").apply { writeText("x") }
        val b = FakeBackend()
        val svc = ClipService(env(model), b, FakeCodec())
        val r = runBlocking { svc.warmup() }
        runBlocking { svc.warmup() }
        assertEquals(LocalClipProvider.ID, r.provider)
        assertEquals(listOf("vocab:1", "load:m.mnn"), b.calls)
        runBlocking { svc.classify(File("x.jpg"), 3) }
        assertEquals(listOf("vocab:1", "load:m.mnn", "classify:3"), b.calls)
    }

    @Test
    fun warmup_notReady_andUnloadReportsWhetherLoaded() {
        val missing = ClipService(env(File(tmp.root, "nope.mnn")), FakeBackend(), FakeCodec())
        val e = assertThrows(BridgeException::class.java) { runBlocking { missing.warmup() } }
        assertEquals(BridgeErrors.NOT_READY, e.code)
        val model = tmp.newFile("m2.mnn").apply { writeText("x") }
        val svc = ClipService(env(model), FakeBackend(), FakeCodec())
        assertFalse(runBlocking { svc.unload() })
        runBlocking { svc.warmup() }
        assertTrue(runBlocking { svc.unload() })
    }

    @Test
    fun notReady_whenModelMissing() {
        val svc = ClipService(env(File(tmp.root, "nope.mnn")), FakeBackend(), FakeCodec())
        assertFalse(svc.isModelReady())
        val e = assertThrows(BridgeException::class.java) { runBlocking { svc.classify(File("x.jpg"), 3) } }
        assertEquals(BridgeErrors.NOT_READY, e.code)
    }

    @Test
    fun notReady_whenModelEmpty() {
        val m = tmp.newFile("empty.mnn")
        assertFalse(ClipService(env(m), FakeBackend(), FakeCodec()).isModelReady())
    }

    @Test
    fun classify_loadsLazilyOnceAndBuildsResult() {
        val m = tmp.newFile("model.mnn").apply { writeText("x") }
        val be = FakeBackend()
        val codec = FakeCodec(2, 3)
        var t = 0L
        val svc = ClipService(env(m), be, codec) { t += 10; t }
        assertTrue(svc.isModelReady())
        val r1 = runBlocking { svc.classify(File("a.jpg"), 3) }
        runBlocking { svc.classify(File("b.jpg"), 2) }
        // 词表与模型各只加载一次
        assertEquals(listOf("vocab:1", "load:model.mnn", "classify:3", "classify:2"), be.calls)
        assertEquals(2 to 3, be.lastSize)
        assertEquals(2 * 3 * 3, be.lastRgbLen)
        assertTrue(codec.closed)
        assertEquals(ClipService.MODEL_ID, r1.modelId)
        // 时钟每次 +10：t0=10，t1=20，t2=30
        assertEquals(20L, r1.elapsedMs)
        assertEquals(10L, r1.inferMs)
        assertEquals("a", r1.vocab.items[0].id)
    }

    @Test
    fun classify_reloadsWhenModelReplaced() {
        val m = tmp.newFile("model.mnn").apply { writeText("x") }
        val be = FakeBackend()
        val svc = ClipService(env(m), be, FakeCodec())
        runBlocking { svc.classify(File("a.jpg"), 1) }
        m.writeText("长度变了")
        runBlocking { svc.classify(File("a.jpg"), 1) }
        assertEquals(listOf("vocab:1", "load:model.mnn", "classify:1", "unload", "load:model.mnn", "classify:1"), be.calls)
    }

    @Test
    fun classify_brokenVocabIsInternal() {
        val m = tmp.newFile("model.mnn").apply { writeText("x") }
        val bad = object : ClipEnv {
            override fun modelFile() = m
            override fun readVocabJson() = vocabJson
            override fun readVocabVectors() = ByteArray(3)
        }
        val e = assertThrows(BridgeException::class.java) {
            runBlocking { ClipService(bad, FakeBackend(), FakeCodec()).classify(File("a.jpg"), 1) }
        }
        assertEquals(BridgeErrors.INTERNAL, e.code)
    }

    @Test
    fun heavyGate_serializesTasks() {
        val running = AtomicInteger(0)
        val maxSeen = AtomicInteger(0)
        runBlocking {
            (1..5).map {
                async(Dispatchers.Default) {
                    AiHeavyGate.run {
                        val n = running.incrementAndGet()
                        maxSeen.updateAndGet { m -> maxOf(m, n) }
                        delay(20)
                        running.decrementAndGet()
                    }
                }
            }.awaitAll()
        }
        assertEquals(1, maxSeen.get())
    }

    @Test
    fun provider_availabilityFollowsModel() {
        val m = File(tmp.root, "model.mnn")
        val p = LocalClipProvider(ClipService(env(m), FakeBackend(), FakeCodec()))
        assertEquals(setOf(AiTask.CLASSIFY_IMAGE), p.capabilities())
        assertEquals(AiAvailability.unavailable(AiUnavailableReason.NOT_INSTALLED), p.availability())
        m.writeText("x")
        assertTrue(p.availability().available)
        assertEquals("local-clip", p.id)
        val e = assertThrows(BridgeException::class.java) { runBlocking { p.run(AiTask.TRANSLATE, "hi") } }
        assertEquals(BridgeErrors.BAD_PARAMS, e.code)
    }

    @Test
    fun providersJson_listsLocalClip() {
        val m = File(tmp.root, "model.mnn")
        val p = LocalClipProvider(ClipService(env(m), FakeBackend(), FakeCodec()))
        val down = AiPolicy.providersJson(listOf(p))
        assertEquals("not_installed", down.getJSONArray("providers").getJSONObject(0).getString("reason"))
        assertEquals(0, down.getJSONArray("capabilities").length())
        m.writeText("x")
        val up = AiPolicy.providersJson(listOf(p))
        assertEquals("classifyImage", up.getJSONArray("capabilities").getString(0))
    }
}
