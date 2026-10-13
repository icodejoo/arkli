package com.let188.arkli.image

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
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

    /**
     * 编码真彩图。全部像素不透明时输出 RGB，否则输出 RGBA；无损。
     *
     * @param argb 像素（ARGB，非预乘），长度 = w * h
     * @param w 宽
     * @param h 高
     * @param strategy Deflater 策略，默认 [Deflater.DEFAULT_STRATEGY]；可试 [Deflater.FILTERED]
     * @param check 协作式取消点，每行调用一次，需要取消时抛异常即可
     * @return PNG 文件字节
     */
    fun encodeRgba(
        argb: IntArray,
        w: Int,
        h: Int,
        strategy: Int = Deflater.DEFAULT_STRATEGY,
        check: () -> Unit = {},
    ): ByteArray {
        require(w > 0 && h > 0 && argb.size == w * h) { "像素数与宽高不符" }
        val opaque = argb.all { (it ushr 24) == BYTE_MASK }
        val bpp = if (opaque) 3 else 4
        val idat = deflateRows(w * bpp, bpp, h, strategy, check) { y, buf ->
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
        val idat = deflateRows(rowBytes, 1, h, strategy, check) { y, buf ->
            java.util.Arrays.fill(buf, 0, rowBytes, 0)
            for (x in 0 until w) {
                val v = indices[y * w + x].toInt() and BYTE_MASK
                val bit = x * depth
                buf[bit shr 3] = (buf[bit shr 3].toInt() or (v shl (8 - depth - (bit and 7)))).toByte()
            }
        }
        return assemble(w, h, depth, COLOR_INDEXED, palette, idat)
    }

    /** 逐行选滤波并送进 Deflater，返回 zlib 流 */
    private fun deflateRows(
        rowBytes: Int,
        bpp: Int,
        h: Int,
        strategy: Int,
        check: () -> Unit,
        fill: (Int, ByteArray) -> Unit,
    ): ByteArray {
        val deflater = Deflater(DEFLATE_LEVEL).apply { setStrategy(strategy) }
        val bos = ByteArrayOutputStream()
        try {
            DeflaterOutputStream(bos, deflater, DEFLATE_BUF).use { out ->
                var prev = ByteArray(rowBytes)
                var cur = ByteArray(rowBytes)
                val cand = Array(FILTER_COUNT) { ByteArray(rowBytes) }
                for (y in 0 until h) {
                    check()
                    fill(y, cur)
                    var bestType = 0
                    var bestSum = Long.MAX_VALUE
                    for (t in 0 until FILTER_COUNT) {
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
                }
            }
        } finally {
            deflater.end()
        }
        return bos.toByteArray()
    }

    /** 用滤波类型 [type] 处理一行写入 [out]，返回结果字节按有符号数的绝对值之和 */
    private fun filterRow(type: Int, cur: ByteArray, prev: ByteArray, bpp: Int, out: ByteArray): Long {
        var sum = 0L
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
        chunk(bos, "IHDR", ihdr.toByteArray())
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
    private fun chunk(out: ByteArrayOutputStream, type: String, data: ByteArray) {
        val d = DataOutputStream(out)
        d.writeInt(data.size)
        val typeBytes = type.toByteArray(Charsets.US_ASCII)
        d.write(typeBytes)
        d.write(data)
        val crc = CRC32()
        crc.update(typeBytes)
        crc.update(data)
        d.writeInt(crc.value.toInt())
    }
}
