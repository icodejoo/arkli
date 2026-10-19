package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 统一路由：端口推导、缺省与指定选择、错误语义。
 * 其中 run / translate / classify / warmup 四组用例由原先各 Policy 的 requireXxx 用例迁来，语义不变。
 */
class AiRouterTest {
    /** 断言抛指定错误码，返回异常便于再查 message */
    private fun assertCode(code: String, block: () -> Unit): BridgeException {
        val e = assertThrows(BridgeException::class.java) { block() }
        assertEquals(code, e.code)
        return e
    }

    /** 只有 run 的提供者替身（交接类、将来的在线服务类） */
    private class Runner(
        override val id: String,
        private val tasks: Set<AiTask>,
        private val avail: AiAvailability = AiAvailability.AVAILABLE,
    ) : AiProvider {
        override val displayName = "假 $id"
        override val layer = AiLayer.L3
        override fun capabilities() = tasks
        override fun availability() = avail
        override suspend fun run(task: AiTask, input: String): AiRunResult = AiRunResult.Text("ok")
    }

    /** 能翻译、也能经 run 做文本任务的替身（形如 local-qwen） */
    private class Translator(
        override val id: String,
        private val runTasks: Set<AiTask> = emptySet(),
        private val avail: AiAvailability = AiAvailability.AVAILABLE,
    ) : AiProvider, TextTranslator {
        override val displayName = "假翻译"
        override val layer = AiLayer.L1
        override fun capabilities() = runTasks + AiTask.TRANSLATE
        override fun availability() = avail
        override suspend fun run(task: AiTask, input: String): AiRunResult = AiRunResult.Text("")
        override suspend fun translate(req: AiTranslateRequest): TranslateResult = throw UnsupportedOperationException()
    }

    /** 能识图的替身 */
    private class Classifier(
        override val id: String,
        private val avail: AiAvailability = AiAvailability.AVAILABLE,
    ) : AiProvider, ImageClassifier {
        override val displayName = "假识图"
        override val layer = AiLayer.L1
        override fun capabilities() = setOf(AiTask.CLASSIFY_IMAGE)
        override fun availability() = avail
        override suspend fun run(task: AiTask, input: String): AiRunResult = AiRunResult.Text("")
        override suspend fun classify(file: File, topK: Int, params: ClassifyRunParams?): ClassifyResult = throw UnsupportedOperationException()
    }

    /** 持有会话的替身 */
    private class Sess(
        override val id: String,
        private val avail: AiAvailability = AiAvailability.AVAILABLE,
    ) : AiProvider, AiSessionControl {
        override val displayName = "会话"
        override val layer = AiLayer.L3
        override fun capabilities() = setOf(AiTask.PROMPT)
        override fun availability() = avail
        override suspend fun run(task: AiTask, input: String): AiRunResult = AiRunResult.Text("")
        override suspend fun warmup(): WarmupResult = WarmupResult(id, 0)
        override suspend fun unloadSession(): Boolean = false
    }

    /** 不可用：未安装 */
    private val notInstalled = AiAvailability.unavailable(AiUnavailableReason.NOT_INSTALLED)

    // ---- 端口推导 ----

    @Test
    fun runTasks_areDeclaredMinusDedicated() {
        val q = Translator("q", setOf(AiTask.SUMMARIZE, AiTask.PROMPT))
        assertEquals(setOf(AiTask.TRANSLATE), AiRouter.dedicatedTasks(q))
        assertEquals(setOf(AiTask.SUMMARIZE, AiTask.PROMPT), AiRouter.runTasks(q))
        // 声明了 translate 但没实现端口：translate 归 run（交接类）
        val h = Runner("h", setOf(AiTask.TRANSLATE, AiTask.PROMPT))
        assertEquals(emptySet<AiTask>(), AiRouter.dedicatedTasks(h))
        assertEquals(setOf(AiTask.TRANSLATE, AiTask.PROMPT), AiRouter.runTasks(h))
        assertEquals(emptySet<AiTask>(), AiRouter.runTasks(Classifier("c")))
    }

    @Test
    fun supports_matchesTaskAndPort() {
        val q = Translator("q", setOf(AiTask.SUMMARIZE))
        assertTrue(AiRouter.supports(q, AiTask.TRANSLATE, AiPort.Translate))
        assertTrue(AiRouter.supports(q, AiTask.SUMMARIZE, AiPort.Run))
        assertEquals(false, AiRouter.supports(q, AiTask.TRANSLATE, AiPort.Run))
        assertEquals(false, AiRouter.supports(q, AiTask.SUMMARIZE, AiPort.Translate))
        assertEquals(false, AiRouter.supports(q, AiTask.CLASSIFY_IMAGE, AiPort.Classify))
        assertEquals(false, AiRouter.supports(Runner("h", setOf(AiTask.TRANSLATE)), AiTask.TRANSLATE, AiPort.Translate))
    }

