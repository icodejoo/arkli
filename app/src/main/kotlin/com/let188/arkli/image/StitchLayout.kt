package com.let188.arkli.image

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject

/** 交叉轴对齐方式（不统一宽/高时生效） */
enum class StitchAlign(val wire: String) {
    /** 靠起点（纵拼靠左，横拼靠上） */
    START("start"),

    /** 居中 */
    CENTER("center"),

    /** 靠终点（纵拼靠右，横拼靠下） */
    END("end"),
}

/**
 * 一张图在画布上的目标矩形。
 *
 * @property x 左上角 x
 * @property y 左上角 y
 * @property w 宽
 * @property h 高
 */
data class StitchRect(val x: Int, val y: Int, val w: Int, val h: Int)

/**
 * 拼接布局结果。
 *
 * @property width 画布宽
 * @property height 画布高
 * @property items 各图目标矩形，与输入顺序一致
 */
class StitchLayoutResult(val width: Int, val height: Int, val items: List<StitchRect>)

/**
 * 拼接布局的纯计算，与 web/src/shared/image-calc.ts 的 `stitchLayout` 逐步等价（含四舍五入规则），
 * 无 Android 依赖，可在 JVM 单测。
 *
 * 使用示例：
 * ```
 * val l = StitchLayout.compute(listOf(ImageMath.Size(100, 50), ImageMath.Size(200, 80)), true, 10, true, StitchAlign.START)
 * ```
 */
object StitchLayout {
    /**
     * 计算画布尺寸与各图目标矩形。
     *
     * @param sizes 各图尺寸（已按 EXIF 摆正），每项宽高须大于 0
     * @param vertical true 纵向拼接，false 横向拼接
     * @param gap 图间距（像素）
     * @param unify 是否把交叉轴统一成最窄（纵拼）/最矮（横拼）的那张
     * @param align 不统一时交叉轴上的对齐
     * @return 布局；空列表返回 0x0。主轴长度按 Long 累加，超出 Int 时调用方应先拦截（见 [ImageStitcher]）
     */
    fun compute(
        sizes: List<ImageMath.Size>,
        vertical: Boolean,
        gap: Int,
        unify: Boolean,
        align: StitchAlign,
    ): StitchLayoutResult {
        if (sizes.isEmpty()) return StitchLayoutResult(0, 0, emptyList())
        val cross = { s: ImageMath.Size -> if (vertical) s.width else s.height }
        val main = { s: ImageMath.Size -> if (vertical) s.height else s.width }
        val unifiedCross = sizes.minOf(cross)
        val scaledCross = IntArray(sizes.size)
        val scaledMain = IntArray(sizes.size)
        for ((i, s) in sizes.withIndex()) {
            val k = if (unify) unifiedCross.toDouble() / cross(s) else 1.0
            scaledCross[i] = maxOf(1, jsRound(cross(s) * k))
            scaledMain[i] = maxOf(1, jsRound(main(s) * k))
        }
        val crossTotal = scaledCross.max()
        val mainTotal = scaledMain.sumOf { it.toLong() } + gap.toLong() * (sizes.size - 1)
        var pos = 0L
        val rects = ArrayList<StitchRect>(sizes.size)
        for (i in sizes.indices) {
            val free = crossTotal - scaledCross[i]
            val off = when (align) {
                StitchAlign.START -> 0
                StitchAlign.CENTER -> free / 2
                StitchAlign.END -> free
            }
            val p = pos.toInt()
            rects += if (vertical) StitchRect(off, p, scaledCross[i], scaledMain[i]) else StitchRect(p, off, scaledMain[i], scaledCross[i])
            pos += scaledMain[i] + gap
        }
        val m = mainTotal.toInt()
        return if (vertical) StitchLayoutResult(crossTotal, m, rects) else StitchLayoutResult(m, crossTotal, rects)
    }

    /** 与 JS `Math.round` 一致：x.5 向正无穷进位 */
    private fun jsRound(v: Double): Int = Math.floor(v + 0.5).toInt()
}

/**
 * `native.image.stitch` 的强类型参数。契约：
 * ```
 * { items: [{ path }],                 // 2..20 张，缓存页面路径
 *   direction: "v" | "h",
 *   gap?: 0..200 (默认 0),
 *   bg?: "#rrggbb" (默认 #ffffff),
 *   align?: "start" | "center" | "end" (默认 center),
 *   unify?: boolean (默认 true),
 *   format?: "png" | "jpeg" (默认 png),
 *   quality?: 0..1 (默认 0.92，仅 jpeg) }
 * ```
 * 非法参数一律抛 [BridgeException]（BAD_PARAMS）。
 *
 * 使用示例：`val plan = StitchPlan.parse(params)`
 */
