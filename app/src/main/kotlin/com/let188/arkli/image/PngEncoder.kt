package com.let188.arkli.image

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.OutputStream
import java.util.zip.CRC32
import java.util.zip.Deflater
import java.util.zip.DeflaterOutputStream
import kotlin.math.abs

/**
 * 自写 PNG 编码器：只依赖 java.util.zip，纯逻辑，可在 JVM 单测。
 *
 * 支持真彩 RGBA、真彩 RGB（全不透明时自动去掉 alpha）、索引色（PLTE + 可选 tRNS，位深 1/2/4/8）。
 * 每行从 5 种滤波里挑"字节绝对值之和最小"的（PNG 规范推荐的启发式），IDAT 用 Deflater level 9。
 * 不写 gAMA/sRGB 等辅助块，体积最小。
 *
 * 使用示例：
 * ```
 * val png = PngEncoder.encodeRgba(argb, w, h)
 * val png2 = PngEncoder.encodeIndexed(palette, indices, w, h)
 * ```
 */
object PngEncoder {
    /** PNG 文件头 */
    private val SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)

    /** 颜色类型：真彩 */
    private const val COLOR_RGB = 2

    /** 颜色类型：索引 */
    private const val COLOR_INDEXED = 3

    /** 颜色类型：真彩 + alpha */
    private const val COLOR_RGBA = 6

    /** 滤波类型个数 */
    private const val FILTER_COUNT = 5

    /** 字节掩码 */
    private const val BYTE_MASK = 0xFF

    /** Deflater 压缩级别 */
    private const val DEFLATE_LEVEL = 9

    /** 压缩输出缓冲大小 */
    private const val DEFLATE_BUF = 32 * 1024

    /** 流式编码时每个 IDAT 块的大小 */
    private const val IDAT_CHUNK_BYTES = 64 * 1024

    /**
     * 编码真彩图。全部像素不透明时输出 RGB，否则输出 RGBA；无损。
     *
     * @param argb 像素（ARGB，非预乘），长度 = w * h
     * @param w 宽
     * @param h 高
     * @param strategy Deflater 策略，默认 [Deflater.DEFAULT_STRATEGY]；可试 [Deflater.FILTERED]
     * @param check 协作式取消点，每行调用一次，需要取消时抛异常即可
     * @param tuning 压缩调优，默认 [PngTuning.BEST]（压缩工具现有行为）
     * @return PNG 文件字节
     */
    fun encodeRgba(
        argb: IntArray,
        w: Int,
        h: Int,
        strategy: Int = Deflater.DEFAULT_STRATEGY,
        check: () -> Unit = {},
        tuning: PngTuning = PngTuning.BEST,
    ): ByteArray {
        require(w > 0 && h > 0 && argb.size == w * h) { "像素数与宽高不符" }
        val opaque = argb.all { (it ushr 24) == BYTE_MASK }
        val bpp = if (opaque) 3 else 4
        val idat = deflateRows(w * bpp, bpp, h, strategy, check, tuning) { y, buf ->
            var o = 0
            for (x in 0 until w) {
                val c = argb[y * w + x]
                buf[o++] = (c shr 16).toByte()
                buf[o++] = (c shr 8).toByte()
                buf[o++] = c.toByte()
                if (!opaque) buf[o++] = (c ushr 24).toByte()
            }
        }
        return assemble(w, h, 8, if (opaque) COLOR_RGB else COLOR_RGBA, null, idat)
    }

    /**
     * 编码索引色图。位深按调色板大小取 1/2/4/8；调色板里有半透明项时写 tRNS（只写到最后一个非不透明项）。
     *
     * @param palette 调色板（ARGB），1..256 项
     * @param indices 每像素下标（无符号字节），长度 = w * h
     * @param w 宽
     * @param h 高
     * @param strategy Deflater 策略
     * @param check 协作式取消点，每行调用一次，需要取消时抛异常即可
     * @return PNG 文件字节
     */
    fun encodeIndexed(
        palette: IntArray,
        indices: ByteArray,
        w: Int,
        h: Int,
        strategy: Int = Deflater.DEFAULT_STRATEGY,
        check: () -> Unit = {},
    ): ByteArray {
        require(palette.size in 1..ImageConst.MAX_COLORS) { "调色板大小越界" }
        require(w > 0 && h > 0 && indices.size == w * h) { "像素数与宽高不符" }
        val depth = when {
            palette.size <= 2 -> 1
            palette.size <= 4 -> 2
            palette.size <= 16 -> 4
            else -> 8
        }
        val rowBytes = (w * depth + 7) / 8
        val idat = deflateRows(rowBytes, 1, h, strategy, check, PngTuning.BEST) { y, buf ->
            java.util.Arrays.fill(buf, 0, rowBytes, 0)
            for (x in 0 until w) {
                val v = indices[y * w + x].toInt() and BYTE_MASK
                val bit = x * depth
                buf[bit shr 3] = (buf[bit shr 3].toInt() or (v shl (8 - depth - (bit and 7)))).toByte()
            }
        }
        return assemble(w, h, depth, COLOR_INDEXED, palette, idat)
    }

    /**
     * 流式编码不透明真彩图：逐行滤波、压缩，压好一块写一块（IDAT 按 [IDAT_CHUNK_BYTES] 分块），
     * 不在内存里攒整幅 PNG，写目标文件时文件随编码一起增长。丢弃 alpha，调用方保证不透明。
     * 先写签名与 IHDR，压完写 IEND，保持合法 PNG；本方法不关闭 [out]。
     *
     * @param out 目标流
     * @param w 宽
     * @param h 高
     * @param readRow 填充第 y 行：参数为行号与长度 w 的 ARGB 缓冲
     * @param tuning 压缩调优，拼接传 [PngTuning.FAST]
     * @param check 协作式取消点，每行调用一次
     * @param onRow 每压完一行回调一次，参数为已完成的行数（1..h），用来上报进度
     */
    fun writeRgb(
        out: OutputStream,
        w: Int,
        h: Int,
        readRow: (y: Int, row: IntArray) -> Unit,
        tuning: PngTuning = PngTuning.BEST,
        check: () -> Unit = {},
        onRow: (done: Int) -> Unit = {},
    ) {
        require(w > 0 && h > 0) { "宽高必须大于 0" }
        out.write(SIGNATURE)
        writeIhdr(out, w, h, 8, COLOR_RGB)
        val idat = IdatChunkOutput(out)
        val deflater = Deflater(tuning.level)
        try {
            val dos = DeflaterOutputStream(idat, deflater, DEFLATE_BUF)
            val row = IntArray(w)
            compressRows(dos, w * 3, 3, h, tuning, check, onRow) { y, buf ->
                readRow(y, row)
                var o = 0
                for (x in 0 until w) {
                    val c = row[x]
                    buf[o++] = (c shr 16).toByte()
                    buf[o++] = (c shr 8).toByte()
                    buf[o++] = c.toByte()
                }
            }
            dos.finish()
            idat.finish()
        } finally {
            deflater.end()
        }
        chunk(out, "IEND", ByteArray(0))
    }

    /** 逐行选滤波并送进 Deflater，返回 zlib 流 */
    private fun deflateRows(
        rowBytes: Int,
        bpp: Int,
        h: Int,
        strategy: Int,
        check: () -> Unit,
        tuning: PngTuning,
        fill: (Int, ByteArray) -> Unit,
    ): ByteArray {
        val deflater = Deflater(tuning.level).apply { setStrategy(strategy) }
        val bos = ByteArrayOutputStream()
        try {
            DeflaterOutputStream(bos, deflater, DEFLATE_BUF).use { out ->
                compressRows(out, rowBytes, bpp, h, tuning, check, {}, fill)
            }
        } finally {
            deflater.end()
        }
        return bos.toByteArray()
    }

    /** 逐行：填充 -> 在 [PngTuning.filters] 里挑字节绝对值之和最小的滤波 -> 写入 [out]（不关闭） */
    private fun compressRows(
        out: OutputStream,
        rowBytes: Int,
        bpp: Int,
        h: Int,
        tuning: PngTuning,
        check: () -> Unit,
        onRow: (Int) -> Unit,
        fill: (Int, ByteArray) -> Unit,
    ) {
        var prev = ByteArray(rowBytes)
        var cur = ByteArray(rowBytes)
        val cand = Array(FILTER_COUNT) { ByteArray(rowBytes) }
        for (y in 0 until h) {
            check()
            fill(y, cur)
            var bestType = tuning.filters[0]
            var bestSum = Long.MAX_VALUE
            for (t in tuning.filters) {
                val sum = filterRow(t, cur, prev, bpp, cand[t])
                if (sum < bestSum) {
                    bestSum = sum
                    bestType = t
                }
            }
            out.write(bestType)
            out.write(cand[bestType])
            val tmp = prev
            prev = cur
            cur = tmp
            onRow(y + 1)
        }
    }

    /** 用滤波类型 [type] 处理一行写入 [out]，返回结果字节按有符号数的绝对值之和 */
    private fun filterRow(type: Int, cur: ByteArray, prev: ByteArray, bpp: Int, out: ByteArray): Long {
        var sum = 0L
        // None / Sub / Up 最常用，单独写无分支循环；结果与下面的通用实现逐字节一致
        when (type) {
            0 -> {
                for (i in cur.indices) {
                    val r = cur[i]
                    out[i] = r
                    sum += abs(r.toInt())
                }
                return sum
            }
            1 -> {
                for (i in 0 until minOf(bpp, cur.size)) {
                    val r = cur[i]
                    out[i] = r
                    sum += abs(r.toInt())
                }
                for (i in bpp until cur.size) {
                    val r = (cur[i] - cur[i - bpp]).toByte()
                    out[i] = r
                    sum += abs(r.toInt())
                }
                return sum
            }
            2 -> {
                for (i in cur.indices) {
                    val r = (cur[i] - prev[i]).toByte()
                    out[i] = r
                    sum += abs(r.toInt())
                }
                return sum
            }
        }
        for (i in cur.indices) {
            val x = cur[i].toInt() and BYTE_MASK
            val a = if (i >= bpp) cur[i - bpp].toInt() and BYTE_MASK else 0
            val b = prev[i].toInt() and BYTE_MASK
            val c = if (i >= bpp) prev[i - bpp].toInt() and BYTE_MASK else 0
            val pred = when (type) {
                0 -> 0
                1 -> a
                2 -> b
                3 -> (a + b) / 2
                else -> paeth(a, b, c)
            }
            val r = (x - pred).toByte()
            out[i] = r
            sum += abs(r.toInt())
        }
        return sum
    }

    /** Paeth 预测器 */
    private fun paeth(a: Int, b: Int, c: Int): Int {
        val p = a + b - c
        val pa = abs(p - a)
        val pb = abs(p - b)
        val pc = abs(p - c)
        return if (pa <= pb && pa <= pc) a else if (pb <= pc) b else c
    }

    /** 拼出完整 PNG：签名 + IHDR + [PLTE + tRNS] + IDAT + IEND */
    private fun assemble(w: Int, h: Int, depth: Int, colorType: Int, palette: IntArray?, idat: ByteArray): ByteArray {
        val bos = ByteArrayOutputStream(idat.size + 1024)
        bos.write(SIGNATURE)
        writeIhdr(bos, w, h, depth, colorType)
        if (palette != null) {
            val plte = ByteArray(palette.size * 3)
            palette.forEachIndexed { i, c ->
                plte[i * 3] = (c shr 16).toByte()
                plte[i * 3 + 1] = (c shr 8).toByte()
                plte[i * 3 + 2] = c.toByte()
            }
            chunk(bos, "PLTE", plte)
            val lastAlpha = palette.indexOfLast { (it ushr 24) != BYTE_MASK }
            if (lastAlpha >= 0) {
                chunk(bos, "tRNS", ByteArray(lastAlpha + 1) { (palette[it] ushr 24).toByte() })
            }
        }
        chunk(bos, "IDAT", idat)
        chunk(bos, "IEND", ByteArray(0))
        return bos.toByteArray()
    }

    /** 写一个数据块：长度 + 类型 + 数据 + CRC（覆盖类型与数据） */
    private fun chunk(out: OutputStream, type: String, data: ByteArray, len: Int = data.size) {
        val d = DataOutputStream(out)
        d.writeInt(len)
        val typeBytes = type.toByteArray(Charsets.US_ASCII)
        d.write(typeBytes)
        d.write(data, 0, len)
        val crc = CRC32()
        crc.update(typeBytes)
        crc.update(data, 0, len)
        d.writeInt(crc.value.toInt())
    }

    /** 写 IHDR：宽高、位深、颜色类型，压缩/滤波/隔行方法均为 0 */
    private fun writeIhdr(out: OutputStream, w: Int, h: Int, depth: Int, colorType: Int) {
        val ihdr = ByteArrayOutputStream(13)
        DataOutputStream(ihdr).apply {
            writeInt(w)
            writeInt(h)
            writeByte(depth)
            writeByte(colorType)
            writeByte(0)
            writeByte(0)
            writeByte(0)
        }
        chunk(out, "IHDR", ihdr.toByteArray())
    }

    /**
     * 把压缩流切成固定大小的 IDAT 块边攒边写。[finish] 写出最后不足一块的部分；
     * [close] 等同 [finish]，不关闭底层流（由调用方管）。
     */
    private class IdatChunkOutput(private val out: OutputStream) : OutputStream() {
        /** 当前块缓冲 */
        private val buf = ByteArray(IDAT_CHUNK_BYTES)

        /** 缓冲里已有的字节数 */
        private var n = 0

        override fun write(b: Int) {
            if (n == buf.size) flushChunk()
            buf[n++] = b.toByte()
        }

        override fun write(b: ByteArray, off: Int, len: Int) {
            var o = off
            var left = len
            while (left > 0) {
                if (n == buf.size) flushChunk()
                val k = minOf(left, buf.size - n)
                System.arraycopy(b, o, buf, n, k)
                n += k
                o += k
                left -= k
            }
        }

        /** 写出当前块 */
        private fun flushChunk() {
            if (n > 0) chunk(out, "IDAT", buf, n)
            n = 0
        }

        /** 写出剩余数据 */
        fun finish() = flushChunk()

        override fun close() = finish()
    }
}

/**
 * PNG 压缩调优：Deflater 级别与允许选用的行滤波。
 * 滤波编号同 PNG 规范：0 None、1 Sub、2 Up、3 Average、4 Paeth；每行在 [filters] 里挑字节绝对值之和最小的。
 *
 * @property level Deflater 级别 1..9
 * @property filters 候选滤波类型，至少一个
 */
class PngTuning(val level: Int, val filters: IntArray) {
    init {
        require(level in 1..9) { "Deflater 级别须在 1..9" }
        require(filters.isNotEmpty() && filters.all { it in 0..4 }) { "滤波类型须在 0..4 且非空" }
    }

    companion object {
        /** 压缩工具用的默认值：级别 9，5 种滤波全试，体积最小、最慢 */
        val BEST = PngTuning(9, intArrayOf(0, 1, 2, 3, 4))

        /** 拼接用的快速模式：级别 3 + 只试 Sub/Up；取舍依据是 3072x8192 真图的基准，见 docs/design/bridge-protocol.md 的 native.image.stitch */
        val FAST = PngTuning(3, intArrayOf(1, 2))
    }
}
