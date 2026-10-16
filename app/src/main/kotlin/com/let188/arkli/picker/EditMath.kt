package com.let188.arkli.picker

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * 矩形（浮点），既用于像素坐标，也用于 0..1 的归一化坐标。
 *
 * @property left 左边
 * @property top 上边
 * @property right 右边
 * @property bottom 下边
 */
data class EditRect(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    /** 宽 */
    val width: Float get() = right - left

    /** 高 */
    val height: Float get() = bottom - top

    /** 中心 x */
    val centerX: Float get() = (left + right) / 2f

    /** 中心 y */
    val centerY: Float get() = (top + bottom) / 2f

    /**
     * 顺时针或逆时针转 90°后的归一化矩形（把 0..1 的画面整体旋转）。
     *
     * @param clockwise true 为顺时针
     * @return 旋转后的归一化矩形
     */
    fun rotated(clockwise: Boolean): EditRect =
        if (clockwise) EditRect(1f - bottom, left, 1f - top, right) else EditRect(top, 1f - right, bottom, 1f - left)

    /**
     * 归一化矩形翻转。
     *
     * @param horizontal true 为左右翻转，false 为上下翻转
     * @return 翻转后的归一化矩形
     */
    fun flipped(horizontal: Boolean): EditRect =
        if (horizontal) EditRect(1f - right, top, 1f - left, bottom) else EditRect(left, 1f - bottom, right, 1f - top)

    /**
     * 把归一化矩形放大到像素坐标。
     *
     * @param w 画面宽（像素）
     * @param h 画面高（像素）
     * @return 像素矩形
     */
    fun scaledBy(w: Float, h: Float): EditRect = EditRect(left * w, top * h, right * w, bottom * h)

    /**
     * 把像素矩形除以画面尺寸，得到归一化矩形。
     *
     * @param w 画面宽（像素）
     * @param h 画面高（像素）
     * @return 归一化矩形
     */
    fun normalizedBy(w: Float, h: Float): EditRect = EditRect(left / w, top / h, right / w, bottom / h)

    companion object {
        /** 整张画面（归一化） */
        val FULL = EditRect(0f, 0f, 1f, 1f)
    }
}

/** 裁剪框上的可拖拽部位 */
enum class CropHandle {
    /** 框内：整体平移 */
    MOVE,

    /** 左边 */
    LEFT,

    /** 上边 */
    TOP,

    /** 右边 */
    RIGHT,

    /** 下边 */
    BOTTOM,

    /** 左上角 */
    TOP_LEFT,

    /** 右上角 */
    TOP_RIGHT,

    /** 左下角 */
    BOTTOM_LEFT,

    /** 右下角 */
    BOTTOM_RIGHT,
}

/**
 * 视图变换：图像像素 → 视图坐标，`v = img * scale + (tx, ty)`。
 *
 * @property scale 缩放倍数
 * @property tx 水平偏移（视图像素）
 * @property ty 垂直偏移（视图像素）
 */
data class ViewTransform(val scale: Float, val tx: Float, val ty: Float)

/**
 * 图片编辑的纯数学：裁剪框约束、坐标映射、缩放平移钳制。全部不依赖 Android 类型，可直接 JVM 单测。
 */
object EditMath {
    /** 相对适配缩放，最多放大的倍数 */
    const val MAX_ZOOM = 8f

    /** 相对适配缩放，最多缩小到的倍数 */
    const val MIN_ZOOM = PickerConst.EDIT_MIN_ZOOM

    /** 裁剪框最小边长（图像像素） */
    const val MIN_CROP_PX = 32f

    /** 判断框是否被图边裁到的容差（图像像素） */
    private const val CLIP_EPS = 0.01f

    /**
     * 计算让整张图刚好放进视图的缩放。
     *
     * @param viewW 视图宽
     * @param viewH 视图高
     * @param imgW 图宽
     * @param imgH 图高
     * @return 适配缩放；任一尺寸非正返回 1
     * @example EditMath.fitScale(1000f, 2000f, 500f, 500f) // 2.0
     */
    fun fitScale(viewW: Float, viewH: Float, imgW: Float, imgH: Float): Float =
        if (viewW <= 0f || viewH <= 0f || imgW <= 0f || imgH <= 0f) 1f else min(viewW / imgW, viewH / imgH)

