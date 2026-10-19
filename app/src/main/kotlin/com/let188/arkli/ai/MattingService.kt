package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.image.ImageCodec
import com.let188.arkli.image.PngEncoder
import com.let188.arkli.image.PngTuning
import com.let188.arkli.model.ModelStateSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 一次抠图的完整结果，交给 [AiMattingPolicy.resultJson] 序列化。
 *
 * @property path 带透明通道的 PNG 的页面路径（`cache/out/...`）
 * @property width PNG 宽
 * @property height PNG 高
 * @property mode 使用的模式
 * @property modelId 模型标识
 * @property elapsedMs 总耗时（含加载、解码、推理、合成与编码）
 * @property inferMs 其中 Rust 侧抠图总耗时（缩放、前向、alpha 缩回原尺寸、边缘细化）
 * @property refineMs 其中边缘细化（引导滤波 + 前景色估计）耗时，关闭细化时为 0
 */
data class MattingResult(
    val path: String,
    val width: Int,
    val height: Int,
    val mode: MattingMode,
    val modelId: String,
    val elapsedMs: Long,
    val inferMs: Long,
    val refineMs: Long = 0L,
)

/**
 * 边缘细化强度，与 Rust 侧 `MattingFfiRefine` 一一对应。页面暂未暴露滑块，原生一律用 [STANDARD]，给后续滑块留口。
 *
 * 使用示例：`backend.matte(w, h, rgb, MattingRefine.STRONG)`
 */
enum class MattingRefine {
    /** 不细化：alpha 原样，前景色即原图像素 */
    OFF,

    /** 轻 */
    LIGHT,

    /** 标准（缺省） */
    STANDARD,

    /** 强：过渡更利落，细发丝可能被削弱 */
    STRONG,
}

/**
 * Rust 返回的原始抠图结果。
 *
 * @property width 宽（同送进引擎的图）
 * @property height 高
 * @property alpha 与图同尺寸的 8 位 alpha，长度 `width * height`
 * @property fg 去污染后的前景色 RGB（straight alpha），长度 `width * height * 3`
 * @property elapsedMs Rust 侧总耗时（毫秒，不含加载）
 * @property refineMs 其中边缘细化耗时，关闭细化时为 0
 */
class MattingOutcome(
    val width: Int,
    val height: Int,
    val alpha: ByteArray,
    val fg: ByteArray,
    val elapsedMs: Long,
    val refineMs: Long = 0L,
)

/**
 * 能给图片抠图的提供者端口（`matting` 任务）。与文本类的 [AiProvider.run] 分开，因为输入是文件、输出也是文件。
 *
 * 使用示例：`(registry.get("local-matting-portrait") as MattingEngine).matte(file)`
 */
interface MattingEngine {
    /**
     * 对一张图抠图，成品 PNG 写进缓存的 `out/` 目录。
     *
     * @param file 图片文件
     * @return 抠图结果
     * @throws BridgeException NOT_READY（模型未就绪）、BAD_PARAMS/INTERNAL（解码失败、推理失败、内存不足）
     * @throws CancellationException 被取消（一次前向不可中途打断，最迟在前向结束后生效）
     */
    suspend fun matte(file: File): MattingResult
}

/**
 * Rust 抠图引擎的 Kotlin 侧抽象，真实实现走 UniFFI，单测用替身。每个实例只对应一种模式。
 */
interface MattingBackend {
    /**
     * 加载运行库与模型；同一文件重复调用无副作用。
     *
     * @param modelPath `.mnn` 模型文件绝对路径
     */
    fun load(modelPath: String)

    /** 释放模型会话 */
    fun unload()

    /**
     * 抠图。阻塞调用；被 [cancel] 打断时抛 [CancellationException]（一次前向跑完才会生效）。
     *
     * @param width 宽
     * @param height 高
     * @param rgb 行优先 RGB，长度 `width * height * 3`
     * @param refine 边缘细化强度，缺省标准
     * @return 与图同尺寸的 alpha 与去污染前景色
     */
    fun matte(width: Int, height: Int, rgb: ByteArray, refine: MattingRefine = MattingRefine.STANDARD): MattingOutcome

    /** 打断正在进行的 [matte]，可在任意线程调用，没有抠图在跑时无副作用 */
    fun cancel()
}

/**
 * 抠图所需的文件环境，抽出来便于单测替身。
 */
