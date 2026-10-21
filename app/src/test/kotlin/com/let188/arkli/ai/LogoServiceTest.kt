package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.model.ModelStateInfo
import com.let188.arkli.model.ModelStateSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** logo 生成服务测试：就绪、懒加载、重载、驻留选择、并发拒绝、取消与再生成、卸载先取消、让位顺序 */
class LogoServiceTest {
    @get:Rule
    val tmp = TemporaryFolder()

    /** 等待上限（秒），超过说明测试挂住了 */
    private val waitSec = 10L

    /** 记录调用顺序的引擎替身；[blockOnGenerate] 为真时生成会卡住，直到被 cancel 或 [release] */
    private class FakeBackend(@Volatile var blockOnGenerate: Boolean = false, private val onLoad: (LogoResidency) -> Unit = {}) : LogoBackend {
        /** 调用顺序 */
        val calls: MutableList<String> = Collections.synchronizedList(mutableListOf())

        /** 每次 load 的驻留方式 */
        val loads: MutableList<LogoResidency> = Collections.synchronizedList(mutableListOf())

        /** 最近一次生成的种子 */
        @Volatile
        var lastSeed: Long? = null

        /** 生成已进入阻塞 */
        val started = CountDownLatch(1)

        /** 放行阻塞中的生成 */
        private val released = CountDownLatch(1)

        /** 收到过取消 */
        private val cancelled = CountDownLatch(1)

        /** 放行阻塞中的生成（正常结束） */
        fun release() = released.countDown()

        override fun load(modelDir: String, residency: LogoResidency) {
            calls += "load"
            loads += residency
            onLoad(residency)
        }

        override fun unload() {
            calls += "unload"
        }

        override fun cancel() {
            calls += "cancel"
            cancelled.countDown()
        }

        override fun generate(req: AiLogoRequest, seed: Long): LogoOutcome {
            calls += "generate"
            lastSeed = seed
            if (blockOnGenerate) {
                blockOnGenerate = false
                started.countDown()
                while (released.count > 0) {
                    if (cancelled.await(10, TimeUnit.MILLISECONDS)) throw CancellationException("已取消")
                }
            }
            return outcome()
        }

        /** 固定的 Rust 结果 */
        fun outcome() = LogoOutcome(
            "<path d=\"M0 0\"/>", 1, true, emptyList(), false,
            LogoFeatures(0.2f, 0.1f, 1, 0, 0.8f, 0.05f, 0.9f, false),
            LogoTimings(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 55),
        )
    }

    /** 文件齐全的模型目录 */
    private fun fullDir(): File = tmp.newFolder().also { d -> LogoService.REQUIRED_FILES.forEach { File(d, it).writeText("x") } }

    /** 基准请求 */
    private fun req(seed: Long? = 7L) = AiLogoRequest(null, "flat pictogram glyph of a carrot", seed)

    /** 造服务，可用内存缺省给够常驻 */
    private fun service(
        backend: LogoBackend,
        dir: File = fullDir(),
        avail: () -> Long = { AiLogoPolicy.RESIDENT_NEED_BYTES },
        evict: suspend () -> Unit = {},
        seed: () -> Long = { 12345L },
    ) = LogoService(object : LogoEnv { override fun modelDir() = dir }, backend, avail, evict, randomSeed = seed)

    /** 断言抛出给定桥错误码 */
    private fun assertBridge(code: String, block: suspend () -> Unit) {
        assertEquals(code, assertThrows(BridgeException::class.java) { runBlocking { block() } }.code)
    }

    @Test
    fun missingOrEmptyFile_isNotReady() {
        val dir = fullDir()
        File(dir, "tokenizer.json").delete()
        val svc = service(FakeBackend(), dir)
        assertFalse(svc.isModelReady())
        assertBridge(BridgeErrors.NOT_READY) { svc.generate(req()) }
        assertBridge(BridgeErrors.NOT_READY) { svc.warmup() }
        File(dir, "tokenizer.json").writeText("")
        assertFalse(svc.isModelReady())
    }