    @Test
    fun dedicatedFor_mapsTasksToPorts() {
        assertSame(AiPort.Translate, AiPort.dedicatedFor(AiTask.TRANSLATE))
        assertSame(AiPort.Classify, AiPort.dedicatedFor(AiTask.CLASSIFY_IMAGE))
        assertNull(AiPort.dedicatedFor(AiTask.SUMMARIZE))
    }

    // ---- native.ai.run（原 AiPolicy.requireRunnable） ----

    @Test
    fun resolveRun_errors() {
        val ok = Runner("p", setOf(AiTask.TRANSLATE))
        assertCode(BridgeErrors.BAD_PARAMS) { AiRouter.resolve(emptyList(), AiTask.TRANSLATE, AiPort.Run, "p") }
        assertCode(BridgeErrors.BAD_PARAMS) { AiRouter.resolve(listOf(Runner("p", setOf(AiTask.PROMPT))), AiTask.TRANSLATE, AiPort.Run, "p") }
        val off = Runner("p", setOf(AiTask.TRANSLATE), AiAvailability.unavailable(AiUnavailableReason.NO_HANDLER))
        val e = assertCode(BridgeErrors.NOT_READY) { AiRouter.resolve(listOf(off), AiTask.TRANSLATE, AiPort.Run, "p") }
        assertTrue(e.message!!.contains("no_handler"))
        assertSame(ok, AiRouter.resolve(listOf(ok), AiTask.TRANSLATE, AiPort.Run, "p").port)
    }

    @Test
    fun resolveRun_translateOnTranslator_isBadParamsPointingToTranslateEntry() {
        val q = Translator("local-qwen", setOf(AiTask.SUMMARIZE))
        val e = assertCode(BridgeErrors.BAD_PARAMS) { AiRouter.resolve(listOf(q), AiTask.TRANSLATE, AiPort.Run, "local-qwen") }
        assertTrue(e.message!!.contains(AiModule.METHOD_TRANSLATE))
        assertSame(q, AiRouter.resolve(listOf(q), AiTask.SUMMARIZE, AiPort.Run, "local-qwen").provider)
    }

    // ---- native.ai.translate（原 AiTranslatePolicy.requireTranslator） ----

    @Test
    fun resolveTranslate_picksFirstTranslatorAndSkipsHandoff() {
        val t = Translator("local-nllb")
        assertSame(t, AiRouter.resolve(listOf(Runner("handoff", setOf(AiTask.TRANSLATE)), t), AiTask.TRANSLATE, AiPort.Translate).port)
    }

    @Test
    fun resolveTranslate_withProviderId_picksThatOneEvenIfNotFirst() {
        val a = Translator("local-nllb")
        val q = Translator("local-qwen")
        assertSame(q, AiRouter.resolve(listOf(a, q), AiTask.TRANSLATE, AiPort.Translate, "local-qwen").port)
        assertCode(BridgeErrors.BAD_PARAMS) { AiRouter.resolve(listOf(a), AiTask.TRANSLATE, AiPort.Translate, "local-qwen") }
        // 交接类声明了 translate 但没有语言对端口：指定它也不行
        val h = Runner("handoff", setOf(AiTask.TRANSLATE))
        assertCode(BridgeErrors.BAD_PARAMS) { AiRouter.resolve(listOf(h, a), AiTask.TRANSLATE, AiPort.Translate, "handoff") }
    }

    @Test
    fun resolveTranslate_noTranslator_isBadParams() {
        assertCode(BridgeErrors.BAD_PARAMS) { AiRouter.resolve(listOf(Runner("handoff", setOf(AiTask.TRANSLATE))), AiTask.TRANSLATE, AiPort.Translate) }
        assertCode(BridgeErrors.BAD_PARAMS) { AiRouter.resolve(emptyList(), AiTask.TRANSLATE, AiPort.Translate) }
    }

    @Test
    fun resolveTranslate_unavailable_isNotReadyWithReason() {
        val t = Translator("local-nllb", avail = notInstalled)
        val e = assertCode(BridgeErrors.NOT_READY) { AiRouter.resolve(listOf(t), AiTask.TRANSLATE, AiPort.Translate) }
        assertTrue(e.message!!.contains("not_installed"))
    }

    @Test
    fun resolve_default_doesNotSkipUnavailableFirstCandidate() {
        // 缺省按注册顺序取第一个候选，不因为它没下载就悄悄换成下一个
        val a = Translator("a", avail = notInstalled)
        val b = Translator("b")
        assertCode(BridgeErrors.NOT_READY) { AiRouter.resolve(listOf(a, b), AiTask.TRANSLATE, AiPort.Translate) }
    }

