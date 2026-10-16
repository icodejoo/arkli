package com.let188.arkli.picker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 形状轮廓、点内判定、套索抽稀与坐标变换的单测 */
class EditShapesTest {
    /** 测试用的裁剪框 */
    private val box = EditRect(100f, 50f, 300f, 250f)

    /** 除矩形外的预设形状：中心在内，外接框四角（略向内收一点）在外 */
    @Test
    fun shapesCenterInCornersOut() {
        for (s in EditShape.entries.filter { it != EditShape.RECT }) {
            assertTrue("${s.key} 中心应在内", EditShapes.contains(s, box, box.centerX, box.centerY))
            val corners = listOf(
                box.left + 0.5f to box.top + 0.5f, box.right - 0.5f to box.top + 0.5f,
                box.left + 0.5f to box.bottom - 0.5f, box.right - 0.5f to box.bottom - 0.5f,
            )
            for ((x, y) in corners) assertFalse("${s.key} 角 ($x,$y) 应在外", EditShapes.contains(s, box, x, y))
        }
    }

    /** 矩形整个框内都算在内 */
    @Test
    fun rectContainsWholeBox() {
        assertTrue(EditShapes.contains(EditShape.RECT, box, box.left + 1f, box.top + 1f))
        assertFalse(EditShapes.contains(EditShape.RECT, box, box.left - 1f, box.top))
    }

    /** 轮廓点都落在外接框内（留一点浮点误差） */
    @Test
    fun outlineStaysInBox() {
        for (s in EditShape.entries) {
            for (p in EditShapes.outline(s, box)) {
                assertTrue("${s.key} x 越界 ${p.x}", p.x >= box.left - 0.01f && p.x <= box.right + 0.01f)
                assertTrue("${s.key} y 越界 ${p.y}", p.y >= box.top - 0.01f && p.y <= box.bottom + 0.01f)
            }
        }
    }

    /** 心形：上缘中间的凹口在外，底部尖角附近在内 */
    @Test
    fun heartHasNotchAndTip() {
        assertFalse(EditShapes.contains(EditShape.HEART, box, box.centerX, box.top + 1f))
        assertTrue(EditShapes.contains(EditShape.HEART, box, box.centerX, box.bottom - 8f))
    }

    /** 星形：顶角尖端附近在内，左缘腰线外侧在外 */
    @Test
    fun starTipsAndWaist() {
        assertTrue(EditShapes.contains(EditShape.STAR, box, box.centerX, box.top + 8f))
        assertFalse(EditShapes.contains(EditShape.STAR, box, box.left + 2f, box.centerY + 40f))
    }

    /** 圆形在非正方形框里取内切正圆 */
    @Test
    fun circleIsRoundInWideBox() {
        val wide = EditRect(0f, 0f, 400f, 200f)
        val pts = EditShapes.outline(EditShape.CIRCLE, wide)
        assertEquals(EditShapes.ELLIPSE_SEGMENTS, pts.size)
        assertEquals(200f, pts.maxOf { it.x } - pts.minOf { it.x }, 0.5f)
        assertEquals(200f, pts.maxOf { it.y } - pts.minOf { it.y }, 0.5f)
    }

    /** 圆形强制 1:1，其余不强制；套上强制比例后得到正方形 */
    @Test
    fun circleForcesSquare() {
        assertEquals(1f, EditShape.CIRCLE.ratio)
        assertTrue(EditShape.entries.filter { it != EditShape.CIRCLE }.all { it.ratio == null })
        val sq = EditMath.applyRatio(EditRect(0f, 0f, 400f, 200f), EditShape.CIRCLE.ratio, 400f, 200f)
        assertEquals(sq.width, sq.height, 0.01f)
    }

    /** 套索：共线点被抽稀、闭合后只剩 4 个顶点，面积不变 */
    @Test
    fun lassoSimplifiesAndCloses() {
        val raw = buildList {
            for (i in 0..100) add(EditPoint(i.toFloat(), 0f))
            for (i in 1..100) add(EditPoint(100f, i.toFloat()))
            for (i in 1..100) add(EditPoint(100f - i, 100f))
            // 末尾回到起点，应被去掉重复
            for (i in 1..100) add(EditPoint(0f, 100f - i))
        }
        val out = EditShapes.finishLasso(raw)
        assertNotNull(out)
        assertEquals(4, out!!.size)
        assertEquals(10000f, kotlin.math.abs(EditShapes.area(out)), 1f)
    }

