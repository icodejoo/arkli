package com.let188.arkli.ai

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.corpus.CorpusModule
import com.let188.arkli.files.FileEnv
import com.let188.arkli.files.requireMainFrame
import com.let188.arkli.model.ModelModule
import com.let188.arkli.model.ModelStateSource
import org.json.JSONObject

/**
 * 原生 AI 模块：
 * - `native.ai.status`：本地模型就绪状态；
 * - `native.ai.providers` / `native.ai.run`：AI 提供者抽象（见 [AiProvider]），交接类提供者与本地识物提供者；
 * - `native.ai.classify`：本地 SigLIP2 识物，见 [AiClassifyPolicy] 与 [ClipService]；
 * - `native.ai.ocr`：本地 PP-OCRv6 small 文字识别，是第一个按统一协议新增的任务（新增任务的步骤见 docs/design/ai-protocol.md），
 *   见 [AiOcrPolicy] 与 [OcrService]；
 * - `native.ai.matting`：本地抠图（人像 MODNet / 通用 U2Net-p / 实验的 PP-MattingV2 与 BiRefNet-lite，各是一个提供者），见 [AiMattingPolicy] 与 [MattingService]；
 * - `native.ai.couplet`：本地 GPT-2 对联（MNN），上联进、等长下联出，见 [AiCoupletPolicy] 与 [CoupletService]；
 * - `native.ai.translate`：带语言对的翻译，缺省本地 NLLB（6 种联合国语言），可用 `provider` 指定 `local-qwen`，见 [AiTranslatePolicy] 与 [TranslateService]；
 * - 本地文本模型（Qwen3.5-0.8B，MNN）作为 `local-qwen` 提供者，经 `native.ai.run` 做摘要、校对、改写、提示词问答，经 `native.ai.translate` 做翻译，见 [AiQwenPolicy] 与 [QwenService]；
 * - `native.ai.invoke`：统一入口 `{ task, input, provider?, entry?, options? }`，按任务分派到强类型端口；
 *   `run` / `translate` / `classify` 是它钉死端口的别名，共用 [AiInvoker]；
 * - `native.ai.params.get/set/reset`：各提供者的可调推理参数（规格随 `native.ai.providers` 的 `params` 下发），见 [AiParams]；
 * - 各入口选提供者统一经 [AiRouter]；
 * - `native.ai.warmup` / `native.ai.unload`：本地模型会话的预热与卸载，见 [AiLifecyclePolicy]；会话的预热、卸载、
 *   删模型前释放、进程级回收（[AiRecycle]）都从 [providers] 里实现了 [AiSessionControl] 的提供者派生，新增模型只登记一处；
 * - 同时注册 `native.model.*` 模型下载管理（见 [ModelModule]），本地模型一律经它按需下载。
 *
 * 使用示例：`AiModule.install(bridge, env)`
 */
object AiModule {
    /** 方法名：模型状态 */
    const val METHOD_STATUS = "native.ai.status"

    /** 方法名：提供者列表与能力探测 */
    const val METHOD_PROVIDERS = "native.ai.providers"

    /** 方法名：统一入口，按任务分派到强类型端口 */
    const val METHOD_INVOKE = "native.ai.invoke"

    /** 方法名：交给某个提供者执行任务 */
    const val METHOD_RUN = "native.ai.run"

    /** 方法名：识图（本地 SigLIP2 识物） */
    const val METHOD_CLASSIFY = "native.ai.classify"

    /** 方法名：对联（本地 GPT-2 对联模型，等长下联） */
    const val METHOD_COUPLET = "native.ai.couplet"

    /** 方法名：文字识别（本地 PP-OCRv6 small） */
    const val METHOD_OCR = "native.ai.ocr"

    /** 方法名：抠图（本地 MODNet 人像 / U2Net-p 通用） */
    const val METHOD_MATTING = "native.ai.matting"

    /** 方法名：本地翻译（NLLB-200 600M） */
    const val METHOD_TRANSLATE = "native.ai.translate"

    /** 方法名：读某个提供者的可调参数规格与当前值 */
    const val METHOD_PARAMS_GET = "native.ai.params.get"

    /** 方法名：写某个提供者的可调参数（整批原子校验） */
    const val METHOD_PARAMS_SET = "native.ai.params.set"

    /** 方法名：恢复某个提供者的参数默认值 */
    const val METHOD_PARAMS_RESET = "native.ai.params.reset"

    /** 方法名：预热本地模型会话 */
    const val METHOD_WARMUP = "native.ai.warmup"

    /** 方法名：卸载本地模型会话 */
    const val METHOD_UNLOAD = "native.ai.unload"

    /** 前端约定的模型名，顺序即返回顺序 */
    val MODEL_NAMES: List<String> = listOf("ocr", "upscale", "classify", "matte", "fuse", "colorize")

