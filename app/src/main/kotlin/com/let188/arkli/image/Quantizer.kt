package com.let188.arkli.image

import java.util.Arrays

/**
 * 量化结果。
 *
 * @property palette 调色板（ARGB），已按 alpha 升序排列，半透明项靠前，便于 tRNS 只写前缀
 * @property indices 每个像素的调色板下标（无符号字节），长度 = 宽 * 高
 * @property exact 原图颜色数不超过上限，无损映射
 */
class QuantResult(val palette: IntArray, val indices: ByteArray, val exact: Boolean)

/**
 * 缩色量化：中位切分（median cut），可选 Floyd-Steinberg 抖动。纯逻辑，无 Android 依赖。
 *
 * 取舍：
 * - alpha 当第 4 个通道参与聚类，半透明颜色不会被硬并进不透明色。距离也含 alpha，
 *   代价是半透明渐变会占掉一部分调色板名额。
 * - alpha 为 0 的像素颜色没有意义，一律归一成 0x00000000，避免白占名额。
 * - 切分时挑"像素数 x 最大通道跨度"最大的盒子，按像素数加权的中位数切；盒内颜色取加权平均。
 * - 不做感知色彩空间转换（直接在 sRGB 通道上做），换来简单，色带略逊于 pngquant。
 *
 * 使用示例：
 * ```
 * val r = Quantizer.quantize(argb, w, h, maxColors = 64, dither = true)
 * PngEncoder.encodeIndexed(r.palette, r.indices, w, h)
 * ```
 */
object Quantizer {
    /** 抖动时最近色缓存的位宽：alpha 4 位 + RGB 各 5 位 */
    private const val CACHE_BITS = 19

    /** 通道个数（A、R、G、B） */
    private const val CHANNELS = 4

    /** 字节掩码 */
    private const val BYTE_MASK = 0xFF

    /** 低 32 位掩码，打包排序键用 */
    private const val LOW32 = 0xFFFFFFFFL

    /**
     * 量化到不超过 [maxColors] 种颜色。
     *
     * @param argb 像素（ARGB，非预乘）
     * @param width 宽
     * @param height 高，width * height 须等于 argb.size
     * @param maxColors 2..256
     * @param dither 是否 Floyd-Steinberg 抖动；原图颜色数本就不超标时忽略
     * @param check 协作式取消点，处理中会被反复调用，需要取消时抛异常即可
     * @return 量化结果
     */
    fun quantize(
        argb: IntArray,
        width: Int,
        height: Int,
        maxColors: Int,
        dither: Boolean,
        check: () -> Unit = {},
    ): QuantResult {
        require(maxColors in ImageConst.MIN_COLORS..ImageConst.MAX_COLORS) { "颜色数越界" }
        require(argb.size == width * height) { "像素数与宽高不符" }
        val norm = IntArray(argb.size) { normalize(argb[it]) }
        val sorted = norm.copyOf().also { Arrays.sort(it) }
        // 去重，得到唯一色与计数
        var u = 0
        val colors = IntArray(sorted.size)
        val counts = IntArray(sorted.size)
        for (c in sorted) {
            if (u > 0 && colors[u - 1] == c) {
                counts[u - 1]++
            } else {
                colors[u] = c
                counts[u] = 1
                u++
            }
        }
        if (u <= maxColors) {
            val pal = colors.copyOf(u)
            return reorder(pal, mapToUnique(norm, colors, u) { it }, true)
        }
        val cut = medianCut(colors, counts, u, maxColors, check)
        val pal = cut.first
        val idx = if (dither) {
            ditherMap(argb, width, height, pal, check)
        } else {
            // 每个唯一色直接归入它所在的盒子，不必再做最近色搜索
            mapToUnique(norm, colors, u) { cut.second[it] }
        }
        return reorder(pal, idx, false)
    }

    /**
     * 颜色数不超过 [maxColors] 时，按原值（不归一化）给出调色板，用于无损转索引色。
     *
     * @param argb 像素
     * @param maxColors 颜色数上限
     * @return 调色板；超限返回 null
     */
    fun exactPalette(argb: IntArray, maxColors: Int): IntArray? {
        val set = HashSet<Int>()
        for (c in argb) {
            if (set.add(c) && set.size > maxColors) return null
        }
        return set.toIntArray()
    }

