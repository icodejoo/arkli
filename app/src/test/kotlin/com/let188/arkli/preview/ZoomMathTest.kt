package com.let188.arkli.preview

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 缩放计算的单测 */
class ZoomMathTest {
    /** 适应：长图按宽度受限的反方向——高先顶满 */
    @Test
    fun fitKeepsRatio() {
        val f = ZoomMath.fit(1000, 4000, 1000f, 2000f)
        assertEquals(500f, f.w, 0.01f)
        assertEquals(2000f, f.h, 0.01f)
    }

    /** 细长图的放大上限随适应宽度提高 */
    @Test
    fun maxScaleGrowsForTallImage() {
        val tall = ZoomMath.fit(1080, 20000, 1080f, 2200f) // 显示宽约 119
        assertTrue(ZoomMath.maxScale(tall, 1080f) > 20f)
        val normal = ZoomMath.fit(1000, 1000, 1000f, 2000f)
        assertEquals(PreviewConst.MIN_MAX_SCALE, ZoomMath.maxScale(normal, 1000f), 0.01f)
    }

    /** 双击：已放大回 1，细长图到适应宽度，普通图到默认倍数 */
    @Test
    fun doubleTapTargets() {
        val tall = ZoomMath.fit(1080, 20000, 1080f, 2200f)
        assertEquals(1f, ZoomMath.doubleTapTarget(3f, tall, 1080f), 0.01f)
        assertEquals(1080f / tall.w, ZoomMath.doubleTapTarget(1f, tall, 1080f), 0.01f)
        val normal = ZoomMath.fit(1000, 1000, 1000f, 2000f)
        assertEquals(PreviewConst.DOUBLE_TAP_SCALE, ZoomMath.doubleTapTarget(1f, normal, 1000f), 0.01f)
    }

    /** 平移夹紧：小于容器的轴固定居中，大于的轴不露空白 */
    @Test
    fun clampOffset() {
        assertEquals(0f, ZoomMath.clampOffset(50f, 1f, 500f, 1000f), 0.01f)
        assertEquals(250f, ZoomMath.clampOffset(999f, 2f, 750f, 1000f), 0.01f)
        assertEquals(-250f, ZoomMath.clampOffset(-999f, 2f, 750f, 1000f), 0.01f)
    }

    /** 以手指中心缩放：中心点在屏幕上不动 */
    @Test
    fun zoomAboutKeepsCentroid() {
        val scale = 2f
        val zoom = 1.5f
        val offset = 40f
        val c = 100f
        val q = (c - offset) / scale
        val newOffset = ZoomMath.zoomAbout(offset, c, zoom)
        assertEquals(c, scale * zoom * q + newOffset, 0.01f)
    }

    /** 未放大时可见区域就是整图 */
    @Test
    fun visibleRectCoversWholeAtScaleOne() {
        val fit = ZoomMath.fit(1000, 2000, 500f, 1000f)
        val r = ZoomMath.visibleRect(1000, 2000, fit, 1f, 0f, 0f, 500f, 1000f, 0f)
        assertEquals(RectI(0, 0, 1000, 2000), r)
    }

    /** 放大 2 倍居中：可见区域是中间四分之一，外扩后更大但不越界 */
    @Test
    fun visibleRectZoomedCenter() {
        val fit = ZoomMath.fit(1000, 2000, 500f, 1000f)
        val r = ZoomMath.visibleRect(1000, 2000, fit, 2f, 0f, 0f, 500f, 1000f, 0f)!!
        assertEquals(250, r.left)
        assertEquals(750, r.right)
        assertEquals(500, r.top)
        assertEquals(1500, r.bottom)
        val m = ZoomMath.visibleRect(1000, 2000, fit, 2f, 0f, 0f, 500f, 1000f, 0.25f)!!
        assertTrue(m.width > r.width && m.height > r.height)
    }

    /** 完全拖出图外时没有可解区域 */
    @Test
    fun visibleRectOutsideIsNull() {
        val fit = ZoomMath.fit(1000, 1000, 500f, 500f)
        assertNull(ZoomMath.visibleRect(1000, 1000, fit, 2f, 5000f, 0f, 500f, 500f, 0f))
        assertNotNull(ZoomMath.visibleRect(1000, 1000, fit, 2f, 0f, 0f, 500f, 500f, 0f))
    }

    /** 采样倍数取 2 的幂，且不低于屏幕分辨率 */
    @Test
    fun samples() {
        assertEquals(1, ZoomMath.detailSample(500, 1080f))
        assertEquals(4, ZoomMath.detailSample(4500, 1080f))
        assertEquals(1, ZoomMath.baseSample(1080, 2000))
        assertEquals(8, ZoomMath.baseSample(1080, 20000)) // 长边 20000/8=2500 ≤ 4096，且 20000/4=5000 超限
    }
}
