package com.let188.arkli.model

import com.let188.arkli.ai.AiTask
import com.let188.arkli.ai.AiUnavailableReason
import com.let188.arkli.ai.AiPolicy
import com.let188.arkli.ai.ClipService
import com.let188.arkli.ai.ClipBackend
import com.let188.arkli.ai.ClipVocabMeta
import com.let188.arkli.ai.ClassifyOutcome
import com.let188.arkli.ai.ClipEnv
import com.let188.arkli.ai.LocalClipProvider
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.image.CodecImage
import com.let188.arkli.image.ImageCodec
import com.let188.arkli.image.OutFormat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** 管理器：幂等、并发保护、取消续传、删除、校验、状态汇总，以及与 local-clip 提供者的对接 */
class ModelManagerTest {
    /** 临时目录，充当 filesDir */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 下载任务的作用域 */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 内容 30000 字节 */
    private val data = content(30_000)

    /** 清单项 */
    private val entry = entryOf(data)

    /** 模型目录 */
    private val dir get() = File(tmp.root, "models/m1")

    @After
    fun tearDown() = scope.cancel()

    /** 造管理器 */
    private fun manager(t: FakeTransport, override: List<String>? = null, metered: Boolean = false): ModelManager =
        ModelManager(
            ModelManifest(listOf(entry)), tmp.root,
            ModelDownloader(t, { Long.MAX_VALUE }, { override != null }, { delay(1) }),
            scope, { metered }, { override },
        )

    /** 等任务结束（最多 10 秒） */
    private fun settle(m: ModelManager): ModelSnapshot {
        val end = System.currentTimeMillis() + 10_000
        while (m.status("m1").state == ModelState.DOWNLOADING) {
            check(System.currentTimeMillis() < end) { "下载超时" }
            Thread.sleep(5)
        }
        return m.status("m1")
    }

    @Test
    fun ensure_downloadsVerifiesAndMarksInstalled_thenIsIdempotent() {
        val t = FakeTransport { _, h, _ -> serve(data, h) }
        val m = manager(t, metered = true)
        val r = m.ensure("m1")
        assertTrue(r.started)
        assertTrue(r.meteredHint)
        val s = settle(m)
        assertEquals(ModelState.INSTALLED, s.state)
        assertEquals(data.size.toLong(), s.downloadedBytes)
        assertNull(s.errorCode)
        assertTrue(m.info("m1").installed)
        val again = m.ensure("m1")
        assertFalse(again.started)
        assertEquals(1, t.count)
        assertEquals(listOf("m1"), m.list().map { it.id })
    }

    @Test
    fun ensure_whileDownloading_doesNotStartSecondTask() {
        val gate = CountDownLatch(1)
        val t = FakeTransport { _, h, _ -> serve(data, h, onRead = { gate.await(5, TimeUnit.SECONDS) }) }
        val m = manager(t)
        assertTrue(m.ensure("m1").started)
        val second = m.ensure("m1")
        assertFalse(second.started)
        assertEquals(ModelState.DOWNLOADING, second.snapshot.state)
        assertTrue(m.info("m1").downloading)
        gate.countDown()
        assertEquals(ModelState.INSTALLED, settle(m).state)
        assertEquals(1, t.count)
    }

    @Test
    fun concurrentEnsure_startsExactlyOnce() {
        val t = FakeTransport { _, h, _ -> serve(data, h) }
        val m = manager(t)
        val started = java.util.concurrent.atomic.AtomicInteger()
        val pool = (1..8).map { Thread { if (m.ensure("m1").started) started.incrementAndGet() } }
        pool.forEach { it.start() }
        pool.forEach { it.join() }
        settle(m)
        // 任务可能在其他线程调用前就已完成并装好（已安装则 started=false），所以只要求至多一次且只下了一遍
        assertTrue(started.get() == 1)
        assertEquals(1, t.count)
    }

    @Test
    fun cancel_keepsPart_andEnsureResumes() {
        lateinit var m: ModelManager
        val fired = java.util.concurrent.atomic.AtomicBoolean(false)
        val t = FakeTransport { _, h, _ ->
            serve(data, h, onRead = { n ->
                // 取消要在任务线程之外发起（cancelAndJoin 会等任务结束），给它一点时间生效
                if (n >= 9_000 && fired.compareAndSet(false, true)) {
                    Thread { runBlocking { m.cancel("m1") } }.start()
                    Thread.sleep(300)
                }
            })
        }
        m = manager(t)
        m.ensure("m1")
        val s = settle(m)
        assertEquals(ModelState.ABSENT, s.state)
        assertTrue("应保留已下载部分：${s.downloadedBytes}", s.downloadedBytes in 1 until data.size)
        assertNull("取消不算失败", s.errorCode)
        assertTrue(File(dir, "m.bin.part").exists())
        val kept = File(dir, "m.bin.part").length()

        val t2 = FakeTransport { _, h, _ -> serve(data, h) }
        val m2 = manager(t2)
        m2.ensure("m1")
        assertEquals(ModelState.INSTALLED, settle(m2).state)
        assertEquals("bytes=$kept-", t2.requestHeaders[0]["Range"])
        assertArrayEquals(data, File(dir, "m.bin").readBytes())
    }

