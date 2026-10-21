package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.model.ModelStateSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/**
 * Rust 返回的原始生成结果（不含种子、驻留方式、总耗时等 Service 层信息）。
 *
 * @property svgPaths 单色符号的 `<path/>` 片段，空图为 null
 * @property pathCount 路径元素个数
 * @property gateOk 质量闸门是否通过
 * @property gateReasons 闸门未通过的原因代码
 * @property ringDetected 是否去掉了模型自画的外圈
 * @property features 质量特征
 * @property timings 各段耗时
 */
data class LogoOutcome(
    val svgPaths: String?,
    val pathCount: Int,
    val gateOk: Boolean,
    val gateReasons: List<String>,
    val ringDetected: Boolean,
    val features: LogoFeatures,
    val timings: LogoTimings,
)

/**
 * 能生成 logo 符号的提供者端口（`logoSymbol` 任务）。
 *
 * 使用示例：`(registry.get("local-logo-sdxs") as LogoEngine).generate(AiLogoRequest(null, prompt))`
 */
interface LogoEngine {
    /**
     * 生成一个单色符号。
     *
     * @param req 已校验的请求
     * @return 生成结果
     * @throws BridgeException NOT_READY（模型未就绪）、INTERNAL（已有生成在跑，或推理失败）、BAD_PARAMS
     * @throws CancellationException 被取消
     */
    suspend fun generate(req: AiLogoRequest): LogoResult
}

/**
 * Rust logo 引擎的 Kotlin 侧抽象，真实实现走 UniFFI，单测用替身。
 */
interface LogoBackend {
    /**
     * 加载运行库与模型目录；同参数重复调用无副作用。
     *
     * @param modelDir 模型目录绝对路径
     * @param residency 驻留方式
     */
    fun load(modelDir: String, residency: LogoResidency)

    /** 释放模型会话 */
    fun unload()

    /**
     * 生成。阻塞调用；被 [cancel] 打断时抛 [CancellationException]。
     *
     * @param req 已校验的请求
     * @param seed 种子
     * @return Rust 结果
     */
    fun generate(req: AiLogoRequest, seed: Long): LogoOutcome

    /** 打断正在进行的 [generate]（段间生效，最长约一次 UNet），可在任意线程调用 */
    fun cancel()
}

/**
 * logo 生成所需的文件环境，抽出来便于单测替身。
 */
interface LogoEnv {
    /** 模型目录（可能还不存在） */
    fun modelDir(): File
}

/**
 * logo 符号生成服务：交给 Rust 生成 -> 组装结果。进程内应只有一份（Rust 侧也是进程级单例）。
 *
 * - **同一时刻只允许一个生成在飞**：Rust 只记最后一次登记的取消令牌，并发会让 `logo_cancel` 取消不到真正在跑的那次。
 *   新请求到来时若已有生成（含排队等闸门的）直接拒绝，回 INTERNAL「正在生成，请稍候」，不排队。
 * - **加载前先让位**：生成前调 [evictOthers]（卸掉 Qwen 等其他已常驻的模型），它在闸门外执行，因为别的服务卸载自己要排 [AiHeavyGate]，闸门不可重入。
 * - **驻留方式**：加载时按 [availMem] 经 [AiLogoPolicy.chooseResidency] 选常驻或每段即卸，已加载的沿用，不中途切换。
 * - **卸载先取消**：[unload] 先置取消再排闸门卸载，否则会被正在跑的生成卡住（Rust 持全局锁跑完整次生成，约 10 秒）。
 * - **取消**：一步前向不可打断，只在段间检查，最长约一次 UNet（真机 6~8 秒）；取消后下一次调用照常可用。
 *
 * 使用示例：`LogoService(env, backend, { availMem }).generate(AiLogoRequest(null, "flat pictogram glyph of a carrot"))`
 *
 * @param env 文件环境
 * @param backend Rust 引擎
 * @param availMem 系统可用内存（字节），加载时取
 * @param evictOthers 让位回调：卸掉其他常驻模型
 * @param settingsKey 会话级设置指纹，并入重载判定；缺省无设置
 * @param now 单调时钟（毫秒），单测可替换
 * @param randomSeed 缺省种子的来源，单测可替换
 */