    /** 套索点太少、面积太小、退化成直线都当作误触 */
    @Test
    fun lassoRejectsTinyOrShort() {
        assertNull(EditShapes.finishLasso(listOf(EditPoint(0f, 0f), EditPoint(5f, 5f))))
        assertNull(EditShapes.finishLasso(listOf(EditPoint(0f, 0f), EditPoint(2f, 0f), EditPoint(2f, 2f), EditPoint(0f, 2f))))
        assertNull(EditShapes.finishLasso(listOf(EditPoint(0f, 0f), EditPoint(50f, 0f), EditPoint(100f, 0f))))
    }

    /** 点数过多时自动加大容差，结果不超过上限 */
    @Test
    fun lassoCapsPointCount() {
        val raw = List(2000) {
            val a = 2.0 * Math.PI * it / 2000
            EditPoint((500 + 400 * Math.cos(a) + (if (it % 2 == 0) 3 else -3)).toFloat(), (500 + 400 * Math.sin(a)).toFloat())
        }
        val out = EditShapes.finishLasso(raw, epsilon = 0.01f)
        assertNotNull(out)
        assertTrue(out!!.size <= EditShapes.LASSO_MAX_POINTS)
    }

    /** 点的旋转：顺时针四次回原位；顺逆各一次回原位；翻两次回原位 */
    @Test
    fun pointTransforms() {
        val p = EditPoint(0.2f, 0.7f)
        var q = p
        repeat(4) { q = q.rotated(true) }
        assertEquals(p.x, q.x, 1e-5f)
        assertEquals(p.y, q.y, 1e-5f)
        val back = p.rotated(true).rotated(false)
        assertEquals(p.x, back.x, 1e-5f)
        assertEquals(p.y, back.y, 1e-5f)
        val fh = p.flipped(true).flipped(true)
        val fv = p.flipped(false).flipped(false)
        assertEquals(p.x, fh.x, 1e-5f)
        assertEquals(p.y, fv.y, 1e-5f)
    }

    /** 点的旋转与矩形的旋转一致：原左上角顺时针转后落在新矩形的右上角 */
    @Test
    fun pointRotateMatchesRect() {
        val r = EditRect(0.1f, 0.2f, 0.5f, 0.9f)
        val rr = r.rotated(true)
        val p = EditPoint(r.left, r.top).rotated(true)
        assertEquals(rr.right, p.x, 1e-5f)
        assertEquals(rr.top, p.y, 1e-5f)
    }

    /** 像素与归一化互转 */
    @Test
    fun pointScaleRoundTrip() {
        val p = EditPoint(30f, 40f)
        val back = p.normalizedBy(200f, 100f).scaledBy(200f, 100f)
        assertEquals(p.x, back.x, 1e-4f)
        assertEquals(p.y, back.y, 1e-4f)
    }

    /** 抠图多边形：矩形不抠；形状按结果图尺寸生成；套索映射到外接框内 */
    @Test
    fun maskPolygonCases() {
        assertNull(EditShapes.maskPolygon(EditState(), 100f, 100f))
        val shaped = EditShapes.maskPolygon(EditState(shape = EditShape.CIRCLE), 100f, 100f)
        assertNotNull(shaped)
        assertTrue(shaped!!.all { it.x in -0.01f..100.01f && it.y in -0.01f..100.01f })
        val lasso = listOf(EditPoint(0.2f, 0.2f), EditPoint(0.6f, 0.2f), EditPoint(0.6f, 0.8f))
        val poly = EditShapes.maskPolygon(EditState(lasso = lasso), 400f, 600f)!!
        // 外接框 0.2..0.6 x 0.2..0.8，映射后左上角 (0,0)，右下角 (400,600)
        assertEquals(0f, poly[0].x, 0.01f)
        assertEquals(400f, poly[1].x, 0.01f)
        assertEquals(600f, poly[2].y, 0.01f)
    }
}