    @Test
    fun failure_isRecordedInStatus_andClearedOnNextEnsure() {
        var fail = true
        val t = FakeTransport { _, h, _ -> if (fail) FakeResponse(404) else serve(data, h) }
        val m = manager(t)
        m.ensure("m1")
        val s = settle(m)
        assertEquals(ModelState.ABSENT, s.state)
        assertEquals("NETWORK", s.errorCode)
        fail = false
        m.ensure("m1")
        val ok = settle(m)
        assertEquals(ModelState.INSTALLED, ok.state)
        assertNull(ok.errorCode)
    }

    @Test
    fun remove_releasesSessionBeforeDeleting_andCleansEverything() {
        val t = FakeTransport { _, h, _ -> serve(data, h) }
        val m = manager(t)
        m.ensure("m1")
        settle(m)
        var existedDuringHook = false
        m.addReleaseHook("m1") { existedDuringHook = File(dir, "m.bin").exists() }
        File(dir, "m.bin.part").writeText("x")
        val s = runBlocking { m.remove("m1") }
        assertTrue("钩子应在删文件之前运行", existedDuringHook)
        assertEquals(ModelState.ABSENT, s.state)
        assertEquals(0L, s.diskBytes)
        assertFalse(File(dir, "m.bin").exists())
        assertFalse(File(dir, "m.bin.part").exists())
        assertFalse(File(dir, MARKER_NAME).exists())
        assertFalse(m.info("m1").installed)
        // 再次 ensure 能重新下载
        m.ensure("m1")
        assertEquals(ModelState.INSTALLED, settle(m).state)
        assertEquals(2, t.count)
    }

    @Test
    fun remove_whileDownloading_cancelsFirst() {
        val gate = CountDownLatch(1)
        val t = FakeTransport { _, h, _ -> serve(data, h, onRead = { gate.await(5, TimeUnit.SECONDS) }) }
        val m = manager(t)
        m.ensure("m1")
        val s = runBlocking { m.remove("m1") }
        gate.countDown()
        assertEquals(ModelState.ABSENT, s.state)
        assertEquals(0L, s.diskBytes)
    }

    @Test
    fun remove_keepsUnknownFilesInDir() {
        dir.mkdirs()
        File(dir, "other.txt").writeText("keep")
        File(dir, "m.bin").writeBytes(data)
        runBlocking { manager(FakeTransport { _, _, _ -> FakeResponse(500) }).remove("m1") }
        assertTrue(File(dir, "other.txt").exists())
        assertFalse(File(dir, "m.bin").exists())
    }

    @Test
    fun manuallyPlacedFile_isUnverified_untilVerifyPasses() {
        dir.mkdirs()
        File(dir, "m.bin").writeBytes(data)
        val m = manager(FakeTransport { _, _, _ -> FakeResponse(500) })
        assertEquals(ModelState.UNVERIFIED, m.status("m1").state)
        assertFalse(m.info("m1").installed)
        val s = runBlocking { m.verify("m1") }
        assertEquals(ModelState.INSTALLED, s.state)
        assertTrue(m.info("m1").installed)
    }

    @Test
    fun verify_badFile_isDeletedAndReported() {
        dir.mkdirs()
        File(dir, "m.bin").writeBytes(ByteArray(data.size) { 3 })
        val m = manager(FakeTransport { _, _, _ -> FakeResponse(500) })
        val s = runBlocking { m.verify("m1") }
        assertEquals(ModelState.ABSENT, s.state)
        assertEquals("HASH_MISMATCH", s.errorCode)
        assertFalse(File(dir, "m.bin").exists())
    }

    @Test
    fun verify_afterFileTampered_installedBecomesUnverified() {
        val m = manager(FakeTransport { _, h, _ -> serve(data, h) })
        m.ensure("m1")
        settle(m)
        File(dir, "m.bin").setLastModified(System.currentTimeMillis() - 100_000)
        assertEquals(ModelState.UNVERIFIED, m.status("m1").state)
    }

    @Test
    fun wrongSizeFile_isCorrupt_andEnsureRedownloads() {
        dir.mkdirs()
        File(dir, "m.bin").writeBytes(ByteArray(100))
        val t = FakeTransport { _, h, _ -> serve(data, h) }
        val m = manager(t)
        assertEquals(ModelState.CORRUPT, m.status("m1").state)
        m.ensure("m1")
        assertEquals(ModelState.INSTALLED, settle(m).state)
    }

