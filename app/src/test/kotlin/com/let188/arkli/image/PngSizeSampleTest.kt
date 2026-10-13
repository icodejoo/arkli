package com.let188.arkli.image

import org.junit.Assert.assertTrue
import org.junit.Test

/** 几类样本图的 PNG 体积对比（无损 vs 缩色）；数字打印到标准输出，供汇报引用 */
class PngSizeSampleTest {
    /** 无损：能转索引色就转，否则真彩 */
    private fun lossless(px: IntArray, w: Int, h: Int): ByteArray {
        val pal = Quantizer.exactPalette(px, 256)
        return if (pal != null) {
            val s = pal.sortedBy { it ushr 24 }.toIntArray()
            PngEncoder.encodeIndexed(s, Quantizer.indexWith(px, s), w, h)
        } else {
            PngEncoder.encodeRgba(px, w, h)
        }
    }

    /** 缩色到 [n] 色 */
    private fun palette(px: IntArray, w: Int, h: Int, n: Int, dither: Boolean): ByteArray {
        val q = Quantizer.quantize(px, w, h, n, dither)
        return PngEncoder.encodeIndexed(q.palette, q.indices, w, h)
    }

    @Test
    fun printSizes() {
        val cases = listOf(
            "纯色 512x512" to Triple(512, 512, Samples.solid(512, 512, 0xFF3366CC.toInt())),
            "彩色渐变 512x512" to Triple(512, 512, Samples.colorGradient(512, 512)),
            "透明图标 256x256" to Triple(256, 256, Samples.icon(256)),
            "类照片(渐变+轻噪声) 512x512" to Triple(512, 512, Samples.photoLike(512, 512)),
            "纯噪声 256x256" to Triple(256, 256, Samples.noise(256, 256)),
        )
        for ((name, c) in cases) {
            val (w, h, px) = c
            val raw = w * h * 4
            val a = lossless(px, w, h).size
            val b = palette(px, w, h, 256, false).size
            val d = palette(px, w, h, 64, true).size
            println("SAMPLE $name 原始RGBA=$raw 无损=$a 缩256色=$b 缩64色抖动=$d")
        }
        val photo = Samples.photoLike(512, 512)
        assertTrue(palette(photo, 512, 512, 256, false).size < lossless(photo, 512, 512).size)
    }
}