    @Test
    fun loadsLazilyOnce_andResultCarriesSeedResidencyModelId() = runBlocking {
        val b = FakeBackend()
        val svc = service(b)
        assertEquals(emptyList<String>(), b.calls)
        val r = svc.generate(req())
        svc.generate(req())
        assertEquals(listOf("load", "generate", "generate"), b.calls)
        assertEquals(LogoService.MODEL_ID, r.modelId)
        assertEquals(7L, r.seed)
        assertEquals(LogoResidency.RESIDENT, r.residency)
        assertEquals(55L, r.timings.totalMs)
        // 已加载再预热不重复加载
        assertEquals(LocalLogoProvider.ID, svc.warmup().provider)
        assertEquals(listOf("load", "generate", "generate"), b.calls)
    }

    @Test
    fun missingSeed_usesRandomSeedAndReportsIt() = runBlocking {
        val b = FakeBackend()
        val r = service(b, seed = { 99L }).generate(req(seed = null))
        assertEquals(99L, r.seed)
        assertEquals(99L, b.lastSeed)
    }

    @Test
    fun fileChange_unloadsThenReloads() = runBlocking {
        val dir = fullDir()
        val b = FakeBackend()
        val svc = service(b, dir)
        svc.generate(req())
        File(dir, "unet.mnn").writeText("changed-longer")
        svc.generate(req())
        assertEquals(listOf("load", "generate", "unload", "load", "generate"), b.calls)
    }

    @Test
    fun lowMemory_choosesPerStage_highChoosesResident_andLoadedSessionIsKept() = runBlocking {
        var avail = 500L * 1024 * 1024
        val b = FakeBackend()
        val svc = service(b, avail = { avail })
        assertEquals(LogoResidency.PER_STAGE, svc.generate(req()).residency)
        // 已加载的沿用，内存回升也不中途切换
        avail = AiLogoPolicy.RESIDENT_NEED_BYTES
        assertEquals(LogoResidency.PER_STAGE, svc.generate(req()).residency)
        svc.unload()
        assertEquals(LogoResidency.RESIDENT, svc.generate(req()).residency)
        assertEquals(listOf(LogoResidency.PER_STAGE, LogoResidency.RESIDENT), b.loads)
    }

    @Test
    fun concurrentGenerate_isRejectedAsBusy_andFirstIsUnaffected() = runBlocking {
        val b = FakeBackend(blockOnGenerate = true)
        val svc = service(b)
        val first = async(Dispatchers.Default) { svc.generate(req()) }
        assertTrue(b.started.await(waitSec, TimeUnit.SECONDS))
        val ex = assertThrows(BridgeException::class.java) { runBlocking { svc.generate(req()) } }
        assertEquals(BridgeErrors.INTERNAL, ex.code)
        assertEquals(LogoService.MSG_BUSY, ex.message)
        b.release()
        assertEquals(LogoService.MODEL_ID, first.await().modelId)
        // 第一个结束后可再用
        assertEquals(LogoService.MODEL_ID, svc.generate(req()).modelId)
    }

    @Test
    fun coroutineCancel_callsBackendCancel_thenRegenerateWorks() = runBlocking {
        val b = FakeBackend(blockOnGenerate = true)
        val svc = service(b)
        val job = async(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) { svc.generate(req()) }
        assertTrue(b.started.await(waitSec, TimeUnit.SECONDS))
        job.cancelAndJoin()
        assertTrue(b.calls.contains("cancel"))
        assertThrows(CancellationException::class.java) { runBlocking { job.await() } }
        // 取消后会话还在（不重复 load），再生成正常
        val r = svc.generate(req())
        assertEquals(LogoService.MODEL_ID, r.modelId)
        assertEquals(1, b.calls.count { it == "load" })
    }

    @Test
    fun unloadDuringGenerate_cancelsFirstThenUnloads() = runBlocking {
        val b = FakeBackend(blockOnGenerate = true)
        val svc = service(b)
        val gen = async(Dispatchers.Default) { svc.generate(req()) }
        assertTrue(b.started.await(waitSec, TimeUnit.SECONDS))
        val un = async(Dispatchers.Default) { svc.unload() }
        assertThrows(CancellationException::class.java) { runBlocking { gen.await() } }
        assertTrue(un.await())
        val cancelAt = b.calls.indexOf("cancel")
        val unloadAt = b.calls.indexOf("unload")
        assertTrue("应调用过 cancel", cancelAt >= 0)
        assertTrue("cancel 必须在 unload 之前: ${b.calls}", cancelAt < unloadAt)
        // 卸载后再生成会重新加载
        svc.generate(req())
        assertEquals(2, b.calls.count { it == "load" })
    }