interface MattingEnv {
    /** 模型目录（可能还不存在） */
    fun modelDir(): File

    /** 成品目录（缓存根下的 `out/`，可能还不存在） */
    fun outDir(): File

    /**
     * 成品的页面路径。
     *
     * @param file 成品文件（在 [outDir] 内）
     * @return 形如 `cache/out/a.png`
     */
    fun pagePath(file: File): String
}

/**
 * 抠图服务：解码 -> 交给 Rust 出 alpha -> 合成透明 PNG 写盘。每个模式一个实例（Rust 侧每种模式一个槽位）。
 *
 * 模型目录由 [MattingEnv.modelDir] 指定，必需文件不齐则报 NOT_READY（下载由模型管理负责）。
 * 模型首次抠图时才加载；文件被替换（长度或修改时间变了）后会自动重载。重活排在 [AiHeavyGate] 后串行执行。
 *
 * **取消**：一次前向没有循环可插检查点，不可中途打断。这里在预处理前、推理前、后处理（合成）前各检查一次协程取消，
 * 推理中被取消则调 [MattingBackend.cancel]，Rust 在前向结束后的检查点返回（4 线程最长约 0.6~0.8 秒）；
 * 取消后会话保留，下一次调用正常运行。
 *
 * 使用示例：`MattingService(MattingMode.PORTRAIT, env, backend, AndroidImageCodec()).matte(file)`
 *
 * @param mode 模式
 * @param env 文件环境
 * @param backend Rust 引擎
 * @param codec 图片解码器
 * @param now 单调时钟（毫秒），单测可替换
 */
