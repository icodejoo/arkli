package com.let188.arkli.image

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom

/**
 * 单张成功的结果。
 *
 * @property path 成品页面路径（如 `cache/out/a-1f2e3d4c.jpg`）
 * @property name 建议保存名（不含随机后缀）
 * @property ratio 成品体积 / 原体积
 * @property targetReached 仅设了 targetBytes 时有值：是否压进了目标
 */
class CompressedItem(
    val path: String,
    val name: String,
    val mime: String,
    val width: Int,
    val height: Int,
    val bytes: Long,
    val srcBytes: Long,
    val ratio: Double,
    val targetReached: Boolean?,
)

/**
 * 单张失败的记录。
 *
 * @property index 在 items 里的下标
 * @property name 显示名
 * @property code 协议错误码
 */
class FailedItem(val index: Int, val name: String?, val code: String, val message: String)

/** 一次批量压缩的结果 */
class CompressResult(val items: List<CompressedItem>, val failed: List<FailedItem>) {
    /**
     * 转成协议里的返回值 `{ items: [...], failed: [...] }`。
     *
     * @return JSON 对象
     */
    fun toJson(): JSONObject {
        val ok = JSONArray()
        for (i in items) {
            ok.put(
                JSONObject().put("path", i.path).put("name", i.name).put("mime", i.mime)
                    .put("width", i.width).put("height", i.height).put("bytes", i.bytes)
                    .put("srcBytes", i.srcBytes).put("ratio", i.ratio)
                    .apply { if (i.targetReached != null) put("targetReached", i.targetReached) },
            )
        }
        val bad = JSONArray()
        for (f in failed) {
            bad.put(
                JSONObject().put("index", f.index).put("code", f.code).put("message", f.message)
                    .apply { if (f.name != null) put("name", f.name) },
            )
        }
        return JSONObject().put("items", ok).put("failed", bad)
    }
}

/** 进度回调，阶段 2 接到 `image.progress` 事件 */
fun interface ProgressSink {
    /**
     * 每处理完一张（无论成败）回调一次。
     *
     * @param done 已处理张数
     * @param total 总张数
     * @param name 刚处理完的这张的显示名
     */
    fun onProgress(done: Int, total: Int, name: String)
}

/**
 * 批量压缩流水线：串行处理，解码、缩放、编码、写入 [outDir]。
 * 单张失败记入 failed，不影响后面的；协程取消时删掉本次已写出的全部成品与半成品。
 *
 * JPEG/WebP 走质量或目标体积搜索（quality 当上限）；PNG 走无损（能转索引色就转）或缩色。
 *
 * 使用示例：
 * ```
 * val c = ImageCompressor(AndroidImageCodec(), outDir)
 * val r = c.run(plan, files) { done, total, name -> ... }
 * ```
 *
 * @param codec 编解码实现，测试时注入假的
 * @param outDir 成品目录（调用方保证位于缓存根下）
 * @param outPagePrefix 成品页面路径前缀，默认 `cache/out`；成品直接放在 [outDir] 下
 * @param dispatcher 干活的调度器，默认 Default
 * @param idGen 输出文件名的唯一后缀生成器
 */
