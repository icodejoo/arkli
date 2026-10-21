package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException

/**
 * 任务端口：提供者用哪种强类型接口承接任务。输入输出按端口各管各的，路由只认端口。
 *
 * - 专用端口（[DEDICATED]）各绑一个任务：实现了端口就必须在 [AiProvider.capabilities] 里声明那个任务，反过来也一样，
 *   除非该任务改由 [AiProvider.run] 承接（如 `intent-handoff` 的翻译是交接，没有语言对）；
 * - [Run] 是通用文本入口，任何提供者都有 `run()`，它能承接哪些任务由 [AiRouter.runTasks] 推导，不由提供者另报；
 * - [Session] 不绑任务，表示持有可预热/卸载的模型会话。
 *
 * 使用示例：`AiRouter.resolve(providers, AiTask.TRANSLATE, AiPort.Translate, "local-qwen").port.translate(req)`
 *
 * @param T 端口的接口类型
 * @property entry 对应的桥方法名，写进错误提示
 * @property task 专用端口绑定的任务；通用端口为 null
 */
sealed class AiPort<T : Any>(val entry: String, val task: AiTask?) {
    /**
     * 把提供者绑到本端口。
     *
     * @param provider 提供者
     * @return 实现了本端口时返回端口对象，否则 null
     */
    abstract fun bind(provider: AiProvider): T?

    /** 通用文本入口 `native.ai.run` */
    object Run : AiPort<AiProvider>(AiModule.METHOD_RUN, null) {
        /** 人人都有 run()，能不能承接某任务看 [AiRouter.runTasks] */
        override fun bind(provider: AiProvider): AiProvider = provider
    }

    /** 带语言对的翻译 `native.ai.translate` */
    object Translate : AiPort<TextTranslator>(AiModule.METHOD_TRANSLATE, AiTask.TRANSLATE) {
        /** 实现了 [TextTranslator] 才算 */
        override fun bind(provider: AiProvider): TextTranslator? = provider as? TextTranslator
    }

    /** 识图 `native.ai.classify` */
    object Classify : AiPort<ImageClassifier>(AiModule.METHOD_CLASSIFY, AiTask.CLASSIFY_IMAGE) {
        /** 实现了 [ImageClassifier] 才算 */
        override fun bind(provider: AiProvider): ImageClassifier? = provider as? ImageClassifier
    }

    /** 文字识别 `native.ai.ocr` */
    object Ocr : AiPort<OcrEngine>(AiModule.METHOD_OCR, AiTask.OCR) {
        /** 实现了 [OcrEngine] 才算 */
        override fun bind(provider: AiProvider): OcrEngine? = provider as? OcrEngine
    }

    /** 对联 `native.ai.couplet` */
    object Couplet : AiPort<CoupletEngine>(AiModule.METHOD_COUPLET, AiTask.COUPLET) {
        /** 实现了 [CoupletEngine] 才算 */
        override fun bind(provider: AiProvider): CoupletEngine? = provider as? CoupletEngine
    }

    /** 抠图 `native.ai.matting` */
    object Matting : AiPort<MattingEngine>(AiModule.METHOD_MATTING, AiTask.MATTING) {
        /** 实现了 [MattingEngine] 才算 */
        override fun bind(provider: AiProvider): MattingEngine? = provider as? MattingEngine
    }

    /** logo 符号生成 `native.ai.logoSymbol` */
    object Logo : AiPort<LogoEngine>(AiModule.METHOD_LOGO, AiTask.LOGO_SYMBOL) {
        /** 实现了 [LogoEngine] 才算 */
        override fun bind(provider: AiProvider): LogoEngine? = provider as? LogoEngine
    }

    /** 模型会话的预热与卸载 `native.ai.warmup` / `native.ai.unload` */
    object Session : AiPort<AiSessionControl>(AiModule.METHOD_WARMUP, null) {
        /** 实现了 [AiSessionControl] 才算 */
        override fun bind(provider: AiProvider): AiSessionControl? = provider as? AiSessionControl
    }