class MattingService(
    val mode: MattingMode,
    private val env: MattingEnv,
    private val backend: MattingBackend,
    private val codec: ImageCodec,
    private val now: () -> Long = { System.nanoTime() / NANOS_PER_MS },
) {
    /** 当前加载的模型指纹（路径|各文件长度与修改时间） */
    private var loadedKey: String? = null

    /** 本模式必需的文件名：模型、说明、许可证 */
    val requiredFiles: List<String> get() = requiredFilesOf(mode)

    /**
     * 模型文件是否齐全（必需文件都存在且非空）。快速返回，供 `native.ai.providers` 探测。
     *
     * @return 齐全返回 true
     */
    fun isModelReady(): Boolean =
        env.modelDir().let { dir -> requiredFiles.all { File(dir, it).let { f -> f.isFile && f.length() > 0 } } }

    /**
     * 抠图，排在重任务闸门后执行；协程被取消时尽快退出。
     *
     * @param file 图片文件
     * @return 抠图结果
     * @throws BridgeException NOT_READY（模型未就绪）、BAD_PARAMS/INTERNAL（解码失败、推理失败、内存不足）
     * @throws CancellationException 被取消
     */
    suspend fun matte(file: File): MattingResult = AiHeavyGate.run { matteLocked(file) }

    /**
     * 释放已加载的模型会话，排在重任务闸门后，不会打断正在进行的抠图。
     * 模型文件被删除前、页面离开时调用；下次抠图会按需重新加载。
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
     * 预热：只加载模型会话，不抠图，排在重任务闸门后。已加载则立刻返回；
     * 加载期间被取消时，加载完成后立刻卸掉，不留半加载状态。
     *
     * @return 预热结果（provider 为本模式的提供者 id）
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
        WarmupResult(mode.providerId, now() - t0)
    }

    /** 闸门内的实际流程：加载（按需）-> 解码并收敛尺寸 -> 抠图（可被取消）-> 合成写盘 */
    private suspend fun matteLocked(file: File): MattingResult {
        val dir = env.modelDir()
        requireReady(dir)
        val t0 = now()
        ensureLoaded(dir)
        currentCoroutineContext().ensureActive()
        var img = codec.decode(file, AiMattingPolicy.MAX_EDGE)
        try {
            AiMattingPolicy.fitSize(img.width, img.height)?.let { (w, h) ->
                val small = codec.scale(img, w, h)
                img.close()
                img = small
            }
            val width = img.width
            val height = img.height
            val argb = img.toArgb()
            val rgb = AiClassifyPolicy.argbToRgb(argb)
            currentCoroutineContext().ensureActive()
            val t1 = now()
            val outcome = matteCancellable(width, height, rgb)
            val t2 = now()
            // 后处理（合成与编码）前再看一眼：取消了就别白费这几百毫秒
            currentCoroutineContext().ensureActive()
            val path = withContext(Dispatchers.IO) { composeAndWrite(argb, outcome, currentCoroutineContext()[Job]) }
            return MattingResult(
                env.pagePath(path), width, height, mode, mode.modelId,
                elapsedMs = now() - t0, inferMs = t2 - t1, refineMs = outcome.refineMs,
            )
        } finally {
            img.close()
        }
    }

    /**
     * 把 alpha 乘进原像素的透明度（原图自带透明度的保留），RGB 换成去污染后的前景色（straight alpha，非预乘），
     * 编码成 PNG 写进成品目录。
     * 先写 `.part` 再改名，中途失败或取消不留半成品。
     */
    private fun composeAndWrite(argb: IntArray, outcome: MattingOutcome, job: Job?): File {
        if (outcome.alpha.size != argb.size) {
            throw BridgeException(BridgeErrors.INTERNAL, "alpha 尺寸 ${outcome.alpha.size} 与图像素数 ${argb.size} 不符")
        }
        if (outcome.fg.size != argb.size * RGB_CHANNELS) {
            throw BridgeException(BridgeErrors.INTERNAL, "前景色长度 ${outcome.fg.size} 与图像素数 ${argb.size} 不符")
        }
        val fg = outcome.fg
        for (i in argb.indices) {
            val a = outcome.alpha[i].toInt() and BYTE_MASK
            val src = argb[i] ushr ALPHA_SHIFT
            val merged = if (src == BYTE_MASK) a else (a * src + HALF_BYTE) / BYTE_MASK
            val o = i * RGB_CHANNELS
            val rgb = ((fg[o].toInt() and BYTE_MASK) shl RED_SHIFT) or ((fg[o + 1].toInt() and BYTE_MASK) shl GREEN_SHIFT) or
                (fg[o + 2].toInt() and BYTE_MASK)
            argb[i] = (merged shl ALPHA_SHIFT) or rgb
        }
        val dir = env.outDir().apply { mkdirs() }
        val dst = File(dir, "$OUT_PREFIX${mode.wire}_${UUID.randomUUID().toString().take(ID_LEN)}.png")
        val part = File(dir, dst.name + PART_SUFFIX)
        try {
            val png = PngEncoder.encodeRgba(argb, outcome.width, outcome.height, tuning = PngTuning.FAST, check = { job?.ensureActive() })
            part.writeBytes(png)
            if (!part.renameTo(dst)) throw BridgeException(BridgeErrors.INTERNAL, "成品写入失败")
        } finally {
            part.delete()
        }
        return dst
    }

    /**
     * 在 IO 线程跑阻塞的抠图；外层协程被取消时立刻调 [MattingBackend.cancel]，让 Rust 在前向结束后的检查点返回。
     * 正常结束不会触发取消。
     */
    private suspend fun matteCancellable(width: Int, height: Int, rgb: ByteArray): MattingOutcome = coroutineScope {
        val finished = AtomicBoolean(false)
        val watcher = launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                if (!finished.get()) backend.cancel()
            }
        }
        try {
            withContext(Dispatchers.IO) { backend.matte(width, height, rgb) }
        } finally {
            finished.set(true)
            watcher.cancel()
        }
    }

    /** 必需文件不齐则报 NOT_READY */
    private fun requireReady(dir: File) {
        if (!isModelReady()) {
            throw BridgeException(BridgeErrors.NOT_READY, "抠图模型未就绪：${dir.path} 缺文件，请先下载模型")
        }
    }

    /** 确保模型已加载；指纹变化时先释放旧会话再加载 */
    private fun ensureLoaded(dir: File) {
        val key = fingerprint(dir)
        if (key == loadedKey) return
        // 模型被替换：先释放旧会话，避免两份模型同时占内存
        if (loadedKey != null) backend.unload()
        backend.load(File(dir, mode.modelFile).path)
        loadedKey = key
    }

    /** 计算模型指纹：目录路径加每个必需文件的长度与修改时间，任一变化都会触发重载 */
    private fun fingerprint(dir: File): String = fingerprintOf(mode, dir)

    companion object {
        /** 纳秒转毫秒 */
        private const val NANOS_PER_MS = 1_000_000L

        /** 字节掩码 */
        private const val BYTE_MASK = 0xFF

        /** 每像素的 RGB 字节数 */
        private const val RGB_CHANNELS = 3

        /** ARGB 里红色的位移 */
        private const val RED_SHIFT = 16

        /** ARGB 里绿色的位移 */
        private const val GREEN_SHIFT = 8

        /** ARGB 里 alpha 的位移 */
        private const val ALPHA_SHIFT = 24

        /** 四舍五入用的半个字节量程 */
        private const val HALF_BYTE = 127

        /** 成品文件名前缀 */
        private const val OUT_PREFIX = "matting_"

        /** 成品文件名里随机段的长度 */
        private const val ID_LEN = 8

        /** 半成品后缀 */
        private const val PART_SUFFIX = ".part"

        /** 说明文件名（随模型下载） */
        private const val NOTICE_FILE = "NOTICE.txt"

        /** 许可证文件名（随模型下载） */
        private const val LICENSE_FILE = "LICENSE-Apache-2.0.txt"

        /**
         * 某模式设备上必需的文件名，与清单里 files 一致。
         *
         * @param mode 模式
         * @return 文件名列表：模型、说明、许可证
         */
        fun requiredFilesOf(mode: MattingMode): List<String> = listOf(mode.modelFile, NOTICE_FILE, LICENSE_FILE)

        /**
         * 计算模型指纹：目录路径加每个必需文件的长度与修改时间。
         *
         * @param mode 模式
         * @param dir 模型目录
         * @return 指纹字符串
         */
        fun fingerprintOf(mode: MattingMode, dir: File): String =
            dir.path + requiredFilesOf(mode).joinToString("") { File(dir, it).let { f -> "|${f.length()}:${f.lastModified()}" } }
    }
}

