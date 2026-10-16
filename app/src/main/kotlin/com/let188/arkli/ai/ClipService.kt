package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.image.ImageCodec
import com.let188.arkli.model.ModelStateSource
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import java.io.File

/**
 * 重任务闸门：整个进程同一时刻只放行一个 AI 重任务，后来的排队等待（不报忙）。
 * 原因：低端机连续跑会降频、内存也吃紧，见 docs/research/garbage-classify-clip.md 第 8 节。
 *
 * 使用示例：`AiHeavyGate.run { 重活 }`
 */
object AiHeavyGate {
    /** 互斥锁，协程挂起式排队 */
    private val mutex = Mutex()

    /**
     * 独占执行一个重任务。
     *
     * @param block 任务体
     * @return 任务体的返回值
     */
    suspend fun <T> run(block: suspend () -> T): T = mutex.withLock { block() }
}

/**
 * 识物服务：解码图片 -> 交给 Rust 推理 -> 组装结果。进程内应只有一份（Rust 侧也是进程级单例）。
 *
 * 模型文件由 [ClipEnv.modelFile] 指定，不存在则报 NOT_READY（下载由后续的模型管理负责）。
 * 模型与词表都是首次识别时才加载；模型文件被替换（长度或修改时间变了）后会自动重载。
 *
 * 使用示例：`ClipService(env, backend, AndroidImageCodec()).classify(file, 3)`
 *
 * @param env 文件环境
 * @param backend Rust 引擎
 * @param codec 图片解码器
 * @param now 单调时钟（毫秒），单测可替换
 */
class ClipService(
    private val env: ClipEnv,
    private val backend: ClipBackend,
    private val codec: ImageCodec,
    private val now: () -> Long = { System.nanoTime() / NANOS_PER_MS },
) {
    /** 已设置到 Rust 的词表；null 表示还没设置 */
    private var vocab: ClipVocabMeta? = null

    /** 当前加载的模型指纹（路径|长度|修改时间） */
    private var loadedKey: String? = null

    /**
     * 模型文件是否就绪（存在且非空）。快速返回，供 `native.ai.providers` 探测。
     *
     * @return 就绪返回 true
     */
    fun isModelReady(): Boolean = env.modelFile().let { it.isFile && it.length() > 0 }

    /**
     * 识别一张图，排在重任务闸门后执行。
     *
     * @param file 图片文件
     * @param topK 物品数
     * @return 识别结果
     * @throws BridgeException NOT_READY（模型未就绪）、BAD_PARAMS/INTERNAL（解码失败、推理失败）
     */
    suspend fun classify(file: File, topK: Int): ClassifyResult = AiHeavyGate.run { classifyLocked(file, topK) }

    /**
     * 释放已加载的模型会话（词表保留），排在重任务闸门后，不会打断正在进行的识别。
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
     * 预热：加载词表与模型会话，不识别，排在重任务闸门后。已加载则立刻返回；
     * 加载期间被取消时，加载完成后立刻卸掉，不留半加载状态。
     *
     * @return 预热结果（provider 为 [LocalClipProvider.ID]）
     * @throws BridgeException NOT_READY（模型未就绪）、INTERNAL（加载失败）
     */
    suspend fun warmup(): WarmupResult = AiHeavyGate.run {
        val model = env.modelFile()
        if (!isModelReady()) {
            throw BridgeException(BridgeErrors.NOT_READY, "识物模型未就绪：${model.path} 不存在，请先下载或放置模型")
        }
        val t0 = now()
        val already = loadedKey != null && loadedKey == "${model.path}|${model.length()}|${model.lastModified()}"
        ensureReady(model)
        if (!already && !currentCoroutineContext().isActive) {
            backend.unload()
            loadedKey = null
            throw CancellationException("预热已取消")
        }
        WarmupResult(LocalClipProvider.ID, now() - t0)
    }

    /** 闸门内的实际流程 */
    private fun classifyLocked(file: File, topK: Int): ClassifyResult {
        val model = env.modelFile()
        if (!isModelReady()) {
            throw BridgeException(BridgeErrors.NOT_READY, "识物模型未就绪：${model.path} 不存在，请先下载或放置模型")
        }
        val t0 = now()
        val meta = ensureReady(model)
        val rgb: ByteArray
        val width: Int
        val height: Int
        codec.decode(file, DECODE_MAX_EDGE).use { img ->
            width = img.width
            height = img.height
            rgb = AiClassifyPolicy.argbToRgb(img.toArgb())
        }
        val t1 = now()
        val outcome = backend.classify(width, height, rgb, topK)
        val t2 = now()
        return ClassifyResult(meta, outcome, MODEL_ID, elapsedMs = t2 - t0, inferMs = t2 - t1)
    }

    /** 确保词表与模型都已加载，返回词表元数据 */
    private fun ensureReady(model: File): ClipVocabMeta {
        val meta = vocab ?: loadVocab().also { vocab = it }
        val key = "${model.path}|${model.length()}|${model.lastModified()}"
        if (key != loadedKey) {
            // 模型被替换：先释放旧会话，避免两份模型同时占内存
            if (loadedKey != null) backend.unload()
            backend.load(model.path)
            loadedKey = key
        }
        return meta
    }

    /** 读取并校验词表，再交给 Rust */
    private fun loadVocab(): ClipVocabMeta {
        try {
            val meta = AiClassifyPolicy.parseVocab(env.readVocabJson())
            val bytes = env.readVocabVectors()
            AiClassifyPolicy.checkVocabVectors(meta, bytes)
            backend.setVocab(meta, bytes)
            return meta
        } catch (e: IllegalArgumentException) {
            throw BridgeException(BridgeErrors.INTERNAL, "识物词表损坏：${e.message}")
        }
    }

    companion object {
        /** 模型标识，写进结果 */
        const val MODEL_ID = "siglip2-mnn-w8"

        /** 解码阶段的最长边：先降采样省内存，最终缩到 224 由 Rust 完成 */
        const val DECODE_MAX_EDGE = 896

        /** 纳秒转毫秒 */
        private const val NANOS_PER_MS = 1_000_000L
    }
}