    /**
     * 居中放置的初始视图变换。
     *
     * @param viewW 视图宽
     * @param viewH 视图高
     * @param imgW 图宽
     * @param imgH 图高
     * @return 适配缩放并居中的变换
     */
    fun fitTransform(viewW: Float, viewH: Float, imgW: Float, imgH: Float): ViewTransform {
        val s = fitScale(viewW, viewH, imgW, imgH)
        return ViewTransform(s, (viewW - imgW * s) / 2f, (viewH - imgH * s) / 2f)
    }

    /**
     * 单轴平移钳制：图随便拖，但至少留 [minVisible] 在视图里（图本身更小就留整张）。
     *
     * @param offset 期望偏移
     * @param scaledSize 缩放后的图尺寸
     * @param viewSize 视图尺寸
     * @param minVisible 至少可见的长度（视图像素）
     * @return 钳制后的偏移
     */
    fun clampVisibleAxis(offset: Float, scaledSize: Float, viewSize: Float, minVisible: Float): Float {
        val m = min(minVisible, scaledSize)
        return offset.coerceIn(m - scaledSize, max(m - scaledSize, viewSize - m))
    }

    /**
     * 钳制整个视图变换：缩放限制在 [fit*MIN_ZOOM, fit*MAX_ZOOM]，平移后图至少留 [minVisible] 在视图内。
     *
     * @param t 待钳制的变换
     * @param viewW 视图宽
     * @param viewH 视图高
     * @param imgW 图宽
     * @param imgH 图高
     * @param minVisible 图至少可见的长度（视图像素）
     * @return 合法变换
     */
    fun clampTransform(t: ViewTransform, viewW: Float, viewH: Float, imgW: Float, imgH: Float, minVisible: Float): ViewTransform {
        val fit = fitScale(viewW, viewH, imgW, imgH)
        val s = t.scale.coerceIn(fit * MIN_ZOOM, fit * MAX_ZOOM)
        return ViewTransform(s, clampVisibleAxis(t.tx, imgW * s, viewW, minVisible), clampVisibleAxis(t.ty, imgH * s, viewH, minVisible))
    }

    /**
     * 以视图上某点为中心缩放，再平移，再钳制。
     *
     * @param t 当前变换
     * @param zoom 本次缩放系数（相对当前）
     * @param px 缩放中心 x（视图坐标）
     * @param py 缩放中心 y（视图坐标）
     * @param panX 额外平移 x（视图像素）
     * @param panY 额外平移 y（视图像素）
     * @param viewW 视图宽
     * @param viewH 视图高
     * @param imgW 图宽
     * @param imgH 图高
     * @param minVisible 图至少可见的长度（视图像素）
     * @return 新变换
     */
    fun zoomPan(
        t: ViewTransform, zoom: Float, px: Float, py: Float, panX: Float, panY: Float,
        viewW: Float, viewH: Float, imgW: Float, imgH: Float, minVisible: Float,
    ): ViewTransform {
        val fit = fitScale(viewW, viewH, imgW, imgH)
        val s = (t.scale * zoom).coerceIn(fit * MIN_ZOOM, fit * MAX_ZOOM)
        val f = s / t.scale
        val moved = ViewTransform(s, px - (px - t.tx) * f + panX, py - (py - t.ty) * f + panY)
        return clampTransform(moved, viewW, viewH, imgW, imgH, minVisible)
    }

    /**
     * 缩放平移的结果：新视图变换，以及按框的屏幕位置重算出的裁剪框。
     *
     * @property transform 新视图变换
     * @property crop 新裁剪框（图像像素）；屏幕位置与大小不变，允许超出图像范围
     */
    data class BoxZoom(val transform: ViewTransform, val crop: EditRect)

