package com.let188.arkli.ai

import java.io.File

/**
 * 词表里的一个物品。
 *
 * @property id 稳定 id，如 `milk_carton`
 * @property nameZh 中文名
 * @property nameEn 英文名
 * @property category 分类代码，如 `R`
 */
data class ClipVocabItem(val id: String, val nameZh: String, val nameEn: String, val category: String)

/**
 * 词表元数据（`garbage_vocab.json` 解析结果）。向量在同名 `.f16` 文件里。
 *
 * @property dim 向量维度
 * @property items 条目，与向量行一一对应
 * @property categoryNames 分类代码到中文名，如 `R` 到 `可回收物`
 * @property note 文件头里的提示（分类草稿需核对）
 */
data class ClipVocabMeta(
    val dim: Int,
    val items: List<ClipVocabItem>,
    val categoryNames: Map<String, String>,
    val note: String,
)

/**
 * 一个命中的物品。
 *
 * @property index 词表下标
 * @property score 余弦相似度
 */
data class ClassifyHit(val index: Int, val score: Float)

/**
 * 一个分类的聚合概率。
 *
 * @property category 分类代码
 * @property prob 概率
 */
data class CategoryProb(val category: String, val prob: Float)

/**
 * Rust 返回的原始分类结果。
 *
 * @property hits top-k 物品，余弦从大到小
 * @property categories 分类概率，从大到小
 * @property confidence 最大分类概率
 * @property uncertain 是否低于“拿不准”阈值
 */
data class ClassifyOutcome(
    val hits: List<ClassifyHit>,
    val categories: List<CategoryProb>,
    val confidence: Float,
    val uncertain: Boolean,
)

/**
 * 一次识别的完整结果（带词表信息与耗时），交给 [AiClassifyPolicy.resultJson] 序列化。
 *
 * @property vocab 词表，用来把下标换成物品信息
 * @property outcome Rust 返回的分类结果
 * @property modelId 模型标识
 * @property elapsedMs 总耗时（含解码、缩放）
 * @property inferMs 其中 Rust 侧（缩放 + 推理 + 分类）耗时
 */
data class ClassifyResult(
    val vocab: ClipVocabMeta,
    val outcome: ClassifyOutcome,
    val modelId: String,
    val elapsedMs: Long,
    val inferMs: Long,
)

/**
 * 能识别图片的提供者（`classifyImage` 任务）。与文本类的 [AiProvider.run] 分开，因为输入是文件。
 *
 * 使用示例：`(registry.get("local-clip") as ImageClassifier).classify(file, 3)`
 */
interface ImageClassifier {
    /**
     * 识别一张图。
     *
     * @param file 图片文件
     * @param topK 返回的物品数
     * @return 识别结果
     * @throws com.let188.arkli.bridge.BridgeException NOT_READY（模型未就绪）、INTERNAL（解码或推理失败）
     */
    suspend fun classify(file: File, topK: Int): ClassifyResult
}

/**
 * Rust 识物引擎的 Kotlin 侧抽象，真实实现走 UniFFI，单测用替身。
 */
interface ClipBackend {
    /**
     * 加载 MNN 运行库与模型；同一模型重复调用无副作用。
     *
     * @param modelPath 模型文件绝对路径
     */
    fun load(modelPath: String)

    /** 释放模型会话（词表保留） */
    fun unload()

    /**
     * 设置词表。
     *
     * @param meta 词表元数据
     * @param vectorsF16le `items.size * dim` 个小端 fp16
     */
    fun setVocab(meta: ClipVocabMeta, vectorsF16le: ByteArray)

    /**
     * 对一张图分类。
     *
     * @param width 宽
     * @param height 高
     * @param rgb 行优先 RGB，长度 `width * height * 3`
     * @param topK 物品数
     * @return 分类结果
     */
    fun classify(width: Int, height: Int, rgb: ByteArray, topK: Int): ClassifyOutcome
}

/**
 * 识物所需的文件环境，抽出来便于单测替身。
 */
interface ClipEnv {
    /** 模型文件（可能还不存在） */
    fun modelFile(): File

    /** 读词表 JSON 文本 */
    fun readVocabJson(): String

    /** 读词表向量字节 */
    fun readVocabVectors(): ByteArray
}
