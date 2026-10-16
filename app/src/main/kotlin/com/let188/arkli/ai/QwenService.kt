package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.model.ModelStateSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import java.io.File

/**
 * MNN 本地文本模型引擎的 Kotlin 侧抽象，真实实现走 JNI，单测用替身。
 */
interface QwenBackend {
    /**
     * 加载模型会话；调用方保证同一时刻只有一份会话。
     *
     * @param configPath 模型目录里 config.json 的绝对路径
     */
    fun load(configPath: String)

    /** 释放模型会话，幂等 */
    fun unload()

    /**
     * 单轮生成。
     *
     * @param system system 角色提示词，空串表示不带
     * @param prompt 送给模型的用户内容
     * @param maxNewTokens 最多生成的 token 数
     * @param sampling 本次采样设置；与上一次不同会让引擎重建会话（采样器只在加载时建一次），贪心默认
     * @return 模型原始输出
     */
    fun generate(system: String, prompt: String, maxNewTokens: Int, sampling: Sampling = Sampling.GREEDY): String

    /**
     * 打断正在进行的 [generate]：在下一个 token 写出时生效，[generate] 随后抛 [CancellationException]。
     * 可在任意线程调用；没有生成在跑时无副作用（下一次 [generate] 开头会复位取消标志）。
     */
    fun cancel()
}

/**
 * 本地文本模型所需的文件环境，抽出来便于单测替身。
 */
interface QwenEnv {
    /** 模型目录（可能还不存在） */
    fun modelDir(): File
}

/**
 * 本地文本模型服务：按需加载 -> 生成 -> 清理输出。进程内应只有一份（MNN 会话占 500MB 左右内存）。
 *
 * 必需文件不齐则报 NOT_READY（下载由模型管理负责）。首次使用时才加载；模型文件被替换后自动重载。
 * 重活排在 [AiHeavyGate] 后串行执行。
 *
 * 使用示例：`QwenService(env, backend).run(AiTask.SUMMARIZE, "一大段文字")`
 *
 * @param env 文件环境
 * @param backend MNN 引擎
 * @param now 单调时钟（毫秒），单测可替换
 */