/**
 * 本地抠图提供者（L1）：一个模式一个实例，声明 `matting`，可用性取决于对应模型是否由 `native.model.*` 装好并校验通过。
 * 人像用 MODNet（`local-matting-portrait`），通用用 U2Net-p（`local-matting-general`）。
 *
 * 文本入口 [run] 不适用（输入是图片），请走 `native.ai.matting`。
 *
 * 传入 [models] 时，可用性以“模型已安装且 sha256 校验通过”为准，并带出下载状态；不传则只看文件是否齐全。
 *
 * @param service 本模式的抠图服务
 * @param models 模型状态来源，对应清单里的 [MattingMode.modelId]
 */
class LocalMattingProvider(private val service: MattingService, private val models: ModelStateSource? = null) :
    AiProvider, MattingEngine, AiSessionControl {
    /** 模式 */
    private val mode: MattingMode = service.mode

    /** 每个模式一个 id */
    override val id: String = mode.providerId

    /** 展示名 */
    override val displayName: String = mode.displayName

    /** 专用小模型，属 L1 */
    override val layer: AiLayer = AiLayer.L1

    /** 会话依赖本模式的模型，删除它前先卸载 */
    override val sessionModelId: String = mode.modelId

    /** 只做抠图 */
    override fun capabilities(): Set<AiTask> = setOf(AiTask.MATTING)

    /** 有模型状态来源时看“已安装且校验过”，否则看文件齐不齐；不可用一律 not_installed */
    override fun availability(): AiAvailability {
        val ready = if (models != null) models.info(mode.modelId).installed else service.isModelReady()
        return if (ready) AiAvailability.AVAILABLE else AiAvailability.unavailable(AiUnavailableReason.NOT_INSTALLED)
    }

    /** 有模型状态来源时给出下载状态，否则为 null */
    override fun modelInfo(): AiModelInfo? = models?.info(mode.modelId)?.let {
        AiModelInfo(mode.modelId, it.installed, it.diskBytes, it.downloading)
    }

    /** 文本入口一律不收：输入是图片，只经 `native.ai.matting`（[AiPort.Matting]）；路由也不会把 run 派到这里 */
    override suspend fun run(task: AiTask, input: String): AiRunResult = throw AiRouter.notRunnable(id, task)

    /** 转交服务 */
    override suspend fun matte(file: File): MattingResult = service.matte(file)

    /** 预热：加载模型会话 */
    override suspend fun warmup(): WarmupResult = service.warmup()

    /** 卸载模型会话 */
    override suspend fun unloadSession(): Boolean = service.unload()
}
