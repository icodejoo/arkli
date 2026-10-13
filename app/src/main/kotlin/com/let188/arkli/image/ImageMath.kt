package com.let188.arkli.image

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** 目标体积搜索结果 */
class QualitySearch(
    /** 选中的质量 */
    val quality: Int,
    /** 该质量下的编码字节数 */
    val bytes: Int,
    /** 是否达到目标（bytes <= targetBytes） */
    val reached: Boolean,
    /** 实际调用编码的次数 */
    val steps: Int,
)

/**
 * 图片尺寸、采样率、目标体积搜索的纯计算，无 Android 依赖，可在 JVM 单测。
 *
 * 使用示例：
 * ```
 * val s = ImageMath.fitSize(4000, 3000, 1600)   // 1600x1200
 * val n = ImageMath.sampleSize(4000, 3000, 1600, 1200) // 2
 * ```
 */
object ImageMath {
    /** 宽高对 */
    data class Size(val width: Int, val height: Int)

    /**
     * 按最长边限制算目标尺寸，保持比例，不放大。
     *
     * @param w 原宽，需大于 0
     * @param h 原高，需大于 0
     * @param maxEdge 最长边上限；null 表示不缩
     * @return 目标尺寸，最短边至少 1
     */
    fun fitSize(w: Int, h: Int, maxEdge: Int?): Size {
        require(w > 0 && h > 0) { "宽高必须大于 0" }
        if (maxEdge == null || max(w, h) <= maxEdge) return Size(w, h)
        val scale = maxEdge.toDouble() / max(w, h)
        return if (w >= h) {
            Size(maxEdge, max(1, (h * scale).roundToInt()))
        } else {
            Size(max(1, (w * scale).roundToInt()), maxEdge)
        }
    }

    /**
     * 计算解码的 inSampleSize：2 的幂，且解码后两边都不小于目标。
     * 按"长边/短边"比较，与 EXIF 旋转无关。
     *
     * @param srcW 原宽
     * @param srcH 原高
     * @param targetW 目标宽
     * @param targetH 目标高
     * @return 采样率，至少 1
     */
    fun sampleSize(srcW: Int, srcH: Int, targetW: Int, targetH: Int): Int {
        val srcLong = max(srcW, srcH)
        val srcShort = min(srcW, srcH)
        val tgtLong = max(targetW, targetH)
        val tgtShort = min(targetW, targetH)
        var s = 1
        while (srcLong / (s * 2) >= tgtLong && srcShort / (s * 2) >= tgtShort) s *= 2
        return s
    }

    /**
     * 找"体积不超过目标的最高质量"。假设质量越高体积越大（单调）。
     * 先试上界，够小就直接用；否则二分。最多调用 [maxSteps] 次编码。
     * 全都超标时返回 [minQ]，reached 为 false（此时 bytes 是 [minQ] 的体积）。
     *
     * @param targetBytes 目标字节数
     * @param minQ 质量下界
     * @param maxQ 质量上界，不小于 minQ
     * @param encode 编码函数：质量 -> 字节数
     * @param maxSteps 编码次数上限
     * @return 搜索结果
     */
    fun searchQualityForTarget(
        targetBytes: Long,
        minQ: Int,
        maxQ: Int,
        encode: (Int) -> Int,
        maxSteps: Int = ImageConst.MAX_SEARCH_STEPS,
    ): QualitySearch {
        require(minQ <= maxQ) { "minQ 不能大于 maxQ" }
        var steps = 0
        val top = encode(maxQ).also { steps++ }
        if (top <= targetBytes) return QualitySearch(maxQ, top, true, steps)
        var lo = minQ
        var hi = maxQ - 1
        var bestQ = -1
        var bestBytes = 0
        var minBytes = if (minQ == maxQ) top else -1
        // 留 1 次给下界兜底
        while (lo <= hi && steps < maxSteps - 1) {
            val mid = (lo + hi) ushr 1
            val b = encode(mid).also { steps++ }
            if (mid == minQ) minBytes = b
            if (b <= targetBytes) {
                bestQ = mid
                bestBytes = b
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        if (bestQ >= 0) return QualitySearch(bestQ, bestBytes, true, steps)
        if (minBytes < 0) minBytes = encode(minQ).also { steps++ }
        return QualitySearch(minQ, minBytes, false, steps)
    }
}