class QwenService(
    private val env: QwenEnv,
    private val backend: QwenBackend,
    private val now: () -> Long = { System.nanoTime() / NANOS_PER_MS },
) {
    /** 当前加载的模型指纹 */
    private var loadedKey: String? = null

    /**
     * 模型文件是否齐全（必需文件都存在且非空）。快速返回。
     *
     * @return 齐全返回 true
     */
    fun isModelReady(): Boolean =
        env.modelDir().let { dir -> REQUIRED_FILES.all { File(dir, it).let { f -> f.isFile && f.length() > 0 } } }

    /**
     * 执行一次文本任务，排在重任务闸门后。
     *
     * @param task 任务，必须是 [AiQwenPolicy.SUPPORTED_TASKS] 之一
     * @param input 用户输入
     * @param opts 页面传的可选项：预设（缺省按任务）、prompt 预设的额外 system、采样参数（缺省按预设）
     * @return 清理后的模型输出
     * @throws BridgeException BAD_PARAMS（任务不支持）、NOT_READY（模型未就绪）、INTERNAL（加载或推理失败）
     */
    suspend fun run(task: AiTask, input: String, opts: AiGenOptions = AiGenOptions.NONE): String = AiHeavyGate.run {
        val preset = opts.preset ?: AiQwenPolicy.presetOf(task)
        val prompt = AiQwenPolicy.buildPrompt(preset, input)
        val system = AiQwenPolicy.systemPrompt(preset, opts.system)
        val sampling = AiQwenPolicy.samplingFor(preset, opts.sampling)
        val dir = requireReady()
        ensureLoaded(dir)
        generateGuarded { backend.generate(system, prompt, AiQwenPolicy.MAX_NEW_TOKENS, sampling) }
    }

    /**
     * 翻译：用翻译专用 system 提示，贪心解码，排在重任务闸门后。
     *
     * @param text 原文
     * @param src 源语言码，可为 auto
     * @param tgt 目标语言码
     * @return 清理后的译文
     * @throws BridgeException NOT_READY（模型未就绪）、INTERNAL（加载或推理失败）
     */
    suspend fun translate(text: String, src: String, tgt: String): String = AiHeavyGate.run {
        val dir = requireReady()
        ensureLoaded(dir)
        val system = AiQwenPolicy.translateSystemPrompt(AiQwenPolicy.langName(src), AiQwenPolicy.langName(tgt))
        generateGuarded { backend.generate(system, text, AiQwenPolicy.translateMaxTokens(text.length), Sampling.GREEDY) }
    }

    /**
     * 预热：只加载会话，不生成。已加载则立刻返回；加载期间被取消时，加载完成后立刻卸掉。
     *
     * @return 预热结果（provider 为 [LocalQwenProvider.ID]）
     * @throws BridgeException NOT_READY（模型未就绪）、INTERNAL（加载失败）
     */
    suspend fun warmup(): WarmupResult = AiHeavyGate.run {
        val dir = requireReady()
        val t0 = now()
        val already = fingerprint(dir) == loadedKey
        ensureLoaded(dir)
        if (!already && !currentCoroutineContext().isActive) {
            backend.unload()
            loadedKey = null
            throw CancellationException("预热已取消")
        }
        WarmupResult(LocalQwenProvider.ID, now() - t0)
    }

    /**
     * 释放已加载的会话，排在重任务闸门后，不会打断正在进行的生成。
     *
     * @return 此前确实加载过返回 true
     */
    suspend fun unload(): Boolean = AiHeavyGate.run {
        val was = loadedKey != null
        backend.unload()
        loadedKey = null
        was
    }

    /** 模型就绪则返回目录，否则抛 NOT_READY */
    private fun requireReady(): File {
        val dir = env.modelDir()
        if (!isModelReady()) throw BridgeException(BridgeErrors.NOT_READY, "文本模型未就绪：${dir.path} 缺文件，请先下载模型")
        return dir
    }

    /**
     * 跑一次生成并清理输出。引擎抛 INTERNAL（会话已失效、重建失败等）时卸掉会话并清掉指纹，下次调用会重新加载，
     * 不让一个坏掉的会话卡死到被回收。生成可被取消：协程被取消时调 [QwenBackend.cancel]，引擎在下一个 token 处中止，
     * 抛出的 [CancellationException] 原样往外传（会话仍可用，不丢弃）。
     */
    private suspend fun generateGuarded(block: () -> String): String = try {
        AiQwenPolicy.cleanOutput(runCancellable(backend::cancel, block))
    } catch (e: BridgeException) {
        if (e.code == BridgeErrors.INTERNAL) discardSession()
        throw e
    }

    /** 丢弃当前会话：卸载并忘掉指纹（卸载失败也要忘掉，保证下次重载） */
    private fun discardSession() {
        try {
            backend.unload()
        } finally {
            loadedKey = null
        }
    }

    /** 确保模型已加载；指纹变化时先释放旧会话再加载 */
    private fun ensureLoaded(dir: File) {
        val key = fingerprint(dir)
        if (key == loadedKey) return
        if (loadedKey != null) backend.unload()
        backend.load(File(dir, CONFIG_FILE).path)
        loadedKey = key
    }

    companion object {
        /** 模型标识，与 `assets/ai/models.json` 的 id 一致 */
        const val MODEL_ID = "qwen35-0.8b-mnn-q4"

        /** 引擎入口配置文件名 */
        const val CONFIG_FILE = "config.json"

        /** 设备上必需的文件名，与清单里 files 一致 */
        val REQUIRED_FILES: List<String> =
            listOf("llm.mnn", "llm.mnn.weight", "llm.mnn.json", "tokenizer.txt", "llm_config.json", CONFIG_FILE)

        /** 纳秒转毫秒 */
        private const val NANOS_PER_MS = 1_000_000L

        /**
         * 计算模型指纹：目录路径加每个必需文件的长度与修改时间，任一变化都会触发重载。
         *
         * @param dir 模型目录
         * @return 指纹字符串
         */
        fun fingerprint(dir: File): String =
            dir.path + REQUIRED_FILES.joinToString("") { File(dir, it).let { f -> "|${f.length()}:${f.lastModified()}" } }
    }
}

