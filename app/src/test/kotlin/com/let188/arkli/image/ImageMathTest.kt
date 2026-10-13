package com.let188.arkli.image

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 尺寸、采样率、目标体积搜索 */
class ImageMathTest {
    @Test
    fun fitSizeKeepsRatioAndNeverEnlarges() {
        assertEquals(ImageMath.Size(1600, 1200), ImageMath.fitSize(4000, 3000, 1600))
        assertEquals(ImageMath.Size(1200, 1600), ImageMath.fitSize(3000, 4000, 1600))
        assertEquals(ImageMath.Size(800, 600), ImageMath.fitSize(800, 600, 1600))
        assertEquals(ImageMath.Size(800, 600), ImageMath.fitSize(800, 600, null))
        assertEquals(ImageMath.Size(100, 1), ImageMath.fitSize(10000, 10, 100))
    }

    @Test
    fun sampleSizeIsPowerOfTwoAndNotBelowTarget() {
        assertEquals(1, ImageMath.sampleSize(4000, 3000, 4000, 3000))
        assertEquals(2, ImageMath.sampleSize(4000, 3000, 1600, 1200))
        assertEquals(4, ImageMath.sampleSize(4000, 3000, 1000, 750))
        assertEquals(1, ImageMath.sampleSize(4000, 3000, 2001, 1501))
        // 方向互换结果相同
        assertEquals(2, ImageMath.sampleSize(3000, 4000, 1600, 1200))
        for (t in 100..3999 step 97) {
            val th = t * 3 / 4
            val s = ImageMath.sampleSize(4000, 3000, t, th)
            assertTrue(s and (s - 1) == 0)
            assertTrue(4000 / s >= t && 3000 / s >= th)
        }
    }

    /** 假编码：体积随质量线性增长 */
    private fun linear(q: Int) = q * 1000

    @Test
    fun searchFindsHighestQualityUnderTarget() {
        val r = ImageMath.searchQualityForTarget(55_500, 1, 100, ::linear)
        assertTrue(r.reached)
        assertEquals(55, r.quality)
        assertEquals(55_000, r.bytes)
        assertTrue(r.steps <= ImageConst.MAX_SEARCH_STEPS)
    }

    @Test
    fun searchReturnsMaxWhenAlreadySmallEnough() {
        val r = ImageMath.searchQualityForTarget(1_000_000, 1, 80, ::linear)
        assertTrue(r.reached)
        assertEquals(80, r.quality)
        assertEquals(1, r.steps)
    }

    @Test
    fun searchReportsNotReachedWithMinQuality() {
        val r = ImageMath.searchQualityForTarget(500, 1, 100, ::linear)
        assertFalse(r.reached)
        assertEquals(1, r.quality)
        assertEquals(1000, r.bytes)
    }

    @Test
    fun searchRespectsStepLimitAndEqualBounds() {
        var calls = 0
        ImageMath.searchQualityForTarget(50_000, 1, 100, { calls++; linear(it) }, 4)
        assertTrue(calls <= 4)
        val r = ImageMath.searchQualityForTarget(1, 30, 30, ::linear)
        assertFalse(r.reached)
        assertEquals(30, r.quality)
        assertEquals(1, r.steps)
    }

    @Test
    fun searchExactTargetBoundaryCounts() {
        val r = ImageMath.searchQualityForTarget(42_000, 1, 100, ::linear)
        assertEquals(42, r.quality)
        assertTrue(r.reached)
    }
}
