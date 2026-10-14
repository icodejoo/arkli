package com.let188.arkli.wallpaper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 壁纸读取的分类与缩放计算测试 */
class WallpaperPolicyTest {
    @Test
    fun classifiesExceptions() {
        assertEquals(WallpaperFailure.RESTRICTED, WallpaperPolicy.classify(SecurityException("x")))
        assertEquals(WallpaperFailure.UNSUPPORTED, WallpaperPolicy.classify(UnsupportedOperationException()))
        assertEquals(WallpaperFailure.ERROR, WallpaperPolicy.classify(OutOfMemoryError()))
        assertEquals(WallpaperFailure.ERROR, WallpaperPolicy.classify(IllegalStateException()))
    }

    @Test
    fun wireNamesMatchProtocol() {
        assertEquals(listOf("restricted", "unsupported", "error"), WallpaperFailure.values().map { it.wire })
        WallpaperFailure.values().forEach { assertTrue(WallpaperPolicy.message(it).isNotEmpty()) }
    }

    @Test
    fun kindDependsOnSourceAndSdk() {
        assertEquals("current", WallpaperPolicy.kindOf(34, fromFile = true))
        assertEquals("default", WallpaperPolicy.kindOf(34, fromFile = false))
        assertEquals("default", WallpaperPolicy.kindOf(33, fromFile = false))
        assertEquals("current", WallpaperPolicy.kindOf(32, fromFile = false))
    }

    @Test
    fun noScaleWithinLimit() {
        assertEquals(1.0, WallpaperPolicy.scaleFor(1080, 2400), 0.0)
        assertEquals(1.0, WallpaperPolicy.scaleFor(6000, 4000), 0.0)
        assertEquals(1, WallpaperPolicy.sampleSize(6000, 4000))
    }

    @Test
    fun scaleBringsPixelsUnderLimit() {
        val w = 8000
        val h = 6000
        val s = WallpaperPolicy.scaleFor(w, h)
        assertTrue(s < 1.0)
        assertTrue((w * s).toLong() * (h * s).toLong() <= WallpaperPolicy.MAX_PIXELS)
        assertEquals(0.5, WallpaperPolicy.scaleFor(4000, 4000, 4_000_000), 1e-9)
    }

    @Test
    fun sampleSizeIsPowerOfTwo() {
        assertEquals(2, WallpaperPolicy.sampleSize(8000, 6000))
        assertEquals(4, WallpaperPolicy.sampleSize(16000, 12000))
        assertEquals(1, WallpaperPolicy.sampleSize(0, 0))
    }

    @Test
    fun degenerateSizesDoNotScale() {
        assertEquals(1.0, WallpaperPolicy.scaleFor(0, 100), 0.0)
    }
}
