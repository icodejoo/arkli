package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.model.ModelStateSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import java.io.File

/**
 * Rust 翻译引擎的一次输出。
 *
 * @property text 译文
 * @property elapsedMs Rust 侧翻译耗时（毫秒，不含加载）
 * @property detected 识别出的源语言码（按出现顺序去重）；非 auto 时由 Rust 填 `[src]`
 * @property unrecognized 有句子因无法识别而原样放进译文
 */
data class TranslateOutcome(
    val text: String,
    val elapsedMs: Long,
    val detected: List<String> = emptyList(),
    val unrecognized: Boolean = false,
)

/**
 * Rust 本地翻译引擎的 Kotlin 侧抽象，真实实现走 UniFFI，单测用替身。
 */
interface TranslateBackend {
    /**
     * 加载运行库与翻译模型；同一目录重复调用无副作用。
     *
     * @param modelDir 模型目录绝对路径
     */
    fun load(modelDir: String)

    /** 释放模型会话 */
    fun unload()

    /**
     * 翻译一段文本。
     *
     * @param text 原文
     * @param src 源语言码，可为 auto（按句识别）
     * @param tgt 目标语言码
     * @param numBeams 束宽，0 表示用模型缺省
     * @return 译文、耗时、识别出的语言与是否有无法识别的句子
     */
    fun translate(text: String, src: String, tgt: String, numBeams: Int): TranslateOutcome

    /**
     * 打断正在进行的 [translate]：在下一个解码步前生效，[translate] 随后抛 [CancellationException]。
     * 可在任意线程调用；没有翻译在跑时无副作用（每次 [translate] 都会换新的取消标志）。
     */
    fun cancel()
}

/**
 * 翻译所需的文件环境，抽出来便于单测替身。
 */
interface TranslateEnv {
    /** 模型目录（可能还不存在） */
    fun modelDir(): File
}

/**
 * 本地翻译服务：按需加载模型 -> 交给 Rust 翻译 -> 组装结果。进程内应只有一份（Rust 侧也是进程级单例）。
 *
 * 模型目录由 [TranslateEnv.modelDir] 指定，必需文件不齐则报 NOT_READY（下载由模型管理负责）。
 * 模型首次翻译时才加载；模型文件被替换（长度或修改时间变了）后会自动重载。重活排在 [AiHeavyGate] 后串行执行。
 *
 * 使用示例：`TranslateService(env, backend).translate(AiTranslateRequest("你好", "zh-CN", "en", null))`
 *
 * @param env 文件环境
 * @param backend Rust 引擎
 * @param settingsKey 会话级设置指纹，并入重载判定；缺省无设置
 * @param now 单调时钟（毫秒），单测可替换
 */
