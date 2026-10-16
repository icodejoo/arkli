package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.image.SourceResolver
import kotlinx.coroutines.runBlocking
import com.let188.arkli.model.ModelStateInfo
import com.let188.arkli.model.ModelStateSource
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** `native.ai.invoke`：端到端分派、按提供者约束校验、与旧入口错误一致 */
class AiInvokeTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 替身翻译约束：故意与全局 LANGS 不同（含德语、源语言不许 auto），验证路由不写死语言 */
    private val omniLangs = AiConstraints.Translate(listOf("en", "fr", "de"), sourceAuto = false)

    /** 全能替身：三个端口都实现，记录每次落到哪个入口、收到的翻译请求与 topK */
    private inner class Omni(override val id: String = "omni") : AiProvider, TextTranslator, ImageClassifier {
        /** 落到的入口，按调用顺序 */
        val hits = mutableListOf<String>()

        /** 最近一次翻译请求 */
        var lastReq: AiTranslateRequest? = null

        /** 最近一次 topK */
        var lastTopK = 0

        override val displayName = "全能替身"
        override val layer = AiLayer.L1
        override fun capabilities() = setOf(AiTask.SUMMARIZE, AiTask.TRANSLATE, AiTask.CLASSIFY_IMAGE)
        override fun offers() = listOf(AiOffer(AiTask.SUMMARIZE), AiOffer(AiTask.TRANSLATE, omniLangs), AiOffer(AiTask.CLASSIFY_IMAGE))
        override fun availability() = AiAvailability.AVAILABLE

        override suspend fun run(task: AiTask, input: String): AiRunResult {
            if (task != AiTask.SUMMARIZE) throw AiRouter.notRunnable(id, task)
            hits += AiModule.METHOD_RUN
            return AiRunResult.Text("sum:$input")
        }

        override suspend fun translate(req: AiTranslateRequest): TranslateResult {
            hits += AiModule.METHOD_TRANSLATE
            lastReq = req
            return TranslateResult("tr:${req.text}", 1, "omni-model", req.src, req.tgt)
        }

        override suspend fun classify(file: File, topK: Int): ClassifyResult {
            hits += AiModule.METHOD_CLASSIFY
            lastTopK = topK
            val vocab = ClipVocabMeta(1, listOf(ClipVocabItem("cup", "杯子", "cup", "R")), mapOf("R" to "可回收物"), "")
            return ClassifyResult(vocab, ClassifyOutcome(listOf(ClassifyHit(0, 0.5f)), listOf(CategoryProb("R", 1f)), 1f, false), "omni-model", 2, 1)
        }
    }

    /** 交接式替身：声明了翻译但没有语言对接口，翻译经 run 承接 */
    private class RunTranslator : AiProvider {
        /** 落到的入口 */
        val hits = mutableListOf<String>()
        override val id = "run-translator"
        override val displayName = "交接替身"
        override val layer = AiLayer.L3
        override fun capabilities() = setOf(AiTask.TRANSLATE)
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult {
            hits += AiModule.METHOD_RUN
            return AiRunResult.Handoff(true)
        }
    }

    /** 一张真实存在的缓存图片 */
    private fun image(): File = tmp.newFile("a.jpg").apply { writeBytes(byteArrayOf(1)) }

    /** 造分派器：路径一律解析到 [file]（null 表示解析失败） */
    private fun invoker(all: List<AiProvider>, file: File? = null) = AiInvoker({ all }, SourceResolver { file })

    /** 拼 invoke 参数 */
    private fun params(task: String, input: JSONObject, provider: String? = null, entry: String? = null, options: JSONObject? = null): JSONObject {
        val o = JSONObject().put("task", task).put("input", input)
        provider?.let { o.put("provider", it) }
        entry?.let { o.put("entry", it) }
        options?.let { o.put("options", it) }
        return o
    }

    /** 翻译输入 */
    private fun tr(src: String = "en", tgt: String = "fr") = JSONObject().put("text", "hi").put("src", src).put("tgt", tgt)

    /** 文本输入 */
    private fun text() = JSONObject().put("text", "hi")

    /** 跑一段挂起代码，返回它抛的桥错误（码 + 文案）；没抛就失败 */
    private fun err(block: suspend () -> Unit): Pair<String, String> = try {
        runBlocking { block() }
        fail("应当抛 BridgeException")
        error("unreachable")
    } catch (e: BridgeException) {
        e.code to e.message.orEmpty()
    }

    @Test
    fun everyOffer_dispatchReachesReportedPort() {
        val omni = Omni()
        val handoff = RunTranslator()
        val all = listOf(handoff, omni)
        val inv = invoker(all, image())
        val inputs = mapOf(
            AiModule.METHOD_RUN to text(),
            AiModule.METHOD_TRANSLATE to tr(),
            AiModule.METHOD_CLASSIFY to JSONObject().put("path", "cache/pick/a.jpg"),
        )
        for (p in all) {
            val offers = AiPolicy.offersJson(p)
            for (i in 0 until offers.length()) {
                val o = offers.getJSONObject(i)
                val entry = o.getString("entry")
                runBlocking { inv.invoke(params(o.getString("task"), inputs.getValue(entry), provider = p.id)) }
                val hits = if (p === omni) omni.hits else handoff.hits
                assertEquals("${p.id} 的 ${o.getString("task")}", entry, hits.last())
            }
        }
        assertEquals(listOf(AiModule.METHOD_RUN, AiModule.METHOD_TRANSLATE, AiModule.METHOD_CLASSIFY), omni.hits)
        assertEquals(listOf(AiModule.METHOD_RUN), handoff.hits)
    }

    @Test
    fun noProvider_usesCanonicalPort() {
        val omni = Omni()
        val handoff = RunTranslator()
        val inv = invoker(listOf(handoff, omni))
        // 交接排在前面，但它的翻译不走语言对端口，缺省翻译仍落到 omni 的专用端口
        assertSame(omni, inv.plan(params("translate", tr())).provider)
        assertEquals(AiPort.Translate, inv.plan(params("translate", tr())).port)
        // 要交接必须点名（钉住 run 但不点名也不行：缺省只在本地层里选）
        assertSame(handoff, inv.plan(params("translate", text(), provider = handoff.id, entry = AiModule.METHOD_RUN)).provider)
        assertEquals(BridgeErrors.BAD_PARAMS, err { inv.plan(params("translate", text(), entry = AiModule.METHOD_RUN)) }.first)
        assertEquals(AiPort.Run, inv.plan(params("summarize", text())).port)
        assertSame(omni, inv.plan(params("summarize", text())).provider)
    }

    /** 全部正式提供者（交接排第一）+ Qwen 未安装的模型状态 */
    private fun registeredNotInstalled() =
        AiFixtures.registered(tmp, ModelStateSource { ModelStateInfo(installed = false, diskBytes = 0, downloading = false) })

    @Test
    fun noProvider_neverFallsBackToHandoff() {
        val all = AiFixtures.registered(tmp)
        val inv = invoker(all)
        // 正式注册里交接排第一，但缺省的文本任务只会落到本地 Qwen
        for (t in listOf("summarize", "proofread", "rewrite", "prompt")) {
            assertEquals(t, LocalQwenProvider.ID, inv.plan(params(t, text())).provider.id)
        }
        // 翻译缺省走 L1 的 NLLB（专用端口）
        assertEquals(LocalNllbProvider.ID, inv.plan(params("translate", tr())).provider.id)
        // 要交接必须点名
        assertEquals(IntentHandoffProvider.ID, inv.plan(params("summarize", text(), provider = IntentHandoffProvider.ID)).provider.id)
    }

    @Test
    fun noProvider_localNotReady_isNotReadyNotHandoff() {
        val inv = invoker(registeredNotInstalled())
        // Qwen 没装：报 NOT_READY，而不是悄悄把文本交给第三方应用
        assertEquals(BridgeErrors.NOT_READY, err { inv.invoke(params("summarize", text())) }.first)
        assertEquals(BridgeErrors.NOT_READY, err { inv.invoke(params("translate", tr())) }.first)
        // 点名交接仍然可以
        assertTrue(runBlocking { inv.invoke(params("summarize", text(), provider = IntentHandoffProvider.ID)) }.getBoolean("handoff"))
    }

    @Test
    fun noProvider_onlyHandoffCandidate_isBadParams() {
        val inv = invoker(listOf(RunTranslator()))
        val e = err { inv.invoke(params("translate", text().put("src", "en").put("tgt", "fr"), entry = AiModule.METHOD_RUN)) }
        assertEquals(BridgeErrors.BAD_PARAMS, e.first)
        assertTrue(e.second, e.second.contains("显式指定 provider"))
    }

    @Test
    fun noProvider_generateOptions_landOnGenerativeLocalProvider() {
        // 非生成式的本地提供者排在前面，也不能被带 temperature 的调用选中
        val all = listOf(IntentHandoffProvider(AiFixtures.OkHandoff()), Omni()) + AiFixtures.registered(tmp).filter { it.id == LocalQwenProvider.ID }
        val inv = invoker(all)
        val opts = JSONObject().put("temperature", 0.3).put("preset", "rewrite")
        assertEquals(LocalQwenProvider.ID, inv.plan(params("summarize", text(), options = opts)).provider.id)
        // 没带选项时按注册顺序取第一个本地候选（Omni）
        assertEquals("omni", inv.plan(params("summarize", text())).provider.id)
    }

    @Test
    fun generateOptions_onNonRunPorts_areBadParams() {
        val inv = invoker(listOf(Omni()), image())
        val cls = JSONObject().put("path", "cache/pick/a.jpg")
        for (k in listOf("preset" to "rewrite", "system" to "x", "temperature" to 0.5)) {
            val o = JSONObject().put(k.first, k.second)
            assertEquals(k.first, BridgeErrors.BAD_PARAMS, err { inv.invoke(params("translate", tr(), options = o)) }.first)
            assertEquals(k.first, BridgeErrors.BAD_PARAMS, err { inv.invoke(params("classifyImage", cls, options = o)) }.first)
        }
        // topK 对翻译无意义要报错，对识图是前 K 个类别、合法
        assertEquals(BridgeErrors.BAD_PARAMS, err { inv.invoke(params("translate", tr(), options = JSONObject().put("topK", 3))) }.first)
        runBlocking { inv.invoke(params("classifyImage", cls, options = JSONObject().put("topK", 3))) }
    }

    @Test
    fun qwenTranslate_tooLong_orNumBeams_areBadParams() {
        val inv = invoker(AiFixtures.registered(tmp))
        val long = JSONObject().put("text", "字".repeat(AiQwenPolicy.MAX_TRANSLATE_CHARS + 1)).put("src", "zh-CN").put("tgt", "en")
        val e = err { inv.invoke(params("translate", long, provider = LocalQwenProvider.ID)) }
        assertEquals(BridgeErrors.BAD_PARAMS, e.first)
        assertTrue(e.second, e.second.contains("最多翻译 ${AiQwenPolicy.MAX_TRANSLATE_CHARS} 字") && e.second.contains("本地翻译模型"))
        // 刚好到上限放行
        val ok = JSONObject().put("text", "字".repeat(AiQwenPolicy.MAX_TRANSLATE_CHARS)).put("src", "zh-CN").put("tgt", "en")
        assertEquals(AiFixtures.QWEN_OUT, runBlocking { inv.invoke(params("translate", ok, provider = LocalQwenProvider.ID)) }.getString("text"))
        // NLLB 的上限仍是入口的 2000，不被 Qwen 的收紧牵连
        assertEquals(AiTranslatePolicy.MAX_TEXT, AiTranslatePolicy.OFFER_CONSTRAINTS.maxChars)
        // Qwen 没有束搜索：传 numBeams 报错而不是静默忽略
        val beams = JSONObject().put("numBeams", 2)
        assertEquals(BridgeErrors.BAD_PARAMS, err { inv.invoke(params("translate", tr(), provider = LocalQwenProvider.ID, options = beams)) }.first)
    }

    @Test
    fun translateOffer_json_carriesMaxCharsAndBeams() {
        val j = AiQwenPolicy.OFFER_TRANSLATE.toJson()
        assertEquals(AiQwenPolicy.MAX_TRANSLATE_CHARS, j.getInt("maxChars"))
        assertFalse(j.getBoolean("allowNumBeams"))
        assertEquals(AiTranslatePolicy.MAX_TEXT, AiTranslatePolicy.OFFER_CONSTRAINTS.toJson().getInt("maxChars"))
    }

    @Test
    fun translateLanguages_followSelectedProviderConstraint() {
        val omni = Omni()
        val all = AiFixtures.registered(tmp) + omni
        val inv = invoker(all)
        // omni 报了德语：放行；全局 LANGS 没有德语也不影响
        val r = runBlocking { inv.invoke(params("translate", tr("de", "en"), provider = omni.id)) }
        assertEquals("tr:hi", r.getString("text"))
        // omni 不许 auto
        assertEquals(BridgeErrors.BAD_PARAMS, err { inv.invoke(params("translate", tr("auto", "en"), provider = omni.id)) }.first)
        // 旧入口同理：按选中提供者校验
        assertEquals("tr:hi", runBlocking { inv.dispatch(AiCall.Translate(AiTranslatePolicy.parse(tr("de", "en").put("provider", omni.id)))) }.getString("text"))
        // Qwen 的约束没有德语
        assertEquals(BridgeErrors.BAD_PARAMS, err { inv.invoke(params("translate", tr("de", "en"), provider = LocalQwenProvider.ID)) }.first)
    }

    @Test
    fun badLanguage_reportedBeforeNotReady() {
        val inv = invoker(AiFixtures.registered(tmp))
        // NLLB 没装：语言不合法仍先报 BAD_PARAMS（与改造前 parse 阶段就拒的顺序一致）
        val e = err { inv.invoke(params("translate", tr("de", "en"), provider = LocalNllbProvider.ID)) }
        assertEquals(BridgeErrors.BAD_PARAMS, e.first)
        assertTrue(e.second, e.second.startsWith("src 不支持：de"))
        assertEquals(BridgeErrors.NOT_READY, err { inv.invoke(params("translate", tr(), provider = LocalNllbProvider.ID)) }.first)
    }

    @Test
    fun options_mergeIntoPortInput() {
        val omni = Omni()
        val inv = invoker(listOf(omni), image())
        runBlocking { inv.invoke(params("translate", tr(), options = JSONObject().put("numBeams", 3))) }
        assertEquals(3, omni.lastReq?.numBeams)
        val j = runBlocking { inv.invoke(params("classifyImage", JSONObject().put("path", "cache/pick/a.jpg"), options = JSONObject().put("topK", 7))) }
        assertEquals(7, omni.lastTopK)
        assertEquals("cup", j.getJSONArray("items").getJSONObject(0).getString("id"))
    }

    @Test
    fun invokeShapeErrors_areBadParams() {
        val inv = invoker(listOf(Omni()))
        val bad = listOf(
            JSONObject().put("task", "summarize"),
            JSONObject().put("task", "summarize").put("input", "hi"),
            params("summarize", text(), options = JSONObject().put("text", "x")),
            params("translate", tr().put("provider", "omni")),
            params("summarize", text(), entry = "native.ai.nope"),
            params("summarize", text(), entry = AiModule.METHOD_WARMUP),
            params("summarize", text(), entry = AiModule.METHOD_TRANSLATE),
            params("summarize", text()).put("options", 1),
            params("summarize", text()).put("entry", 1),
            params("summarize", text(), provider = ""),
            params("summarize", JSONObject().put("text", "   ")),
        )
        bad.forEach { p -> assertEquals(p.toString(), BridgeErrors.BAD_PARAMS, err { inv.invoke(p) }.first) }
    }

    @Test
    fun errors_matchLegacyEntries() {
        val all = AiFixtures.registered(tmp)
        val inv = invoker(all)
        /** 旧 translate 入口的处理流程（与 AiTranslateHandler 一致） */
        fun oldTranslate(p: JSONObject) = err { inv.dispatch(AiCall.Translate(AiTranslatePolicy.parse(p))) }
        /** 旧 classify 入口 */
        fun oldClassify(p: JSONObject) = err { inv.dispatch(AiCall.Classify(AiClassifyPolicy.parse(p))) }
        /** 旧 run 入口 */
        fun oldRun(p: JSONObject) = err { AiPolicy.parseRun(p).let { inv.dispatch(AiCall.Run(it.task, it.provider, it.input)) } }
        /** invoke */
        fun newCall(p: JSONObject) = err { inv.invoke(p) }

        val cases = listOf(
            // 未知提供者
            newCall(params("translate", tr(), provider = "nope")) to oldTranslate(tr().put("provider", "nope")),
            // 提供者不支持该任务
            newCall(params("classifyImage", JSONObject().put("path", "p"), provider = LocalNllbProvider.ID)) to
                oldClassify(JSONObject().put("path", "p").put("provider", LocalNllbProvider.ID)),
            // 走错入口：交接没有语言对接口
            newCall(params("translate", tr(), provider = IntentHandoffProvider.ID, entry = AiModule.METHOD_TRANSLATE)) to
                oldTranslate(tr().put("provider", IntentHandoffProvider.ID)),
            // 走错入口：Qwen 的翻译不走 run
            newCall(params("translate", text(), provider = LocalQwenProvider.ID, entry = AiModule.METHOD_RUN)) to
                oldRun(JSONObject().put("provider", LocalQwenProvider.ID).put("task", "translate").put("input", "hi")),
            // 未就绪
            newCall(params("translate", tr(), provider = LocalNllbProvider.ID)) to oldTranslate(tr().put("provider", LocalNllbProvider.ID)),
            newCall(params("translate", tr())) to oldTranslate(tr()),
            newCall(params("classifyImage", JSONObject().put("path", "p"))) to oldClassify(JSONObject().put("path", "p")),
            // 未知任务、要图片输入的任务
            newCall(params("dance", text(), provider = "p")) to oldRun(JSONObject().put("provider", "p").put("task", "dance").put("input", "hi")),
            newCall(params("describeImage", text(), provider = "p")) to
                oldRun(JSONObject().put("provider", "p").put("task", "describeImage").put("input", "hi")),
        )
        cases.forEach { (now, old) -> assertEquals(old, now) }
        // 关键文案钉住，确认与改造前一致
        assertEquals(BridgeErrors.BAD_PARAMS to "未知的 provider：nope", cases[0].first)
        assertEquals(BridgeErrors.BAD_PARAMS to "local-nllb 不支持 classifyImage", cases[1].first)
        assertEquals(BridgeErrors.BAD_PARAMS to "intent-handoff 的 translate 不走 native.ai.translate", cases[2].first)
        assertEquals(BridgeErrors.BAD_PARAMS to "local-qwen 的 translate 不走 native.ai.run，请用 native.ai.translate", cases[3].first)
        assertEquals(BridgeErrors.NOT_READY to "local-nllb 当前不可用：not_installed", cases[4].first)
        assertEquals(BridgeErrors.NOT_READY to "local-clip 当前不可用：not_installed", cases[6].first)
    }

    @Test
    fun ocr_invokeAndLegacyEntryAgree_andWrongEntryIsRejected() {
        val all = AiFixtures.registered(tmp)
        val inv = invoker(all, image())
        val path = JSONObject().put("path", "cache/pick/a.jpg")
        /** 旧入口 native.ai.ocr 的处理流程（与 AiOcrHandler 一致） */
        fun oldOcr(p: JSONObject) = err { inv.dispatch(AiCall.Ocr(AiOcrPolicy.parse(p))) }
        // 未就绪：错误码与文案同识图、翻译一致，invoke 与旧入口完全相同
        val notReady = err { inv.invoke(params("ocr", path, provider = LocalOcrProvider.ID)) }
        assertEquals(BridgeErrors.NOT_READY to "local-ocr 当前不可用：not_installed", notReady)
        assertEquals(notReady, oldOcr(JSONObject().put("path", "cache/pick/a.jpg").put("provider", LocalOcrProvider.ID)))
        assertEquals(notReady.first, err { inv.invoke(params("ocr", path)) }.first)
        // 缺省端口是专用端口，不走 run
        assertEquals(AiPort.Ocr, inv.plan(params("ocr", path)).port)
        // 走错入口：钉住 run / translate 都报错
        val viaRun = err { inv.invoke(params("ocr", JSONObject().put("text", "hi"), provider = LocalOcrProvider.ID, entry = AiModule.METHOD_RUN)) }
        assertEquals(BridgeErrors.BAD_PARAMS, viaRun.first)
        assertEquals(BridgeErrors.BAD_PARAMS, err { inv.invoke(params("ocr", path, entry = AiModule.METHOD_TRANSLATE)) }.first)
        // 别的提供者不支持 ocr
        assertEquals(BridgeErrors.BAD_PARAMS to "local-nllb 不支持 ocr", err { inv.invoke(params("ocr", path, provider = LocalNllbProvider.ID)) })
        // 路径解析不到文件：BAD_PARAMS
        val bad = invoker(listOf(OcrOmni()), null)
        assertEquals(BridgeErrors.BAD_PARAMS, err { bad.invoke(params("ocr", path)) }.first)
    }

    /** 文字识别替身：恒可用，回固定一行 */
    private class OcrOmni : AiProvider, OcrEngine {
        override val id = "ocr-omni"
        override val displayName = "识字替身"
        override val layer = AiLayer.L1
        override fun capabilities() = setOf(AiTask.OCR)
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult = throw AiRouter.notRunnable(id, task)
        override suspend fun recognize(file: File): OcrResult = OcrResult(
            OcrOutcome(100, 50, listOf(OcrLine(listOf(OcrPoint(1f, 2f), OcrPoint(9f, 2f), OcrPoint(9f, 8f), OcrPoint(1f, 8f)), "你好", 0.98767f)), 7),
            "ocr-model", 12, 7,
        )
    }

    @Test
    fun ocr_resultJsonShape() {
        val inv = invoker(listOf(OcrOmni()), image())
        val j = runBlocking { inv.invoke(params("ocr", JSONObject().put("path", "cache/pick/a.jpg"))) }
        val b = j.getJSONArray("blocks").getJSONObject(0)
        assertEquals("你好", b.getString("text"))
        assertEquals(8, b.getJSONArray("box").length())
        assertEquals(0.9877, b.getDouble("score"), 1e-9)
        assertEquals(100, j.getInt("width"))
        assertEquals(50, j.getInt("height"))
        assertEquals("ocr-model", j.getString("modelId"))
        assertEquals(runBlocking { inv.dispatch(AiCall.Ocr(AiOcrPolicy.parse(JSONObject().put("path", "cache/pick/a.jpg")))) }.toString(), j.toString())
    }

    @Test
    fun results_matchLegacyEntries() {
        val all = AiFixtures.registered(tmp)
        val inv = invoker(all)
        val now = runBlocking { inv.invoke(params("summarize", text(), provider = LocalQwenProvider.ID)) }
        val old = runBlocking { inv.dispatch(AiCall.Run(AiTask.SUMMARIZE, LocalQwenProvider.ID, "hi")) }
        assertEquals(old.toString(), now.toString())
        assertFalse(now.getBoolean("handoff"))
        assertEquals(AiFixtures.QWEN_OUT, now.getString("text"))
        val t = runBlocking { inv.invoke(params("translate", tr(), provider = LocalQwenProvider.ID)) }
        assertEquals(QwenService.MODEL_ID, t.getString("modelId"))
        // 只点名交接、不钉入口：按它报价的 entry（run）交接出去
        val h = runBlocking { inv.invoke(params("translate", tr(), provider = IntentHandoffProvider.ID)) }
        assertTrue(h.getBoolean("handoff"))
    }

    @Test
    fun classify_badPath_isBadParams() {
        val inv = invoker(listOf(Omni()), null)
        assertEquals(
            BridgeErrors.BAD_PARAMS to "path 不是有效的缓存图片路径",
            err { inv.invoke(params("classifyImage", JSONObject().put("path", "cache/../x.jpg"))) },
        )
    }

    /** 对联替身：恒可用，记录收到的请求，回固定下联 */
    private class CoupletOmni : AiProvider, CoupletEngine {
        override val id = "couplet-omni"
        var last: AiCoupletRequest? = null
        override val displayName = "对联替身"
        override val layer = AiLayer.L1
        override fun capabilities() = setOf(AiTask.COUPLET)
        override fun offers() = listOf(AiOffer(AiTask.COUPLET, AiCoupletPolicy.OFFER_CONSTRAINTS))
        override fun availability() = AiAvailability.AVAILABLE
        override suspend fun run(task: AiTask, input: String): AiRunResult = throw AiRouter.notRunnable(id, task)
        override suspend fun generate(req: AiCoupletRequest): CoupletResult {
            last = req
            return CoupletResult("春满乾坤福满门", 9, "couplet-model")
        }
    }

    @Test
    fun couplet_invokeAndLegacyEntryAgree_resultShapeAndConstraints() {
        val p = CoupletOmni()
        val inv = invoker(listOf(p))
        val input = JSONObject().put("text", "天增岁月人增寿")
        // 缺省端口是对联专用端口，options 里的 temperature / topK / seed 进到强类型请求
        assertEquals(AiPort.Couplet, inv.plan(params("couplet", input)).port)
        val opts = JSONObject().put("temperature", 0).put("topK", 5).put("seed", 3)
        val j = runBlocking { inv.invoke(params("couplet", input, options = opts)) }
        assertEquals("春满乾坤福满门", j.getString("text"))
        assertEquals("couplet-model", j.getString("modelId"))
        assertEquals(AiCoupletRequest(null, "天增岁月人增寿", 0f, 5, 3L), p.last)
        // 旧入口 native.ai.couplet 同一份结果
        val flat = JSONObject().put("text", "天增岁月人增寿").put("temperature", 0).put("topK", 5).put("seed", 3)
        assertEquals(j.toString(), runBlocking { inv.dispatch(AiCall.Couplet(AiCoupletPolicy.parse(flat))) }.toString())
        // 超界参数：BAD_PARAMS，invoke 与旧入口一致
        assertEquals(BridgeErrors.BAD_PARAMS, err { inv.invoke(params("couplet", input, options = JSONObject().put("topK", 0))) }.first)
        assertEquals(BridgeErrors.BAD_PARAMS, err { inv.invoke(params("couplet", input, options = JSONObject().put("temperature", 3))) }.first)
        // 对联不认 preset / system，也不走 run、translate 入口
        assertEquals(BridgeErrors.BAD_PARAMS, err { inv.invoke(params("couplet", input, options = JSONObject().put("preset", "prompt"))) }.first)
        assertEquals(BridgeErrors.BAD_PARAMS, err { inv.invoke(params("couplet", input, entry = AiModule.METHOD_RUN)) }.first)
        // 空上联
        assertEquals(BridgeErrors.BAD_PARAMS, err { inv.invoke(params("couplet", JSONObject().put("text", ""))) }.first)
    }

    @Test
    fun couplet_notReadyWhenModelMissing_andOtherProvidersDontSupportIt() {
        val inv = invoker(AiFixtures.registered(tmp))
        val input = JSONObject().put("text", "春风")
        assertEquals(BridgeErrors.NOT_READY to "local-couplet 当前不可用：not_installed", err { inv.invoke(params("couplet", input, provider = LocalCoupletProvider.ID)) })
        assertEquals(BridgeErrors.BAD_PARAMS to "local-ocr 不支持 couplet", err { inv.invoke(params("couplet", input, provider = LocalOcrProvider.ID)) })
    }
}
