package com.let188.arkli.picker

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 二维点（浮点），既用于像素坐标，也用于 0..1 的归一化坐标。
 *
 * @property x 横坐标
 * @property y 纵坐标
 */
data class EditPoint(val x: Float, val y: Float) {
    /**
     * 把 0..1 的画面整体转 90° 后的归一化点。
     *
     * @param clockwise true 为顺时针
     * @return 旋转后的点
     */
    fun rotated(clockwise: Boolean): EditPoint = if (clockwise) EditPoint(1f - y, x) else EditPoint(y, 1f - x)

    /**
     * 归一化点翻转。
     *
     * @param horizontal true 为左右翻转，false 为上下翻转
     * @return 翻转后的点
     */
    fun flipped(horizontal: Boolean): EditPoint = if (horizontal) EditPoint(1f - x, y) else EditPoint(x, 1f - y)

    /**
     * 归一化点放大到像素坐标。
     *
     * @param w 画面宽（像素）
     * @param h 画面高（像素）
     * @return 像素点
     */
    fun scaledBy(w: Float, h: Float): EditPoint = EditPoint(x * w, y * h)

    /**
     * 像素点除以画面尺寸，得到归一化点。
     *
     * @param w 画面宽（像素）
     * @param h 画面高（像素）
     * @return 归一化点
     */
    fun normalizedBy(w: Float, h: Float): EditPoint = EditPoint(x / w, y / h)
}

/**
 * 预设裁剪形状：只决定裁剪框的遮罩轮廓，框的拖拽缩放仍是矩形那一套。
 *
 * @property key 稳定标识
 * @property label 界面显示名
 * @property ratio 强制的宽/高比；null 表示不强制
 */
enum class EditShape(val key: String, val label: String, val ratio: Float? = null) {
    /** 矩形（默认，不抠形状，输出 JPEG） */
    RECT("rect", "矩形"),

    /** 圆形：强制 1:1 */
    CIRCLE("circle", "圆形", 1f),

    /** 椭圆 */
    ELLIPSE("ellipse", "椭圆"),

    /** 圆角矩形 */
    ROUNDED("rounded", "圆角"),

    /** 心形 */
    HEART("heart", "心形"),

    /** 五角星 */
    STAR("star", "星形"),

    /** 六边形 */
    HEXAGON("hexagon", "六边形"),
}

/**
 * 形状轮廓与手绘套索的纯几何：不依赖 Android 类型，可直接 JVM 单测。
 */
object EditShapes {
    /** 圆与椭圆的折线段数 */
    const val ELLIPSE_SEGMENTS = 72

    /** 圆角矩形的圆角半径占短边的比例 */
    const val ROUNDED_RADIUS_RATIO = 0.2f

    /** 圆角矩形每个角的折线段数 */
    const val ROUNDED_CORNER_SEGMENTS = 10

    /** 心形参数曲线的采样点数 */
    const val HEART_SEGMENTS = 96

    /** 五角星顶点数（外 5 内 5） */
    const val STAR_VERTICES = 10

    /** 五角星内外半径比（正五角星） */
    const val STAR_INNER_RATIO = 0.382f

    /** 六边形顶点数 */
    const val HEX_VERTICES = 6

    /** 套索抽稀的容差（图像像素） */
    const val LASSO_EPSILON_PX = 2.5f

    /** 套索抽稀后最多保留的点数 */
    const val LASSO_MAX_POINTS = 240

    /** 套索围出的最小面积（图像像素平方），再小当作误触 */
    const val LASSO_MIN_AREA_PX = 256f

    /** 一圈弧度 */
    private const val TAU = (2.0 * PI).toFloat()

    /** 心形参数曲线的横向系数 */
    private const val HEART_X = 16f

    /**
     * 形状的轮廓折线（闭合，首尾不重复）。
     *
     * @param shape 形状
     * @param r 裁剪框
     * @return 轮廓点序列
     * @example EditShapes.outline(EditShape.RECT, EditRect(0f, 0f, 10f, 10f)).size // 4
     */
    fun outline(shape: EditShape, r: EditRect): List<EditPoint> = when (shape) {
        EditShape.RECT -> listOf(EditPoint(r.left, r.top), EditPoint(r.right, r.top), EditPoint(r.right, r.bottom), EditPoint(r.left, r.bottom))
        // 圆在非正方形框里取内切最大圆，保证始终是正圆
        EditShape.CIRCLE -> {
            val d = min(r.width, r.height)
            ellipse(EditRect(r.centerX - d / 2f, r.centerY - d / 2f, r.centerX + d / 2f, r.centerY + d / 2f))
        }
        EditShape.ELLIPSE -> ellipse(r)
        EditShape.ROUNDED -> rounded(r)
        EditShape.HEART -> fit(heartRaw(), r)
        EditShape.STAR -> fit(starRaw(), r)
        EditShape.HEXAGON -> fit(hexagonRaw(), r)
    }