    /**
     * 裁剪框固定在屏幕上的缩放平移：只动图片，框的屏幕位置与大小不变，仅把它重新换算成图像坐标（不夹回图内、不收缩）。
     * 缩放范围 [fit*MIN_ZOOM, fit*MAX_ZOOM]，平移后图至少留 [minVisible] 在视图内。
     *
     * @param t 当前变换
     * @param crop 当前裁剪框（图像像素），其屏幕位置即“固定”的位置
     * @param zoom 本次缩放系数（相对当前）
     * @param px 缩放中心 x（视图坐标）
     * @param py 缩放中心 y（视图坐标）
     * @param panX 额外平移 x（视图像素）
     * @param panY 额外平移 y（视图像素）
     * @param viewW 视图宽
     * @param viewH 视图高
     * @param imgW 图宽
     * @param imgH 图高
     * @param minVisible 图至少可见的长度（视图像素）
     * @return 新变换与新裁剪框
     */
    fun zoomPanKeepBox(
        t: ViewTransform, crop: EditRect, zoom: Float, px: Float, py: Float, panX: Float, panY: Float,
        viewW: Float, viewH: Float, imgW: Float, imgH: Float, minVisible: Float,
    ): BoxZoom {
        val (bl, bt) = imageToView(t, crop.left, crop.top)
        val (br, bb) = imageToView(t, crop.right, crop.bottom)
        val nt = zoomPan(t, zoom, px, py, panX, panY, viewW, viewH, imgW, imgH, minVisible)
        val (il, it) = viewToImage(nt, bl, bt)
        val (ir, ib) = viewToImage(nt, br, bb)
        return BoxZoom(nt, EditRect(il, it, ir, ib))
    }

    /**
     * 可见画布在图像坐标里的范围，用作拖框的边界（框不能拖出画布）。
     *
     * @param t 视图变换
     * @param viewW 视图宽
     * @param viewH 视图高
     * @return 图像像素矩形，可能超出图像范围
     */
    fun viewBounds(t: ViewTransform, viewW: Float, viewH: Float): EditRect {
        val (l, tp) = viewToImage(t, 0f, 0f)
        val (r, b) = viewToImage(t, viewW, viewH)
        return EditRect(l, tp, r, b)
    }

    /**
     * 导出方案：框在原图像素里的位置与大小、输出缩放。
     *
     * @property boxX 框左上 x（原图像素，可为负）
     * @property boxY 框左上 y
     * @property boxW 框宽（至少 1）
     * @property boxH 框高（至少 1）
     * @property scale 输出缩放，框最长边超过上限时小于 1
     * @property outside 框是否超出原图（超出部分要填透明）
     */
    data class ExportPlan(val boxX: Int, val boxY: Int, val boxW: Int, val boxH: Int, val scale: Float, val outside: Boolean) {
        /**
         * 框与原图的相交区域（原图像素）；无交集时返回宽高为 0 的矩形。
         *
         * @param srcW 原图宽
         * @param srcH 原图高
         * @return 相交矩形
         */
        fun intersection(srcW: Int, srcH: Int): EditRect {
            val l = max(boxX, 0)
            val t = max(boxY, 0)
            val r = max(l, min(boxX + boxW, srcW))
            val b = max(t, min(boxY + boxH, srcH))
            return EditRect(l.toFloat(), t.toFloat(), r.toFloat(), b.toFloat())
        }
    }

    /**
     * 把原图坐标系下的归一化裁剪框换算成导出方案；相交区域在输出里的偏移 = 相交左上 - (boxX, boxY)。
     *
     * @param c 原图坐标系下的归一化裁剪框，可超出 0..1
     * @param srcW 原图宽（像素）
     * @param srcH 原图高（像素）
     * @param maxEdge 输出最长边上限
     * @param outside 框是否超出图片（由 [EditState.exceedsImage] 给出，保证与输出格式一致）
     * @return 导出方案
     */
    fun planExport(c: EditRect, srcW: Int, srcH: Int, maxEdge: Int, outside: Boolean): ExportPlan {
        val x = Math.round(c.left * srcW)
        val y = Math.round(c.top * srcH)
        val w = max(1, Math.round(c.width * srcW))
        val h = max(1, Math.round(c.height * srcH))
        val scale = if (max(w, h) > maxEdge) maxEdge.toFloat() / max(w, h) else 1f
        return ExportPlan(x, y, w, h, scale, outside)
    }

    /**
     * 视图坐标 → 图像像素坐标。
     *
     * @param t 视图变换
     * @param vx 视图 x
     * @param vy 视图 y
     * @return 图像像素 (x, y)
     */
    fun viewToImage(t: ViewTransform, vx: Float, vy: Float): Pair<Float, Float> = (vx - t.tx) / t.scale to (vy - t.ty) / t.scale

    /**
     * 图像像素坐标 → 视图坐标。
     *
     * @param t 视图变换
     * @param ix 图像 x
     * @param iy 图像 y
     * @return 视图 (x, y)
     */
    fun imageToView(t: ViewTransform, ix: Float, iy: Float): Pair<Float, Float> = ix * t.scale + t.tx to iy * t.scale + t.ty