    companion object {
        /** 专用任务端口；以后接文本生成等强类型任务时在这里登记（新增任务的步骤见 docs/design/ai-protocol.md） */
        val DEDICATED: List<AiPort<*>> = listOf(Translate, Classify, Ocr, Couplet, Matting, Logo)

        /** 能承接任务的全部端口（专用 + 通用 run），`native.ai.invoke` 的 `entry` 只能取它们的方法名 */
        val TASK_PORTS: List<AiPort<*>> = DEDICATED + Run

        /**
         * 查任务的专用端口。
         *
         * @param task 任务
         * @return 专用端口，没有（走 run）返回 null
         */
        fun dedicatedFor(task: AiTask): AiPort<*>? = DEDICATED.firstOrNull { it.task == task }

        /**
         * 任务的缺省端口：有专用端口就是它，否则是 run。`native.ai.invoke` 不指定提供者时用。
         *
         * @param task 任务
         * @return 端口
         * @example `canonicalFor(AiTask.TRANSLATE)` == `AiPort.Translate`；`canonicalFor(AiTask.SUMMARIZE)` == `AiPort.Run`
         */
        fun canonicalFor(task: AiTask): AiPort<*> = dedicatedFor(task) ?: Run

        /**
         * 按桥方法名找任务端口。
         *
         * @param entry 桥方法名，如 `native.ai.translate`
         * @return 端口；不是任务端口（含 `native.ai.warmup`）返回 null
         */
        fun byEntry(entry: String): AiPort<*>? = TASK_PORTS.firstOrNull { it.entry == entry }
    }
}

/**
 * 一次路由结果：选中的提供者，以及它在目标端口上的接口。
 *
 * @param T 端口接口类型
 * @property provider 选中的提供者
 * @property port 绑定到端口后的接口对象（与 [provider] 是同一个实例）
 */
data class AiRoute<T : Any>(val provider: AiProvider, val port: T)

/**
 * AI 统一路由：所有入口（invoke 及其别名 run / translate / classify，加上 warmup / unload）都在这里选提供者，错误语义一致；
 * 任务该走哪个端口也只在这里推导（[portOf]），invoke 的分派与 offers 的 entry 都用它。
 * 纯逻辑，无 Android 依赖，可单测。
 *
 * 错误语义：
 * - 指定的 id 不存在、不支持该任务或端口、或没有任何候选 → `BAD_PARAMS`；
 * - 选中了但当前不可用 → `NOT_READY`，message 带 reason（如 `not_installed`）。
 *
 * 缺省 id 时只在本地层（[DEFAULT_LAYERS]：L1/L2）里按注册顺序取第一个候选，不跳过不可用的（结果可预期：不会因为谁没下载就悄悄换模型）；
 * L3/L4（交接、远端）会把文本交给第三方，必须显式点名 provider 才会走（决策 0005 第 5 条）。
 *
 * 使用示例：`AiRouter.resolve(registry.all(), AiTask.CLASSIFY_IMAGE, AiPort.Classify, null).port.classify(file, 3)`
 */
object AiRouter {
    /** 没点名 provider 时允许自动选中的层：只有本地的 L1/L2，交接与远端不自动启用 */
    val DEFAULT_LAYERS: Set<AiLayer> = setOf(AiLayer.L1, AiLayer.L2)

    /**
     * 提供者经专用端口承接的任务：实现了哪个专用端口就算哪个任务，与是否声明无关（不变量测试据此查“说谎”）。
     *
     * @param provider 提供者
     * @return 任务集合
     */
    fun dedicatedTasks(provider: AiProvider): Set<AiTask> =
        AiPort.DEDICATED.filter { it.bind(provider) != null }.mapNotNull { it.task }.toSet()

    /**
     * 提供者经 `native.ai.run` 承接的任务 = 声明的任务 − 已由专用端口承接的任务。
     *
     * @param provider 提供者
     * @return 任务集合
     * @example `runTasks(LocalQwenProvider(...))` == `AiQwenPolicy.SUPPORTED_TASKS`（translate 走专用端口）
     */
    fun runTasks(provider: AiProvider): Set<AiTask> = provider.capabilities() - dedicatedTasks(provider)

