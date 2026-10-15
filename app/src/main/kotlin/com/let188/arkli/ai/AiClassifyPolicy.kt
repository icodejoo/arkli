package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import kotlin.math.pow
import kotlin.math.roundToLong

/**
 * 一次 `native.ai.classify` 校验通过的请求。
 *
 * @property provider 指定的提供者 id；null 表示用第一个支持识图的
 * @property path 页面缓存路径，如 `cache/pick/a.jpg`
 * @property topK 物品数
 */
data class AiClassifyRequest(val provider: String?, val path: String, val topK: Int)

/**
 * 识物的纯逻辑：参数校验、提供者选择、词表解析、像素转换、结果序列化。无 Android 依赖，可单测。
 *
 * 使用示例：`AiClassifyPolicy.parse(JSONObject("""{"path":"cache/pick/a.jpg"}"""))`
 */
object AiClassifyPolicy {
    /** topK 默认值 */
    const val DEFAULT_TOP_K = 3

    /** topK 上限 */
    const val MAX_TOP_K = 10

    /** 路径长度上限 */
    const val MAX_PATH = 1024

    /** 词表文件格式版本，与 `tools/ai-vocab/build_vocab.py` 一致 */
    const val VOCAB_FORMAT = 1

    /** 词表向量的存储类型 */
    const val VOCAB_DTYPE = "f16le"

    /** 结果里小数保留位数 */
    private const val DIGITS = 4

    /** 像素通道满值 */
    private const val OPAQUE = 255

    /** R 通道位移 */
    private const val SHIFT_R = 16

    /** G 通道位移 */
    private const val SHIFT_G = 8

    /** 通道掩码 */
    private const val MASK = 0xFF

    /** fp16 每个数的字节数 */
    private const val F16_BYTES = 2

    /**
     * 解析并校验 `native.ai.classify` 的参数。
     *
     * @param params `{ provider?: string, path: string, topK?: number }`
     * @return 校验通过的请求
     * @throws BridgeException BAD_PARAMS：path 缺失或过长、provider 类型不对、topK 不是 1~[MAX_TOP_K] 的整数
     */
    fun parse(params: JSONObject): AiClassifyRequest {
        val path = params.opt("path") as? String ?: throw bad("path 需要是字符串")
        if (path.isBlank() || path.length > MAX_PATH) throw bad("path 需要 1~$MAX_PATH 字符")
        val provider = when (val p = params.opt("provider")) {
            null, JSONObject.NULL -> null
            is String -> p.takeIf { it.isNotEmpty() && it.length <= AiPolicy.MAX_ID }
                ?: throw bad("provider 需要 1~${AiPolicy.MAX_ID} 字符")
            else -> throw bad("provider 需要是字符串")
        }
        val topK = when (val k = params.opt("topK")) {
            null, JSONObject.NULL -> DEFAULT_TOP_K
            is Int -> k
            is Long -> if (k in 1..MAX_TOP_K.toLong()) k.toInt() else throw bad("topK 需要 1~$MAX_TOP_K")
            else -> throw bad("topK 需要是整数")
        }
        if (topK !in 1..MAX_TOP_K) throw bad("topK 需要 1~$MAX_TOP_K")
        return AiClassifyRequest(provider, path, topK)
    }

    /**
     * 选出执行识图的提供者并检查可用性。
     *
     * @param providers 全部提供者（注册顺序）
     * @param requested 请求里指定的 id，null 表示取第一个支持识图的
     * @return 可用的识图提供者
     * @throws BridgeException BAD_PARAMS（id 未知、不支持识图）、NOT_READY（当前不可用，message 带 reason）
     */
    fun requireClassifier(providers: List<AiProvider>, requested: String?): ImageClassifier {
        val provider = if (requested == null) {
            providers.firstOrNull { AiTask.CLASSIFY_IMAGE in it.capabilities() }
                ?: throw bad("没有支持 classifyImage 的 provider")
        } else {
            providers.firstOrNull { it.id == requested } ?: throw bad("未知的 provider：$requested")
        }
        if (AiTask.CLASSIFY_IMAGE !in provider.capabilities() || provider !is ImageClassifier) {
            throw bad("${provider.id} 不支持 ${AiTask.CLASSIFY_IMAGE.wire}")
        }
        val a = provider.availability()
        if (!a.available) throw BridgeException(BridgeErrors.NOT_READY, "${provider.id} 当前不可用：${a.reason?.wire}")
        return provider
    }