    /**
     * 把裁剪框限制在图内并保证不小于最小边长。
     *
     * @param r 待约束的矩形
     * @param imgW 图宽
     * @param imgH 图高
     * @param minSize 最小边长
     * @return 合法矩形
     */
    fun clampCrop(r: EditRect, imgW: Float, imgH: Float, minSize: Float = MIN_CROP_PX): EditRect {
        val mw = min(minSize, imgW)
        val mh = min(minSize, imgH)
        val l = r.left.coerceIn(0f, imgW - mw)
        val t = r.top.coerceIn(0f, imgH - mh)
        return EditRect(l, t, r.right.coerceIn(l + mw, imgW), r.bottom.coerceIn(t + mh, imgH))
    }

    /**
     * 选定固定比例：在当前框内取同中心、最大的该比例矩形。
     *
     * @param r 当前裁剪框
     * @param ratio 宽/高；null 表示自由，原样返回
     * @param imgW 图宽
     * @param imgH 图高
     * @param minSize 最小边长
     * @param bounds 框允许所在的范围，默认整张图；编辑页传可见画布范围
     * @return 符合比例的新框
     * @example EditMath.applyRatio(EditRect(0f, 0f, 400f, 200f), 1f, 400f, 200f) // 200x200 居中
     */
    fun applyRatio(
        r: EditRect, ratio: Float?, imgW: Float, imgH: Float, minSize: Float = MIN_CROP_PX,
        bounds: EditRect = EditRect(0f, 0f, imgW, imgH),
    ): EditRect {
        if (ratio == null) return r
        val w = max(min(r.width, r.height * ratio), minSize * max(1f, ratio))
        val h = w / ratio
        val l = r.centerX - w / 2f
        val t = r.centerY - h / 2f
        val moved = EditRect(l, t, l + w, t + h)
        return shiftInside(moved, bounds)
    }

    /** 整体平移，使矩形落进边界内（尺寸不变；尺寸超出边界时贴齐左上） */
    private fun shiftInside(r: EditRect, b: EditRect): EditRect {
        val dx = if (r.left < b.left) b.left - r.left else if (r.right > b.right) b.right - r.right else 0f
        val dy = if (r.top < b.top) b.top - r.top else if (r.bottom > b.bottom) b.bottom - r.bottom else 0f
        return EditRect(r.left + dx, r.top + dy, r.right + dx, r.bottom + dy)
    }

    /**
     * 拖拽裁剪框。以拖拽开始时的框为基准、累计位移计算，所以越界后拖回来不会漂移。
     *
     * @param start 拖拽开始时的框（图像像素）
     * @param handle 被拖的部位
     * @param dx 累计 x 位移（图像像素）
     * @param dy 累计 y 位移（图像像素）
     * @param imgW 图宽
     * @param imgH 图高
     * @param ratio 固定宽高比（宽/高），null 为自由
     * @param minSize 最小边长
     * @param bounds 框允许所在的范围，默认整张图；编辑页传可见画布范围，框可因此超出图片
     * @return 新框
     */
    fun dragCrop(
        start: EditRect, handle: CropHandle, dx: Float, dy: Float, imgW: Float, imgH: Float,
        ratio: Float? = null, minSize: Float = MIN_CROP_PX, bounds: EditRect = EditRect(0f, 0f, imgW, imgH),
    ): EditRect {
        if (handle == CropHandle.MOVE) {
            val l = (start.left + dx).coerceIn(bounds.left, max(bounds.left, bounds.right - start.width))
            val t = (start.top + dy).coerceIn(bounds.top, max(bounds.top, bounds.bottom - start.height))
            return EditRect(l, t, l + start.width, t + start.height)
        }
        return if (ratio == null) dragFree(start, handle, dx, dy, bounds, minSize)
        else dragRatio(start, handle, dx, dy, bounds, ratio, minSize)
    }