    @Test
    fun verify_whileDownloading_isRejected() {
        val gate = CountDownLatch(1)
        val m = manager(FakeTransport { _, h, _ -> serve(data, h, onRead = { gate.await(5, TimeUnit.SECONDS) }) })
        m.ensure("m1")
        val e = assertThrows(BridgeException::class.java) { runBlocking { m.verify("m1") } }
        assertEquals(BridgeErrors.NOT_READY, e.code)
        gate.countDown()
        settle(m)
    }

    @Test
    fun unknownId_isBadParams_forEveryOperation() {
        val m = manager(FakeTransport { _, _, _ -> FakeResponse(500) })
        val ops = listOf<() -> Unit>({ m.status("x") }, { m.ensure("x") }, { runBlocking { m.cancel("x") } }, { runBlocking { m.remove("x") } }, { runBlocking { m.verify("x") } })
        ops.forEach { op ->
            val e = assertThrows(BridgeException::class.java) { op() }
            assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        }
        assertFalse(m.info("x").installed)
    }

    @Test
    fun debugOverride_replacesUrls_butSha256StillChecked() {
        val local = "http://127.0.0.1:9000/m.bin"
        val ok = FakeTransport { _, h, _ -> serve(data, h) }
        val m = manager(ok, override = listOf(local))
        m.ensure("m1")
        assertEquals(ModelState.INSTALLED, settle(m).state)
        assertEquals(listOf(local), ok.urls)
        runBlocking { m.remove("m1") }
        val evil = FakeTransport { _, h, _ -> serve(content(data.size, 99), h) }
        val m2 = manager(evil, override = listOf(local))
        m2.ensure("m1")
        val s = settle(m2)
        assertEquals("HASH_MISMATCH", s.errorCode)
        assertEquals(ModelState.ABSENT, s.state)
    }

    @Test
    fun speedAndProgress_areReportedWhileDownloading() {
        val gate = CountDownLatch(1)
        val m = manager(FakeTransport { _, h, _ -> serve(data, h, onRead = { n -> if (n >= 12_000) gate.await(5, TimeUnit.SECONDS) }) })
        m.ensure("m1")
        val end = System.currentTimeMillis() + 5_000
        var s = m.status("m1")
        while (s.downloadedBytes < 12_000 && System.currentTimeMillis() < end) {
            Thread.sleep(5)
            s = m.status("m1")
        }
        assertEquals(ModelState.DOWNLOADING, s.state)
        assertEquals("download", s.phase)
        assertTrue(s.downloadedBytes >= 12_000)
        gate.countDown()
        settle(m)
    }

    // ---- 与 local-clip 提供者对接 ----

    /** 引擎与词表替身，只为构造 ClipService */
    private fun clipService(): ClipService {
        val env = object : ClipEnv {
            override fun modelFile() = File(dir, "m.bin")
            override fun readVocabJson() = "{}"
            override fun readVocabVectors() = ByteArray(0)
        }
        val backend = object : ClipBackend {
            override fun load(modelPath: String) {}
            override fun unload() {}
            override fun setVocab(meta: ClipVocabMeta, vectorsF16le: ByteArray) {}
            override fun classify(width: Int, height: Int, rgb: ByteArray, topK: Int): ClassifyOutcome = throw UnsupportedOperationException()
        }
        val codec = object : ImageCodec {
            override fun decode(file: File, maxEdge: Int?): CodecImage = throw UnsupportedOperationException()
            override fun scale(src: CodecImage, width: Int, height: Int): CodecImage = src
            override fun encodeLossy(img: CodecImage, format: OutFormat, quality: Int) = ByteArray(0)
        }
        return ClipService(env, backend, codec)
    }

    @Test
    fun localClipProvider_availabilityAndDownloadFields_followModelState() {
        var info = ModelStateInfo(false, 0, false)
        val p = LocalClipProvider(clipService()) { id -> if (id == ClipService.MODEL_ID) info else ModelStateInfo(false, 0, false) }
        // 即使文件存在，没校验过也不可用
        dir.mkdirs()
        File(dir, "m.bin").writeText("x")
        assertEquals(AiUnavailableReason.NOT_INSTALLED, p.availability().reason)
        var j = AiPolicy.providerJson(p)
        assertEquals(false, j.getBoolean("available"))
        assertEquals(false, j.getBoolean("downloaded"))
        assertEquals(ClipService.MODEL_ID, j.getString("modelId"))

        info = ModelStateInfo(false, 1234, true)
        j = AiPolicy.providerJson(p)
        assertTrue(j.getBoolean("downloading"))
        assertEquals(1234L, j.getLong("sizeBytes"))
        assertFalse(j.getBoolean("available"))

        info = ModelStateInfo(true, 54_662_805, false)
        j = AiPolicy.providerJson(p)
        assertTrue(j.getBoolean("available"))
        assertTrue(j.getBoolean("downloaded"))
        assertEquals(54_662_805L, j.getLong("sizeBytes"))
        assertFalse(j.getBoolean("downloading"))
        assertEquals(setOf(AiTask.CLASSIFY_IMAGE), p.capabilities())
    }
}
