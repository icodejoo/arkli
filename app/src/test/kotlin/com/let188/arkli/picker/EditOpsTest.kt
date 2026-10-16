package com.let188.arkli.picker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** 编辑操作栈与状态叠加的单测 */
class EditOpsTest {
    /** 空栈等同于没编辑，撤销无效 */
    @Test
    fun emptyIsIdentity() {
        val s = EditOps()
        assertTrue(s.state.isIdentity)
        assertFalse(s.canUndo)
        assertSame(s, s.undo())
    }

    /** 四次顺时针旋转回到原样；单次旋转宽高互换 */
    @Test
    fun rotateCycle() {
        var s = EditOps()
        s = s.push(EditOp.Rotate(true))
        assertEquals(1, s.state.turns)
        assertTrue(s.state.swapsSize)
        repeat(3) { s = s.push(EditOp.Rotate(true)) }
        assertTrue(s.state.isIdentity)
    }

    /** 顺时针再逆时针抵消；逆时针从 0 到 3 */
    @Test
    fun rotateBothWays() {
        assertTrue(EditOps().push(EditOp.Rotate(true)).push(EditOp.Rotate(false)).state.isIdentity)
        assertEquals(3, EditOps().push(EditOp.Rotate(false)).state.turns)
    }

    /** 镜像状态下再转 90°，方向反过来 */
    @Test
    fun rotateAfterFlipReverses() {
        val s = EditOps().push(EditOp.Flip(true)).push(EditOp.Rotate(true)).state
        assertTrue(s.flipH)
        assertEquals(3, s.turns)
    }

    /** 上下翻转 = 镜像 + 转 180°，连做两次回到原样 */
    @Test
    fun flipVerticalTwice() {
        val once = EditOps().push(EditOp.Flip(false)).state
        assertTrue(once.flipH)
        assertEquals(2, once.turns)
        assertTrue(EditOps().push(EditOp.Flip(false)).push(EditOp.Flip(false)).state.isIdentity)
        assertTrue(EditOps().push(EditOp.Flip(true)).push(EditOp.Flip(true)).state.isIdentity)
    }

    /** 裁剪框随旋转、翻转一起变换 */
    @Test
    fun cropFollowsTransforms() {
        val box = EditRect(0f, 0f, 0.5f, 0.5f)
        val s = EditOps().push(EditOp.Crop(box)).push(EditOp.Rotate(true)).state
        assertEquals(box.rotated(true), s.crop)
        val f = EditOps().push(EditOp.Crop(box)).push(EditOp.Flip(true)).state
        assertEquals(box.flipped(true), f.crop)
    }

    /** 还原到原图坐标系后，与最初在原图上画的框一致 */
    @Test
    fun sourceCropInvertsTransforms() {
        val box = EditRect(0.1f, 0.2f, 0.4f, 0.6f)
        val cases = listOf(
            listOf(EditOp.Rotate(true)),
            listOf(EditOp.Flip(true), EditOp.Rotate(false)),
            listOf(EditOp.Flip(false), EditOp.Rotate(true), EditOp.Flip(true)),
        )
        for (pre in cases) {
            var s = EditState().apply(EditOp.Crop(box))
            pre.forEach { s = s.apply(it) }
            val src = s.sourceCrop()
            assertEquals(box.left, src.left, EPS)
            assertEquals(box.top, src.top, EPS)
            assertEquals(box.right, src.right, EPS)
            assertEquals(box.bottom, src.bottom, EPS)
        }
    }

    /** 撤销只回退最近一步 */
    @Test
    fun undoLastStep() {
        val s = EditOps().push(EditOp.Rotate(true)).push(EditOp.Flip(true))
        assertTrue(s.canUndo)
        val u = s.undo()
        assertEquals(1, u.state.turns)
        assertFalse(u.state.flipH)
        assertTrue(u.undo().state.isIdentity)
    }

    /** 超过 20 步后最老的一步折进基础状态：栈长封顶、结果不变、折掉的不能再撤销 */
    @Test
    fun capsAtMaxSteps() {
        var s = EditOps()
        repeat(EditOps.MAX_STEPS + 5) { s = s.push(EditOp.Rotate(true)) }
        assertEquals(EditOps.MAX_STEPS, s.ops.size)
        assertEquals((EditOps.MAX_STEPS + 5) % 4, s.state.turns)
        var back = s
        repeat(EditOps.MAX_STEPS + 5) { back = back.undo() }
        assertFalse(back.canUndo)
        assertEquals(5 % 4, back.state.turns)
    }