class StitchPlan(
    /** 各图缓存页面路径 */
    val paths: List<String>,
    /** 是否纵向拼接 */
    val vertical: Boolean,
    /** 图间距（像素） */
    val gap: Int,
    /** 背景色（不透明 ARGB） */
    val bg: Int,
    /** 交叉轴对齐 */
    val align: StitchAlign,
    /** 是否统一宽/高 */
    val unify: Boolean,
    /** 输出格式，仅 PNG / JPEG */
    val format: OutFormat,
    /** JPEG 质量 1..100 */
    val quality: Int,
) {
    companion object {
        /** 背景色格式：#rrggbb */
        private val BG_RE = Regex("^#[0-9a-fA-F]{6}$")

        /** 不透明 alpha 位 */
        private const val OPAQUE = 0xFF000000.toInt()

        /**
         * 解析并校验参数。
         *
         * @param params 页面传来的 params
         * @return 计划
         * @throws BridgeException 参数缺失或越界（BAD_PARAMS）
         */
        fun parse(params: JSONObject): StitchPlan {
            val arr = params.optJSONArray("items") ?: throw bad("items 必须是数组")
            if (arr.length() < ImageConst.STITCH_MIN_ITEMS || arr.length() > ImageConst.STITCH_MAX_ITEMS) {
                throw bad("items 需要 ${ImageConst.STITCH_MIN_ITEMS}~${ImageConst.STITCH_MAX_ITEMS} 张")
            }
            val paths = (0 until arr.length()).map { i ->
                val path = (arr.opt(i) as? JSONObject)?.opt("path") as? String
                if (path.isNullOrEmpty()) throw bad("items[$i].path 必须是非空字符串")
                path
            }
            val vertical = when (params.opt("direction")) {
                "v" -> true
                "h" -> false
                else -> throw bad("direction 必须是 \"v\" 或 \"h\"")
            }
            val gap = intOrDefault(params, "gap", 0)
            if (gap < 0 || gap > ImageConst.STITCH_MAX_GAP) throw bad("gap 必须在 0..${ImageConst.STITCH_MAX_GAP}")
            val bgText = if (params.has("bg")) params.opt("bg") else ImageConst.STITCH_DEFAULT_BG
            if (bgText !is String || !BG_RE.matches(bgText)) throw bad("bg 必须是 #rrggbb")
            val bg = OPAQUE or bgText.substring(1).toInt(16)
            val alignText = if (params.has("align")) params.opt("align") else StitchAlign.CENTER.wire
            val align = StitchAlign.values().firstOrNull { it.wire == alignText } ?: throw bad("align 必须是 start / center / end")
            val unify = (if (params.has("unify")) params.opt("unify") else true) as? Boolean ?: throw bad("unify 必须是布尔值")
            val formatText = if (params.has("format")) params.opt("format") else OutFormat.PNG.wire
            val format = listOf(OutFormat.PNG, OutFormat.JPEG).firstOrNull { it.wire == formatText } ?: throw bad("format 必须是 png 或 jpeg")
            val q = quality(params)
            if (q.isNaN() || q < 0.0 || q > 1.0) throw bad("quality 必须在 0..1")
            val quality = Math.round(q * ImageConst.MAX_QUALITY).toInt().coerceIn(ImageConst.MIN_QUALITY, ImageConst.MAX_QUALITY)
            return StitchPlan(paths, vertical, gap, bg, align, unify, format, quality)
        }

        /** 取 quality，缺省用默认值；不是数字抛 BAD_PARAMS */
        private fun quality(p: JSONObject): Double {
            if (!p.has("quality")) return ImageConst.STITCH_DEFAULT_QUALITY
            return (p.opt("quality") as? Number)?.toDouble() ?: throw bad("quality 必须是数字")
        }

        /** 取整数参数，缺省用默认值；不是整数抛 BAD_PARAMS */
        private fun intOrDefault(p: JSONObject, key: String, def: Int): Int {
            if (!p.has(key)) return def
            val n = p.opt(key) as? Number ?: throw bad("$key 必须是整数")
            val d = n.toDouble()
            if (d != Math.floor(d) || d.isInfinite()) throw bad("$key 必须是整数")
            return n.toInt()
        }

        /** 统一的参数错误 */
        private fun bad(msg: String) = BridgeException(BridgeErrors.BAD_PARAMS, msg)
    }
}