class LogoService(
    private val env: LogoEnv,
    private val backend: LogoBackend,
    private val availMem: () -> Long,
    private val evictOthers: suspend () -> Unit = {},
    private val settingsKey: () -> String = { "" },
    private val now: () -> Long = { System.nanoTime() / NANOS_PER_MS },
    private val randomSeed: () -> Long = { Random.nextLong(0, AiLogoPolicy.MAX_SEED + 1) },
) {
    /** 是否已有生成在飞（含排队等闸门） */
    private val inFlight = AtomicBoolean(false)

    /** 取消纪元：[unload] 递增，入口记下的纪元变了说明期间有人要卸载，排队中的生成就不再开跑 */
    private val cancelEpoch = AtomicInteger(0)

    /** 当前加载的会话指纹（目录与文件指纹 + 设置 + 驻留方式） */
    private var loadedKey: String? = null

    /** 当前会话的驻留方式 */
    private var loadedResidency: LogoResidency? = null

    /**
     * 模型文件是否齐全（必需文件都存在且非空）。快速返回，供 `native.ai.providers` 探测。
     *
     * @return 齐全返回 true
     */
    fun isModelReady(): Boolean =
        env.modelDir().let { dir -> REQUIRED_FILES.all { File(dir, it).let { f -> f.isFile && f.length() > 0 } } }

    /**
     * 生成符号，排在重任务闸门后执行；协程被取消时打断生成。
     *
     * @param req 已校验的请求
     * @return 生成结果
     * @throws BridgeException NOT_READY（模型未就绪）、INTERNAL（已有生成在跑，或推理失败）、BAD_PARAMS
     * @throws CancellationException 被取消（含期间被 [unload] 打断）
     */
    suspend fun generate(req: AiLogoRequest): LogoResult {
        if (!inFlight.compareAndSet(false, true)) throw BridgeException(BridgeErrors.INTERNAL, MSG_BUSY)
        try {
            val dir = env.modelDir()
            requireReady(dir)
            val epoch = cancelEpoch.get()
            evictOthers()
            val seed = req.seed ?: randomSeed()
            return AiHeavyGate.run {
                checkNotUnloaded(epoch)
                val t0 = now()
                val residency = ensureLoaded(dir)
                // 加载期间若有人卸载，别再开跑；开跑前再查一次，把“取消落在令牌登记之前”的窗口压到最小
                checkNotUnloaded(epoch)
                val o = runCancellable(backend::cancel) { backend.generate(req, seed) }
                LogoResult(
                    o.svgPaths, o.pathCount, o.gateOk, o.gateReasons, o.ringDetected, o.features, o.timings,
                    seed, residency, now() - t0, MODEL_ID,
                )
            }
        } finally {
            inFlight.set(false)
        }
    }

    /**
     * 释放已加载的模型会话。**先取消再卸载**：先让在飞的生成在段间退出，再排闸门卸载。
     *
     * @return 此前确实加载过返回 true
     */
    suspend fun unload(): Boolean {
        cancelEpoch.incrementAndGet()
        backend.cancel()
        return AiHeavyGate.run {
            val was = loadedKey != null
            backend.unload()
            loadedKey = null
            loadedResidency = null
            was
        }
    }

    /**
     * 预热：只加载模型会话，不生成，排在重任务闸门后。加载期间被取消时，加载完成后立刻卸掉。
     *
     * @return 预热结果（provider 为 [LocalLogoProvider.ID]）
     * @throws BridgeException NOT_READY（模型未就绪）、INTERNAL（加载失败）
     */
    suspend fun warmup(): WarmupResult = AiHeavyGate.run {
        val dir = env.modelDir()
        requireReady(dir)
        val t0 = now()
        val already = loadedKey != null
        ensureLoaded(dir)
        if (!already && !currentCoroutineContext().isActive) {
            backend.unload()
            loadedKey = null
            loadedResidency = null
            throw CancellationException(MSG_WARMUP_CANCELLED)
        }
        WarmupResult(LocalLogoProvider.ID, now() - t0)
    }

    /** 入口记下的纪元变了（期间有 unload）就按取消处理；协程本身已取消也一并抛出 */
    private suspend fun checkNotUnloaded(epoch: Int) {
        currentCoroutineContext().ensureActive()
        if (cancelEpoch.get() != epoch) throw CancellationException(MSG_CANCELLED)
    }

    /** 必需文件不齐则报 NOT_READY */
    private fun requireReady(dir: File) {
        if (!isModelReady()) throw BridgeException(BridgeErrors.NOT_READY, "logo 模型未就绪：${dir.path} 缺文件，请先下载模型")
    }

    /** 文件与设置指纹（不含驻留方式） */
    private fun baseKey(dir: File): String = fingerprint(dir) + settingsKey()

    /** 确保模型已加载并返回驻留方式：文件或设置变了先卸旧的重载；已加载且没变则沿用，不因内存波动切换 */
    private fun ensureLoaded(dir: File): LogoResidency {
        val base = baseKey(dir)
        val cur = loadedResidency
        if (cur != null && loadedKey == "$base|${cur.wire}") return cur
        if (loadedKey != null) backend.unload()
        val chosen = AiLogoPolicy.chooseResidency(availMem())
        backend.load(dir.path, chosen)
        loadedKey = "$base|${chosen.wire}"
        loadedResidency = chosen
        return chosen
    }

    companion object {
        /** 模型标识，与 `assets/ai/models.json` 的 id 一致，也写进结果 */
        const val MODEL_ID = "sdxs512-mnn-w8"

        /** 设备上必需的文件名，与清单里 files 一致 */
        val REQUIRED_FILES: List<String> = listOf(
            "text_encoder.mnn",
            "unet.mnn",
            "vae_decoder.mnn",
            "tokenizer.json",
            "NOTICE.txt",
            "LICENSE-CreativeML-OpenRAIL-PlusPlus-M.txt",
            "LICENSE-CreativeML-OpenRAIL-M.txt",
            "LICENSE-MIT-TAESD.txt",
            "LICENSE-MIT-OpenAI-CLIP.txt",
        )

        /** 并发生成被拒时的提示 */
        const val MSG_BUSY = "正在生成，请稍候"

        /** 生成被卸载打断时的提示 */
        private const val MSG_CANCELLED = "生成已取消"

        /** 预热被取消时的提示 */
        private const val MSG_WARMUP_CANCELLED = "预热已取消"

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
 * 本地 logo 符号提供者（L1，SDXS 一步文生图 + 二值化 + vtracer）：声明 `logoSymbol`，可用性取决于模型是否由 `native.model.*` 装好并校验通过。
 *
 * 文本入口 [run] 不适用，请走 `native.ai.logoSymbol`。
 *
 * @param service logo 服务
 * @param models 模型状态来源，对应清单里的 [LogoService.MODEL_ID]；不传则只看文件是否齐全
 */
class LocalLogoProvider(private val service: LogoService, private val models: ModelStateSource? = null) :
    AiProvider, LogoEngine, AiSessionControl {
    /** 固定 id */
    override val id: String = ID

    /** 展示名 */
    override val displayName: String = "本地符号生成（SDXS）"

    /** 专用小模型，属 L1 */
    override val layer: AiLayer = AiLayer.L1

    /** 会话依赖 logo 模型，删除它前先卸载 */
    override val sessionModelId: String = LogoService.MODEL_ID

    /** 只做 logo 符号 */
    override fun capabilities(): Set<AiTask> = setOf(AiTask.LOGO_SYMBOL)

    /** 有模型状态来源时看“已安装且校验过”，否则看文件齐不齐；不可用一律 not_installed */
    override fun availability(): AiAvailability {
        val ready = if (models != null) models.info(LogoService.MODEL_ID).installed else service.isModelReady()
        return if (ready) AiAvailability.AVAILABLE else AiAvailability.unavailable(AiUnavailableReason.NOT_INSTALLED)
    }

    /** 有模型状态来源时给出下载状态，否则为 null */
    override fun modelInfo(): AiModelInfo? = models?.info(LogoService.MODEL_ID)?.let {
        AiModelInfo(LogoService.MODEL_ID, it.installed, it.diskBytes, it.downloading)
    }

    /** 文本入口一律不收：只经 `native.ai.logoSymbol`（[AiPort.Logo]） */
    override suspend fun run(task: AiTask, input: String): AiRunResult = throw AiRouter.notRunnable(ID, task)

    /** 转交服务 */
    override suspend fun generate(req: AiLogoRequest): LogoResult = service.generate(req)

    /** 预热：加载模型会话 */
    override suspend fun warmup(): WarmupResult = service.warmup()

    /** 卸载模型会话（先取消在飞的生成） */
    override suspend fun unloadSession(): Boolean = service.unload()

    companion object {
        /** 提供者 id 常量 */
        const val ID = "local-logo-sdxs"
    }
}