    /**
     * 提供者执行某任务该走的桥方法：实现了该任务的专用端口就是专用方法，否则是 `native.ai.run`。
     * 由实现推导，不由提供者自报，所以不会说谎。
     *
     * @param provider 提供者
     * @param task 任务（调用方保证是它声明过的）
     * @return 桥方法名
     * @example `entryOf(LocalQwenProvider(...), AiTask.TRANSLATE)` == `"native.ai.translate"`；交接类的 translate 是 `"native.ai.run"`
     */
    fun entryOf(provider: AiProvider, task: AiTask): String = portOf(provider, task).entry

    /**
     * 提供者执行某任务该走的端口：实现了该任务的专用端口就是它，否则是 run。
     * [entryOf]、`native.ai.invoke` 的分派都以它为准，全项目只此一处。
     *
     * @param provider 提供者
     * @param task 任务
     * @return 端口
     * @example `portOf(LocalQwenProvider(...), AiTask.TRANSLATE)` == `AiPort.Translate`
     */
    fun portOf(provider: AiProvider, task: AiTask): AiPort<*> =
        AiPort.dedicatedFor(task)?.takeIf { it.bind(provider) != null } ?: AiPort.Run

    /**
     * 提供者对某任务的报价（含约束）。
     *
     * @param provider 提供者
     * @param task 任务
     * @return 报价，没报这项为 null
     */
    fun offerOf(provider: AiProvider, task: AiTask): AiOffer? = provider.offers().firstOrNull { it.task == task }

    /**
     * 提供者能否经某端口执行某任务（不看当前可用性）。
     *
     * @param provider 提供者
     * @param task 任务
     * @param port 端口
     * @return 声明了任务、实现了端口、且端口与任务对得上时为 true
     */
    fun supports(provider: AiProvider, task: AiTask, port: AiPort<*>): Boolean {
        if (task !in provider.capabilities() || port.bind(provider) == null) return false
        return when {
            port.task != null -> port.task == task
            port == AiPort.Run -> task in runTasks(provider)
            else -> true
        }
    }

    /**
     * 列出能经某端口执行某任务的全部提供者（不看可用性），保持注册顺序。
     *
     * @param providers 全部提供者（注册顺序）
     * @param task 任务
     * @param port 端口
     * @return 路由候选
     */
    fun <T : Any> candidates(providers: List<AiProvider>, task: AiTask, port: AiPort<T>): List<AiRoute<T>> =
        providers.mapNotNull { p -> port.bind(p)?.takeIf { supports(p, task, port) }?.let { AiRoute(p, it) } }

    /**
     * 为一次任务选提供者并检查可用性。
     *
     * @param providers 全部提供者（注册顺序）
     * @param task 任务
     * @param port 端口
     * @param providerId 指定的提供者 id；null 表示取第一个候选
     * @return 可用的路由
     * @throws BridgeException BAD_PARAMS（id 不存在、不支持、没有候选）、NOT_READY（当前不可用，message 带 reason）
     * @example `AiRouter.resolve(all, AiTask.TRANSLATE, AiPort.Translate, "local-qwen").port.translate(req)`
     */
    fun <T : Any> resolve(providers: List<AiProvider>, task: AiTask, port: AiPort<T>, providerId: String? = null): AiRoute<T> =
        select(providers, task, port, providerId).also { requireAvailable(it.provider) }

    /**
     * 只选提供者、不查可用性（[resolve] 的前半段）。分派时先选、再按选中者的约束校验输入、最后查可用性，
     * 这样“参数不合法”总是先于“模型没装”报出来，与旧入口一致。
     *
     * @param providers 全部提供者（注册顺序）
     * @param task 任务
     * @param port 端口
     * @param providerId 指定的提供者 id；null 表示在本地层（[DEFAULT_LAYERS]）里取第一个候选，不会回落到交接/远端
     * @param generative 为 true 时缺省候选还要求实现了 [TextGenerator]（调用带了 preset/system/采样参数）；点名 provider 时不影响
     * @return 路由
     * @throws BridgeException BAD_PARAMS（id 不存在、不支持、没有候选）
     */
    fun <T : Any> select(
        providers: List<AiProvider>,
        task: AiTask,
        port: AiPort<T>,
        providerId: String? = null,
        generative: Boolean = false,
    ): AiRoute<T> {
        if (providerId == null) {
            return candidates(providers, task, port)
                .firstOrNull { it.provider.layer in DEFAULT_LAYERS && (!generative || it.provider is TextGenerator) }
                ?: throw bad("没有可自动选用的本地 provider 支持 ${task.wire}，需要交接或远端请显式指定 provider")
        }
        val p = providers.firstOrNull { it.id == providerId } ?: throw unknown(providerId)
        val bound = port.bind(p)
        if (bound == null || !supports(p, task, port)) throw unsupported(p, task, port)
        return AiRoute(p, bound)
    }