    /**
     * 按给定调色板把像素映射成下标（调色板须包含全部颜色）。
     *
     * @param argb 像素
     * @param palette 调色板
     * @return 下标数组
     */
    fun indexWith(argb: IntArray, palette: IntArray): ByteArray {
        val map = HashMap<Int, Int>(palette.size * 2)
        palette.forEachIndexed { i, c -> map[c] = i }
        return ByteArray(argb.size) { map.getValue(argb[it]).toByte() }
    }

    /** alpha 为 0 的像素归一成 0，其余原样 */
    private fun normalize(c: Int): Int = if ((c ushr 24) == 0) 0 else c

    /** 取通道值，ch 0=A 1=R 2=G 3=B */
    private fun channel(c: Int, ch: Int): Int = (c ushr (24 - 8 * ch)) and BYTE_MASK

    /** 把每个像素定位到排序后的唯一色，再经 [pick] 换成最终下标；相邻同色走快速路径 */
    private inline fun mapToUnique(norm: IntArray, colors: IntArray, u: Int, pick: (Int) -> Int): ByteArray {
        val idx = ByteArray(norm.size)
        var last = 0
        var lastIdx = 0
        for (i in norm.indices) {
            val c = norm[i]
            if (i == 0 || c != last) {
                lastIdx = pick(Arrays.binarySearch(colors, 0, u, c))
                last = c
            }
            idx[i] = lastIdx.toByte()
        }
        return idx
    }

    /** 一个待切分的盒子：[start, end) 是 order 里的区间，score 为切分优先级 */
    private class Box(val start: Int, val end: Int, val ch: Int, val score: Double)

    /** 对唯一色做中位切分，返回调色板与"唯一色下标 -> 盒子（调色板）下标" */
    private fun medianCut(
        colors: IntArray,
        counts: IntArray,
        u: Int,
        maxColors: Int,
        check: () -> Unit,
    ): Pair<IntArray, IntArray> {
        val order = IntArray(u) { it }
        val keys = LongArray(u)
        /** 算盒子的最宽通道与得分（像素数 x 跨度）；跨度为 0 的得分为 -1，不再切 */
        fun makeBox(s: Int, e: Int): Box {
            if (e - s < 2) return Box(s, e, 0, -1.0)
            val (ch, range) = widestChannel(colors, order, s, e)
            if (range == 0) return Box(s, e, ch, -1.0)
            var pop = 0L
            for (i in s until e) pop += counts[order[i]]
            return Box(s, e, ch, pop.toDouble() * range)
        }
        val boxes = ArrayList<Box>()
        boxes.add(makeBox(0, u))
        while (boxes.size < maxColors) {
            check()
            var best = -1
            for (b in boxes.indices) if (boxes[b].score > 0 && (best < 0 || boxes[b].score > boxes[best].score)) best = b
            if (best < 0) break
            val box = boxes[best]
            val s = box.start
            val e = box.end
            for (i in s until e) keys[i] = (channel(colors[order[i]], box.ch).toLong() shl 32) or order[i].toLong()
            Arrays.sort(keys, s, e)
            for (i in s until e) order[i] = (keys[i] and LOW32).toInt()
            // 按像素数加权的中位数切，保证两侧都至少 1 个颜色
            var total = 0L
            for (i in s until e) total += counts[order[i]]
            var acc = 0L
            var cut = s + 1
            for (i in s until e - 1) {
                acc += counts[order[i]]
                cut = i + 1
                if (acc * 2 >= total) break
            }
            boxes[best] = makeBox(s, cut)
            boxes.add(makeBox(cut, e))
        }
        val boxOf = IntArray(u)
        val pal = IntArray(boxes.size) { b ->
            val sum = LongArray(CHANNELS)
            var pop = 0L
            for (i in boxes[b].start until boxes[b].end) {
                val ci = order[i]
                boxOf[ci] = b
                val n = counts[ci].toLong()
                pop += n
                for (ch in 0 until CHANNELS) sum[ch] += channel(colors[ci], ch) * n
            }
            var out = 0
            for (ch in 0 until CHANNELS) out = (out shl 8) or (((sum[ch] + pop / 2) / pop).toInt() and BYTE_MASK)
            out
        }
        return pal to boxOf
    }

