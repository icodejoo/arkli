package com.let188.arkli.image

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.util.zip.CRC32
import java.util.zip.Inflater

/** 流式 RGB PNG 编码与调优参数测试：用测试内的独立解码器验证合法性（含 CRC）与无损 */
class PngEncoderRowsTest {
    /** 造一张不透明的带纹理渐变图 */
    private fun image(w: Int, h: Int) =
        IntArray(w * h) { i -> 0xFF000000.toInt() or (((i * 7) and 0xFF) shl 16) or (((i / w * 13) and 0xFF) shl 8) or (i % w and 0xFF) }

    /** 流式编码到字节数组 */
    private fun stream(px: IntArray, w: Int, h: Int, tuning: PngTuning, onRow: (Int) -> Unit = {}): ByteArray {
        val bos = ByteArrayOutputStream()
        PngEncoder.writeRgb(bos, w, h, { y, row -> System.arraycopy(px, y * w, row, 0, w) }, tuning, {}, onRow)
        return bos.toByteArray()
    }

    /**
     * 独立的最小 PNG 解码器（只认 8 位 RGB、无隔行）：校验签名、每个块的 CRC、块顺序，
     * 合并 IDAT 后 inflate 并逐行还原五种滤波，返回 ARGB 像素。
     * 不用 javax.imageio：Android 单测编译类路径里没有它。
     */
    private fun decode(png: ByteArray): Triple<Int, Int, IntArray> {
        assertArrayEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A), png.copyOfRange(0, 8))
        var o = 8
        var w = 0
        var h = 0
        val idat = ByteArrayOutputStream()
        var seenIend = false
        while (o < png.size) {
            assertTrue("IEND 之后不应再有块", !seenIend)
            val len = int32(png, o)
            val type = String(png, o + 4, 4, Charsets.US_ASCII)
            val crc = CRC32().apply { update(png, o + 4, 4 + len) }.value.toInt()
            assertEquals("$type 块 CRC", crc, int32(png, o + 8 + len))
            when (type) {
                "IHDR" -> {
                    w = int32(png, o + 8)
                    h = int32(png, o + 12)
                    assertEquals(8, png[o + 16].toInt())
                    assertEquals(2, png[o + 17].toInt())
                }
                "IDAT" -> idat.write(png, o + 8, len)
                "IEND" -> seenIend = true
            }
            o += 12 + len
        }
        assertTrue(seenIend)
        val raw = ByteArray(h * (w * 3 + 1))
        val inf = Inflater()
        inf.setInput(idat.toByteArray())
        var got = 0
        while (got < raw.size) {
            val n = inf.inflate(raw, got, raw.size - got)
            if (n == 0 && (inf.finished() || inf.needsInput())) break
            got += n
        }
        assertEquals("解压出的字节数", raw.size, got)
        val stride = w * 3
        val cur = ByteArray(stride)
        var prev = ByteArray(stride)
        val px = IntArray(w * h)
        for (y in 0 until h) {
            val base = y * (stride + 1)
            val ft = raw[base].toInt()
            for (i in 0 until stride) {
                val x = raw[base + 1 + i].toInt() and 0xFF
                val a = if (i >= 3) cur[i - 3].toInt() and 0xFF else 0
                val b = prev[i].toInt() and 0xFF
                val c = if (i >= 3) prev[i - 3].toInt() and 0xFF else 0
                val pred = when (ft) {
                    0 -> 0
                    1 -> a
                    2 -> b
                    3 -> (a + b) / 2
                    else -> paeth(a, b, c)
                }
                cur[i] = (x + pred).toByte()
            }
            for (x in 0 until w) {
                px[y * w + x] = 0xFF000000.toInt() or ((cur[x * 3].toInt() and 0xFF) shl 16) or ((cur[x * 3 + 1].toInt() and 0xFF) shl 8) or (cur[x * 3 + 2].toInt() and 0xFF)
            }
            prev = cur.copyOf()
        }
        return Triple(w, h, px)
    }

    /** 大端 32 位整数 */
    private fun int32(b: ByteArray, o: Int) =
        ((b[o].toInt() and 0xFF) shl 24) or ((b[o + 1].toInt() and 0xFF) shl 16) or ((b[o + 2].toInt() and 0xFF) shl 8) or (b[o + 3].toInt() and 0xFF)

    /** Paeth 预测器 */
    private fun paeth(a: Int, b: Int, c: Int): Int {
        val p = a + b - c
        val pa = Math.abs(p - a)
        val pb = Math.abs(p - b)
        val pc = Math.abs(p - c)
        return if (pa <= pb && pa <= pc) a else if (pb <= pc) b else c
    }

    @Test
    fun streamedPngDecodesToIdenticalPixelsForEveryTuning() {
        val w = 53
        val h = 41
        val px = image(w, h)
        val tunings = listOf(
            PngTuning.BEST, PngTuning.FAST, PngTuning(1, intArrayOf(0)), PngTuning(1, intArrayOf(1)),
            PngTuning(1, intArrayOf(2)), PngTuning(3, intArrayOf(1, 2, 4)), PngTuning(6, intArrayOf(0, 1, 2, 3, 4)),
        )
        for (t in tunings) {
            val (dw, dh, dp) = decode(stream(px, w, h, t))
            assertEquals(w, dw)
            assertEquals(h, dh)
            assertArrayEquals("tuning level=${t.level} filters=${t.filters.toList()}", px, dp)
        }
    }

    @Test
    fun wholeImageEncoderWithFastTuningIsLosslessToo() {
        val w = 30
        val h = 20
        val px = image(w, h)
        assertArrayEquals(px, decode(PngEncoder.encodeRgba(px, w, h, tuning = PngTuning.FAST)).third)
    }

    @Test
    fun defaultTuningKeepsCompressorOutputUnchanged() {
        // 压缩工具用默认参数：级别 9 + 五种滤波，输出字节必须和显式传 BEST 完全一致（即未被快速模式污染）
        val px = image(64, 48)
        assertArrayEquals(PngEncoder.encodeRgba(px, 64, 48), PngEncoder.encodeRgba(px, 64, 48, tuning = PngTuning.BEST))
    }

    @Test
    fun streamedOutputHasSignatureIhdrMultipleIdatAndIend() {
        // 噪声压不动，足够撑出多个 64KB 的 IDAT 块
        val w = 300
        val h = 300
        val rnd = java.util.Random(5)
        val px = IntArray(w * h) { 0xFF000000.toInt() or rnd.nextInt(0x1000000) }
        val png = stream(px, w, h, PngTuning.FAST)
        assertArrayEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A), png.copyOfRange(0, 8))
        val types = ArrayList<String>()
        var o = 8
        while (o < png.size) {
            val len = int32(png, o)
            types += String(png, o + 4, 4, Charsets.US_ASCII)
            o += 12 + len
        }
        assertEquals(png.size, o)
        assertEquals("IHDR", types.first())
        assertEquals("IEND", types.last())
        assertTrue(types.count { it == "IDAT" } >= 2)
        assertArrayEquals(px, decode(png).third)
    }

    @Test
    fun outputGrowsWhileEncodingInsteadOfAtTheEnd() {
        // 编码进行到一半时，目标流应已收到数据（边压边写）
        val w = 400
        val h = 400
        val rnd = java.util.Random(9)
        val px = IntArray(w * h) { 0xFF000000.toInt() or rnd.nextInt(0x1000000) }
        var written = 0L
        var halfway = -1L
        val sink = object : OutputStream() {
            override fun write(b: Int) {
                written++
            }

            override fun write(b: ByteArray, off: Int, len: Int) {
                written += len
            }
        }
        PngEncoder.writeRgb(sink, w, h, { y, row -> System.arraycopy(px, y * w, row, 0, w) }, PngTuning.FAST, {}) { done ->
            if (done == h / 2) halfway = written
        }
        assertTrue("编码到一半时应已写出数据，实际 $halfway", halfway > 100_000)
        assertTrue(written > halfway)
    }

    @Test
    fun onRowCalledOncePerRowInOrderAndCheckCanAbort() {
        val seen = ArrayList<Int>()
        stream(image(8, 6), 8, 6, PngTuning.FAST) { seen += it }
        assertEquals(listOf(1, 2, 3, 4, 5, 6), seen)
        var n = 0
        val bos = ByteArrayOutputStream()
        PngEncoder.writeRgb(bos, 4, 6, { _, _ -> }, PngTuning.FAST, { n++ })
        assertEquals(6, n)
        val r = runCatching { PngEncoder.writeRgb(bos, 4, 6, { _, _ -> }, PngTuning.FAST, { throw IllegalStateException("stop") }) }
        assertEquals("stop", r.exceptionOrNull()?.message)
    }

    @Test
    fun tuningValidatesArguments() {
        assertTrue(runCatching { PngTuning(0, intArrayOf(1)) }.isFailure)
        assertTrue(runCatching { PngTuning(10, intArrayOf(1)) }.isFailure)
        assertTrue(runCatching { PngTuning(1, intArrayOf()) }.isFailure)
        assertTrue(runCatching { PngTuning(1, intArrayOf(5)) }.isFailure)
    }
}
