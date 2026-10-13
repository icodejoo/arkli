package com.let188.arkli.image

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random
import java.util.zip.Deflater

/** PNG 编码器：用 ImageIO 读回逐像素比对 */
class PngEncoderTest {
    /** 读回并断言与原像素一致 */
    private fun assertRoundTrip(png: ByteArray, w: Int, h: Int, expected: IntArray) {
        val (rw, rh, px) = Samples.readBack(png)
        assertEquals(w, rw)
        assertEquals(h, rh)
        assertArrayEquals(expected, px)
    }

    @Test
    fun rgbaRoundTripKeepsEveryPixel() {
        val px = Samples.randomArgb(37, 23)
        val png = PngEncoder.encodeRgba(px, 37, 23)
        assertEquals(6, Samples.colorType(png))
        assertRoundTrip(png, 37, 23, px)
    }

    @Test
    fun opaqueImageDropsAlphaChannel() {
        val px = Samples.noise(20, 20)
        val png = PngEncoder.encodeRgba(px, 20, 20)
        assertEquals(2, Samples.colorType(png))
        assertRoundTrip(png, 20, 20, px)
    }

    @Test
    fun oneByOneImage() {
        val px = intArrayOf(0x80336699.toInt())
        assertRoundTrip(PngEncoder.encodeRgba(px, 1, 1), 1, 1, px)
    }

    @Test
    fun strategyOptionStillValid() {
        val px = Samples.colorGradient(40, 30)
        val png = PngEncoder.encodeRgba(px, 40, 30, Deflater.FILTERED)
        assertRoundTrip(png, 40, 30, px)
    }

    @Test
    fun indexedBitDepthFollowsPaletteSize() {
        for ((n, depth) in listOf(1 to 1, 2 to 1, 3 to 2, 4 to 2, 5 to 4, 16 to 4, 17 to 8, 200 to 8)) {
            val w = 13
            val h = 9
            val rnd = Random(n.toLong())
            // 调色板各项互不相同
            val pal = IntArray(n) { (0xFF shl 24) or ((it * 1237) and 0xFFFF) or ((it shl 16) and 0xFF0000) }
            val idx = ByteArray(w * h) { rnd.nextInt(n).toByte() }
            val png = PngEncoder.encodeIndexed(pal, idx, w, h)
            assertEquals("调色板 $n 项", depth, Samples.bitDepth(png))
            assertEquals(3, Samples.colorType(png))
            assertRoundTrip(png, w, h, IntArray(w * h) { pal[idx[it].toInt() and 0xFF] })
        }
    }

    @Test
    fun indexedWithTransparencyWritesTrns() {
        val pal = intArrayOf(0x00000000, 0x80FF0000.toInt(), 0xFF00FF00.toInt(), 0xFF0000FF.toInt())
        val w = 8
        val h = 8
        val idx = ByteArray(w * h) { (it % 4).toByte() }
        val png = PngEncoder.encodeIndexed(pal, idx, w, h)
        val (_, _, px) = Samples.readBack(png)
        for (i in px.indices) {
            val want = pal[i % 4]
            // 完全透明的颜色分量不要求一致
            if ((want ushr 24) == 0) assertEquals(0, px[i] ushr 24) else assertEquals(want, px[i])
        }
        assertTrue(String(png, Charsets.ISO_8859_1).contains("tRNS"))
    }

    @Test
    fun opaquePaletteHasNoTrns() {
        val pal = intArrayOf(0xFF000000.toInt(), 0xFFFFFFFF.toInt())
        val png = PngEncoder.encodeIndexed(pal, ByteArray(16) { (it % 2).toByte() }, 4, 4)
        assertTrue(!String(png, Charsets.ISO_8859_1).contains("tRNS"))
    }

    @Test
    fun solidColorCompressesVerySmall() {
        val png = PngEncoder.encodeRgba(Samples.solid(200, 200, 0xFF123456.toInt()), 200, 200)
        assertTrue("纯色图应小于 600 字节，实际 ${png.size}", png.size < 600)
    }
}
