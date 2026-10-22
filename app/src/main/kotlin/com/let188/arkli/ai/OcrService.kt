package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.image.ImageCodec
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
 * 一个点，识别图的像素坐标。
 *
 * @property x 横坐标
 * @property y 纵坐标
 */
data class OcrPoint(val x: Float, val y: Float)

/**
 * 一行识别结果。
 *
 * @property points 文本框四个角（左上、右上、右下、左下）
 * @property text 识别文本
 * @property score 置信度 0~1
 */
data class OcrLine(val points: List<OcrPoint>, val text: String, val score: Float)

/**
 * Rust 返回的原始识别结果。
 *
 * @property width 送进引擎的图宽（坐标系基准）
 * @property height 送进引擎的图高
 * @property lines 文本行，按阅读顺序
 * @property elapsedMs Rust 侧识别耗时（毫秒，不含加载）
 */
data class OcrOutcome(val width: Int, val height: Int, val lines: List<OcrLine>, val elapsedMs: Long)

/**
 * 一次识别的完整结果，交给 [AiOcrPolicy.resultJson] 序列化。
 *
 * @property outcome Rust 返回的识别结果
 * @property modelId 模型标识
 * @property elapsedMs 总耗时（含加载、解码、转换）
 * @property inferMs 其中 Rust 侧识别耗时
 */
data class OcrResult(val outcome: OcrOutcome, val modelId: String, val elapsedMs: Long, val inferMs: Long)

/**
 * 文字识别运行期可调参数（调用级）。
 *
 * @property sensitivity 检测灵敏度：0 宽松、1 标准、2 严格；null 表示缺省
 * @property dropScore 识别最低得分阈值（0.0..=0.8）；null 表示缺省
 * @property maxSide 检测图最长边上限（只允许 640/960/1280）；null 表示缺省
 */
data class OcrRunParams(
    val sensitivity: Int? = null,
    val dropScore: Float? = null,
    val maxSide: Int? = null,
)

/**
 * 能识别图片文字的提供者端口（`ocr` 任务）。与文本类的 [AiProvider.run] 分开，因为输入是文件。
 *
 * 使用示例：`(registry.get("local-ocr") as OcrEngine).recognize(file)`
 */
interface OcrEngine {
    /**
     * 识别一张图里的文字。
     *
     * @param file 图片文件
     * @param params 运行期可调参数；null 表示缺省
     * @return 识别结果
     * @throws BridgeException NOT_READY（模型未就绪）、INTERNAL（解码或推理失败）
     */
    suspend fun recognize(file: File, params: OcrRunParams? = null): OcrResult
}

/**
 * Rust 文字识别引擎的 Kotlin 侧抽象，真实实现走 UniFFI，单测用替身。
 */
interface OcrBackend {
    /**
     * 加载运行库与模型目录；同一目录重复调用无副作用。
     *
     * @param modelDir 模型目录绝对路径
     */
    fun load(modelDir: String)

    /** 释放模型会话 */
    fun unload()

    /**
     * 识别一张图。阻塞调用；被 [cancel] 打断时抛 [CancellationException]。
     *
     * @param width 宽
     * @param height 高
     * @param rgb 行优先 RGB，长度 `width * height * 3`
     * @param params 运行期可调参数；null 表示缺省
     * @return 识别结果
     */
    fun recognize(width: Int, height: Int, rgb: ByteArray, params: OcrRunParams? = null): OcrOutcome

    /** 打断正在进行的 [recognize]，可在任意线程调用，没有识别在跑时无副作用 */
    fun cancel()
}

/**
 * 文字识别所需的文件环境，抽出来便于单测替身。
 */
interface OcrEnv {
    /** 模型目录（可能还不存在） */
    fun modelDir(): File
}