    /**
     * 按 id 取实现了某端口的提供者，不看任务、不看可用性（卸载用：模型删了也要能卸）。
     *
     * @param providers 全部提供者
     * @param port 端口
     * @param providerId 提供者 id
     * @return 路由
     * @throws BridgeException BAD_PARAMS（id 不存在、没实现该端口）
     */
    fun <T : Any> find(providers: List<AiProvider>, port: AiPort<T>, providerId: String): AiRoute<T> {
        val p = providers.firstOrNull { it.id == providerId } ?: throw unknown(providerId)
        val bound = port.bind(p) ?: throw bad("$providerId 不支持 ${port.entry}")
        return AiRoute(p, bound)
    }

    /**
     * 按 id 取实现了某端口的提供者并检查可用性，不看任务（预热用）。
     *
     * @param providers 全部提供者
     * @param port 端口
     * @param providerId 提供者 id
     * @return 可用的路由
     * @throws BridgeException BAD_PARAMS（id 不存在、没实现该端口）、NOT_READY（当前不可用，message 带 reason）
     */
    fun <T : Any> resolveById(providers: List<AiProvider>, port: AiPort<T>, providerId: String): AiRoute<T> =
        find(providers, port, providerId).also { requireAvailable(it.provider) }

    /**
     * 全部实现了某端口的提供者，注册顺序（卸载全部用）。
     *
     * @param providers 全部提供者
     * @param port 端口
     * @return 路由列表
     */
    fun <T : Any> all(providers: List<AiProvider>, port: AiPort<T>): List<AiRoute<T>> =
        providers.mapNotNull { p -> port.bind(p)?.let { AiRoute(p, it) } }

    /**
     * 提供者的 `run()` 收到不归它承接的任务时用的错误：任务有专用端口就指明该走哪个方法。
     *
     * @param providerId 提供者 id
     * @param task 任务
     * @return BAD_PARAMS 异常（由调用方 throw）
     * @example `override suspend fun run(task, input) = throw AiRouter.notRunnable(ID, task)`
     */
    fun notRunnable(providerId: String, task: AiTask): BridgeException {
        val port = AiPort.dedicatedFor(task)
        val msg = if (port != null) {
            "$providerId 的 ${task.wire} 不走 ${AiPort.Run.entry}，请用 ${port.entry}"
        } else {
            "$providerId 不支持经 ${AiPort.Run.entry} 执行 ${task.wire}"
        }
        return bad(msg)
    }

    /**
     * 不可用则抛 NOT_READY，message 带 reason。
     *
     * @param p 提供者
     * @throws BridgeException NOT_READY
     */
    fun requireAvailable(p: AiProvider) {
        val a = p.availability()
        if (!a.available) throw BridgeException(BridgeErrors.NOT_READY, "${p.id} 当前不可用：${a.reason?.wire}")
    }

    /** 选中的提供者不支持时的错误：声明了任务但走错了入口，就说明不走这个入口 */
    private fun unsupported(p: AiProvider, task: AiTask, port: AiPort<*>): BridgeException = when {
        task !in p.capabilities() -> bad("${p.id} 不支持 ${task.wire}")
        port == AiPort.Run -> notRunnable(p.id, task)
        else -> bad("${p.id} 的 ${task.wire} 不走 ${port.entry}")
    }

    /** id 不存在 */
    private fun unknown(id: String) = bad("未知的 provider：$id")

    /** 造 BAD_PARAMS 异常 */
    private fun bad(msg: String) = BridgeException(BridgeErrors.BAD_PARAMS, msg)
}