    /** 自由比例：各边独立移动 */
    private fun dragFree(s: EditRect, h: CropHandle, dx: Float, dy: Float, bd: EditRect, minSize: Float): EditRect {
        val mw = min(minSize, bd.width)
        val mh = min(minSize, bd.height)
        var l = s.left
        var t = s.top
        var r = s.right
        var b = s.bottom
        if (h.movesLeft()) l = (s.left + dx).coerceIn(bd.left, s.right - mw)
        if (h.movesRight()) r = (s.right + dx).coerceIn(s.left + mw, bd.right)
        if (h.movesTop()) t = (s.top + dy).coerceIn(bd.top, s.bottom - mh)
        if (h.movesBottom()) b = (s.bottom + dy).coerceIn(s.top + mh, bd.bottom)
        return EditRect(l, t, r, b)
    }

    /** 固定比例：角以对角为锚；边以对边为锚、另一维居中伸缩 */
    private fun dragRatio(s: EditRect, h: CropHandle, dx: Float, dy: Float, bd: EditRect, ratio: Float, minSize: Float): EditRect {
        val minW = minSize * max(1f, ratio)
        val horizontalEdge = h == CropHandle.LEFT || h == CropHandle.RIGHT
        val verticalEdge = h == CropHandle.TOP || h == CropHandle.BOTTOM
        if (horizontalEdge) {
            val right = h == CropHandle.RIGHT
            val ax = if (right) s.left else s.right
            val rawW = abs((if (right) s.right else s.left) + dx - ax)
            val room = if (right) bd.right - ax else ax - bd.left
            val vRoom = 2f * min(s.centerY - bd.top, bd.bottom - s.centerY) * ratio
            val w = rawW.coerceAtMost(min(room, vRoom)).coerceAtLeast(minW)
            val hh = w / ratio
            return if (right) EditRect(ax, s.centerY - hh / 2f, ax + w, s.centerY + hh / 2f)
            else EditRect(ax - w, s.centerY - hh / 2f, ax, s.centerY + hh / 2f)
        }
        if (verticalEdge) {
            val bottom = h == CropHandle.BOTTOM
            val ay = if (bottom) s.top else s.bottom
            val rawH = abs((if (bottom) s.bottom else s.top) + dy - ay)
            val room = if (bottom) bd.bottom - ay else ay - bd.top
            val hRoom = 2f * min(s.centerX - bd.left, bd.right - s.centerX) / ratio
            val hh = rawH.coerceAtMost(min(room, hRoom)).coerceAtLeast(minW / ratio)
            val w = hh * ratio
            return if (bottom) EditRect(s.centerX - w / 2f, ay, s.centerX + w / 2f, ay + hh)
            else EditRect(s.centerX - w / 2f, ay - hh, s.centerX + w / 2f, ay)
        }
        // 角：锚点是对角
        val toRight = h.movesRight()
        val toBottom = h.movesBottom()
        val ax = if (toRight) s.left else s.right
        val ay = if (toBottom) s.top else s.bottom
        val px = (if (toRight) s.right else s.left) + dx
        val py = (if (toBottom) s.bottom else s.top) + dy
        val maxW = min(if (toRight) bd.right - ax else ax - bd.left, (if (toBottom) bd.bottom - ay else ay - bd.top) * ratio)
        val w = max(abs(px - ax), abs(py - ay) * ratio).coerceAtMost(maxW).coerceAtLeast(minW)
        val hh = w / ratio
        val l = if (toRight) ax else ax - w
        val t = if (toBottom) ay else ay - hh
        return EditRect(l, t, l + w, t + hh)
    }

    /**
     * 判断一次按下落在裁剪框的哪个部位。角优先，其次边，再次框内。
     *
     * @param r 裁剪框（图像像素）
     * @param x 按下点 x（图像像素）
     * @param y 按下点 y（图像像素）
     * @param slopRaw 命中半径（图像像素，调用方用“触摸半径 / 缩放”换算；框很小时会被收小）
     * @return 命中的部位；框外且不靠近任何边返回 null
     */
    fun hitTest(r: EditRect, x: Float, y: Float, slopRaw: Float): CropHandle? {
        // 框很小时热区上限取短边的 1/3，给框内“整体平移”留出中间一段，边与边不互相吞没
        val slop = min(slopRaw, min(r.width, r.height) / 3f)
        val nearL = abs(x - r.left) <= slop
        val nearR = abs(x - r.right) <= slop
        val nearT = abs(y - r.top) <= slop
        val nearB = abs(y - r.bottom) <= slop
        val inX = x >= r.left - slop && x <= r.right + slop
        val inY = y >= r.top - slop && y <= r.bottom + slop
        return when {
            nearL && nearT -> CropHandle.TOP_LEFT
            nearR && nearT -> CropHandle.TOP_RIGHT
            nearL && nearB -> CropHandle.BOTTOM_LEFT
            nearR && nearB -> CropHandle.BOTTOM_RIGHT
            nearL && inY -> CropHandle.LEFT
            nearR && inY -> CropHandle.RIGHT
            nearT && inX -> CropHandle.TOP
            nearB && inX -> CropHandle.BOTTOM
            x > r.left && x < r.right && y > r.top && y < r.bottom -> CropHandle.MOVE
            else -> null
        }
    }