    /** 重置回到原图 */
    @Test
    fun resetClears() {
        val s = EditOps().push(EditOp.Rotate(true)).push(EditOp.Crop(EditRect(0f, 0f, 0.5f, 0.5f))).reset()
        assertTrue(s.state.isIdentity)
        assertFalse(s.canUndo)
    }

    /** 选形状：带 alpha、非恒等；撤销回矩形；Shape 可顺带设置裁剪框 */
    @Test
    fun shapeOpUndo() {
        val box = EditRect(0.1f, 0.1f, 0.6f, 0.6f)
        val ops = EditOps().push(EditOp.Shape(EditShape.CIRCLE, box))
        assertEquals(EditShape.CIRCLE, ops.state.shape)
        assertEquals(box, ops.state.crop)
        assertTrue(ops.state.needsAlpha)
        assertFalse(ops.state.isIdentity)
        val back = ops.undo().state
        assertEquals(EditShape.RECT, back.shape)
        assertFalse(back.needsAlpha)
        assertTrue(back.isIdentity)
        // 切回矩形不再带 alpha
        assertFalse(ops.push(EditOp.Shape(EditShape.RECT)).state.needsAlpha)
    }

    /** 套索：设置后带 alpha、有效裁剪框是外接框；撤销与重置都能清掉，重画不残留旧点 */
    @Test
    fun lassoOpUndoReset() {
        val pts = listOf(EditPoint(0.2f, 0.3f), EditPoint(0.7f, 0.3f), EditPoint(0.5f, 0.8f))
        val ops = EditOps().push(EditOp.Lasso(pts))
        assertTrue(ops.state.needsAlpha)
        assertEquals(EditRect(0.2f, 0.3f, 0.7f, 0.8f), ops.state.effectiveCrop)
        assertNull(ops.undo().state.lasso)
        assertTrue(ops.reset().state.isIdentity)
        val cleared = ops.push(EditOp.Lasso(null))
        assertNull(cleared.state.lasso)
        assertFalse(cleared.state.needsAlpha)
    }

    /** 套索与形状互斥：设套索复位形状，选形状或改裁剪框清掉套索 */
    @Test
    fun lassoAndShapeExclusive() {
        val pts = listOf(EditPoint(0.2f, 0.3f), EditPoint(0.7f, 0.3f), EditPoint(0.5f, 0.8f))
        val withShape = EditOps().push(EditOp.Shape(EditShape.HEART))
        assertEquals(EditShape.RECT, withShape.push(EditOp.Lasso(pts)).state.shape)
        assertNull(EditOps().push(EditOp.Lasso(pts)).push(EditOp.Shape(EditShape.STAR)).state.lasso)
        assertNull(EditOps().push(EditOp.Lasso(pts)).push(EditOp.Crop(EditRect(0f, 0f, 0.5f, 0.5f))).state.lasso)
    }

    /** 套索随旋转翻转一起变换：转 90° 后，还原到原图坐标的外接框与原来一致 */
    @Test
    fun lassoFollowsTransforms() {
        val pts = listOf(EditPoint(0.1f, 0.1f), EditPoint(0.4f, 0.1f), EditPoint(0.4f, 0.3f))
        val orig = EditShapes.bounds(pts)
        val steps = listOf(
            listOf(EditOp.Rotate(true)),
            listOf(EditOp.Flip(true)),
            listOf(EditOp.Flip(false)),
            listOf(EditOp.Rotate(true), EditOp.Flip(true), EditOp.Rotate(false), EditOp.Flip(false)),
        )
        for (seq in steps) {
            val s = seq.fold(EditOps().push(EditOp.Lasso(pts))) { acc, op -> acc.push(op) }.state
            val src = s.sourceCrop()
            assertEquals(orig.left, src.left, EPS)
            assertEquals(orig.top, src.top, EPS)
            assertEquals(orig.right, src.right, EPS)
            assertEquals(orig.bottom, src.bottom, EPS)
            assertEquals(3, s.lasso!!.size)
        }
    }

    /** 形状计入步数上限，最老的一步折进基础状态后形状仍保留 */
    @Test
    fun shapeSurvivesFold() {
        var ops = EditOps().push(EditOp.Shape(EditShape.HEXAGON))
        repeat(EditOps.MAX_STEPS) { ops = ops.push(EditOp.Flip(true)) }
        assertEquals(EditShape.HEXAGON, ops.state.shape)
    }

    private companion object {
        /** 浮点比较容差 */
        const val EPS = 0.001f
    }
}