    /** 盒内跨度最大的通道及跨度 */
    private fun widestChannel(colors: IntArray, order: IntArray, s: Int, e: Int): Pair<Int, Int> {
        val mn = IntArray(CHANNELS) { 255 }
        val mx = IntArray(CHANNELS)
        for (i in s until e) {
            val c = colors[order[i]]
            for (ch in 0 until CHANNELS) {
                val v = channel(c, ch)
                if (v < mn[ch]) mn[ch] = v
                if (v > mx[ch]) mx[ch] = v
            }
        }
        var bestCh = 0
        var bestRange = -1
        for (ch in 0 until CHANNELS) {
            if (mx[ch] - mn[ch] > bestRange) {
                bestRange = mx[ch] - mn[ch]
                bestCh = ch
            }
        }
        return bestCh to bestRange
    }

    /** 调色板里与 [c] 欧氏距离最近的下标 */
    private fun nearest(pal: IntArray, c: Int): Int {
        var best = 0
        var bestD = Long.MAX_VALUE
        for (i in pal.indices) {
            var d = 0L
            for (ch in 0 until CHANNELS) {
                val diff = channel(c, ch) - channel(pal[i], ch)
                d += diff * diff
            }
            if (d < bestD) {
                bestD = d
                best = i
            }
        }
        return best
    }

    /** Floyd-Steinberg 抖动映射；alpha 为 0 的像素不扩散误差 */
    private fun ditherMap(argb: IntArray, w: Int, h: Int, pal: IntArray, check: () -> Unit): ByteArray {
        val idx = ByteArray(argb.size)
        val cache = IntArray(1 shl CACHE_BITS) { -1 }
        var cur = Array(CHANNELS) { FloatArray(w + 2) }
        var next = Array(CHANNELS) { FloatArray(w + 2) }
        val v = IntArray(CHANNELS)
        for (y in 0 until h) {
            check()
            for (x in 0 until w) {
                val c = normalize(argb[y * w + x])
                val clear = (c ushr 24) == 0
                for (ch in 0 until CHANNELS) {
                    val e = if (clear) 0f else cur[ch][x + 1]
                    v[ch] = (channel(c, ch) + e).toInt().coerceIn(0, 255)
                }
                val key = ((v[0] shr 4) shl 15) or ((v[1] shr 3) shl 10) or ((v[2] shr 3) shl 5) or (v[3] shr 3)
                var p = cache[key]
                if (p < 0) {
                    p = nearest(pal, (v[0] shl 24) or (v[1] shl 16) or (v[2] shl 8) or v[3])
                    cache[key] = p
                }
                idx[y * w + x] = p.toByte()
                if (clear) continue
                for (ch in 0 until CHANNELS) {
                    val err = v[ch] - channel(pal[p], ch)
                    cur[ch][x + 2] += err * 7f / 16f
                    next[ch][x] += err * 3f / 16f
                    next[ch][x + 1] += err * 5f / 16f
                    next[ch][x + 2] += err * 1f / 16f
                }
            }
            val t = cur
            cur = next
            next = t
            for (ch in 0 until CHANNELS) Arrays.fill(next[ch], 0f)
        }
        return idx
    }

    /** 调色板按 alpha 升序（稳定）重排，并同步改写下标 */
    private fun reorder(pal: IntArray, idx: ByteArray, exact: Boolean): QuantResult {
        val order = pal.indices.sortedBy { pal[it] ushr 24 }
        val remap = IntArray(pal.size)
        order.forEachIndexed { newI, oldI -> remap[oldI] = newI }
        val newPal = IntArray(pal.size) { pal[order[it]] }
        val newIdx = ByteArray(idx.size) { remap[idx[it].toInt() and BYTE_MASK].toByte() }
        return QuantResult(newPal, newIdx, exact)
    }
}
