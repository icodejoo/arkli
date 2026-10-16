package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.model.ModelStateSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Rust 返回的原始生成结果。
 *
 * @property text 下联
 * @property elapsedMs Rust 侧生成耗时（毫秒，不含加载）
 */
data class CoupletOutcome(val text: String, val elapsedMs: Long)

/**
 * 一次生成的完整结果，交给 [AiCoupletPolicy.resultJson] 序列化。
 *
 * @property text 下联（与上联等长，标点位与上联相同）
 * @property elapsedMs 总耗时（含加载）
 * @property modelId 模型标识
 */
data class CoupletResult(val text: String, val elapsedMs: Long, val modelId: String)

/**
 * 能按上联生成下联的提供者端口（`couplet` 任务）。是文本生成类任务，但参数与结果都是强类型，不走通用 run。
 *
 * 使用示例：`(registry.get("local-couplet") as CoupletEngine).generate(req)`
 */
interface CoupletEngine {
    /**
     * 生成下联。
     *
     * @param req 已校验的请求
     * @return 生成结果
     * @throws BridgeException NOT_READY（模型未就绪）、BAD_PARAMS（上联含非法字符）、INTERNAL（推理失败）
     */
    suspend fun generate(req: AiCoupletRequest): CoupletResult
}

/**
 * Rust 对联引擎的 Kotlin 侧抽象，真实实现走 UniFFI，单测用替身。
 */
interface CoupletBackend {
    /**
     * 加载运行库与模型目录；同一目录重复调用无副作用。
     *
     * @param modelDir 模型目录绝对路径
     */
    fun load(modelDir: String)

    /** 释放模型会话 */
    fun unload()

    /**
     * 生成下联。阻塞调用；被 [cancel] 打断时抛 [CancellationException]。
     *
     * @param req 已校验的请求
     * @return 生成结果
     */
    fun generate(req: AiCoupletRequest): CoupletOutcome

    /** 打断正在进行的 [generate]，可在任意线程调用，没有生成在跑时无副作用 */
    fun cancel()
}

/**
 * 对联所需的文件环境，抽出来便于单测替身。
 */
interface CoupletEnv {
    /** 模型目录（可能还不存在） */
    fun modelDir(): File
}

/**
 * 对联服务：交给 Rust 生成 -> 组装结果。进程内应只有一份（Rust 侧也是进程级单例）。
 *
 * 模型目录由 [CoupletEnv.modelDir] 指定，必需文件不齐则报 NOT_READY（下载由模型管理负责）。
 * 模型首次生成时才加载；文件被替换后自动重载。重活排在 [AiHeavyGate] 后串行执行；协程被取消时打断 Rust 里的生成。
 *
 * 使用示例：`CoupletService(env, backend).generate(AiCoupletRequest(null, "春风送暖入屠苏"))`
 *
 * @param env 文件环境
 * @param backend Rust 引擎
 * @param now 单调时钟（毫秒），单测可替换
 */