    /**
     * 生成状态数据：全部模型 false。纯函数，可单测。
     *
     * @return `{ models: { ocr:false, ... } }`
     */
    fun statusJson(): JSONObject {
        val models = JSONObject()
        MODEL_NAMES.forEach { models.put(it, false) }
        return JSONObject().put("models", models)
    }

    /**
     * 按注册顺序构造全部 AI 提供者。抽成纯函数，单测（`AiProviderContractTest`）用替身服务调它，
     * 保证“能力声明 = 实现的端口”覆盖到真正注册的每一个提供者。
     *
     * @param handoff 交接平台能力
     * @param clip 识物服务
     * @param ocr 文字识别服务
     * @param translate 翻译服务
     * @param qwen 文本模型服务
     * @param couplet 对联服务
     * @param mattingPortrait 人像抠图服务
     * @param mattingGeneral 通用抠图服务
     * @param mattingPpMatting 人像 v2（实验）抠图服务
     * @param mattingBiRefNet 通用高精（实验）抠图服务
     * @param models 模型状态来源；null 时各本地提供者只看文件是否齐全
     * @return 提供者列表（注册顺序即缺省路由的优先级）
     * @example `ProviderRegistry(AiModule.providers(platform, clip, ocr, translate, qwen, couplet, mattingPortrait, mattingGeneral, mattingPpMatting, mattingBiRefNet, models))`
     */
    fun providers(
        handoff: HandoffPlatform,
        clip: ClipService,
        ocr: OcrService,
        translate: TranslateService,
        qwen: QwenService,
        couplet: CoupletService,
        mattingPortrait: MattingService,
        mattingGeneral: MattingService,
        mattingPpMatting: MattingService,
        mattingBiRefNet: MattingService,
        models: ModelStateSource?,
    ): List<AiProvider> = listOf(
        IntentHandoffProvider(handoff),
        LocalClipProvider(clip, models),
        LocalOcrProvider(ocr, models),
        LocalNllbProvider(translate, models),
        LocalQwenProvider(qwen, models),
        LocalCoupletProvider(couplet, models),
        LocalMattingProvider(mattingPortrait, models),
        LocalMattingProvider(mattingGeneral, models),
        LocalMattingProvider(mattingPpMatting, models),
        LocalMattingProvider(mattingBiRefNet, models),
    )

    /**
     * 注册 AI 方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取上下文与宿主
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        val models = ModelModule.install(bridge, env.appContext)
        CorpusModule.install(bridge, env.appContext.filesDir, models)
        val all = providers(
            AndroidHandoffPlatform(env.appContext, env.host),
            ClipRuntime.get(env.appContext),
            OcrRuntime.get(env.appContext),
            TranslateRuntime.get(env.appContext),
            QwenRuntime.get(env.appContext),
            CoupletRuntime.get(env.appContext),
            MattingRuntime.get(env.appContext, MattingMode.PORTRAIT),
            MattingRuntime.get(env.appContext, MattingMode.GENERAL),
            MattingRuntime.get(env.appContext, MattingMode.PPMATTING),
            MattingRuntime.get(env.appContext, MattingMode.BIREFNET),
            models,
        )
        // 生命周期全从提供者派生：删模型前先卸会话（按 id 登记，重复安装只会替换）、进程级回收
        AiLifecyclePolicy.releaseHooks(all).forEach { (modelId, sessions) ->
            models.addReleaseHook(modelId) { AiLifecyclePolicy.unloadAll(sessions) }
        }
        AiRecycle.attach(all)
        val registry = ProviderRegistry(all)
        val paramStore = AiParamStores.get(env.appContext)
        val invoker = AiInvoker({ registry.all() }, { env.roots.resolveCache(it) }, paramStore)
        bridge.register(METHOD_PROVIDERS, AiProvidersHandler(registry))
        bridge.register(METHOD_PARAMS_GET, AiParamsGetHandler(registry, paramStore))
        bridge.register(METHOD_PARAMS_SET, AiParamsSetHandler(registry, paramStore))
        bridge.register(METHOD_PARAMS_RESET, AiParamsResetHandler(registry, paramStore))
        bridge.register(METHOD_INVOKE, AiInvokeHandler(invoker))
        bridge.register(METHOD_RUN, AiRunHandler(invoker))
        bridge.register(METHOD_CLASSIFY, AiClassifyHandler(invoker))
        bridge.register(METHOD_OCR, AiOcrHandler(invoker))
        bridge.register(METHOD_COUPLET, AiCoupletHandler(invoker))
        bridge.register(METHOD_MATTING, AiMattingHandler(invoker))
        bridge.register(METHOD_TRANSLATE, AiTranslateHandler(invoker))
        bridge.register(METHOD_WARMUP, AiWarmupHandler(registry))
        bridge.register(METHOD_UNLOAD, AiUnloadHandler(registry))
        bridge.register(METHOD_STATUS, BridgeHandler { ctx, _ ->
            requireMainFrame(ctx)
            statusJson()
        })
    }
}