    @Test
    fun unloadWhileQueuedBeforeGate_preventsGenerateFromStarting() = runBlocking {
        val b = FakeBackend()
        // 让位回调里（闸门外）触发一次卸载，模拟“排队期间有人卸载”
        lateinit var svc: LogoService
        svc = service(b, evict = { svc.unload() })
        assertThrows(CancellationException::class.java) { runBlocking { svc.generate(req()) } }
        assertFalse(b.calls.contains("generate"))
    }

    @Test
    fun evictOthers_runsBeforeLoad_outsideTheGate() = runBlocking {
        val order = Collections.synchronizedList(mutableListOf<String>())
        val b = FakeBackend(onLoad = { order += "load" })
        // 让位里去拿闸门：若 generate 已在闸门里调用它，会死锁
        val svc = service(b, evict = {
            order += "evict"
            AiHeavyGate.run { order += "evictGate" }
        })
        svc.generate(req())
        assertEquals(listOf("evict", "evictGate", "load"), order.toList())
    }

    @Test
    fun unload_isIdempotent() = runBlocking {
        val svc = service(FakeBackend())
        assertFalse(svc.unload())
        svc.generate(req())
        assertTrue(svc.unload())
        assertFalse(svc.unload())
    }

    @Test
    fun warmupCancelledDuringLoad_unloadsAgain() = runBlocking {
        val loading = CountDownLatch(1)
        val go = CountDownLatch(1)
        val calls = Collections.synchronizedList(mutableListOf<String>())
        val b = object : LogoBackend {
            override fun load(modelDir: String, residency: LogoResidency) {
                calls += "load"
                loading.countDown()
                go.await(waitSec, TimeUnit.SECONDS)
            }
            override fun unload() { calls += "unload" }
            override fun generate(req: AiLogoRequest, seed: Long): LogoOutcome = error("不该生成")
            override fun cancel() {}
        }
        val job = async(Dispatchers.Default) { service(b).warmup() }
        assertTrue(loading.await(waitSec, TimeUnit.SECONDS))
        job.cancel()
        go.countDown()
        assertThrows(CancellationException::class.java) { runBlocking { job.await() } }
        assertTrue(calls.contains("unload"))
    }

    @Test
    fun provider_availabilityFollowsModelState_andRunIsRejected() {
        val svc = service(FakeBackend())
        assertTrue(LocalLogoProvider(svc).availability().available)
        val p = LocalLogoProvider(svc, ModelStateSource { ModelStateInfo(installed = false, diskBytes = 0, downloading = false) })
        assertEquals(AiUnavailableReason.NOT_INSTALLED, p.availability().reason)
        assertEquals(LogoService.MODEL_ID, p.modelInfo()?.modelId)
        assertThrows(BridgeException::class.java) { runBlocking { p.run(AiTask.LOGO_SYMBOL, "x") } }
    }

    @Test
    fun requiredFiles_matchManifestEntryExactly() {
        // models.json 随包，测试里直接读源码树
        val arr = org.json.JSONObject(File("src/main/assets/ai/models.json").readText()).getJSONArray("models")
        val m = (0 until arr.length()).map { arr.getJSONObject(it) }.first { it.getString("id") == LogoService.MODEL_ID }
        assertEquals(LOGO_MODEL_DIR, m.getString("dir"))
        val names = m.getJSONArray("files").let { fs -> (0 until fs.length()).map { fs.getJSONObject(it).getString("name") } }
        assertEquals(LogoService.REQUIRED_FILES.sorted(), names.sorted())
        val total = m.getJSONArray("files").let { fs -> (0 until fs.length()).sumOf { fs.getJSONObject(it).getLong("bytes") } }
        assertEquals(total, m.getLong("totalBytes"))
        assertTrue(m.getJSONObject("archive").getJSONArray("urls").getString(0).contains("/logo-sdxs-mnn-v1/"))
    }
}