class CoupletService(
    private val env: CoupletEnv,
    private val backend: CoupletBackend,
    private val now: () -> Long = { System.nanoTime() / NANOS_PER_MS },
) {
    /** 当前加载的模型指纹（目录|各文件长度与修改时间） */
    private var loadedKey: String? = null

    /**
     * 模型文件是否齐全（必需文件都存在且非空）。快速返回，供 `native.ai.providers` 探测。
     *
     * @return 齐全返回 true
     */
    fun isModelReady(): Boolean =
        env.modelDir().let { dir -> REQUIRED_FILES.all { File(dir, it).let { f -> f.isFile && f.length() > 0 } } }

    /**
     * 生成下联，排在重任务闸门后执行；协程被取消时打断生成。
     *
     * @param req 已校验的请求
     * @return 生成结果
     * @throws BridgeException NOT_READY（模型未就绪）、BAD_PARAMS（上联不合法）、INTERNAL
     * @throws CancellationException 被取消
     */
    suspend fun generate(req: AiCoupletRequest): CoupletResult = AiHeavyGate.run { generateLocked(req) }

    /**
     * 释放已加载的模型会话，排在重任务闸门后，不会打断正在进行的生成。
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
     * 预热：只加载模型会话，不生成，排在重任务闸门后。加载期间被取消时，加载完成后立刻卸掉。
     *
     * @return 预热结果（provider 为 [LocalCoupletProvider.ID]）
     * @throws BridgeException NOT_READY（模型未就绪）、INTERNAL（加载失败）
     */
    suspend fun warmup(): WarmupResult = AiHeavyGate.run {
        val dir = env.modelDir()
        requireReady(dir)
        val t0 = now()
        val already = fingerprint(dir) == loadedKey
        ensureLoaded(dir)
        if (!already && !currentCoroutineContext().isActive) {
            backend.unload()
            loadedKey = null
            throw CancellationException("预热已取消")
        }
        WarmupResult(LocalCoupletProvider.ID, now() - t0)
    }

    /** 闸门内的实际流程：加载（按需），生成（可被取消打断） */
    private suspend fun generateLocked(req: AiCoupletRequest): CoupletResult {
        val dir = env.modelDir()
        requireReady(dir)
        val t0 = now()
        ensureLoaded(dir)
        val outcome = generateCancellable(req)
        return CoupletResult(outcome.text, now() - t0, MODEL_ID)
    }

    /** 在 IO 线程跑阻塞的生成；外层协程被取消时立刻调 [CoupletBackend.cancel]，正常结束不触发 */
    private suspend fun generateCancellable(req: AiCoupletRequest): CoupletOutcome = coroutineScope {
        val finished = AtomicBoolean(false)
        val watcher = launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                if (!finished.get()) backend.cancel()
            }
        }
        try {
            withContext(Dispatchers.IO) { backend.generate(req) }
        } finally {
            finished.set(true)
            watcher.cancel()
        }
    }

    /** 必需文件不齐则报 NOT_READY */
    private fun requireReady(dir: File) {
        if (!isModelReady()) {
            throw BridgeException(BridgeErrors.NOT_READY, "对联模型未就绪：${dir.path} 缺文件，请先下载模型")
        }
    }

    /** 确保模型已加载；指纹变化时先释放旧会话再加载 */
    private fun ensureLoaded(dir: File) {
        val key = fingerprint(dir)
        if (key == loadedKey) return
        if (loadedKey != null) backend.unload()
        backend.load(dir.path)
        loadedKey = key
    }

    companion object {
        /** 模型标识，与 `assets/ai/models.json` 的 id 一致，也写进结果 */
        const val MODEL_ID = "couplet-gpt2-mnn-w6"

        /** 设备上必需的文件名，与清单里 files 一致 */
        val REQUIRED_FILES: List<String> = listOf(
            "model.mnn",
            "model.mnn.weight",
            "vocab.txt",
            "model.json",
            "NOTICE.txt",
            "UER-py_LICENSE_Apache-2.0.txt",
            "couplet-clean-dataset_LICENSE_MIT.txt",
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
 * 本地对联提供者（L1，GPT-2 字级模型，MNN 6-bit）：声明 `couplet`，可用性取决于模型是否由 `native.model.*` 装好并校验通过。
 *
 * 文本入口 [run] 不适用（对联有自己的强类型端口），请走 `native.ai.couplet`。
 *
 * @param service 对联服务
 * @param models 模型状态来源，对应清单里的 [CoupletService.MODEL_ID]；不传则只看文件是否齐全
 */
class LocalCoupletProvider(private val service: CoupletService, private val models: ModelStateSource? = null) :
    AiProvider, CoupletEngine, AiSessionControl {
    /** 固定 id */
    override val id: String = ID

    /** 展示名 */
    override val displayName: String = "本地对联（GPT-2）"

    /** 专用小模型，属 L1 */
    override val layer: AiLayer = AiLayer.L1

    /** 会话依赖对联模型，删除它前先卸载 */
    override val sessionModelId: String = CoupletService.MODEL_ID

    /** 只做对联 */
    override fun capabilities(): Set<AiTask> = setOf(AiTask.COUPLET)

    /** 报价带字数与采样范围约束 */
    override fun offers(): List<AiOffer> = listOf(AiOffer(AiTask.COUPLET, AiCoupletPolicy.OFFER_CONSTRAINTS))

    /** 有模型状态来源时看“已安装且校验过”，否则看文件齐不齐；不可用一律 not_installed */
    override fun availability(): AiAvailability {
        val ready = if (models != null) models.info(CoupletService.MODEL_ID).installed else service.isModelReady()
        return if (ready) AiAvailability.AVAILABLE else AiAvailability.unavailable(AiUnavailableReason.NOT_INSTALLED)
    }

    /** 有模型状态来源时给出下载状态，否则为 null */
    override fun modelInfo(): AiModelInfo? = models?.info(CoupletService.MODEL_ID)?.let {
        AiModelInfo(CoupletService.MODEL_ID, it.installed, it.diskBytes, it.downloading)
    }

    /** 文本入口一律不收：只经 `native.ai.couplet`（[AiPort.Couplet]） */
    override suspend fun run(task: AiTask, input: String): AiRunResult = throw AiRouter.notRunnable(ID, task)

    /** 转交服务 */
    override suspend fun generate(req: AiCoupletRequest): CoupletResult = service.generate(req)

    /** 预热：加载模型会话 */
    override suspend fun warmup(): WarmupResult = service.warmup()

    /** 卸载模型会话 */
    override suspend fun unloadSession(): Boolean = service.unload()

    companion object {
        /** 提供者 id 常量 */
        const val ID = "local-couplet"
    }
}