    /**
     * 解析词表元数据 JSON。
     *
     * @param json `garbage_vocab.json` 全文
     * @return 词表元数据
     * @throws IllegalArgumentException 格式版本不符、条目数与 count 不一致、字段缺失
     */
    fun parseVocab(json: String): ClipVocabMeta {
        try {
            val o = JSONObject(json)
            require(o.getInt("format") == VOCAB_FORMAT) { "词表格式版本不支持：${o.opt("format")}" }
            require(o.getString("dtype") == VOCAB_DTYPE) { "词表向量类型不支持：${o.opt("dtype")}" }
            val dim = o.getInt("dim")
            require(dim > 0) { "词表维度必须大于 0" }
            val arr = o.getJSONArray("items")
            require(arr.length() > 0) { "词表为空" }
            require(arr.length() == o.getInt("count")) { "条目数 ${arr.length()} 与 count ${o.opt("count")} 不一致" }
            val items = (0 until arr.length()).map {
                val e = arr.getJSONObject(it)
                ClipVocabItem(e.getString("id"), e.getString("nameZh"), e.getString("nameEn"), e.getString("category"))
            }
            val cats = o.getJSONObject("categories")
            val names = cats.keys().asSequence().associateWith { cats.getString(it) }
            require(items.all { it.category in names }) { "条目里有未声明的分类" }
            return ClipVocabMeta(dim, items, names, o.optString("note"))
        } catch (e: JSONException) {
            throw IllegalArgumentException("词表 JSON 不合法：${e.message}")
        }
    }

    /**
     * 校验词表向量字节数。
     *
     * @param meta 词表元数据
     * @param bytes 向量字节
     * @throws IllegalArgumentException 长度不等于 `条目数 * dim * 2`
     */
    fun checkVocabVectors(meta: ClipVocabMeta, bytes: ByteArray) {
        val expect = meta.items.size.toLong() * meta.dim * F16_BYTES
        require(bytes.size.toLong() == expect) { "词表向量 ${bytes.size} 字节，应为 $expect" }
    }

    /**
     * ARGB 像素转 RGB 字节；带透明度的按不透明度叠白底，与 Rust `RawImage::to_rgb` 一致。
     *
     * @param argb 非预乘 ARGB 像素
     * @return 长度 `argb.size * 3` 的 RGB 字节
     */
    fun argbToRgb(argb: IntArray): ByteArray {
        val out = ByteArray(argb.size * 3)
        for (i in argb.indices) {
            val p = argb[i]
            val a = (p ushr 24) and MASK
            out[i * 3] = blend((p shr SHIFT_R) and MASK, a).toByte()
            out[i * 3 + 1] = blend((p shr SHIFT_G) and MASK, a).toByte()
            out[i * 3 + 2] = blend(p and MASK, a).toByte()
        }
        return out
    }

    /** 单通道叠白底：`(c*a + 255*(255-a) + 127) / 255` */
    private fun blend(c: Int, a: Int): Int =
        if (a == OPAQUE) c else (c * a + OPAQUE * (OPAQUE - a) + OPAQUE / 2) / OPAQUE

    /**
     * 序列化识别结果。
     *
     * @param r 识别结果
     * @return `{ items:[{id,nameZh,nameEn,category,score}], categories:[{category,name,prob}], confidence, uncertain, elapsedMs, inferMs, modelId }`
     */
    fun resultJson(r: ClassifyResult): JSONObject {
        val items = JSONArray()
        r.outcome.hits.forEach { h ->
            val v = r.vocab.items[h.index]
            items.put(
                JSONObject().put("id", v.id).put("nameZh", v.nameZh).put("nameEn", v.nameEn)
                    .put("category", v.category).put("score", round(h.score)),
            )
        }
        val cats = JSONArray()
        r.outcome.categories.forEach { c ->
            val name = r.vocab.categoryNames[c.category] ?: c.category
            cats.put(JSONObject().put("category", c.category).put("name", name).put("prob", round(c.prob)))
        }
        return JSONObject().put("items", items).put("categories", cats)
            .put("confidence", round(r.outcome.confidence)).put("uncertain", r.outcome.uncertain)
            .put("elapsedMs", r.elapsedMs).put("inferMs", r.inferMs).put("modelId", r.modelId)
    }

    /** 保留 [DIGITS] 位小数 */
    private fun round(v: Float): Double {
        val m = 10.0.pow(DIGITS)
        return (v.toDouble() * m).roundToLong() / m
    }

    /** 造 BAD_PARAMS 异常 */
    private fun bad(msg: String) = BridgeException(BridgeErrors.BAD_PARAMS, msg)
}