    /**
     * 点是否落在形状内（边界上不保证）。
     *
     * @param shape 形状
     * @param r 裁剪框
     * @param x 点 x
     * @param y 点 y
     * @return 在形状内为 true
     */
    fun contains(shape: EditShape, r: EditRect, x: Float, y: Float): Boolean =
        if (shape == EditShape.RECT) x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
        else inPolygon(outline(shape, r), x, y)

    /**
     * 射线法判断点是否在多边形内。
     *
     * @param poly 多边形顶点（隐含闭合）
     * @param x 点 x
     * @param y 点 y
     * @return 在内部为 true
     */
    fun inPolygon(poly: List<EditPoint>, x: Float, y: Float): Boolean {
        var inside = false
        var j = poly.size - 1
        for (i in poly.indices) {
            val a = poly[i]
            val b = poly[j]
            if ((a.y > y) != (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside
            j = i
        }
        return inside
    }

    /**
     * 导出时要抠出的多边形（落在裁剪结果图自身的像素坐标里）。
     *
     * @param state 编辑状态
     * @param w 裁剪结果图宽（像素）
     * @param h 裁剪结果图高（像素）
     * @return 抠图多边形；矩形裁剪（不需要抠）返回 null
     */
    fun maskPolygon(state: EditState, w: Float, h: Float): List<EditPoint>? {
        val lasso = state.lasso
        if (lasso != null) {
            val c = state.effectiveCrop
            val cw = max(c.width, Float.MIN_VALUE)
            val ch = max(c.height, Float.MIN_VALUE)
            return lasso.map { EditPoint((it.x - c.left) / cw * w, (it.y - c.top) / ch * h) }
        }
        return if (state.shape == EditShape.RECT) null else outline(state.shape, EditRect(0f, 0f, w, h))
    }

    /** 内切椭圆折线 */
    private fun ellipse(r: EditRect): List<EditPoint> = List(ELLIPSE_SEGMENTS) {
        val a = TAU * it / ELLIPSE_SEGMENTS
        EditPoint(r.centerX + r.width / 2f * cos(a), r.centerY + r.height / 2f * sin(a))
    }

    /** 圆角矩形折线：四个角各一段圆弧，半径为短边的一定比例 */
    private fun rounded(r: EditRect): List<EditPoint> {
        val rad = min(r.width, r.height) * ROUNDED_RADIUS_RATIO
        // 每个角：圆心与起始象限序号（屏幕坐标系里 0 为右、1 为下、2 为左、3 为上）
        val corners = listOf(
            EditPoint(r.right - rad, r.top + rad) to 3,
            EditPoint(r.right - rad, r.bottom - rad) to 0,
            EditPoint(r.left + rad, r.bottom - rad) to 1,
            EditPoint(r.left + rad, r.top + rad) to 2,
        )
        return corners.flatMap { (c, q) ->
            List(ROUNDED_CORNER_SEGMENTS + 1) {
                val a = TAU / 4f * (q + it.toFloat() / ROUNDED_CORNER_SEGMENTS)
                EditPoint(c.x + rad * cos(a), c.y + rad * sin(a))
            }
        }
    }

    /** 心形的参数曲线（未归一化，y 已翻成屏幕向下） */
    private fun heartRaw(): List<EditPoint> = List(HEART_SEGMENTS) {
        val t = TAU * it / HEART_SEGMENTS
        val s = sin(t)
        val y = 13f * cos(t) - 5f * cos(2f * t) - 2f * cos(3f * t) - cos(4f * t)
        EditPoint(HEART_X * s * s * s, -y)
    }

    /** 五角星顶点（顶角朝上，未归一化） */
    private fun starRaw(): List<EditPoint> = List(STAR_VERTICES) {
        val a = TAU * it / STAR_VERTICES - TAU / 4f
        val rad = if (it % 2 == 0) 1f else STAR_INNER_RATIO
        EditPoint(rad * cos(a), rad * sin(a))
    }

    /** 六边形顶点（尖角朝上，未归一化） */
    private fun hexagonRaw(): List<EditPoint> = List(HEX_VERTICES) {
        val a = TAU * it / HEX_VERTICES - TAU / 4f
        EditPoint(cos(a), sin(a))
    }

    /** 把任意坐标的点集按外接框拉伸进目标矩形 */
    private fun fit(raw: List<EditPoint>, r: EditRect): List<EditPoint> {
        val minX = raw.minOf { it.x }
        val minY = raw.minOf { it.y }
        val sw = max(raw.maxOf { it.x } - minX, Float.MIN_VALUE)
        val sh = max(raw.maxOf { it.y } - minY, Float.MIN_VALUE)
        return raw.map { EditPoint(r.left + (it.x - minX) / sw * r.width, r.top + (it.y - minY) / sh * r.height) }
    }

    /**
     * 套索收尾：去掉末尾与起点重复的点（闭合由首尾相连隐含）、RDP 抽稀、限制点数；围出的面积太小返回 null。
     *
     * @param raw 手指划过的点（图像像素）
     * @param epsilon 抽稀容差（图像像素）
     * @return 抽稀后的闭合多边形顶点；不足 3 点或面积过小返回 null
     * @example EditShapes.finishLasso(listOf(EditPoint(0f, 0f), EditPoint(100f, 0f), EditPoint(100f, 100f), EditPoint(0f, 100f))) // 4 个点
     */
    fun finishLasso(raw: List<EditPoint>, epsilon: Float = LASSO_EPSILON_PX): List<EditPoint>? {
        val pts = if (raw.size > 1 && raw.last() == raw.first()) raw.dropLast(1) else raw
        if (pts.size < 3) return null
        var eps = epsilon
        var out = simplifyClosed(pts, eps)
        while (out.size > LASSO_MAX_POINTS) {
            eps *= 2f
            out = simplifyClosed(pts, eps)
        }
        return if (out.size < 3 || abs(area(out)) < LASSO_MIN_AREA_PX) null else out
    }

    /** 闭合多边形的 RDP：以首点与离首点最远的点拆成两条链分别抽稀 */
    private fun simplifyClosed(pts: List<EditPoint>, eps: Float): List<EditPoint> {
        val far = (1 until pts.size).maxByOrNull { dist2(pts[0], pts[it]) } ?: return pts
        val a = rdp(pts.subList(0, far + 1), eps)
        val b = rdp(pts.subList(far, pts.size) + pts[0], eps)
        return a.dropLast(1) + b.dropLast(1)
    }

    /** 开放折线的 RDP 抽稀（用显式栈，长折线不会递归过深） */
    private fun rdp(pts: List<EditPoint>, eps: Float): List<EditPoint> {
        if (pts.size < 3) return pts
        val keep = BooleanArray(pts.size)
        keep[0] = true
        keep[pts.lastIndex] = true
        val stack = ArrayDeque<Pair<Int, Int>>()
        stack.add(0 to pts.lastIndex)
        while (stack.isNotEmpty()) {
            val (s, e) = stack.removeLast()
            var worst = -1
            var best = eps
            for (i in s + 1 until e) {
                val d = segDist(pts[i], pts[s], pts[e])
                if (d > best) {
                    best = d
                    worst = i
                }
            }
            if (worst >= 0) {
                keep[worst] = true
                stack.add(s to worst)
                stack.add(worst to e)
            }
        }
        return pts.filterIndexed { i, _ -> keep[i] }
    }

    /** 点到线段的距离 */
    private fun segDist(p: EditPoint, a: EditPoint, b: EditPoint): Float {
        val dx = b.x - a.x
        val dy = b.y - a.y
        val len2 = dx * dx + dy * dy
        if (len2 == 0f) return sqrt(dist2(p, a))
        val t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).coerceIn(0f, 1f)
        return sqrt(dist2(p, EditPoint(a.x + t * dx, a.y + t * dy)))
    }

    /** 两点距离的平方 */
    private fun dist2(a: EditPoint, b: EditPoint): Float = (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)

    /**
     * 多边形有向面积（鞋带公式）。
     *
     * @param poly 顶点
     * @return 面积，顺逆时针决定正负
     */
    fun area(poly: List<EditPoint>): Float {
        var s = 0f
        for (i in poly.indices) {
            val a = poly[i]
            val b = poly[(i + 1) % poly.size]
            s += a.x * b.y - b.x * a.y
        }
        return s / 2f
    }

    /**
     * 点集的外接矩形。
     *
     * @param pts 点集，不能为空
     * @return 外接矩形
     */
    fun bounds(pts: List<EditPoint>): EditRect =
        EditRect(pts.minOf { it.x }, pts.minOf { it.y }, pts.maxOf { it.x }, pts.maxOf { it.y })
}
