package com.let188.arkli.ai

import com.let188.arkli.image.CodecImage
import com.let188.arkli.image.ImageCodec
import com.let188.arkli.image.OutFormat
import com.let188.arkli.model.ModelStateSource
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * AI 测试共用的替身：用它们调 [AiModule.providers]，得到与正式注册完全相同的提供者列表，不需要真模型。
 * 识物、文字识别、NLLB、对联的模型文件不放（不可用，NOT_READY）；Qwen 文件写齐、引擎回固定文本（可用，run/translate 能跑通）。
 */
internal object AiFixtures {
    /** Qwen 替身引擎的固定输出 */
    const val QWEN_OUT = "ok"

    /** 交接平台替身：有响应者、总能拉起 */
    class OkHandoff : HandoffPlatform {
        /** 恒有响应者 */
        override fun hasProcessTextHandler() = true

        /** 恒能拉起 */
        override fun sendProcessText(text: String) = true
    }

    /** 不该被调用的识物引擎（卸载除外：卸载幂等，回收时会调） */
    class NoClip : ClipBackend {
        override fun load(modelPath: String) = error("不该加载")
        override fun unload() {}
        override fun setVocab(meta: ClipVocabMeta, vectorsF16le: ByteArray) = error("不该设词表")
        override fun classify(width: Int, height: Int, rgb: ByteArray, topK: Int): ClassifyOutcome = error("不该识别")
    }

    /** 不该被调用的文字识别引擎（卸载除外） */
    class NoOcr : OcrBackend {
        override fun load(modelDir: String) = error("不该加载")
        override fun unload() {}
        override fun recognize(width: Int, height: Int, rgb: ByteArray): OcrOutcome = error("不该识别")
        override fun cancel() {}
    }

    /** 不该被调用的解码器 */
    class NoCodec : ImageCodec {
        override fun decode(file: File, maxEdge: Int?): CodecImage = error("不该解码")
        override fun scale(src: CodecImage, width: Int, height: Int): CodecImage = error("不该缩放")
        override fun encodeLossy(img: CodecImage, format: OutFormat, quality: Int): ByteArray = error("不该编码")
    }

    /** 不该被调用的翻译引擎（卸载除外） */
    class NoTranslate : TranslateBackend {
        override fun load(modelDir: String) = error("不该加载")
        override fun unload() {}
        override fun translate(text: String, src: String, tgt: String, numBeams: Int): TranslateOutcome = error("不该翻译")
    }

    /** 不该被调用的对联引擎（卸载除外） */
    class NoCouplet : CoupletBackend {
        override fun load(modelDir: String) = error("不该加载")
        override fun unload() {}
        override fun generate(req: AiCoupletRequest): CoupletOutcome = error("不该生成")
        override fun cancel() {}
    }

    /** 文本模型引擎替身：直接回 [QWEN_OUT] */
    class EchoQwen : QwenBackend {
        override fun load(configPath: String) {}
        override fun unload() {}
        override fun generate(system: String, prompt: String, maxNewTokens: Int, sampling: Sampling) = QWEN_OUT
    }

    /**
     * 用替身服务构造与正式注册完全相同的提供者列表。
     *
     * @param tmp 临时目录规则
     * @param models 模型状态来源；null 时各本地提供者只看文件
     * @return `AiModule.providers(...)` 的结果
     */
    fun registered(tmp: TemporaryFolder, models: ModelStateSource? = null): List<AiProvider> {
        val clipModel = File(tmp.newFolder(), CLIP_MODEL_FILE)
        val clip = ClipService(
            object : ClipEnv {
                override fun modelFile() = clipModel
                override fun readVocabJson() = error("不该读词表")
                override fun readVocabVectors() = error("不该读词表")
            },
            NoClip(),
            NoCodec(),
        )
        val ocrDir = tmp.newFolder()
        val ocr = OcrService(object : OcrEnv { override fun modelDir() = ocrDir }, NoOcr(), NoCodec())
        val nllbDir = tmp.newFolder()
        val translate = TranslateService(object : TranslateEnv { override fun modelDir() = nllbDir }, NoTranslate())
        val qwenDir = tmp.newFolder()
        QwenService.REQUIRED_FILES.forEach { File(qwenDir, it).writeText("x") }
        val qwen = QwenService(object : QwenEnv { override fun modelDir() = qwenDir }, EchoQwen())
        val coupletDir = tmp.newFolder()
        val couplet = CoupletService(object : CoupletEnv { override fun modelDir() = coupletDir }, NoCouplet())
        return AiModule.providers(OkHandoff(), clip, ocr, translate, qwen, couplet, models)
    }
}