/**
 * 文字识别服务：解码图片 -> 交给 Rust 识别 -> 组装结果。进程内应只有一份（Rust 侧也是进程级单例）。
 *
 * 模型目录由 [OcrEnv.modelDir] 指定，必需文件不齐则报 NOT_READY（下载由模型管理负责）。
 * 模型首次识别时才加载；文件被替换（长度或修改时间变了）后会自动重载。重活排在 [AiHeavyGate] 后串行执行；
 * 协程被取消时会打断 Rust 里的识别（[OcrBackend.cancel]）。
 *
 * 使用示例：`OcrService(env, backend, AndroidImageCodec()).recognize(file)`
 *
 * @param env 文件环境
 * @param backend Rust 引擎
 * @param codec 图片解码器
 * @param settingsKey 会话级设置指纹，并入重载判定；缺省无设置
 * @param now 单调时钟（毫秒），单测可替换
 */
class OcrService(
    private val env: OcrEnv,
    private val backend: OcrBackend,
    private val codec: ImageCodec,
    /** 会话级设置指纹（SESSION 级参数的 hash）；变了下次调用自动重载，缺省无设置 */
    private val settingsKey: () -> String = { "" },
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
     * 识别一张图，排在重任务闸门后执行；协程被取消时打断识别。
     *
     * @param file 图片文件
     * @param params 运行期可调参数；null 表示缺省
     * @return 识别结果
     * @throws BridgeException NOT_READY（模型未就绪）、BAD_PARAMS/INTERNAL（解码失败、推理失败）
     * @throws CancellationException 被取消
     */
    suspend fun recognize(file: File, params: OcrRunParams? = null): OcrResult =
        AiHeavyGate.run { recognizeLocked(file, params) }

    /**
     * 释放已加载的模型会话，排在重任务闸门后，不会打断正在进行的识别。
     * 模型文件被删除前、页面离开时调用；下次识别会按需重新加载。
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
     * 预热：只加载模型会话，不识别，排在重任务闸门后。已加载则立刻返回；
     * 加载期间被取消时，加载完成后立刻卸掉，不留半加载状态。
     *
     * @return 预热结果（provider 为 [LocalOcrProvider.ID]）
     * @throws BridgeException NOT_READY（模型未就绪）、INTERNAL（加载失败）
     */
    suspend fun warmup(): WarmupResult = AiHeavyGate.run {
        val dir = env.modelDir()
        requireReady(dir)
        val t0 = now()
        val already = sessionKey(dir) == loadedKey
        ensureLoaded(dir)
        if (!already && !currentCoroutineContext().isActive) {
            backend.unload()
            loadedKey = null
            throw CancellationException("预热已取消")
        }
        WarmupResult(LocalOcrProvider.ID, now() - t0)
    }

    /** 闸门内的实际流程：加载（按需），解码并收敛尺寸，识别（可被取消打断） */
    private suspend fun recognizeLocked(file: File, params: OcrRunParams?): OcrResult {
        val dir = env.modelDir()
        requireReady(dir)
        val t0 = now()
        ensureLoaded(dir)
        var img = codec.decode(file, AiOcrPolicy.DECODE_MAX_EDGE)
        try {
            AiOcrPolicy.fitSize(img.width, img.height)?.let { (w, h) ->
                val small = codec.scale(img, w, h)
                img.close()
                img = small
            }
            val width = img.width
            val height = img.height
            val rgb = AiClassifyPolicy.argbToRgb(img.toArgb())
            val t1 = now()
            val outcome = recognizeCancellable(width, height, rgb, params)
            val t2 = now()
            return OcrResult(outcome, MODEL_ID, elapsedMs = t2 - t0, inferMs = t2 - t1)
        } finally {
            img.close()
        }
    }

    /**
     * 在 IO 线程跑阻塞的识别；外层协程被取消时立刻调 [OcrBackend.cancel] 让 Rust 在下一个检查点返回，
     * 而不是等一整张图跑完。正常结束不会触发取消。
     */
    private suspend fun recognizeCancellable(width: Int, height: Int, rgb: ByteArray, params: OcrRunParams?): OcrOutcome = coroutineScope {
        val finished = AtomicBoolean(false)
        val watcher = launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                if (!finished.get()) backend.cancel()
            }
        }
        try {
            withContext(Dispatchers.IO) { backend.recognize(width, height, rgb, params) }
        } finally {
            finished.set(true)
            watcher.cancel()
        }
    }

    /** 必需文件不齐则报 NOT_READY */
    private fun requireReady(dir: File) {
        if (!isModelReady()) {
            throw BridgeException(BridgeErrors.NOT_READY, "文字识别模型未就绪：${dir.path} 缺文件，请先下载模型")
        }
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
        const val MODEL_ID = "ppocrv6-small-mnn-fp16"

        /** 设备上必需的文件名，与清单里 files 一致 */
        val REQUIRED_FILES: List<String> =
            listOf(
                "det.mnn", "det.mnn.weight", "rec.mnn", "rec.mnn.weight", "cls.mnn", "cls.mnn.weight",
                "ppocr_keys.txt", "NOTICE.txt", "LICENSE-Apache-2.0.txt",
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
 * 本地文字识别提供者（L1，PP-OCRv6 small，MNN fp16）：声明 `ocr`，可用性取决于模型是否由 `native.model.*` 装好并校验通过。
 *
 * 文本入口 [run] 不适用（输入是图片），请走 `native.ai.ocr`。
 *
 * 传入 [models] 时，可用性以“模型已安装且 sha256 校验通过”为准，并带出下载状态；不传则只看文件是否齐全。
 *
 * @param service 文字识别服务
 * @param models 模型状态来源，对应清单里的 [OcrService.MODEL_ID]
 */
class LocalOcrProvider(private val service: OcrService, private val models: ModelStateSource? = null) :
    AiProvider, OcrEngine, AiSessionControl, AiTunable {
    /** 可调参数：来自 [AiOcrPolicy.PARAM_SPECS]，范围与默认值不在这里另抄 */
    override fun paramSpecs(): List<AiParamSpec> = AiOcrPolicy.PARAM_SPECS

    /** 固定 id */
    override val id: String = ID

    /** 展示名 */
    override val displayName: String = "本地文字识别（PP-OCRv6）"

    /** 专用小模型，属 L1 */
    override val layer: AiLayer = AiLayer.L1

    /** 会话依赖文字识别模型，删除它前先卸载 */
    override val sessionModelId: String = OcrService.MODEL_ID

    /** 只做文字识别 */
    override fun capabilities(): Set<AiTask> = setOf(AiTask.OCR)

    /** 有模型状态来源时看“已安装且校验过”，否则看文件齐不齐；不可用一律 not_installed */
    override fun availability(): AiAvailability {
        val ready = if (models != null) models.info(OcrService.MODEL_ID).installed else service.isModelReady()
        return if (ready) AiAvailability.AVAILABLE else AiAvailability.unavailable(AiUnavailableReason.NOT_INSTALLED)
    }

    /** 有模型状态来源时给出下载状态，否则为 null */
    override fun modelInfo(): AiModelInfo? = models?.info(OcrService.MODEL_ID)?.let {
        AiModelInfo(OcrService.MODEL_ID, it.installed, it.diskBytes, it.downloading)
    }

    /** 文本入口一律不收：输入是图片，只经 `native.ai.ocr`（[AiPort.Ocr]）；路由也不会把 run 派到这里 */
    override suspend fun run(task: AiTask, input: String): AiRunResult = throw AiRouter.notRunnable(ID, task)

    /** 转交服务 */
    override suspend fun recognize(file: File, params: OcrRunParams?): OcrResult = service.recognize(file, params)

    /** 预热：加载模型会话 */
    override suspend fun warmup(): WarmupResult = service.warmup()

    /** 卸载模型会话 */
    override suspend fun unloadSession(): Boolean = service.unload()

    companion object {
        /** 提供者 id 常量 */
        const val ID = "local-ocr"
    }
}