class ImageCompressor(
    private val codec: ImageCodec,
    private val outDir: File,
    private val outPagePrefix: String = ImageConst.OUT_PAGE_PREFIX,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val idGen: () -> String = ::randomId,
) {
    /**
     * 执行一次批量压缩。
     *
     * @param plan 已校验的计划
     * @param sources 与 plan.items 一一对应的源文件
     * @param progress 进度回调
     * @return 成功与失败清单
     * @throws CancellationException 被取消时（已清理成品）
     */
    suspend fun run(plan: CompressPlan, sources: List<File>, progress: ProgressSink): CompressResult =
        withContext(dispatcher) {
            require(plan.items.size == sources.size) { "items 与源文件数量不符" }
            outDir.mkdirs()
            val written = ArrayList<File>()
            val ok = ArrayList<CompressedItem>()
            val failed = ArrayList<FailedItem>()
            try {
                for (i in plan.items.indices) {
                    currentCoroutineContext().ensureActive()
                    val item = plan.items[i]
                    val label = item.name ?: sources[i].name
                    try {
                        ok.add(processOne(plan, item, sources[i], written))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: BridgeException) {
                        failed.add(FailedItem(i, label, e.code, e.message ?: ""))
                    } catch (e: OutOfMemoryError) {
                        failed.add(FailedItem(i, label, BridgeErrors.INTERNAL, "内存不足，请缩小 maxEdge 后重试"))
                    } catch (e: Exception) {
                        failed.add(FailedItem(i, label, BridgeErrors.INTERNAL, e.message ?: "处理失败"))
                    }
                    progress.onProgress(i + 1, plan.items.size, label)
                }
            } catch (e: CancellationException) {
                written.forEach { it.delete() }
                throw e
            }
            CompressResult(ok, failed)
        }

    /** 处理一张图，成品文件登记进 [written]；半成品在失败时自行清理 */
    private suspend fun processOne(
        plan: CompressPlan,
        item: CompressItem,
        src: File,
        written: MutableList<File>,
    ): CompressedItem {
        if (!src.isFile) throw BridgeException(BridgeErrors.BAD_PARAMS, "源文件不存在")
        val srcBytes = src.length()
        val ctx = currentCoroutineContext()
        var img: CodecImage = codec.decode(src, plan.maxEdge)
        try {
            ctx.ensureActive()
            val target = ImageMath.fitSize(img.width, img.height, plan.maxEdge)
            if (target.width != img.width || target.height != img.height) {
                val scaled = codec.scale(img, target.width, target.height)
                img.close()
                img = scaled
                ctx.ensureActive()
            }
            var reached: Boolean? = null
            val bytes: ByteArray = when (plan.format) {
                OutFormat.PNG -> encodePng(plan, img) { ctx.ensureActive() }
                else -> {
                    val cache = HashMap<Int, ByteArray>()
                    val enc = { q: Int -> codec.encodeLossy(img, plan.format, q).also { cache[q] = it } }
                    if (plan.targetBytes == null) {
                        enc(plan.quality)
                    } else {
                        val r = ImageMath.searchQualityForTarget(
                            plan.targetBytes, ImageConst.MIN_QUALITY, plan.quality,
                            { q -> enc(q).size.also { ctx.ensureActive() } },
                        )
                        reached = r.reached
                        cache.getValue(r.quality)
                    }
                }
            }
            ctx.ensureActive()
            val stem = stemOf(item.name ?: src.name)
            val file = File(outDir, "$stem-${idGen()}.${plan.format.ext}")
            val part = File(outDir, file.name + ImageConst.PART_SUFFIX)
            try {
                part.writeBytes(bytes)
                if (plan.keepExif && plan.format == OutFormat.JPEG) codec.copyExif(src, part)
                ctx.ensureActive()
                if (!part.renameTo(file)) throw BridgeException(BridgeErrors.INTERNAL, "写入成品失败")
            } finally {
                if (part.exists()) part.delete()
            }
            written.add(file)
            val outBytes = file.length()
            return CompressedItem(
                path = "$outPagePrefix/${file.name}",
                name = "$stem.${plan.format.ext}",
                mime = plan.format.mime,
                width = img.width,
                height = img.height,
                bytes = outBytes,
                srcBytes = srcBytes,
                ratio = if (srcBytes > 0) outBytes.toDouble() / srcBytes else 0.0,
                targetReached = reached,
            )
        } finally {
            img.close()
        }
    }

    /** PNG 编码：lossless 能转索引色就转，否则 RGB/RGBA；palette 走量化 */
    private fun encodePng(plan: CompressPlan, img: CodecImage, check: () -> Unit): ByteArray {
        val w = img.width
        val h = img.height
        if (w.toLong() * h > ImageConst.MAX_PNG_PIXELS) {
            throw BridgeException(BridgeErrors.BAD_PARAMS, "PNG 处理的图片过大，请设置更小的 maxEdge")
        }
        val argb = img.toArgb()
        if (plan.pngMode == PngMode.PALETTE) {
            val q = Quantizer.quantize(argb, w, h, plan.colors, plan.dither, check)
            return PngEncoder.encodeIndexed(q.palette, q.indices, w, h, check = check)
        }
        val pal = Quantizer.exactPalette(argb, ImageConst.MAX_COLORS)
        if (pal != null) {
            // 按 alpha 升序排，tRNS 只需写前缀
            val sorted = pal.sortedBy { it ushr 24 }.toIntArray()
            return PngEncoder.encodeIndexed(sorted, Quantizer.indexWith(argb, sorted), w, h, check = check)
        }
        return PngEncoder.encodeRgba(argb, w, h, check = check)
    }

    companion object {
        /** 非法字符：路径分隔符、保留符号与控制字符 */
        private val BAD_CHARS = Regex("[\\\\/:*?\"<>|\\p{Cntrl}]")

        /** 随机十六进制后缀 */
        fun randomId(): String {
            val b = ByteArray(ImageConst.ID_BYTES).also { SecureRandom().nextBytes(it) }
            return b.joinToString("") { "%02x".format(it) }
        }

        /**
         * 从显示名或文件名取输出主名：只留最后一段路径、去扩展名、替换非法字符、去首尾点和空白、限长。
         *
         * @param name 原始名
         * @return 可安全用作文件名主体的字符串，空则回落 `image`
         */
        fun stemOf(name: String): String {
            val leaf = name.substringAfterLast('/').substringAfterLast('\\')
            val dot = leaf.lastIndexOf('.')
            val base = if (dot > 0) leaf.substring(0, dot) else leaf
            val clean = base.replace(BAD_CHARS, "_").trim().trim('.').take(ImageConst.MAX_NAME_LEN)
            return clean.ifEmpty { ImageConst.DEFAULT_STEM }
        }
    }
}
