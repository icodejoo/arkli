package com.let188.arkli.picker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 图片编辑纯数学的单测 */
class EditMathTest {
    /** 断言矩形四边近似相等 */
    private fun assertRect(exp: EditRect, act: EditRect) {
        assertEquals(exp.left, act.left, EPS)
        assertEquals(exp.top, act.top, EPS)
        assertEquals(exp.right, act.right, EPS)
        assertEquals(exp.bottom, act.bottom, EPS)
    }

    /** 适配缩放取宽高比里较小者，并居中 */
    @Test
    fun fitAndCenter() {
        assertEquals(2f, EditMath.fitScale(1000f, 2000f, 500f, 500f), EPS)
        val t = EditMath.fitTransform(1000f, 2000f, 500f, 500f)
        assertEquals(0f, t.tx, EPS)
        assertEquals(500f, t.ty, EPS)
        assertEquals(1f, EditMath.fitScale(0f, 10f, 5f, 5f), EPS)
    }

    /** 视图与图像坐标互为逆映射 */
    @Test
    fun coordinateRoundTrip() {
        val t = ViewTransform(2f, 10f, 20f)
        val (ix, iy) = EditMath.viewToImage(t, 50f, 100f)
        assertEquals(20f, ix, EPS)
        assertEquals(40f, iy, EPS)
        val (vx, vy) = EditMath.imageToView(t, ix, iy)
        assertEquals(50f, vx, EPS)
        assertEquals(100f, vy, EPS)
    }

    /** 缩放限制在 [fit*MIN_ZOOM, fit*MAX_ZOOM]，平移后图至少留最小可见量 */
    @Test
    fun clampTransformLimits() {
        val fit = EditMath.fitTransform(100f, 100f, 200f, 200f)
        val tooSmall = EditMath.clampTransform(ViewTransform(0.1f, 99f, 99f), 100f, 100f, 200f, 200f, MIN_VIS)
        assertEquals(fit.scale * EditMath.MIN_ZOOM, tooSmall.scale, EPS)
        // 缩小后向右猛拖：图只剩最小可见量在视图内（图 25px 宽，留 20）
        assertEquals(100f - MIN_VIS, tooSmall.tx, EPS)
        val tooBig = EditMath.clampTransform(ViewTransform(100f, 0f, 0f), 100f, 100f, 200f, 200f, MIN_VIS)
        assertEquals(fit.scale * EditMath.MAX_ZOOM, tooBig.scale, EPS)
        // 放大后猛拖，图仍留最小可见量
        val z = EditMath.clampTransform(ViewTransform(1f, 500f, -500f), 100f, 100f, 200f, 200f, MIN_VIS)
        assertEquals(100f - MIN_VIS, z.tx, EPS)
        assertEquals(MIN_VIS - 200f, z.ty, EPS)
    }

    /** 以中心点缩放时，该点下的图像坐标保持不变 */
    @Test
    fun zoomKeepsPivot() {
        val start = EditMath.fitTransform(100f, 100f, 200f, 200f)
        val before = EditMath.viewToImage(start, 50f, 50f)
        val t = EditMath.zoomPan(start, 2f, 50f, 50f, 0f, 0f, 100f, 100f, 200f, 200f, MIN_VIS)
        val after = EditMath.viewToImage(t, 50f, 50f)
        assertEquals(before.first, after.first, EPS)
        assertEquals(before.second, after.second, EPS)
    }

    /** 裁剪框被限制在图内且不小于最小边 */
    @Test
    fun clampCropInsideImage() {
        assertRect(EditRect(0f, 0f, 100f, 80f), EditMath.clampCrop(EditRect(-10f, -5f, 300f, 200f), 100f, 80f))
        val small = EditMath.clampCrop(EditRect(50f, 50f, 51f, 51f), 100f, 100f, 20f)
        assertEquals(20f, small.width, EPS)
        assertEquals(20f, small.height, EPS)
    }

    /** 自由拖边：越界被截到图边，且不能小于最小边 */
    @Test
    fun dragFreeEdges() {
        val s = EditRect(20f, 20f, 80f, 80f)
        assertRect(EditRect(0f, 20f, 80f, 80f), EditMath.dragCrop(s, CropHandle.LEFT, -50f, 0f, 100f, 100f))
        assertRect(EditRect(20f, 20f, 100f, 80f), EditMath.dragCrop(s, CropHandle.RIGHT, 50f, 0f, 100f, 100f))
        val tiny = EditMath.dragCrop(s, CropHandle.RIGHT, -500f, 0f, 100f, 100f, minSize = 10f)
        assertEquals(10f, tiny.width, EPS)
        val corner = EditMath.dragCrop(s, CropHandle.TOP_LEFT, 10f, 15f, 100f, 100f)
        assertRect(EditRect(30f, 35f, 80f, 80f), corner)
    }

