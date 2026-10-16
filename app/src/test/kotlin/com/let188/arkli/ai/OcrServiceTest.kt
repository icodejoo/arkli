package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.image.CodecImage
import com.let188.arkli.image.ImageCodec
import com.let188.arkli.image.OutFormat
import com.let188.arkli.model.ModelStateInfo
import com.let188.arkli.model.ModelStateSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** 文字识别服务：就绪判断、懒加载一次、指纹变化重载、尺寸收敛、取消打断、提供者可用性 */
class OcrServiceTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 一行固定的识别结果 */
    private fun outcome(w: Int, h: Int) =
        OcrOutcome(w, h, listOf(OcrLine(listOf(OcrPoint(0f, 0f), OcrPoint(1f, 0f), OcrPoint(1f, 1f), OcrPoint(0f, 1f)), "字", 0.9f)), 5)

    /** 记录调用的引擎替身；[block] 为真时 recognize 一直阻塞到 cancel 被调用 */
    private class FakeBackend(val block: Boolean = false) : OcrBackend {
        val calls = mutableListOf<String>()
        var lastSize: Pair<Int, Int>? = null
        var lastRgbLen = 0
        val started = CountDownLatch(1)
        private val cancelled = CountDownLatch(1)

        @Volatile
        var cancelCalled = false
        override fun load(modelDir: String) { calls += "load" }
        override fun unload() { calls += "unload" }
        override fun cancel() {
            cancelCalled = true
            cancelled.countDown()
        }

        override fun recognize(width: Int, height: Int, rgb: ByteArray): OcrOutcome {
            lastSize = width to height
            lastRgbLen = rgb.size
            calls += "recognize"
            if (block) {
                started.countDown()
                if (!cancelled.await(5, TimeUnit.SECONDS)) error("超时没等到取消")
                throw CancellationException("识别已取消")
            }
            return OcrOutcome(width, height, emptyList(), 1)
        }
    }

    /** 固定尺寸的解码替身，记录缩放与关闭次数 */
    private class FakeCodec(val w: Int = 2, val h: Int = 3) : ImageCodec {
        var scaledTo: Pair<Int, Int>? = null
        var closed = 0
        private fun img(w: Int, h: Int) = object : CodecImage {
            override val width = w
            override val height = h
            override fun toArgb() = IntArray(w * h) { 0xFF000000.toInt() }
            override fun close() { closed++ }
        }

        override fun decode(file: File, maxEdge: Int?): CodecImage = img(w, h)
        override fun scale(src: CodecImage, width: Int, height: Int): CodecImage {
            scaledTo = width to height
            return img(width, height)
        }

        override fun encodeLossy(img: CodecImage, format: OutFormat, quality: Int) = ByteArray(0)
    }

    /** 建一个必需文件齐全的模型目录 */
    private fun fullDir(): File = tmp.newFolder().also { d -> OcrService.REQUIRED_FILES.forEach { File(d, it).writeText("x") } }

    /** 指向 [dir] 的文件环境 */
    private fun env(dir: File) = object : OcrEnv { override fun modelDir() = dir }

    @Test
    fun missingFiles_isNotReady_andRecognizeThrowsNotReady() {
        val dir = fullDir()
        File(dir, "rec.mnn").delete()
        val svc = OcrService(env(dir), FakeBackend(), FakeCodec())
        assertFalse(svc.isModelReady())
        val e = assertThrows(BridgeException::class.java) { runBlocking { svc.recognize(File("a.jpg")) } }
        assertEquals(BridgeErrors.NOT_READY, e.code)
        assertEquals(BridgeErrors.NOT_READY, assertThrows(BridgeException::class.java) { runBlocking { svc.warmup() } }.code)
    }

    @Test
    fun emptyFile_countsAsMissing() {
        val dir = fullDir()
        File(dir, "ppocr_keys.txt").writeText("")
        assertFalse(OcrService(env(dir), FakeBackend(), FakeCodec()).isModelReady())
    }

    @Test
    fun loadsOnce_lazily_andReusesSession() {
        val b = FakeBackend()
        val svc = OcrService(env(fullDir()), b, FakeCodec())
        assertEquals(emptyList<String>(), b.calls)
        runBlocking { svc.recognize(File("a.jpg")) }
        runBlocking { svc.recognize(File("a.jpg")) }
        assertEquals(listOf("load", "recognize", "recognize"), b.calls)
        // 预热已加载则不再加载
        val r = runBlocking { svc.warmup() }
        assertEquals(LocalOcrProvider.ID, r.provider)
        assertEquals(listOf("load", "recognize", "recognize"), b.calls)
    }

    @Test
    fun warmup_thenRecognizeDoesNotReload_andUnloadReportsWhetherLoaded() {
        val b = FakeBackend()
        val svc = OcrService(env(fullDir()), b, FakeCodec())
        assertFalse(runBlocking { svc.unload() })
        runBlocking { svc.warmup() }
        runBlocking { svc.recognize(File("a.jpg")) }
        assertEquals(listOf("unload", "load", "recognize"), b.calls)
        assertTrue(runBlocking { svc.unload() })
        // 卸载后再识别会重新加载
        runBlocking { svc.recognize(File("a.jpg")) }
        assertEquals(listOf("unload", "load", "recognize", "unload", "load", "recognize"), b.calls)
    }

    @Test
    fun fingerprintChange_unloadsOldThenReloads() {
        val dir = fullDir()
        val b = FakeBackend()
        val svc = OcrService(env(dir), b, FakeCodec())
        runBlocking { svc.recognize(File("a.jpg")) }
        // 模型被替换（长度变了）
        File(dir, "det.mnn").writeText("changed-longer")
        runBlocking { svc.recognize(File("a.jpg")) }
        assertEquals(listOf("load", "recognize", "unload", "load", "recognize"), b.calls)
    }

    @Test
    fun bigImage_isScaledToFitAndRgbMatchesSize_allImagesClosed() {
        val b = FakeBackend()
        val codec = FakeCodec(w = 8192, h = 4096)
        val svc = OcrService(env(fullDir()), b, codec)
        val r = runBlocking { svc.recognize(File("a.jpg")) }
        assertEquals(4096 to 2048, codec.scaledTo)
        assertEquals(4096 to 2048, b.lastSize)
        assertEquals(4096 * 2048 * 3, b.lastRgbLen)
        assertEquals(4096, r.outcome.width)
        assertEquals(OcrService.MODEL_ID, r.modelId)
        assertEquals(2, codec.closed)
    }

    @Test
    fun normalImage_isNotScaled() {
        val b = FakeBackend()
        val codec = FakeCodec(w = 1080, h = 2400)
        runBlocking { OcrService(env(fullDir()), b, codec).recognize(File("a.jpg")) }
        assertEquals(null, codec.scaledTo)
        assertEquals(1080 to 2400, b.lastSize)
        assertEquals(1, codec.closed)
    }

    @Test
    fun cancellingTheCoroutine_interruptsBackend() {
        val b = FakeBackend(block = true)
        val svc = OcrService(env(fullDir()), b, FakeCodec())
        runBlocking {
            val job = launch(Dispatchers.Default, start = CoroutineStart.DEFAULT) { svc.recognize(File("a.jpg")) }
            assertTrue("识别应已开始", b.started.await(5, TimeUnit.SECONDS))
            withTimeout(5_000) { job.cancelAndJoin() }
            assertTrue(job.isCancelled)
        }
        assertTrue("取消应传到引擎", b.cancelCalled)
    }

    @Test
    fun normalFinish_doesNotCallCancel() {
        val b = FakeBackend()
        runBlocking { OcrService(env(fullDir()), b, FakeCodec()).recognize(File("a.jpg")) }
        assertFalse(b.cancelCalled)
    }

    @Test
    fun heavyGate_serializesConcurrentRecognize() {
        val b = FakeBackend()
        val svc = OcrService(env(fullDir()), b, FakeCodec())
        runBlocking {
            val all = (1..3).map { async(Dispatchers.Default) { svc.recognize(File("a.jpg")) } }
            all.forEach { it.await() }
        }
        // 只加载一次，三次识别各一次
        assertEquals(1, b.calls.count { it == "load" })
        assertEquals(3, b.calls.count { it == "recognize" })
    }

    @Test
    fun provider_availabilityFollowsModelState_orFilesWhenNoSource() {
        val dir = fullDir()
        val svc = OcrService(env(dir), FakeBackend(), FakeCodec())
        assertTrue(LocalOcrProvider(svc).availability().available)
        assertEquals(null, LocalOcrProvider(svc).modelInfo())
        // 有状态来源时以“已安装且校验过”为准，文件齐也不算
        val notInstalled = LocalOcrProvider(svc, ModelStateSource { ModelStateInfo(installed = false, diskBytes = 3, downloading = true) })
        assertEquals(AiUnavailableReason.NOT_INSTALLED, notInstalled.availability().reason)
        val info = notInstalled.modelInfo()!!
        assertEquals(OcrService.MODEL_ID, info.modelId)
        assertTrue(info.downloading)
        val installed = LocalOcrProvider(svc, ModelStateSource { ModelStateInfo(installed = true, diskBytes = 9, downloading = false) })
        assertTrue(installed.availability().available)
        assertEquals(OcrService.MODEL_ID, installed.sessionModelId)
        assertEquals(AiLayer.L1, installed.layer)
    }

    @Test
    fun provider_runIsRejected_andModelIdMatchesManifest() {
        val p = LocalOcrProvider(OcrService(env(fullDir()), FakeBackend(), FakeCodec()))
        val e = assertThrows(BridgeException::class.java) { runBlocking { p.run(AiTask.OCR, "x") } }
        assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        assertTrue(e.message.orEmpty().contains(AiModule.METHOD_OCR))
        // 清单里的 id 与必需文件逐一对上（models.json 随包，测试里直接读源码树）
        val manifest = File("src/main/assets/ai/models.json").readText()
        assertTrue(manifest.contains("\"id\": \"${OcrService.MODEL_ID}\""))
        OcrService.REQUIRED_FILES.forEach { assertTrue("清单缺 $it", manifest.contains("\"name\": \"$it\"")) }
        assertTrue(manifest.contains("\"dir\": \"$OCR_MODEL_DIR\""))
    }
}
