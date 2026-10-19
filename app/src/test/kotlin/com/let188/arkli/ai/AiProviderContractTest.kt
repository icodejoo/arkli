package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.image.SourceResolver
import com.let188.arkli.model.ModelStateInfo
import com.let188.arkli.model.ModelStateSource
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 提供者契约（不变量）：能力声明与实现来自同一个来源，不能说谎。对 [AiModule.providers] 注册的每个提供者检查：
 * 1. 实现了专用端口（[AiPort.DEDICATED]）⇒ 声明了对应任务；
 * 2. 声明的任务要么由专用端口承接，要么由 run 承接；run 承接的任务必须是文本任务，且 run() 不能以 BAD_PARAMS 拒绝；
 * 3. 由专用端口承接的任务，run() 一律以 BAD_PARAMS 拒绝（不能两头都收）；
 * 4. 报价（offers）的任务集合与声明一致，经语言对接口承接的翻译必须带非空语言清单；
 * 5. 每个报价经 `native.ai.invoke` 分派，都落到同一个提供者、报价里写的那个端口；
 * 6. 会话类提供者的 [AiSessionControl.sessionModelId] 与它报给前端的 modelId 一致；
 * 7. 实现了 [TextGenerator] ⇔ 它 run 承接的任务报价都带 [AiConstraints.Generate]，且 Generate 只挂在 run 承接的任务上。
 */
class AiProviderContractTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 用替身服务构造与正式注册完全相同的提供者列表；文本模型文件写齐，run 能真正跑通 */
    private fun registered(): List<AiProvider> = AiFixtures.registered(tmp)

    /** run() 是否以 BAD_PARAMS 拒绝该任务（其他错误如 NOT_READY 不算拒绝） */
    private fun runRejects(p: AiProvider, task: AiTask): Boolean = try {
        runBlocking { p.run(task, "测试文本") }
        false
    } catch (e: BridgeException) {
        e.code == BridgeErrors.BAD_PARAMS
    }

    /**
     * 列出一个提供者违反契约的地方。
     *
     * @param p 提供者
     * @return 违规描述，空表示守约
     */
    private fun violations(p: AiProvider): List<String> {
        val out = mutableListOf<String>()
        val caps = p.capabilities()
        val dedicated = AiRouter.dedicatedTasks(p)
        dedicated.filter { it !in caps }.forEach { out += "${p.id} 实现了 ${it.wire} 的端口却没声明" }
        AiRouter.runTasks(p).forEach { t ->
            if (!t.isText) out += "${p.id} 声明了 ${t.wire}，没有专用端口而 run 只收文本"
            else if (runRejects(p, t)) out += "${p.id} 声明了 ${t.wire} 却既没实现端口、run 也不收"
        }
        dedicated.filter { !runRejects(p, it) }.forEach { out += "${p.id} 的 ${it.wire} 有专用端口，run 却也收" }
        out += offerViolations(p)
        return out
    }

    /**
     * 报价（offers）的契约：任务集合 == 声明的任务、不重复；约束只能挂在对应任务上；
     * 经 `native.ai.translate` 承接的翻译必须给出非空、且都在 [AiTranslatePolicy.LANGS] 里的语言清单。
     *
     * @param p 提供者
     * @return 违规描述
     */
    private fun offerViolations(p: AiProvider): List<String> {
        val out = mutableListOf<String>()
        val offers = p.offers()
        val tasks = offers.map { it.task }
        if (tasks.size != tasks.toSet().size) out += "${p.id} 的 offers 有重复任务"
        if (tasks.toSet() != p.capabilities()) out += "${p.id} 的 offers 任务 ${tasks.map { it.wire }} 与声明不一致"
        offers.forEach { o ->
            val c = o.constraints
            if (c is AiConstraints.Translate && o.task != AiTask.TRANSLATE) out += "${p.id} 的 ${o.task.wire} 挂了翻译约束"
            if (AiRouter.entryOf(p, o.task) == AiPort.Translate.entry) {
                val langs = (c as? AiConstraints.Translate)?.languages.orEmpty()
                if (langs.isEmpty()) out += "${p.id} 的 translate 走语言对接口却没给语言清单"
                langs.filter { it !in AiTranslatePolicy.LANGS }.forEach { out += "${p.id} 报了入口不收的语言 $it" }
            }
        }
        out += generateViolations(p)
        return out
    }

    /** 文本生成约束与 [TextGenerator] 端口必须同进同出：实现了端口的 run 任务都带约束，没实现的不得带 */
    private fun generateViolations(p: AiProvider): List<String> {
        val out = mutableListOf<String>()
        val runTasks = AiRouter.runTasks(p)
        p.offers().forEach { o ->
            val hasGen = o.constraints is AiConstraints.Generate
            if (hasGen && o.task !in runTasks) out += "${p.id} 的 ${o.task.wire} 不归 run 却挂了生成约束"
            if (hasGen && p !is TextGenerator) out += "${p.id} 的 ${o.task.wire} 挂了生成约束却没实现 TextGenerator"
            if (!hasGen && p is TextGenerator && o.task in runTasks) out += "${p.id} 实现了 TextGenerator，${o.task.wire} 却没带生成约束"
        }
        return out
    }

    @Test
    fun everyRegisteredProvider_keepsCapabilityPortContract() {
        val all = registered()
        assertEquals(
            listOf(IntentHandoffProvider.ID, LocalClipProvider.ID, LocalOcrProvider.ID, LocalNllbProvider.ID, LocalQwenProvider.ID, LocalCoupletProvider.ID, MattingMode.PORTRAIT.providerId, MattingMode.GENERAL.providerId),
            all.map { it.id },
        )
        assertEquals("id 不能重复", all.size, all.map { it.id }.toSet().size)
        all.forEach { p -> assertEquals("${p.id} 违反契约", emptyList<String>(), violations(p)) }
    }

    @Test
    fun everyDeclaredTask_isRoutableToItsProvider() {
        val all = registered()
        all.forEach { p ->
            p.capabilities().forEach { t ->
                val port = AiPort.dedicatedFor(t)?.takeIf { it.bind(p) != null } ?: AiPort.Run
                assertTrue("${p.id} 的 ${t.wire} 应能经 ${port.entry} 路由到", AiRouter.candidates(all, t, port).any { it.provider === p })
            }
        }
    }

    @Test
    fun translateRoutes_nllbByDefault_qwenWhenAsked_handoffOnlyViaRun() {
        val all = registered()
        assertEquals(listOf(LocalNllbProvider.ID, LocalQwenProvider.ID), AiRouter.candidates(all, AiTask.TRANSLATE, AiPort.Translate).map { it.provider.id })
        assertEquals(listOf(IntentHandoffProvider.ID), AiRouter.candidates(all, AiTask.TRANSLATE, AiPort.Run).map { it.provider.id })
    }

    @Test
    fun registeredLayers_matchFourLayerDecision() {
        // 决策 0005：识物、文字识别、NLLB 是专用小模型（L1），Qwen 是通用 LLM（L2），交接是本机 AI（L3）
        assertEquals(
            mapOf(
                IntentHandoffProvider.ID to AiLayer.L3,
                LocalClipProvider.ID to AiLayer.L1,
                LocalOcrProvider.ID to AiLayer.L1,
                LocalNllbProvider.ID to AiLayer.L1,
                LocalQwenProvider.ID to AiLayer.L2,
                LocalCoupletProvider.ID to AiLayer.L1,
                MattingMode.PORTRAIT.providerId to AiLayer.L1,
                MattingMode.GENERAL.providerId to AiLayer.L1,
            ),
            registered().associate { it.id to it.layer },
        )
    }

    @Test
    fun offers_entryFollowsImplementation_andTranslateLanguagesShared() {
        val byId = registered().associateBy { it.id }
        /** 某提供者某任务的入口 */
        fun entry(id: String, t: AiTask) = AiRouter.entryOf(byId.getValue(id), t)
        assertEquals(AiModule.METHOD_TRANSLATE, entry(LocalNllbProvider.ID, AiTask.TRANSLATE))
        assertEquals(AiModule.METHOD_TRANSLATE, entry(LocalQwenProvider.ID, AiTask.TRANSLATE))
        assertEquals(AiModule.METHOD_RUN, entry(LocalQwenProvider.ID, AiTask.SUMMARIZE))
        assertEquals(AiModule.METHOD_RUN, entry(IntentHandoffProvider.ID, AiTask.TRANSLATE))
        assertEquals(AiModule.METHOD_CLASSIFY, entry(LocalClipProvider.ID, AiTask.CLASSIFY_IMAGE))
        assertEquals(AiModule.METHOD_OCR, entry(LocalOcrProvider.ID, AiTask.OCR))
        assertEquals(AiModule.METHOD_COUPLET, entry(LocalCoupletProvider.ID, AiTask.COUPLET))
        assertEquals(AiModule.METHOD_MATTING, entry(MattingMode.PORTRAIT.providerId, AiTask.MATTING))
        assertEquals(AiModule.METHOD_MATTING, entry(MattingMode.GENERAL.providerId, AiTask.MATTING))
        /** 某提供者 translate 报价的约束 */
        fun tr(id: String) = byId.getValue(id).offers().first { it.task == AiTask.TRANSLATE }.constraints
        // 语言清单与 auto 规则相同；Qwen 的原文上限更小、不收 numBeams
        assertEquals(AiConstraints.Translate(AiTranslatePolicy.LANGS, true), tr(LocalNllbProvider.ID))
        assertEquals(
            AiConstraints.Translate(AiTranslatePolicy.LANGS, true, AiQwenPolicy.MAX_TRANSLATE_CHARS, allowNumBeams = false),
            tr(LocalQwenProvider.ID),
        )
        // 交接没有语言对接口，翻译经 run 交出去，不带语言清单
        assertNull(tr(IntentHandoffProvider.ID))
    }

    /** 按入口给一份结构合法的 invoke 输入 */
    private fun sampleInput(entry: String, providerId: String): JSONObject = when (entry) {
        AiModule.METHOD_TRANSLATE -> JSONObject().put("text", "hi").put("src", "en").put("tgt", "fr")
        AiModule.METHOD_CLASSIFY, AiModule.METHOD_OCR -> JSONObject().put("path", "cache/pick/a.jpg")
        AiModule.METHOD_COUPLET -> JSONObject().put("text", "春风送暖")
        // 抠图的 mode 与提供者一一对应，样例按提供者给
        AiModule.METHOD_MATTING -> JSONObject().put("path", "cache/pick/a.jpg")
            .put("mode", MattingMode.values().first { it.providerId == providerId }.wire)
        else -> JSONObject().put("text", "hi")
    }

    @Test
    fun everyOffer_invokeReachesSameProviderAndPort() {
        val all = registered()
        val invoker = AiInvoker({ all }, SourceResolver { null })
        all.forEach { p ->
            val offers = AiPolicy.offersJson(p)
            for (i in 0 until offers.length()) {
                val o = offers.getJSONObject(i)
                val entry = o.getString("entry")
                val params = JSONObject().put("task", o.getString("task")).put("provider", p.id).put("input", sampleInput(entry, p.id))
                val plan = invoker.plan(params)
                assertSame("${p.id} 的 ${o.getString("task")} 应到它自己", p, plan.provider)
                assertEquals("${p.id} 的 ${o.getString("task")} 应走报价里的入口", entry, plan.port.entry)
                // 显式钉住同一个入口，结果不变
                assertSame(p, invoker.plan(JSONObject(params.toString()).put("entry", entry)).provider)
            }
        }
    }

    @Test
    fun sessionModelId_matchesModelInfo() {
        val all = AiFixtures.registered(tmp, ModelStateSource { ModelStateInfo(installed = false, diskBytes = 0, downloading = false) })
        val sessions = all.mapNotNull { p -> AiPort.Session.bind(p)?.let { p to it } }
        assertEquals(listOf(LocalClipProvider.ID, LocalOcrProvider.ID, LocalNllbProvider.ID, LocalQwenProvider.ID, LocalCoupletProvider.ID, MattingMode.PORTRAIT.providerId, MattingMode.GENERAL.providerId), sessions.map { it.first.id })
        // 删模型前卸会话靠 sessionModelId，它必须就是 providers 里报给前端的 modelId
        sessions.forEach { (p, s) -> assertEquals("${p.id} 的会话模型", p.modelInfo()?.modelId, s.sessionModelId) }
    }

    /** 说谎者 4：报价比声明少一个任务 */
    private class OfferMissing : AiProvider {
        override val id = "liar-offers"
        override val displayName = "说谎"
        override val layer = AiLayer.L3
        override fun capabilities() = setOf(AiTask.SUMMARIZE, AiTask.PROMPT)
        override fun offers() = listOf(AiOffer(AiTask.SUMMARIZE))
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult = AiRunResult.Text("")
    }

    /** 说谎者 5：走语言对接口的翻译，却不报语言清单（用默认 offers） */
    private class TranslatorWithoutLanguages : AiProvider, TextTranslator {
        override val id = "liar-langs"
        override val displayName = "说谎"
        override val layer = AiLayer.L1
        override fun capabilities() = setOf(AiTask.TRANSLATE)
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult = throw AiRouter.notRunnable(id, task)
        override suspend fun translate(req: AiTranslateRequest): TranslateResult = throw UnsupportedOperationException()
    }

    /** 说谎者 1：声明识图，却没实现 ImageClassifier，run 也不收 */
    private class ClaimsClassify : AiProvider {
        override val id = "liar-classify"
        override val displayName = "说谎"
        override val layer = AiLayer.L1
        override fun capabilities() = setOf(AiTask.CLASSIFY_IMAGE)
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult = throw AiRouter.notRunnable(id, task)
    }

    /** 说谎者 6：实现了 OcrEngine，却没声明 ocr（新增任务时最容易漏的一步） */
    private class HiddenOcr : AiProvider, OcrEngine {
        override val id = "liar-ocr"
        override val displayName = "说谎"
        override val layer = AiLayer.L1
        override fun capabilities() = setOf(AiTask.PROMPT)
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult =
            if (task == AiTask.PROMPT) AiRunResult.Text("") else throw AiRouter.notRunnable(id, task)
        override suspend fun recognize(file: java.io.File): OcrResult = throw UnsupportedOperationException()
    }

    /** 说谎者 8：实现了 MattingEngine，却没声明 matting */
    private class HiddenMatting : AiProvider, MattingEngine {
        override val id = "liar-matting"
        override val displayName = "说谎"
        override val layer = AiLayer.L1
        override fun capabilities() = setOf(AiTask.PROMPT)
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult =
            if (task == AiTask.PROMPT) AiRunResult.Text("") else throw AiRouter.notRunnable(id, task)
        override suspend fun matte(file: java.io.File): MattingResult = throw UnsupportedOperationException()
    }

    /** 说谎者 7：实现了 CoupletEngine，却没声明 couplet */
    private class HiddenCouplet : AiProvider, CoupletEngine {
        override val id = "liar-couplet"
        override val displayName = "说谎"
        override val layer = AiLayer.L1
        override fun capabilities() = setOf(AiTask.PROMPT)
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult =
            if (task == AiTask.PROMPT) AiRunResult.Text("") else throw AiRouter.notRunnable(id, task)
        override suspend fun generate(req: AiCoupletRequest): CoupletResult = throw UnsupportedOperationException()
    }

    /** 说谎者 2：实现了 TextTranslator，却没声明 translate */
    private class HiddenTranslator : AiProvider, TextTranslator {
        override val id = "liar-translate"
        override val displayName = "说谎"
        override val layer = AiLayer.L1
        override fun capabilities() = setOf(AiTask.PROMPT)
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult =
            if (task == AiTask.PROMPT) AiRunResult.Text("") else throw AiRouter.notRunnable(id, task)
        override suspend fun translate(req: AiTranslateRequest): TranslateResult = throw UnsupportedOperationException()
    }

    /** 说谎者 3：声明了文本任务，run 却拒收 */
    private class ClaimsSummarize : AiProvider {
        override val id = "liar-run"
        override val displayName = "说谎"
        override val layer = AiLayer.L3
        override fun capabilities() = setOf(AiTask.SUMMARIZE)
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult = throw AiRouter.notRunnable(id, task)
    }

    /** 说谎者 7：报了生成约束，却没实现 TextGenerator（页面传的预设会被静默忽略） */
    private class GenerateWithoutPort : AiProvider {
        override val id = "liar-generate"
        override val displayName = "说谎"
        override val layer = AiLayer.L3
        override fun capabilities() = setOf(AiTask.PROMPT)
        override fun offers() = listOf(AiOffer(AiTask.PROMPT, AiQwenPolicy.OFFER_GENERATE))
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult = AiRunResult.Text("")
    }

    /** 说谎者 8：实现了 TextGenerator，文本任务的报价却没带生成约束 */
    private class GeneratorWithoutConstraint : AiProvider, TextGenerator {
        override val id = "liar-generator"
        override val displayName = "说谎"
        override val layer = AiLayer.L2
        override fun capabilities() = setOf(AiTask.PROMPT)
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult = AiRunResult.Text("")
        override suspend fun generate(task: AiTask, input: String, opts: AiGenOptions): AiRunResult = AiRunResult.Text("")
    }

    @Test
    fun generateOffers_reachSameProviderViaInvokeWithOptions() {
        val all = registered()
        val inv = AiInvoker({ all }, SourceResolver { null })
        val gen = all.filter { it is TextGenerator }
        assertEquals(listOf(LocalQwenProvider.ID), gen.map { it.id })
        gen.forEach { p ->
            AiRouter.runTasks(p).forEach { t ->
                val c = p.offers().first { it.task == t }.constraints
                assertEquals("${p.id} 的 ${t.wire} 应带生成约束", AiQwenPolicy.OFFER_GENERATE, c)
                // 带预设与采样参数的 invoke 仍落到同一个提供者的 run 入口，且能通过它自己的约束
                val params = JSONObject().put("task", t.wire).put("provider", p.id).put("input", JSONObject().put("text", "hi"))
                    .put("options", JSONObject().put("preset", t.wire).put("temperature", 0.5).put("topK", 10))
                assertSame(p, inv.plan(params).provider)
                assertEquals(AiModule.METHOD_RUN, inv.plan(params).port.entry)
                val r = runBlocking { inv.invoke(params) }
                assertEquals(AiFixtures.QWEN_OUT, r.getString("text"))
            }
        }
    }

    @Test
    fun checker_catchesLies() {
        assertEquals(1, violations(GenerateWithoutPort()).size)
        assertEquals(1, violations(GeneratorWithoutConstraint()).size)
        assertEquals(1, violations(ClaimsClassify()).size)
        assertEquals(1, violations(HiddenTranslator()).size)
        assertEquals(1, violations(ClaimsSummarize()).size)
        assertEquals(1, violations(OfferMissing()).size)
        assertEquals(1, violations(TranslatorWithoutLanguages()).size)
        assertEquals(1, violations(HiddenOcr()).size)
        assertEquals(1, violations(HiddenCouplet()).size)
        assertEquals(1, violations(HiddenMatting()).size)
    }

    @Test
    fun ocrProvider_isL1SessionBoundToItsModel_andRunNeverAcceptsOcr() {
        val p = registered().first { it.id == LocalOcrProvider.ID }
        assertEquals(setOf(AiTask.OCR), p.capabilities())
        assertEquals(setOf(AiTask.OCR), AiRouter.dedicatedTasks(p))
        assertEquals(emptySet<AiTask>(), AiRouter.runTasks(p))
        assertEquals(OcrService.MODEL_ID, (p as AiSessionControl).sessionModelId)
        assertTrue(runRejects(p, AiTask.OCR))
    }

    @Test
    fun mattingProviders_areL1SessionsBoundToTheirOwnModels_andRunNeverAcceptsMatting() {
        MattingMode.values().forEach { mode ->
            val p = registered().first { it.id == mode.providerId }
            assertEquals(setOf(AiTask.MATTING), p.capabilities())
            assertEquals(setOf(AiTask.MATTING), AiRouter.dedicatedTasks(p))
            assertEquals(emptySet<AiTask>(), AiRouter.runTasks(p))
            assertEquals(mode.modelId, (p as AiSessionControl).sessionModelId)
            assertTrue(runRejects(p, AiTask.MATTING))
        }
    }

    @Test
    fun coupletProvider_isL1SessionBoundToItsModel_withOwnConstraints_andRunNeverAcceptsCouplet() {
        val p = registered().first { it.id == LocalCoupletProvider.ID }
        assertEquals(setOf(AiTask.COUPLET), p.capabilities())
        assertEquals(setOf(AiTask.COUPLET), AiRouter.dedicatedTasks(p))
        assertEquals(emptySet<AiTask>(), AiRouter.runTasks(p))
        assertEquals(CoupletService.MODEL_ID, (p as AiSessionControl).sessionModelId)
        assertEquals(AiCoupletPolicy.OFFER_CONSTRAINTS, p.offers().single().constraints)
        assertTrue(runRejects(p, AiTask.COUPLET))
    }
}
