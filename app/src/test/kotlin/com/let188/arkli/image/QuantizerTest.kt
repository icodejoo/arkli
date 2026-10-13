package com.let188.arkli.image

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 量化器：颜色数、精确还原、误差、抖动、alpha */
class QuantizerTest {
    /** 按调色板还原后的像素 */
    private fun restore(r: QuantResult): IntArray =
        IntArray(r.indices.size) { r.palette[r.indices[it].toInt() and 0xFF] }

    /** 通道平均绝对误差 */
    private fun meanErr(a: IntArray, b: IntArray): Double {
        var sum = 0L
        for (i in a.indices) {
            for (s in intArrayOf(0, 8, 16, 24)) sum += Math.abs(((a[i] ushr s) and 0xFF) - ((b[i] ushr s) and 0xFF))
        }
        return sum.toDouble() / (a.size * 4)
    }

    @Test
    fun solidColorRestoredExactly() {
        val px = Samples.solid(16, 16, 0xFF336699.toInt())
        val r = Quantizer.quantize(px, 16, 16, 8, false)
        assertEquals(1, r.palette.size)
        assertTrue(r.exact)
        assertEquals(px.toList(), restore(r).toList())
    }

    @Test
    fun twoColorsRestoredExactly() {
        val px = IntArray(100) { if (it % 3 == 0) 0xFFFF0000.toInt() else 0xFF0000FF.toInt() }
        val r = Quantizer.quantize(px, 10, 10, 2, true)
        assertEquals(2, r.palette.size)
        assertEquals(px.toList(), restore(r).toList())
    }

    @Test
    fun colorCountNeverExceedsLimit() {
        val px = Samples.noise(64, 64)
        for (n in intArrayOf(2, 7, 16, 100, 256)) {
            val r = Quantizer.quantize(px, 64, 64, n, false)
            assertTrue("n=$n 实际 ${r.palette.size}", r.palette.size <= n)
            assertEquals(px.size, r.indices.size)
            assertTrue(r.indices.all { (it.toInt() and 0xFF) < r.palette.size })
        }
    }

    @Test
    fun gradientErrorWithinBound() {
        val px = Samples.gradient(256, 4)
        val r = Quantizer.quantize(px, 256, 4, 16, false)
        val err = meanErr(px, restore(r))
        assertTrue("16 色渐变平均误差应小于 6，实际 $err", err < 6.0)
        val r2 = Quantizer.quantize(px, 256, 4, 64, false)
        assertTrue(meanErr(px, restore(r2)) < err)
    }

    @Test
    fun ditherKeepsShapeAndPaletteLimit() {
        val px = Samples.colorGradient(48, 32)
        val plain = Quantizer.quantize(px, 48, 32, 8, false)
        val dith = Quantizer.quantize(px, 48, 32, 8, true)
        assertEquals(px.size, dith.indices.size)
        assertTrue(dith.palette.size <= 8)
        assertTrue(dith.indices.all { (it.toInt() and 0xFF) < dith.palette.size })
        // 抖动应让整体色偏不比不抖动更大：看整幅图的平均颜色
        fun mean(a: IntArray, sh: Int) = a.sumOf { ((it ushr sh) and 0xFF).toLong() }.toDouble() / a.size
        val dm = Math.abs(mean(restore(dith), 8) - mean(px, 8))
        val pm = Math.abs(mean(restore(plain), 8) - mean(px, 8))
        assertTrue("抖动均值偏差 $dm 应不大于不抖动 $pm + 1", dm <= pm + 1.0)
    }

    @Test
    fun alphaIsPreservedAndSortedFirst() {
        val px = Samples.icon(48)
        val r = Quantizer.quantize(px, 48, 48, 16, false)
        assertTrue(r.exact)
        val out = restore(r)
        for (i in px.indices) {
            if ((px[i] ushr 24) == 0) assertEquals(0, out[i] ushr 24) else assertEquals(px[i], out[i])
        }
        // 调色板按 alpha 升序
        for (i in 1 until r.palette.size) assertTrue((r.palette[i - 1] ushr 24) <= (r.palette[i] ushr 24))
    }

    @Test
    fun semiTransparentGradientKeepsAlphaRange() {
        val px = IntArray(256) { (it shl 24) or 0x00FF8000 }
        val r = Quantizer.quantize(px, 256, 1, 8, false)
        val alphas = r.palette.map { it ushr 24 }
        assertTrue(alphas.min() < 40)
        assertTrue(alphas.max() > 215)
    }

    @Test
    fun exactPaletteDetectsOverflow() {
        assertNotNull(Quantizer.exactPalette(Samples.icon(32), 256))
        assertNull(Quantizer.exactPalette(Samples.noise(32, 32), 256))
    }

    @Test
    fun indexWithMapsBack() {
        val pal = intArrayOf(0x00000000, 0xFFFF0000.toInt(), 0xFF00FF00.toInt())
        val px = intArrayOf(pal[2], pal[0], pal[1], pal[2])
        val idx = Quantizer.indexWith(px, pal)
        assertEquals(listOf(2, 0, 1, 2), idx.map { it.toInt() })
    }

    @Test
    fun checkIsCalledAndCanAbort() {
        val px = Samples.noise(64, 64)
        var calls = 0
        Quantizer.quantize(px, 64, 64, 16, true) { calls++ }
        assertTrue("取消点应被调用多次，实际 $calls", calls > 16)
        try {
            Quantizer.quantize(px, 64, 64, 16, false) { throw IllegalStateException("stop") }
            org.junit.Assert.fail("应抛出")
        } catch (e: IllegalStateException) {
            assertEquals("stop", e.message)
        }
    }
}
