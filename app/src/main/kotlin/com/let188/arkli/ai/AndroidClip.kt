package com.let188.arkli.ai

import android.content.Context
import android.util.Log
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.image.AndroidImageCodec
import uniffi.arkli_ffi.ClipFfiException
import uniffi.arkli_ffi.ClipVocabEntry
import uniffi.arkli_ffi.clipClassify
import uniffi.arkli_ffi.clipLoad
import uniffi.arkli_ffi.clipSetVocab
import uniffi.arkli_ffi.clipUnload
import java.io.File

/** 识物日志 tag */
private const val CLIP_LOG_TAG = "ArkliClip"

/**
 * ORT 动态库名。**必须用裸名**：Rust 的 load-dynamic 会 dlopen 它，系统按本应用的 native 库命名空间解析，
 * 找到的就是 APK 里 `lib/arm64-v8a/libonnxruntime.so`（来自 sherpa-onnx 1.13.8，ORT 1.28.2）。
 */
const val ORT_LIB_NAME = "libonnxruntime.so"

/** Rust 算子线程数（骁龙 680 上 4 线程是甜点，见调研文档第 8 节） */
private const val CLIP_THREADS = 4u

/** 模型目录（相对 filesDir） */
const val CLIP_MODEL_DIR = "models/siglip2-q4_half"

/** 模型文件名 */
const val CLIP_MODEL_FILE = "q4_half.onnx"

/** 词表资源（assets 内路径） */
private const val ASSET_VOCAB_JSON = "ai/garbage_vocab.json"
private const val ASSET_VOCAB_VECTORS = "ai/garbage_vocab.f16"

/**
 * 安卓实现的文件环境：模型在 `filesDir/models/...`，词表在 assets。
 *
 * @param context 应用上下文
 */
internal class AndroidClipEnv(context: Context) : ClipEnv {
    /** 应用上下文 */
    private val ctx = context.applicationContext

    /** 模型文件位置 */
    override fun modelFile(): File = File(File(ctx.filesDir, CLIP_MODEL_DIR), CLIP_MODEL_FILE)

    /** 读词表 JSON */
    override fun readVocabJson(): String = ctx.assets.open(ASSET_VOCAB_JSON).use { it.readBytes().toString(Charsets.UTF_8) }

    /** 读词表向量 */
    override fun readVocabVectors(): ByteArray = ctx.assets.open(ASSET_VOCAB_VECTORS).use { it.readBytes() }
}

/**
 * 基于 UniFFI 的真实引擎。Rust 侧对调用加锁串行；这里把 Rust 的错误翻译成桥错误码。
 */
internal class UniffiClipBackend : ClipBackend {
    /** 加载 ORT 与模型 */
    override fun load(modelPath: String) = guard { clipLoad(ORT_LIB_NAME, modelPath, CLIP_THREADS) }

    /** 释放模型会话 */
    override fun unload() = clipUnload()

    /** 设置词表 */
    override fun setVocab(meta: ClipVocabMeta, vectorsF16le: ByteArray) = guard {
        val entries = meta.items.map { ClipVocabEntry(it.id, it.nameZh, it.nameEn, it.category) }
        clipSetVocab(entries, meta.dim.toUInt(), vectorsF16le)
    }

    /** 分类 */
    override fun classify(width: Int, height: Int, rgb: ByteArray, topK: Int): ClassifyOutcome = guard {
        val r = clipClassify(width.toUInt(), height.toUInt(), rgb, topK.toUInt())
        ClassifyOutcome(
            r.items.map { ClassifyHit(it.index.toInt(), it.score) },
            r.categories.map { CategoryProb(it.category, it.prob) },
            r.confidence,
            r.uncertain,
        )
    }

    /** 把 Rust 错误翻译成桥错误 */
    private fun <T> guard(block: () -> T): T = try {
        block()
    } catch (e: ClipFfiException.NotLoaded) {
        throw BridgeException(BridgeErrors.NOT_READY, e.message.orEmpty())
    } catch (e: ClipFfiException.InvalidInput) {
        throw BridgeException(BridgeErrors.BAD_PARAMS, e.message.orEmpty())
    } catch (e: ClipFfiException) {
        Log.e(CLIP_LOG_TAG, "Rust 推理失败", e)
        throw BridgeException(BridgeErrors.INTERNAL, e.message.orEmpty())
    }
}

/**
 * 进程内唯一的识物服务（Rust 侧会话也是进程级单例，WebView 重建时不能重复创建）。
 */
internal object ClipRuntime {
    /** 单例，首次使用时创建 */
    @Volatile
    private var service: ClipService? = null

    /**
     * 取识物服务。
     *
     * @param context 应用上下文
     * @return 进程内唯一的服务
     */
    fun get(context: Context): ClipService = service ?: synchronized(this) {
        service ?: ClipService(AndroidClipEnv(context), UniffiClipBackend(), AndroidImageCodec()).also { service = it }
    }
}