    /** 整体平移被限制在图内，尺寸不变 */
    @Test
    fun dragMoveClamped() {
        val s = EditRect(20f, 20f, 60f, 60f)
        assertRect(EditRect(60f, 0f, 100f, 40f), EditMath.dragCrop(s, CropHandle.MOVE, 500f, -500f, 100f, 100f))
    }

    /** 固定比例拖角：始终保持比例、不出图 */
    @Test
    fun dragCornerKeepsRatio() {
        val s = EditRect(10f, 10f, 50f, 50f)
        val r = EditMath.dragCrop(s, CropHandle.BOTTOM_RIGHT, 30f, 5f, 200f, 100f, ratio = 2f)
        assertEquals(2f, r.width / r.height, EPS)
        assertEquals(10f, r.left, EPS)
        assertEquals(10f, r.top, EPS)
        val huge = EditMath.dragCrop(s, CropHandle.BOTTOM_RIGHT, 999f, 999f, 200f, 100f, ratio = 2f)
        assertEquals(2f, huge.width / huge.height, EPS)
        assertTrue(huge.right <= 200f + EPS && huge.bottom <= 100f + EPS)
    }

    /** 固定比例拖边：对边不动、另一维居中伸缩 */
    @Test
    fun dragEdgeKeepsRatio() {
        val s = EditRect(40f, 40f, 60f, 60f)
        val r = EditMath.dragCrop(s, CropHandle.RIGHT, 20f, 0f, 200f, 200f, ratio = 1f)
        assertEquals(40f, r.left, EPS)
        assertEquals(40f, r.width, EPS)
        assertEquals(1f, r.width / r.height, EPS)
        assertEquals(s.centerY, r.centerY, EPS)
    }

    /** 选比例：同中心取最大内接矩形；自由则原样 */
    @Test
    fun applyRatioCentered() {
        val r = EditMath.applyRatio(EditRect(0f, 0f, 400f, 200f), 1f, 400f, 200f)
        assertRect(EditRect(100f, 0f, 300f, 200f), r)
        val same = EditRect(1f, 2f, 3f, 4f)
        assertEquals(same, EditMath.applyRatio(same, null, 10f, 10f))
        val wide = EditMath.applyRatio(EditRect(0f, 0f, 300f, 300f), 16f / 9f, 300f, 300f)
        assertEquals(16f / 9f, wide.width / wide.height, EPS)
    }

    /** 点击命中：角优先于边，框内是移动，框外为空 */
    @Test
    fun hitTestPriority() {
        val r = EditRect(100f, 100f, 200f, 200f)
        assertEquals(CropHandle.TOP_LEFT, EditMath.hitTest(r, 102f, 98f, 10f))
        assertEquals(CropHandle.RIGHT, EditMath.hitTest(r, 199f, 150f, 10f))
        assertEquals(CropHandle.BOTTOM, EditMath.hitTest(r, 150f, 205f, 10f))
        assertEquals(CropHandle.MOVE, EditMath.hitTest(r, 150f, 150f, 10f))
        assertNull(EditMath.hitTest(r, 10f, 10f, 10f))
    }

    /** 归一化矩形旋转后：顺时针再逆时针回到原样，且新宽高对调 */
    @Test
    fun rotateRectRoundTrip() {
        val r = EditRect(0.1f, 0.2f, 0.5f, 0.9f)
        assertRect(r, r.rotated(true).rotated(false))
        // 顺时针 90°：左上区域移到右上
        assertRect(EditRect(0.1f, 0f, 1f, 0.5f), EditRect(0f, 0f, 0.5f, 0.9f).rotated(true))
        val cw = r.rotated(true)
        assertEquals(r.height, cw.width, EPS)
        assertEquals(r.width, cw.height, EPS)
    }

    /** 翻转两次回到原样；水平翻转镜像 x，垂直镜像 y */
    @Test
    fun flipRect() {
        val r = EditRect(0.1f, 0.2f, 0.5f, 0.9f)
        assertRect(EditRect(0.5f, 0.2f, 0.9f, 0.9f), r.flipped(true))
        assertRect(EditRect(0.1f, 0.1f, 0.5f, 0.8f), r.flipped(false))
        assertRect(r, r.flipped(true).flipped(true))
    }

    /** 像素与归一化互转 */
    @Test
    fun scaleAndNormalize() {
        val r = EditRect(0.25f, 0.5f, 0.75f, 1f)
        assertRect(r, r.scaledBy(400f, 200f).normalizedBy(400f, 200f))
        assertEquals(100f, r.scaledBy(400f, 200f).left, EPS)
    }