class TranslateService(
    private val env: TranslateEnv,
    private val backend: TranslateBackend,
    /** 会话级设置指纹（SESSION 级参数的 hash）；变了下次调用自动重载，缺省无设置 */
    private val settingsKey: () -> String = { "" },
    private val now: () -> Long = { System.nanoTime() / NANOS_PER_MS },
) {
    /** 当前加载的模型指纹（目录|各文件长度与修改时间） */
    private var loadedKey: String? = null

    /**
     * 模型文件是否齐全（必需文件都存在且非空）。快速返回。
     *
     * @return 齐全返回 true
     */
    fun isModelReady(): Boolean = env.modelDir().let { dir -> REQUIRED_FILES.all { File(dir, it).let { f -> f.isFile && f.length() > 0 } } }

    /**
     * 翻译一段文本，排在重任务闸门后执行。
     *
     * @param req 已校验的请求
     * @return 翻译结果
     * @throws BridgeException NOT_READY（模型未就绪）、BAD_PARAMS（Rust 拒绝）、INTERNAL（加载或推理失败）
     * @throws CancellationException 协程被取消：已通知 Rust 在下一个解码步前中止，模型会话保持可用
     */
    suspend fun translate(req: AiTranslateRequest): TranslateResult = AiHeavyGate.run { translateLocked(req) }

    /**
     * 释放已加载的模型会话，排在重任务闸门后，不会打断正在进行的翻译。
     * 模型文件被删除前、预热对应的页面离开时调用；下次翻译会按需重新加载。
     *
     * @return 此前确实加载过返回 true
     */
    suspend fun unload(): Boolean = AiHeavyGate.run {
        val was = loadedKey != null
        backend.unload()
        loadedKey = null
        was
    }

    /**
     * 预热：只加载模型会话，不翻译，排在重任务闸门后。已加载则立刻返回；
     * 加载期间被取消时，加载完成后立刻卸掉，不留半加载状态。
     *
     * @return 预热结果（provider 为 [LocalNllbProvider.ID]）
     * @throws BridgeException NOT_READY（模型未就绪）、INTERNAL（加载失败）
     */
    suspend fun warmup(): WarmupResult = AiHeavyGate.run {
        val dir = env.modelDir()
        if (!isModelReady()) {
            throw BridgeException(BridgeErrors.NOT_READY, "翻译模型未就绪：${dir.path} 缺文件，请先下载模型")
        }
        val t0 = now()
        val already = sessionKey(dir) == loadedKey
        ensureLoaded(dir)
        if (!already && !currentCoroutineContext().isActive) {
            backend.unload()
            loadedKey = null
            throw CancellationException("预热已取消")
        }
        WarmupResult(LocalNllbProvider.ID, now() - t0)
    }

    /** 闸门内的实际流程 */
    private suspend fun translateLocked(req: AiTranslateRequest): TranslateResult {
        val dir = env.modelDir()
        if (!isModelReady()) {
            throw BridgeException(BridgeErrors.NOT_READY, "翻译模型未就绪：${dir.path} 缺文件，请先下载模型")
        }
        val t0 = now()
        ensureLoaded(dir)
        val out = runCancellable(backend::cancel) { backend.translate(req.text, req.src, req.tgt, req.numBeams ?: 0) }
        // 非 auto 时按契约恒为 [src] / false，不依赖后端实现
        val auto = req.src == AiTranslatePolicy.AUTO
        val detected = if (auto) out.detected else listOf(req.src)
        return TranslateResult(out.text, now() - t0, MODEL_ID, req.src, req.tgt, detected, auto && out.unrecognized)
    }


    /** 会话指纹：文件指纹并入会话级设置指纹，任一变化都会触发重载 */
    private fun sessionKey(dir: File): String = fingerprint(dir) + settingsKey()
    /** 确保模型已加载；指纹变化时先释放旧会话再加载 */
    private fun ensureLoaded(dir: File) {
        val key = sessionKey(dir)
        if (key == loadedKey) return
        // 模型被替换：先释放旧会话，避免两份模型同时占内存
        if (loadedKey != null) backend.unload()
        backend.load(dir.path)
        loadedKey = key
    }

    companion object {
        /** 模型标识，与 `assets/ai/models.json` 的 id 一致，也写进结果 */
        const val MODEL_ID = "nllb600m-un6-mnn-w6"

        /** 设备上必需的文件名，与清单里 files 一致 */
        val REQUIRED_FILES: List<String> = listOf(
            "encoder.mnn", "encoder.mnn.weight", "cross_kv.mnn", "cross_kv.mnn.weight",
            "decoder_step.mnn", "decoder_step.mnn.weight", "embed.i8", "embed.scale",
            "tokenizer.json", "model.json", "NOTICE.txt", "LICENSE-CC-BY-NC-4.0.txt",
        )

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
 * 本地翻译提供者（L1，NLLB-200 600M，MNN 6 位）：只声明 `translate`，可用性取决于模型是否由 `native.model.*` 装好并校验通过。
 *
 * 文本入口 [run] 不适用（需要语言对），请走 `native.ai.translate`。
 *
 * 传入 [models] 时，可用性以“模型已安装且 sha256 校验通过”为准，并带出下载状态；不传则只看文件是否齐全。
 *
 * @param service 翻译服务
 * @param models 模型状态来源，对应清单里的 [TranslateService.MODEL_ID]
 */
class LocalNllbProvider(private val service: TranslateService, private val models: ModelStateSource? = null) :
    AiProvider, TextTranslator, AiSessionControl, AiTunable {
    /** 可调参数：来自 [AiTranslatePolicy.PARAM_SPECS]，范围与默认值不在这里另抄 */
    override fun paramSpecs(): List<AiParamSpec> = AiTranslatePolicy.PARAM_SPECS

    /** 固定 id */
    override val id: String = ID

    /** 展示名 */
    override val displayName: String = "本地翻译（NLLB）"

    /** 专用翻译小模型，属 L1 */
    override val layer: AiLayer = AiLayer.L1

    /** 会话依赖翻译模型，删除它前先卸载 */
    override val sessionModelId: String = TranslateService.MODEL_ID

    /** 翻译报价带语言清单（与 Qwen 共用 [AiTranslatePolicy.OFFER_CONSTRAINTS]） */
    override fun offers(): List<AiOffer> = listOf(AiOffer(AiTask.TRANSLATE, AiTranslatePolicy.OFFER_CONSTRAINTS))

    /** 只做翻译 */
    override fun capabilities(): Set<AiTask> = setOf(AiTask.TRANSLATE)

    /** 有模型状态来源时看“已安装且校验过”，否则看文件齐不齐；不可用一律 not_installed */
    override fun availability(): AiAvailability {
        val ready = if (models != null) models.info(TranslateService.MODEL_ID).installed else service.isModelReady()
        return if (ready) AiAvailability.AVAILABLE else AiAvailability.unavailable(AiUnavailableReason.NOT_INSTALLED)
    }

    /** 有模型状态来源时给出下载状态，否则为 null */
    override fun modelInfo(): AiModelInfo? = models?.info(TranslateService.MODEL_ID)?.let {
        AiModelInfo(TranslateService.MODEL_ID, it.installed, it.diskBytes, it.downloading)
    }

    /** 文本入口一律不收：翻译要语言对，只经 `native.ai.translate`（[AiPort.Translate]）；路由也不会把 run 派到这里 */
    override suspend fun run(task: AiTask, input: String): AiRunResult = throw AiRouter.notRunnable(ID, task)

    /** 转交服务 */
    override suspend fun translate(req: AiTranslateRequest): TranslateResult = service.translate(req)

    /** 预热：加载模型会话 */
    override suspend fun warmup(): WarmupResult = service.warmup()

    /** 卸载模型会话 */
    override suspend fun unloadSession(): Boolean = service.unload()

    companion object {
        /** 提供者 id 常量 */
        const val ID = "local-nllb"
    }
}