    @Test
    fun resolve_default_onlyLocalLayers_neverHandoffOrRemote() {
        val handoff = Runner("handoff", setOf(AiTask.SUMMARIZE))
        val local = Translator("local-qwen", runTasks = setOf(AiTask.SUMMARIZE))
        // 交接排前面也不会被缺省选中；点名才行
        assertSame(local, AiRouter.select(listOf(handoff, local), AiTask.SUMMARIZE, AiPort.Run).provider)
        assertSame(handoff, AiRouter.select(listOf(handoff, local), AiTask.SUMMARIZE, AiPort.Run, "handoff").provider)
        // 没有本地候选：BAD_PARAMS，并提示要显式指定
        val e = assertCode(BridgeErrors.BAD_PARAMS) { AiRouter.select(listOf(handoff), AiTask.SUMMARIZE, AiPort.Run) }
        assertTrue(e.message!!.contains("显式指定"))
        assertEquals(setOf(AiLayer.L1, AiLayer.L2), AiRouter.DEFAULT_LAYERS)
    }

    @Test
    fun select_generative_skipsNonGenerativeLocal() {
        val plain = Translator("plain", runTasks = setOf(AiTask.SUMMARIZE))
        val gen = object : AiProvider by Translator("gen", runTasks = setOf(AiTask.SUMMARIZE)), TextGenerator {
            override suspend fun generate(task: AiTask, input: String, opts: AiGenOptions) = AiRunResult.Text("")
        }
        assertSame(plain, AiRouter.select(listOf(plain, gen), AiTask.SUMMARIZE, AiPort.Run).provider)
        assertSame(gen, AiRouter.select(listOf(plain, gen), AiTask.SUMMARIZE, AiPort.Run, generative = true).provider)
    }

    // ---- native.ai.classify（原 AiClassifyPolicy.requireClassifier） ----

    @Test
    fun resolveClassify_picksFirstCapableWhenOmitted() {
        val a = Classifier("c1")
        val picked = AiRouter.resolve(listOf(Runner("text", setOf(AiTask.TRANSLATE)), a, Classifier("c2")), AiTask.CLASSIFY_IMAGE, AiPort.Classify)
        assertSame(a, picked.port)
    }

    @Test
    fun resolveClassify_errors() {
        val text = Runner("text", setOf(AiTask.TRANSLATE))
        assertCode(BridgeErrors.BAD_PARAMS) { AiRouter.resolve(listOf(text), AiTask.CLASSIFY_IMAGE, AiPort.Classify, null) }
        assertCode(BridgeErrors.BAD_PARAMS) { AiRouter.resolve(listOf(Classifier("c")), AiTask.CLASSIFY_IMAGE, AiPort.Classify, "nope") }
        assertCode(BridgeErrors.BAD_PARAMS) { AiRouter.resolve(listOf(text), AiTask.CLASSIFY_IMAGE, AiPort.Classify, "text") }
        val down = Classifier("c", notInstalled)
        val e = assertCode(BridgeErrors.NOT_READY) { AiRouter.resolve(listOf(down), AiTask.CLASSIFY_IMAGE, AiPort.Classify, "c") }
        assertTrue(e.message!!.contains("not_installed"))
    }

    // ---- native.ai.warmup / unload（原 AiLifecyclePolicy.requireWarmable） ----

    @Test
    fun resolveById_session_picksByIdAndChecksAvailability() {
        val a = Sess("local-nllb")
        val plain = Runner("handoff", setOf(AiTask.PROMPT))
        val r = AiRouter.resolveById(listOf(plain, a), AiPort.Session, "local-nllb")
        assertSame(a, r.provider)
        assertSame(a, r.port)
        // 乱填 / 不支持预热 -> BAD_PARAMS
        assertCode(BridgeErrors.BAD_PARAMS) { AiRouter.resolveById(listOf(a), AiPort.Session, "nope") }
        assertCode(BridgeErrors.BAD_PARAMS) { AiRouter.resolveById(listOf(plain), AiPort.Session, "handoff") }
        // 未安装 -> NOT_READY 且 message 带 not_installed
        val off = Sess("local-nllb", notInstalled)
        val e = assertCode(BridgeErrors.NOT_READY) { AiRouter.resolveById(listOf(off), AiPort.Session, "local-nllb") }
        assertTrue(e.message!!.contains("not_installed"))
    }

    @Test
    fun find_and_all_ignoreAvailability() {
        val off = Sess("local-nllb", notInstalled)
        val plain = Runner("handoff", setOf(AiTask.PROMPT))
        assertSame(off, AiRouter.find(listOf(plain, off), AiPort.Session, "local-nllb").port)
        assertEquals(listOf("local-nllb"), AiRouter.all(listOf(plain, off), AiPort.Session).map { it.provider.id })
    }

    // ---- 提供者自己的 run() 报错 ----

    @Test
    fun notRunnable_pointsToDedicatedEntryOrSaysUnsupported() {
        val t = AiRouter.notRunnable("local-qwen", AiTask.TRANSLATE)
        assertEquals(BridgeErrors.BAD_PARAMS, t.code)
        assertTrue(t.message!!.contains(AiModule.METHOD_TRANSLATE))
        val c = AiRouter.notRunnable("local-nllb", AiTask.SUMMARIZE)
        assertEquals(BridgeErrors.BAD_PARAMS, c.code)
        assertTrue(c.message!!.contains(AiTask.SUMMARIZE.wire))
    }
}