/**
 * 本地识物提供者（L1，SigLIP2 MNN int8）：声明 `classifyImage`，可用性取决于模型文件是否就绪。
 *
 * 文本入口 [run] 不适用（输入是图片），请走 `native.ai.classify`。
 *
 * 传入 [models] 时，可用性以“模型已安装且 sha256 校验通过”为准，并带出下载状态；不传则只看文件是否存在（旧行为）。
 *
 * @param service 识物服务
 * @param models 模型状态来源，对应清单里的 [ClipService.MODEL_ID]
 */
class LocalClipProvider(private val service: ClipService, private val models: ModelStateSource? = null) :
    AiProvider, ImageClassifier, AiSessionControl {
    /** 固定 id */
    override val id: String = ID

    /** 展示名 */
    override val displayName: String = "本地识物（SigLIP2）"

    /** 专用小模型，属 L1 */
    override val layer: AiLayer = AiLayer.L1

    /** 会话依赖识物模型，删除它前先卸载 */
    override val sessionModelId: String = ClipService.MODEL_ID

    /** 只做识图 */
    override fun capabilities(): Set<AiTask> = setOf(AiTask.CLASSIFY_IMAGE)

    /** 有模型状态来源时看“已安装且校验过”，否则看文件在不在；不可用一律 not_installed */
    override fun availability(): AiAvailability {
        val ready = if (models != null) models.info(ClipService.MODEL_ID).installed else service.isModelReady()
        return if (ready) AiAvailability.AVAILABLE else AiAvailability.unavailable(AiUnavailableReason.NOT_INSTALLED)
    }

    /** 有模型状态来源时给出下载状态，否则为 null */
    override fun modelInfo(): AiModelInfo? = models?.info(ClipService.MODEL_ID)?.let {
        AiModelInfo(ClipService.MODEL_ID, it.installed, it.diskBytes, it.downloading)
    }

    /** 文本入口一律不收：输入是图片，只经 `native.ai.classify`（[AiPort.Classify]）；路由也不会把 run 派到这里 */
    override suspend fun run(task: AiTask, input: String): AiRunResult = throw AiRouter.notRunnable(ID, task)

    /** 转交服务 */
    override suspend fun classify(file: File, topK: Int): ClassifyResult = service.classify(file, topK)

    /** 预热：加载词表与模型会话 */
    override suspend fun warmup(): WarmupResult = service.warmup()

    /** 卸载模型会话 */
    override suspend fun unloadSession(): Boolean = service.unload()

    companion object {
        /** 提供者 id 常量 */
        const val ID = "local-clip"
    }
}
