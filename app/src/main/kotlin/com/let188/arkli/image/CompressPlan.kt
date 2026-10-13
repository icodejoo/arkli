package com.let188.arkli.image

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject

/** 输出格式 */
enum class OutFormat(val wire: String, val mime: String, val ext: String) {
    /** JPEG，有损，不支持透明 */
    JPEG("jpeg", ImageConst.MIME_JPEG, "jpg"),

    /** WebP，有损，保留透明 */
    WEBP("webp", ImageConst.MIME_WEBP, "webp"),

    /** PNG，无损或缩色 */
    PNG("png", ImageConst.MIME_PNG, "png"),
}

/** PNG 压缩模式 */
enum class PngMode(val wire: String) {
    /** 无损：能转索引色（颜色数 <= 256）就转，否则 RGB/RGBA，只靠滤波与 Deflater 省体积 */
    LOSSLESS("lossless"),

    /** 缩色：量化到 N 色的索引色 PNG，有损 */
    PALETTE("palette"),
}

/**
 * 待处理的单张图。
 *
 * @property path pick 返回的缓存页面路径（如 `cache/pick/a.jpg`），须经路径解析器解析
 * @property name 页面给的显示名，可空；决定输出文件的主名
 */
class CompressItem(val path: String, val name: String?)

/**
 * `native.image.compress` 的强类型参数。契约：
 * ```
 * { items: [{ path, name? }],            // 1..50 张，path 为缓存页面路径
 *   format: "jpeg" | "webp" | "png",
 *   quality?: 1..100 (默认 80),           // jpeg/webp 的质量；有 targetBytes 时作为质量上限
 *   maxEdge?: 64..16384,                  // 最长边上限，缺省不缩，不放大
 *   targetBytes?: > 0,                    // 仅 jpeg/webp 生效：二分找不超出的最高质量
 *   png?: { mode: "lossless" | "palette", colors?: 2..256 (默认 256), dither?: boolean (默认 false) },
 *   keepExif?: boolean (默认 false) }     // 仅 jpeg 输出生效
 * ```
 * 非法参数一律抛 [BridgeException]（BAD_PARAMS）。
 *
 * 使用示例：`val plan = CompressPlan.parse(params)`
 */
class CompressPlan(
    /** 待处理列表 */
    val items: List<CompressItem>,
    /** 输出格式 */
    val format: OutFormat,
    /** 质量（1..100） */
    val quality: Int,
    /** 最长边上限，null 为不缩 */
    val maxEdge: Int?,
    /** 目标字节数，null 为不限；png 时恒为 null */
    val targetBytes: Long?,
    /** PNG 模式 */
    val pngMode: PngMode,
    /** 缩色目标颜色数 */
    val colors: Int,
    /** 缩色是否抖动 */
    val dither: Boolean,
    /** 是否保留 EXIF（仅 jpeg） */
    val keepExif: Boolean,
) {
    companion object {
        /**
         * 解析并校验参数。
         *
         * @param p bridge 传来的参数对象
         * @return 强类型计划
         * @throws BridgeException 参数缺失、类型不对或越界（BAD_PARAMS）
         */
        fun parse(p: JSONObject): CompressPlan {
            val arr = p.optJSONArray("items") ?: bad("items 必须是数组")
            if (arr.length() == 0) bad("items 不能为空")
            if (arr.length() > ImageConst.MAX_ITEMS) bad("一次最多处理 ${ImageConst.MAX_ITEMS} 张")
            val items = (0 until arr.length()).map { i ->
                val o = arr.optJSONObject(i) ?: bad("items[$i] 必须是对象")
                val path = o.opt("path") as? String
                if (path.isNullOrEmpty()) bad("items[$i].path 必须是非空字符串")
                val name = if (o.isNull("name")) null else (o.opt("name") as? String ?: bad("items[$i].name 必须是字符串"))
                CompressItem(path, name)
            }
            val fmtStr = p.opt("format") as? String ?: bad("format 必须是字符串")
            val format = OutFormat.values().firstOrNull { it.wire == fmtStr } ?: bad("format 只能是 jpeg、webp、png")
            val quality = intField(p, "quality", ImageConst.MIN_QUALITY, ImageConst.MAX_QUALITY)
                ?: ImageConst.DEFAULT_QUALITY
            val maxEdge = intField(p, "maxEdge", ImageConst.MIN_EDGE, ImageConst.MAX_EDGE)
            var target: Long? = null
            if (p.has("targetBytes") && !p.isNull("targetBytes")) {
                val v = p.opt("targetBytes")
                if (v !is Number || v.toDouble() != Math.floor(v.toDouble()) || v.toLong() <= 0) {
                    bad("targetBytes 必须是正整数")
                }
                target = (v as Number).toLong()
            }
            if (format == OutFormat.PNG) target = null
            var mode = PngMode.LOSSLESS
            var colors = ImageConst.MAX_COLORS
            var dither = false
            if (p.has("png") && !p.isNull("png")) {
                val png = p.optJSONObject("png") ?: bad("png 必须是对象")
                if (png.has("mode") && !png.isNull("mode")) {
                    val m = png.opt("mode") as? String ?: bad("png.mode 必须是字符串")
                    mode = PngMode.values().firstOrNull { it.wire == m } ?: bad("png.mode 只能是 lossless 或 palette")
                }
                colors = intField(png, "colors", ImageConst.MIN_COLORS, ImageConst.MAX_COLORS, "png.colors")
                    ?: ImageConst.MAX_COLORS
                dither = boolField(png, "dither", "png.dither")
            }
            return CompressPlan(
                items, format, quality, maxEdge, target, mode, colors, dither, boolField(p, "keepExif", "keepExif"),
            )
        }

        /** 读可选的整数字段并校验范围；缺省返回 null */
        private fun intField(o: JSONObject, key: String, min: Int, max: Int, label: String = key): Int? {
            if (!o.has(key) || o.isNull(key)) return null
            val v = o.opt(key)
            if (v !is Number || v.toDouble() != Math.floor(v.toDouble())) bad("$label 必须是整数")
            val n = v.toDouble()
            if (n < min || n > max) bad("$label 须在 $min..$max 之间")
            return n.toInt()
        }

        /** 读可选的布尔字段，缺省 false */
        private fun boolField(o: JSONObject, key: String, label: String): Boolean {
            if (!o.has(key) || o.isNull(key)) return false
            return o.opt(key) as? Boolean ?: bad("$label 必须是布尔值")
        }

        /** 抛 BAD_PARAMS */
        private fun bad(msg: String): Nothing = throw BridgeException(BridgeErrors.BAD_PARAMS, msg)
    }
}