/**
 * 本地文本模型提供者（L2，Qwen3.5-0.8B MNN 4bit）。
 *
 * 能力 = 经 `native.ai.run` 的四类文本任务（[AiQwenPolicy.SUPPORTED_TASKS]：摘要、校对、改写、提示词问答）
 * ∪ 经 `native.ai.translate` 的翻译（实现了 [TextTranslator]，要语言对，所以 [run] 不收 translate）。
 *
 * 传入 [models] 时，可用性以“模型已安装且 sha256 校验通过”为准，并带出下载状态；不传则只看文件是否齐全。
 *
 * @param service 文本模型服务
 * @param models 模型状态来源，对应清单里的 [QwenService.MODEL_ID]
 */
class LocalQwenProvider(private val service: QwenService, private val models: ModelStateSource? = null) :
    AiProvider, AiSessionControl, TextTranslator, TextGenerator {
    /** 固定 id */
    override val id: String = ID

    /** 展示名 */
    override val displayName: String = "本地文本模型（Qwen）"

    /** 通用生成式 LLM，属 L2 */
    override val layer: AiLayer = AiLayer.L2

    /** 会话依赖文本模型，删除它前先卸载（MNN 会话约占 500MB，更要及时放） */
    override val sessionModelId: String = QwenService.MODEL_ID

    /** 按声明逐项报价：translate 带语言清单与更小的原文上限（[AiQwenPolicy.OFFER_TRANSLATE]），文本生成类带 [AiQwenPolicy.OFFER_GENERATE] */
    override fun offers(): List<AiOffer> = AiTask.values().filter { it in CAPABILITIES }.map {
        if (it == AiTask.TRANSLATE) AiOffer(it, AiQwenPolicy.OFFER_TRANSLATE) else AiOffer(it, AiQwenPolicy.OFFER_GENERATE)
    }

    /** 声明的任务：run 承接的四类 + 专用翻译端口 */
    override fun capabilities(): Set<AiTask> = CAPABILITIES

    /** 有模型状态来源时看“已安装且校验过”，否则看文件齐不齐；不可用一律 not_installed */
    override fun availability(): AiAvailability {
        val ready = if (models != null) models.info(QwenService.MODEL_ID).installed else service.isModelReady()
        return if (ready) AiAvailability.AVAILABLE else AiAvailability.unavailable(AiUnavailableReason.NOT_INSTALLED)
    }

    /** 有模型状态来源时给出下载状态，否则为 null */
    override fun modelInfo(): AiModelInfo? = models?.info(QwenService.MODEL_ID)?.let {
        AiModelInfo(QwenService.MODEL_ID, it.installed, it.diskBytes, it.downloading)
    }

    /** 转交服务，返回文本结果；translate 等不归 run 的任务直接报 BAD_PARAMS 并指明入口，不进闸门 */
    override suspend fun run(task: AiTask, input: String): AiRunResult = generate(task, input, AiGenOptions.NONE)

    /** 带预设 / system / 采样参数的生成；不归 run 的任务同样直接报 BAD_PARAMS */
    override suspend fun generate(task: AiTask, input: String, opts: AiGenOptions): AiRunResult {
        if (task !in AiQwenPolicy.SUPPORTED_TASKS) throw AiRouter.notRunnable(ID, task)
        return AiRunResult.Text(service.run(task, input, opts))
    }

    /** 翻译：交给服务，译文带耗时；源语言为 auto 时不声称识别出了语言 */
    override suspend fun translate(req: AiTranslateRequest): TranslateResult {
        val t0 = System.nanoTime()
        val text = service.translate(req.text, req.src, req.tgt)
        val auto = req.src == AiTranslatePolicy.AUTO
        return TranslateResult(
            text, (System.nanoTime() - t0) / NANOS_PER_MS, QwenService.MODEL_ID, req.src, req.tgt,
            detectedSrc = if (auto) emptyList() else listOf(req.src),
        )
    }

    /** 预热：加载模型会话 */
    override suspend fun warmup(): WarmupResult = service.warmup()

    /** 卸载模型会话 */
    override suspend fun unloadSession(): Boolean = service.unload()

    companion object {
        /** 提供者 id 常量 */
        const val ID = "local-qwen"

        /** 声明的全部任务：[AiQwenPolicy.SUPPORTED_TASKS] 加翻译 */
        val CAPABILITIES: Set<AiTask> = AiQwenPolicy.SUPPORTED_TASKS + AiTask.TRANSLATE

        /** 纳秒转毫秒 */
        private const val NANOS_PER_MS = 1_000_000L
    }
}