    /** 导出采样倍数是 2 的幂，且让最长边不超限 */
    @Test
    fun exportSampleLimits() {
        assertEquals(1, EditMath.exportSample(4000, 3000, 4096))
        assertEquals(2, EditMath.exportSample(8000, 6000, 4096))
        assertEquals(4, EditMath.exportSample(12000, 9000, 4096))
    }

    /** 屏幕上的框四边坐标 */
    private fun screenBox(t: ViewTransform, c: EditRect): List<Float> {
        val (l, tp) = EditMath.imageToView(t, c.left, c.top)
        val (r, b) = EditMath.imageToView(t, c.right, c.bottom)
        return listOf(l, tp, r, b)
    }

    /** 缩放（放大）不动框的屏幕位置与大小 */
    @Test
    fun zoomKeepsBoxOnScreen() {
        val t = EditMath.fitTransform(100f, 100f, 200f, 200f)
        val crop = EditRect(40f, 40f, 160f, 160f)
        val r = EditMath.zoomPanKeepBox(t, crop, 2f, 50f, 50f, 0f, 0f, 100f, 100f, 200f, 200f, MIN_VIS)
        assertEquals(1f, r.transform.scale, EPS)
        screenBox(t, crop).zip(screenBox(r.transform, r.crop)).forEach { (a, b) -> assertEquals(a, b, EPS) }
        assertTrue(r.crop.width < crop.width)
    }

    /** 缩小到下限：框的屏幕位置不变，不收缩，图像坐标允许超出图像 */
    @Test
    fun zoomOutDoesNotShrinkBox() {
        val t = EditMath.fitTransform(100f, 100f, 200f, 200f)
        val crop = EditRect(0f, 0f, 200f, 200f)
        val r = EditMath.zoomPanKeepBox(t, crop, 0.001f, 50f, 50f, 0f, 0f, 100f, 100f, 200f, 200f, MIN_VIS)
        assertEquals(0.5f * EditMath.MIN_ZOOM, r.transform.scale, EPS)
        screenBox(t, crop).zip(screenBox(r.transform, r.crop)).forEach { (a, b) -> assertEquals(a, b, EPS) }
        assertTrue(r.crop.left < 0f && r.crop.right > 200f)
    }

    /** 放大不受“框不小于最小边”之类的限制，框屏幕位置照旧 */
    @Test
    fun zoomInHasNoBoxLimit() {
        val t = EditMath.fitTransform(100f, 100f, 200f, 200f)
        val crop = EditRect(80f, 80f, 120f, 120f)
        val r = EditMath.zoomPanKeepBox(t, crop, 100f, 50f, 50f, 0f, 0f, 100f, 100f, 200f, 200f, MIN_VIS)
        assertEquals(0.5f * EditMath.MAX_ZOOM, r.transform.scale, EPS)
        screenBox(t, crop).zip(screenBox(r.transform, r.crop)).forEach { (a, b) -> assertEquals(a, b, EPS) }
    }

    /** 纯平移：框屏幕位置不变，图至少留最小可见量 */
    @Test
    fun panKeepsMinVisible() {
        val t = ViewTransform(1f, 0f, 0f)
        val far = EditMath.zoomPanKeepBox(t, EditRect(10f, 10f, 50f, 50f), 1f, 0f, 0f, 9999f, 9999f, 100f, 100f, 200f, 200f, MIN_VIS)
        assertEquals(100f - MIN_VIS, far.transform.tx, EPS)
        assertEquals(100f - MIN_VIS, far.transform.ty, EPS)
        val back = EditMath.zoomPanKeepBox(t, EditRect(10f, 10f, 50f, 50f), 1f, 0f, 0f, -9999f, -9999f, 100f, 100f, 200f, 200f, MIN_VIS)
        assertEquals(MIN_VIS - 200f, back.transform.tx, EPS)
        screenBox(t, EditRect(10f, 10f, 50f, 50f)).zip(screenBox(far.transform, far.crop)).forEach { (a, b) -> assertEquals(a, b, EPS) }
    }

    /** 单轴最小可见：图比最小可见量还小时留整张 */
    @Test
    fun clampVisibleAxisCases() {
        assertEquals(80f, EditMath.clampVisibleAxis(500f, 100f, 100f, 20f), EPS)
        assertEquals(-80f, EditMath.clampVisibleAxis(-500f, 100f, 100f, 20f), EPS)
        assertEquals(30f, EditMath.clampVisibleAxis(30f, 100f, 100f, 20f), EPS)
        assertEquals(90f, EditMath.clampVisibleAxis(500f, 10f, 100f, 20f), EPS)
    }