    /** 是否会移动左边 */
    private fun CropHandle.movesLeft() = this == CropHandle.LEFT || this == CropHandle.TOP_LEFT || this == CropHandle.BOTTOM_LEFT

    /** 是否会移动右边 */
    private fun CropHandle.movesRight() = this == CropHandle.RIGHT || this == CropHandle.TOP_RIGHT || this == CropHandle.BOTTOM_RIGHT

    /** 是否会移动上边 */
    private fun CropHandle.movesTop() = this == CropHandle.TOP || this == CropHandle.TOP_LEFT || this == CropHandle.TOP_RIGHT

    /** 是否会移动下边 */
    private fun CropHandle.movesBottom() = this == CropHandle.BOTTOM || this == CropHandle.BOTTOM_LEFT || this == CropHandle.BOTTOM_RIGHT

    /**
     * 限制导出尺寸：最长边超过上限时给出 2 的幂采样倍数。
     *
     * @param w 原图宽
     * @param h 原图高
     * @param maxEdge 允许的最长边
     * @return 采样倍数（1、2、4…）
     * @example EditMath.exportSample(8000, 6000, 4096) // 2
     */
    fun exportSample(w: Int, h: Int, maxEdge: Int): Int {
        var s = 1
        while (max(w, h) / s > maxEdge) s *= 2
        return s
    }
}

/** 一步编辑操作；后续要加画笔、马赛克，往这里追加子类型即可 */
sealed interface EditOp {
    /**
     * 裁剪：把裁剪框设为给定矩形。
     *
     * @property rect 当前画面坐标系下的归一化矩形
     */
    data class Crop(val rect: EditRect) : EditOp

    /**
     * 旋转 90°。
     *
     * @property clockwise true 为顺时针
     */
    data class Rotate(val clockwise: Boolean) : EditOp

    /**
     * 翻转。
     *
     * @property horizontal true 为左右翻转，false 为上下翻转
     */
    data class Flip(val horizontal: Boolean) : EditOp

    /**
     * 选预设形状：清掉手绘套索；圆形这类强制比例的形状同时给出调整后的裁剪框，保证一步撤销到位。
     *
     * @property shape 形状，[EditShape.RECT] 即回到普通矩形裁剪
     * @property crop 随形状一起设置的归一化裁剪框；null 表示不动
     */
    data class Shape(val shape: EditShape, val crop: EditRect? = null) : EditOp

    /**
     * 手绘套索：轮廓内保留、外部透明；传 null 清除套索。
     *
     * @property points 当前画面坐标系下的归一化闭合多边形顶点
     */
    data class Lasso(val points: List<EditPoint>?) : EditOp
}

/**
 * 操作累积后的结果状态：先把原图顺时针转 [turns] 个 90°，再按 [flipH] 左右镜像，最后按 [crop]（或套索外接框）裁剪，再按形状/套索抠图。
 * 套索与预设形状互斥：设套索会把形状复位成矩形，选形状或改裁剪框会清掉套索。
 *
 * @property turns 顺时针 90° 的次数，0..3
 * @property flipH 转完之后是否左右镜像
 * @property crop 最终画面坐标系下的归一化裁剪框
 * @property shape 预设裁剪形状
 * @property lasso 最终画面坐标系下的归一化套索顶点；null 表示没有
 */
