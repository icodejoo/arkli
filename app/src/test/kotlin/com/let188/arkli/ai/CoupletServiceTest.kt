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

/** 对联服务：就绪判断、懒加载一次、指纹变化重载、取消打断、提供者可用性与清单对照 */
class CoupletServiceTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 记录调用的引擎替身；[block] 为真时 generate 一直阻塞到 cancel 被调用 */
    private class FakeBackend(val block: Boolean = false) : CoupletBackend {
        val calls = mutableListOf<String>()
        var last: AiCoupletRequest? = null
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

        override fun generate(req: AiCoupletRequest): CoupletOutcome {
            last = req
            calls += "generate"
            if (block) {
                started.countDown()
                if (!cancelled.await(5, TimeUnit.SECONDS)) error("超时没等到取消")
                throw CancellationException("生成已取消")
            }
            return CoupletOutcome("下联".repeat(1), 5)
        }
    }

    /** 建一个必需文件齐全的模型目录 */
    private fun fullDir(): File = tmp.newFolder().also { d -> CoupletService.REQUIRED_FILES.forEach { File(d, it).writeText("x") } }

    /** 指向 [dir] 的文件环境 */
    private fun env(dir: File) = object : CoupletEnv { override fun modelDir() = dir }

    /** 一个最小请求 */
    private fun req(text: String = "春风") = AiCoupletRequest(null, text, 0f, 10, 7L)

    @Test
    fun missingFiles_isNotReady_andGenerateThrowsNotReady() {
        val dir = fullDir()
        File(dir, "vocab.txt").delete()
        val svc = CoupletService(env(dir), FakeBackend())
        assertFalse(svc.isModelReady())
        assertEquals(BridgeErrors.NOT_READY, assertThrows(BridgeException::class.java) { runBlocking { svc.generate(req()) } }.code)
        assertEquals(BridgeErrors.NOT_READY, assertThrows(BridgeException::class.java) { runBlocking { svc.warmup() } }.code)
    }

    @Test
    fun emptyFile_countsAsMissing() {
        val dir = fullDir()
        File(dir, "model.mnn.weight").writeText("")
        assertFalse(CoupletService(env(dir), FakeBackend()).isModelReady())
    }

    @Test
    fun loadsOnce_lazily_passesRequestThrough_andTagsModelId() {
        val b = FakeBackend()
        val svc = CoupletService(env(fullDir()), b)
        assertEquals(emptyList<String>(), b.calls)
        val r = runBlocking { svc.generate(req("山清水秀")) }
        runBlocking { svc.generate(req()) }
        assertEquals(listOf("load", "generate", "generate"), b.calls)
        assertEquals(CoupletService.MODEL_ID, r.modelId)
        assertEquals("下联", r.text)
        assertEquals(req(), b.last)
        // 预热已加载则不再加载
        assertEquals(LocalCoupletProvider.ID, runBlocking { svc.warmup() }.provider)
        assertEquals(listOf("load", "generate", "generate"), b.calls)
    }

    @Test
    fun warmup_thenGenerateDoesNotReload_andUnloadReportsWhetherLoaded() {
        val b = FakeBackend()
        val svc = CoupletService(env(fullDir()), b)
        assertFalse(runBlocking { svc.unload() })
        runBlocking { svc.warmup() }
        runBlocking { svc.generate(req()) }
        assertEquals(listOf("unload", "load", "generate"), b.calls)
        assertTrue(runBlocking { svc.unload() })
        runBlocking { svc.generate(req()) }
        assertEquals(listOf("unload", "load", "generate", "unload", "load", "generate"), b.calls)
    }

    @Test
    fun fingerprintChange_unloadsOldThenReloads() {
        val dir = fullDir()
        val b = FakeBackend()
        val svc = CoupletService(env(dir), b)
        runBlocking { svc.generate(req()) }
        File(dir, "model.mnn").writeText("changed-longer")
        runBlocking { svc.generate(req()) }
        assertEquals(listOf("load", "generate", "unload", "load", "generate"), b.calls)
    }

    @Test
    fun cancellingTheCoroutine_interruptsTheBackend() {
        val b = FakeBackend(block = true)
        val svc = CoupletService(env(fullDir()), b)
        runBlocking {
            val job = async(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) { svc.generate(req()) }
            withTimeout(5_000) { while (b.started.count > 0L) kotlinx.coroutines.delay(10) }
            job.cancelAndJoin()
        }
        assertTrue(b.cancelCalled)
    }

    @Test
    fun requiredFiles_matchManifestEntry() {
        // models.json 随包，测试里直接读源码树
        val text = File("src/main/assets/ai/models.json").readText()
        assertTrue(text.contains("\"id\": \"${CoupletService.MODEL_ID}\""))
        assertTrue(text.contains("\"dir\": \"$COUPLET_MODEL_DIR\""))
        CoupletService.REQUIRED_FILES.forEach { assertTrue("清单缺 $it", text.contains("\"name\": \"$it\"")) }
    }

    @Test
    fun provider_availabilityFollowsModelState() {
        val dir = fullDir()
        val svc = CoupletService(env(dir), FakeBackend())
        assertTrue(LocalCoupletProvider(svc).availability().available)
        val off = LocalCoupletProvider(svc, ModelStateSource { ModelStateInfo(installed = false, diskBytes = 0, downloading = false) })
        assertEquals(AiUnavailableReason.NOT_INSTALLED, off.availability().reason)
        assertEquals(CoupletService.MODEL_ID, off.modelInfo()?.modelId)
    }
}