    /** 拖框限制在画布（可见范围）内，可超出图片 */
    @Test
    fun dragStaysInViewBounds() {
        // 缩小后图像坐标范围比图大：画布对应 -100..300
        val bounds = EditRect(-100f, -100f, 300f, 300f)
        val s = EditRect(0f, 0f, 200f, 200f)
        assertRect(EditRect(-100f, 0f, 200f, 200f), EditMath.dragCrop(s, CropHandle.LEFT, -500f, 0f, 200f, 200f, bounds = bounds))
        assertRect(EditRect(0f, 0f, 300f, 200f), EditMath.dragCrop(s, CropHandle.RIGHT, 500f, 0f, 200f, 200f, bounds = bounds))
        assertRect(EditRect(100f, 0f, 300f, 200f), EditMath.dragCrop(s, CropHandle.MOVE, 500f, 0f, 200f, 200f, bounds = bounds))
        val ratio = EditMath.dragCrop(s, CropHandle.BOTTOM_RIGHT, 500f, 500f, 200f, 200f, ratio = 1f, bounds = bounds)
        assertTrue(ratio.right <= 300f + EPS && ratio.bottom <= 300f + EPS)
        assertEquals(1f, ratio.width / ratio.height, EPS)
        // 最小边长仍生效
        assertEquals(32f, EditMath.dragCrop(s, CropHandle.RIGHT, -500f, 0f, 200f, 200f, bounds = bounds).width, EPS)
    }

    /** 导出：框完全在图内，不算超出 */
    @Test
    fun exportInsideNotOutside() {
        val st = EditState(crop = EditRect(0.1f, 0.1f, 0.9f, 0.9f))
        assertTrue(!st.exceedsImage && !st.needsAlpha)
        assertTrue(!EditState(crop = EditRect(-1e-5f, 0f, 1f + 1e-5f, 1f)).exceedsImage)
    }

    /** 导出：框超出图片，需要 alpha；相交区域与偏移正确 */
    @Test
    fun exportOutsideIntersection() {
        val st = EditState(crop = EditRect(-0.25f, 0.5f, 0.75f, 1.5f))
        assertTrue(st.exceedsImage && st.needsAlpha)
        val plan = EditMath.planExport(st.sourceCrop(), 400, 200, 4096, st.exceedsImage)
        assertEquals(-100, plan.boxX)
        assertEquals(100, plan.boxY)
        assertEquals(400, plan.boxW)
        assertEquals(200, plan.boxH)
        assertTrue(plan.outside)
        assertRect(EditRect(0f, 100f, 300f, 200f), plan.intersection(400, 200))
        // 相交区域在输出里的偏移
        val inter = plan.intersection(400, 200)
        assertEquals(100f, inter.left - plan.boxX, EPS)
        assertEquals(0f, inter.top - plan.boxY, EPS)
    }

    /** 导出：旋转后超出的判定与还原到原图坐标一致 */
    @Test
    fun exportOutsideAfterRotate() {
        val st = EditState().apply(EditOp.Crop(EditRect(0f, 0f, 1.5f, 1f))).apply(EditOp.Rotate(true))
        assertTrue(st.exceedsImage)
        val src = st.sourceCrop()
        assertEquals(1.5f, src.height.coerceAtLeast(src.width), EPS)
    }

    /** 导出：框比上限大时按最长边封顶 */
    @Test
    fun exportScaleCapped() {
        val plan = EditMath.planExport(EditRect(-1f, -1f, 3f, 2f), 1000, 1000, 2000, true)
        assertEquals(4000, plan.boxW)
        assertEquals(0.5f, plan.scale, EPS)
        // 没有交集时相交矩形为空
        val none = EditMath.planExport(EditRect(2f, 2f, 3f, 3f), 100, 100, 4096, true).intersection(100, 100)
        assertEquals(0f, none.width, EPS)
    }

    /** 小框：热区被收到短边 1/3，中间仍能整体平移 */
    @Test
    fun hitTestSmallBoxKeepsMove() {
        val r = EditRect(100f, 100f, 130f, 130f)
        assertEquals(CropHandle.MOVE, EditMath.hitTest(r, 115f, 115f, 28f))
        assertEquals(CropHandle.TOP_LEFT, EditMath.hitTest(r, 100f, 100f, 28f))
    }

    private companion object {
        /** 浮点比较容差 */
        const val EPS = 0.001f

        /** 测试用的图最小可见量 */
        const val MIN_VIS = 20f
    }
}