data class EditState(
    val turns: Int = 0,
    val flipH: Boolean = false,
    val crop: EditRect = EditRect.FULL,
    val shape: EditShape = EditShape.RECT,
    val lasso: List<EditPoint>? = null,
) {
    /** 当前是否等同于没编辑 */
    val isIdentity: Boolean get() = turns == 0 && !flipH && crop == EditRect.FULL && shape == EditShape.RECT && lasso == null

    /** 宽高是否因旋转而互换 */
    val swapsSize: Boolean get() = turns % 2 != 0

    /** 结果是否带透明区域（有形状或套索），带透明必须输出 PNG */
    val needsAlpha: Boolean get() = shape != EditShape.RECT || lasso != null || exceedsImage

    /** 裁剪框是否有部分超出图片（超出部分导出为透明）；容差内的浮点误差不算 */
    val exceedsImage: Boolean
        get() = effectiveCrop.let { it.left < -EXCEED_EPS || it.top < -EXCEED_EPS || it.right > 1f + EXCEED_EPS || it.bottom > 1f + EXCEED_EPS }

    /** 实际生效的裁剪框：有套索取套索外接框，否则取 [crop]（最终画面坐标系，归一化） */
    val effectiveCrop: EditRect
        get() = lasso?.let { l -> EditShapes.bounds(l).let { b -> EditRect(b.left.coerceIn(0f, 1f), b.top.coerceIn(0f, 1f), b.right.coerceIn(0f, 1f), b.bottom.coerceIn(0f, 1f)) } } ?: crop

    /**
     * 叠加一步操作，裁剪框和套索跟着画面一起变换。
     *
     * @param op 操作
     * @return 新状态
     */
    fun apply(op: EditOp): EditState = when (op) {
        is EditOp.Crop -> copy(crop = op.rect, lasso = null)
        // 镜像状态下再转 90°，等价于反方向转
        is EditOp.Rotate -> {
            val step = if (op.clockwise != flipH) 1 else -1
            copy(turns = Math.floorMod(turns + step, TURNS), crop = crop.rotated(op.clockwise), lasso = lasso?.map { it.rotated(op.clockwise) })
        }
        is EditOp.Flip ->
            if (op.horizontal) copy(flipH = !flipH, crop = crop.flipped(true), lasso = lasso?.map { it.flipped(true) })
            // 上下翻转 = 左右镜像 + 转 180°
            else copy(turns = (turns + 2) % TURNS, flipH = !flipH, crop = crop.flipped(false), lasso = lasso?.map { it.flipped(false) })
        is EditOp.Shape -> copy(shape = op.shape, crop = op.crop ?: crop, lasso = null)
        is EditOp.Lasso -> copy(shape = EditShape.RECT, lasso = op.points)
    }

    /**
     * 把最终画面的裁剪区域还原回原图坐标系，导出时据此从原图直接取区域。
     *
     * @return 原图坐标系下的归一化矩形
     */
    fun sourceCrop(): EditRect {
        var r = if (flipH) effectiveCrop.flipped(true) else effectiveCrop
        repeat(turns) { r = r.rotated(false) }
        return r
    }

    private companion object {
        /** 一圈的 90° 份数 */
        const val TURNS = 4

        /** 判断框超出图片的归一化容差，吸收重算坐标的浮点误差 */
        const val EXCEED_EPS = 5e-4f
    }
}

/**
 * 可撤销的操作栈，不可变。最多保留 [MAX_STEPS] 步，更早的会折进基础状态（不能再撤销）。
 *
 * @property base 栈底之前已固化的状态
 * @property ops 保留的操作，按时间先后
 *
 * 使用示例：`val s = EditOps().push(EditOp.Rotate(true)).push(EditOp.Flip(true)).undo().state`
 */
data class EditOps(val base: EditState = EditState(), val ops: List<EditOp> = emptyList()) {
    /** 叠加所有操作后的当前状态 */
    val state: EditState get() = ops.fold(base) { s, op -> s.apply(op) }

    /** 是否还能撤销 */
    val canUndo: Boolean get() = ops.isNotEmpty()

    /**
     * 追加一步；超过上限时最老的一步折进 [base]。
     *
     * @param op 新操作
     * @return 新栈
     */
    fun push(op: EditOp): EditOps {
        if (ops.size < MAX_STEPS) return copy(ops = ops + op)
        return EditOps(base.apply(ops.first()), ops.drop(1) + op)
    }

    /**
     * 撤销最近一步。
     *
     * @return 新栈；没有可撤销的步骤时原样返回
     */
    fun undo(): EditOps = if (ops.isEmpty()) this else copy(ops = ops.dropLast(1))

    /**
     * 清空全部操作回到原图。
     *
     * @return 空栈
     */
    fun reset(): EditOps = EditOps()

    companion object {
        /** 栈最多保留的步数 */
        const val MAX_STEPS = 20
    }
}
