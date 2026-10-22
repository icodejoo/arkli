package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.image.CodecImage
import com.let188.arkli.image.ImageCodec
import com.let188.arkli.image.OutFormat
import com.let188.arkli.image.Samples
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

/** 抠图服务：就绪判断、懒加载一次、指纹重载、尺寸收敛、透明 PNG 合成、取消打断与取消后可再跑、提供者可用性 */
class MattingServiceTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** PNG 文件头 */
    private val pngSignature = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)

    /** 替身给出的前景色（与 [FakeCodec] 的原图颜色 0x336699 故意不同） */
    private companion object {
        val FG_BYTES = byteArrayOf(0x11, 0x22, 0x33)
    }

    /** 记录调用的引擎替身：alpha 全为 [alpha]；[block] 为真时 matte 一直阻塞到 cancel 被调用 */
    private class FakeBackend(val block: Boolean = false, val alpha: Int = 200) : MattingBackend {
        val calls = mutableListOf<String>()
        var lastSize: Pair<Int, Int>? = null
        var lastRgbLen = 0
        var lastRefine: MattingRefine? = null
        var loadedPath: String? = null
        val started = CountDownLatch(1)
        private val cancelled = CountDownLatch(1)

        @Volatile
        var cancelCalled = false

        /** 只让第一次 matte 阻塞：用来验证“取消后下一次调用能正常跑” */
        @Volatile
        var blockOnce = false
        override fun load(modelPath: String) {
            calls += "load"
            loadedPath = modelPath
        }

        override fun unload() { calls += "unload" }
        override fun cancel() {
            cancelCalled = true
            cancelled.countDown()
        }

        override fun matte(width: Int, height: Int, rgb: ByteArray, refine: MattingRefine): MattingOutcome {
            lastSize = width to height
            lastRefine = refine
            lastRgbLen = rgb.size
            calls += "matte"
            if (block || blockOnce) {
                blockOnce = false
                started.countDown()
                if (!cancelled.await(5, TimeUnit.SECONDS)) error("超时没等到取消")
                throw CancellationException("抠图已取消")
            }
            val fg = ByteArray(width * height * 3) { FG_BYTES[it % 3] }
            return MattingOutcome(width, height, ByteArray(width * height) { alpha.toByte() }, fg, 1, refineMs = 7)
        }
    }

    /** 固定尺寸的解码替身，记录缩放与关闭次数；[srcAlpha] 是原图的透明度 */
    private class FakeCodec(val w: Int = 2, val h: Int = 3, val srcAlpha: Int = 255) : ImageCodec {
        var scaledTo: Pair<Int, Int>? = null
        var closed = 0
        private fun img(w: Int, h: Int) = object : CodecImage {
            override val width = w
            override val height = h
            override fun toArgb() = IntArray(w * h) { (srcAlpha shl 24) or 0x336699 }
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
    private fun fullDir(mode: MattingMode = MattingMode.PORTRAIT): File =
        tmp.newFolder().also { d -> MattingService.requiredFilesOf(mode).forEach { File(d, it).writeText("x") } }

    /** 指向 [dir] 的文件环境，成品写进 [out] */
    private fun env(dir: File, out: File = tmp.newFolder()) = object : MattingEnv {
        override fun modelDir() = dir
        override fun outDir() = out
        override fun pagePath(file: File) = "cache/out/${file.name}"
    }

    /** 造服务 */
    private fun service(dir: File, b: FakeBackend, codec: FakeCodec = FakeCodec(), mode: MattingMode = MattingMode.PORTRAIT, out: File = tmp.newFolder()) =
        MattingService(mode, env(dir, out), b, codec)

    @Test
    fun missingFiles_isNotReady_andMatteThrowsNotReady() {
        val dir = fullDir()
        File(dir, MattingMode.PORTRAIT.modelFile).delete()
        val svc = service(dir, FakeBackend())
        assertFalse(svc.isModelReady())
        val e = assertThrows(BridgeException::class.java) { runBlocking { svc.matte(File("a.jpg")) } }
        assertEquals(BridgeErrors.NOT_READY, e.code)
        assertEquals(BridgeErrors.NOT_READY, assertThrows(BridgeException::class.java) { runBlocking { svc.warmup() } }.code)
    }

    @Test
    fun emptyFile_countsAsMissing() {
        val dir = fullDir()
        File(dir, "NOTICE.txt").writeText("")
        assertFalse(service(dir, FakeBackend()).isModelReady())
    }

    @Test
    fun loadsOnce_lazily_withTheModeModelFile() {
        val b = FakeBackend()
        val dir = fullDir(MattingMode.GENERAL)
        val svc = service(dir, b, mode = MattingMode.GENERAL)
        assertEquals(emptyList<String>(), b.calls)
        runBlocking { svc.matte(File("a.jpg")) }
        runBlocking { svc.matte(File("a.jpg")) }
        assertEquals(listOf("load", "matte", "matte"), b.calls)
        assertEquals(File(dir, "u2netp_f16.mnn").path, b.loadedPath)
        val r = runBlocking { svc.warmup() }
        assertEquals(MattingMode.GENERAL.providerId, r.provider)
        assertEquals(listOf("load", "matte", "matte"), b.calls)
    }

    @Test
    fun experimentalModes_requireTheirOwnFiles() {
        assertEquals(listOf("ppmattingv2_w8.mnn", "NOTICE.txt", "LICENSE-Apache-2.0.txt"), MattingService.requiredFilesOf(MattingMode.PPMATTING))
        // 外置权重的模式把 .weight 列入必需文件，整包模式不列
        assertEquals(listOf("birefnet_lite512_w8.mnn", "birefnet_lite512_w8.mnn.weight", "NOTICE.txt", "LICENSE-MIT.txt"), MattingService.requiredFilesOf(MattingMode.BIREFNET))
        assertEquals(listOf("modnet512_fp32.mnn", "modnet512_fp32.mnn.weight", "NOTICE.txt", "LICENSE-Apache-2.0.txt"), MattingService.requiredFilesOf(MattingMode.PORTRAIT))
        assertEquals(listOf("u2netp_f16.mnn", "NOTICE.txt", "LICENSE-Apache-2.0.txt"), MattingService.requiredFilesOf(MattingMode.GENERAL))
        assertTrue(service(fullDir(MattingMode.BIREFNET), FakeBackend(), mode = MattingMode.BIREFNET).isModelReady())
        assertFalse(service(fullDir(MattingMode.PPMATTING), FakeBackend(), mode = MattingMode.BIREFNET).isModelReady())
    }

    @Test
    fun warmup_thenMatteDoesNotReload_andUnloadReportsWhetherLoaded() {
        val b = FakeBackend()
        val svc = service(fullDir(), b)
        assertFalse(runBlocking { svc.unload() })
        runBlocking { svc.warmup() }
        runBlocking { svc.matte(File("a.jpg")) }
        assertEquals(listOf("unload", "load", "matte"), b.calls)
        assertTrue(runBlocking { svc.unload() })
        runBlocking { svc.matte(File("a.jpg")) }
        assertEquals(listOf("unload", "load", "matte", "unload", "load", "matte"), b.calls)
    }

    @Test
    fun fingerprintChange_unloadsOldThenReloads() {
        val dir = fullDir()
        val b = FakeBackend()
        val svc = service(dir, b)
        runBlocking { svc.matte(File("a.jpg")) }
        File(dir, MattingMode.PORTRAIT.modelFile).writeText("changed-longer")
        runBlocking { svc.matte(File("a.jpg")) }
        assertEquals(listOf("load", "matte", "unload", "load", "matte"), b.calls)
    }

    @Test
    fun bigImage_isScaledToFit_rgbMatchesSize_allImagesClosed() {
        val b = FakeBackend()
        val codec = FakeCodec(w = 6144, h = 3072)
        val r = runBlocking { service(fullDir(), b, codec).matte(File("a.jpg")) }
        assertEquals(3072 to 1536, codec.scaledTo)
        assertEquals(3072 to 1536, b.lastSize)
        assertEquals(3072 * 1536 * 3, b.lastRgbLen)
        assertEquals(3072, r.width)
        assertEquals(1536, r.height)
        assertEquals(2, codec.closed)
    }

    @Test
    fun normalImage_isNotScaled() {
        val b = FakeBackend()
        val codec = FakeCodec(w = 1080, h = 2400)
        runBlocking { service(fullDir(), b, codec).matte(File("a.jpg")) }
        assertEquals(null, codec.scaledTo)
        assertEquals(1080 to 2400, b.lastSize)
        assertEquals(1, codec.closed)
    }

    @Test
    fun result_isTransparentPng_withAlphaMultipliedIntoPixels_andPagePath() {
        val out = tmp.newFolder()
        val r = runBlocking { service(fullDir(), FakeBackend(alpha = 100), FakeCodec(2, 3), out = out).matte(File("a.jpg")) }
        assertEquals(2, r.width)
        assertEquals(3, r.height)
        assertEquals(MattingMode.PORTRAIT.modelId, r.modelId)
        assertTrue(r.path.startsWith("cache/out/matting_portrait_") && r.path.endsWith(".png"))
        val f = File(out, r.path.substringAfterLast('/'))
        assertTrue(f.isFile)
        val bytes = f.readBytes()
        assertEquals(pngSignature.toList(), bytes.take(4))
        // IHDR：颜色类型 6 = RGBA（有半透明像素，不会被压成 RGB）
        assertEquals(6, bytes[25].toInt())
        // 目录里不留 .part
        assertEquals(listOf(f.name), out.list()!!.toList())
    }

    @Test
    fun resultPixels_useForegroundColorFromEngine_notSourcePixels() {
        val out = tmp.newFolder()
        val b = FakeBackend(alpha = 100)
        val r = runBlocking { service(fullDir(), b, FakeCodec(2, 1), out = out).matte(File("a.jpg")) }
        val (w, h, px) = Samples.readBack(File(out, r.path.substringAfterLast('/')).readBytes())
        assertEquals(2 to 1, w to h)
        // 原图是 0x336699，输出必须是引擎给的前景色 0x112233，alpha 为 100
        px.forEach { assertEquals(0x64112233, it) }
    }

    @Test
    fun refineStrength_defaultsToStrong_andRefineMsIsReported() {
        val b = FakeBackend()
        val r = runBlocking { service(fullDir(), b).matte(File("a.jpg")) }
        assertEquals(MattingRefine.STRONG, b.lastRefine)
        assertEquals(7L, r.refineMs)
    }

    @Test
    fun refineStrength_allTiersReachBackend() {
        val b = FakeBackend()
        val svc = service(fullDir(), b)
        MattingRefine.values().forEach { refine ->
            runBlocking { svc.matte(File("a.jpg"), refine) }
            assertEquals(refine, b.lastRefine)
        }
    }

    @Test
    fun badForegroundLength_isInternalError() {
        val bad = object : MattingBackend {
            override fun load(modelPath: String) {}
            override fun unload() {}
            override fun cancel() {}
            override fun matte(width: Int, height: Int, rgb: ByteArray, refine: MattingRefine) =
                MattingOutcome(width, height, ByteArray(width * height), ByteArray(2), 1)
        }
        val svc = MattingService(MattingMode.PORTRAIT, env(fullDir()), bad, FakeCodec())
        assertEquals(BridgeErrors.INTERNAL, assertThrows(BridgeException::class.java) { runBlocking { svc.matte(File("a.jpg")) } }.code)
    }

    @Test
    fun sourceAlpha_isKeptAndMultiplied() {
        val out = tmp.newFolder()
        // 原图 alpha 128，抠图 alpha 255：合成后仍是 128，不是 255
        val r = runBlocking { service(fullDir(), FakeBackend(alpha = 255), FakeCodec(1, 1, srcAlpha = 128), out = out).matte(File("a.jpg")) }
        val bytes = File(out, r.path.substringAfterLast('/')).readBytes()
        assertEquals(6, bytes[25].toInt())
    }

    @Test
    fun cancellingTheCoroutine_interruptsBackend() {
        val b = FakeBackend(block = true)
        val svc = service(fullDir(), b)
        runBlocking {
            val job = launch(Dispatchers.Default, start = CoroutineStart.DEFAULT) { svc.matte(File("a.jpg")) }
            assertTrue("抠图应已开始", b.started.await(5, TimeUnit.SECONDS))
            withTimeout(5_000) { job.cancelAndJoin() }
            assertTrue(job.isCancelled)
        }
        assertTrue("取消应传到引擎", b.cancelCalled)
    }

    @Test
    fun afterCancel_nextCallRunsNormally_sessionKept_noLeftovers() {
        val b = FakeBackend()
        b.blockOnce = true
        val out = tmp.newFolder()
        val svc = service(fullDir(), b, out = out)
        runBlocking {
            val job = launch(Dispatchers.Default) { svc.matte(File("a.jpg")) }
            assertTrue(b.started.await(5, TimeUnit.SECONDS))
            withTimeout(5_000) { job.cancelAndJoin() }
        }
        // 取消的那次没有成品、没有半成品
        assertEquals(emptyList<String>(), out.list()!!.toList())
        // 取消后同一服务立刻再跑一次正常出图，会话没重载
        val r = runBlocking { svc.matte(File("a.jpg")) }
        assertEquals(1, out.list()!!.size)
        assertTrue(r.path.endsWith(".png"))
        assertEquals(listOf("load", "matte", "matte"), b.calls)
    }

    @Test
    fun cancelledBeforeStart_neverReachesBackendMatte() {
        val b = FakeBackend()
        val svc = service(fullDir(), b)
        assertThrows(CancellationException::class.java) {
            runBlocking {
                val job = async(start = CoroutineStart.LAZY) { svc.matte(File("a.jpg")) }
                job.cancel()
                job.await()
            }
        }
        assertFalse(b.calls.contains("matte"))
    }

    @Test
    fun normalFinish_doesNotCallCancel() {
        val b = FakeBackend()
        runBlocking { service(fullDir(), b).matte(File("a.jpg")) }
        assertFalse(b.cancelCalled)
    }

    @Test
    fun heavyGate_serializesConcurrentMatte() {
        val b = FakeBackend()
        val svc = service(fullDir(), b)
        runBlocking {
            val all = (1..3).map { async(Dispatchers.Default) { svc.matte(File("a.jpg")) } }
            all.forEach { it.await() }
        }
        assertEquals(1, b.calls.count { it == "load" })
        assertEquals(3, b.calls.count { it == "matte" })
    }

    @Test
    fun badAlphaLength_isInternalError() {
        val bad = object : MattingBackend {
            override fun load(modelPath: String) {}
            override fun unload() {}
            override fun cancel() {}
            override fun matte(width: Int, height: Int, rgb: ByteArray, refine: MattingRefine) =
                MattingOutcome(width, height, ByteArray(1), ByteArray(1), 1)
        }
        val svc = MattingService(MattingMode.PORTRAIT, env(fullDir()), bad, FakeCodec())
        assertEquals(BridgeErrors.INTERNAL, assertThrows(BridgeException::class.java) { runBlocking { svc.matte(File("a.jpg")) } }.code)
    }

    @Test
    fun provider_availabilityFollowsModelState_orFilesWhenNoSource() {
        val svc = service(fullDir(), FakeBackend())
        assertTrue(LocalMattingProvider(svc).availability().available)
        assertEquals(null, LocalMattingProvider(svc).modelInfo())
        val notInstalled = LocalMattingProvider(svc, ModelStateSource { ModelStateInfo(installed = false, diskBytes = 3, downloading = true) })
        assertEquals(AiUnavailableReason.NOT_INSTALLED, notInstalled.availability().reason)
        val info = notInstalled.modelInfo()!!
        assertEquals(MattingMode.PORTRAIT.modelId, info.modelId)
        assertTrue(info.downloading)
        val installed = LocalMattingProvider(svc, ModelStateSource { ModelStateInfo(installed = true, diskBytes = 9, downloading = false) })
        assertTrue(installed.availability().available)
        assertEquals(MattingMode.PORTRAIT.modelId, installed.sessionModelId)
        assertEquals(AiLayer.L1, installed.layer)
    }

    @Test
    fun provider_runIsRejected_andManifestMatchesRequiredFilesForBothModes() {
        val p = LocalMattingProvider(service(fullDir(), FakeBackend()))
        val e = assertThrows(BridgeException::class.java) { runBlocking { p.run(AiTask.MATTING, "x") } }
        assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        assertTrue(e.message.orEmpty().contains(AiModule.METHOD_MATTING))
        // 清单里的 id、目录与必需文件逐一对上（models.json 随包，测试里直接读源码树）
        val manifest = File("src/main/assets/ai/models.json").readText()
        MattingMode.values().forEach { mode ->
            assertTrue(manifest.contains("\"id\": \"${mode.modelId}\""))
            assertTrue(manifest.contains("\"dir\": \"${mode.modelDir}\""))
            MattingService.requiredFilesOf(mode).forEach { assertTrue("清单缺 $it", manifest.contains("\"name\": \"$it\"")) }
        }
    }
}
