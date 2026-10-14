package com.let188.arkli.preview

import kotlin.math.max
import kotlin.math.min

/** 预览页的常量 */
internal object PreviewConst {
    /** 最多一次预览的张数 */
    const val MAX_ITEMS = 50

    /** 意图参数：图片绝对路径列表 */
    const val EXTRA_PATHS = "paths"

    /** 意图参数：起始下标 */
    const val EXTRA_INDEX = "index"

    /** 底图长边上限（像素），低于常见 GPU 纹理上限 */
    const val BASE_MAX_SIDE = 4096

    /** 底图总像素上限，约 64MB（ARGB） */
    const val BASE_MAX_PIXELS = 16_000_000

    /** 缩放到刚好铺满之外，最少允许放大到的倍数 */
    const val MIN_MAX_SCALE = 4f

    /** 在“适应宽度”之上再允许放大的倍数 */
    const val OVER_FIT_WIDTH = 3f

    /** 双击放大的默认倍数（图片本身不细长时） */
    const val DOUBLE_TAP_SCALE = 2.5f

    /** 超过该比例视为细长图，双击直接放到适应宽度 */
    const val TALL_FIT_RATIO = 1.3f

    /** 判定为“已放大”的下限 */
    const val ZOOMED_EPS = 1.05f

    /** 手势停下后多久再解高清局部（毫秒） */
    const val DETAIL_DEBOUNCE_MS = 150L

    /** 高清局部在可见区域外各多解的比例，减少拖动时的露底 */
    const val DETAIL_MARGIN = 0.25f
}

/** 整数矩形（图片像素坐标），不依赖 android，便于单测 */
internal data class RectI(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    /** 宽 */
    val width: Int get() = right - left

    /** 高 */
    val height: Int get() = bottom - top
}

/** 适应屏幕后图片的显示尺寸（像素） */
internal data class FitSize(val w: Float, val h: Float)

/** 缩放与平移的纯计算 */
internal object ZoomMath {
    /**
     * 图片等比缩放到刚好放进容器的显示尺寸。
     *
     * @param imgW 图片宽
     * @param imgH 图片高
     * @param boxW 容器宽
     * @param boxH 容器高
     * @return 显示尺寸
     */
    fun fit(imgW: Int, imgH: Int, boxW: Float, boxH: Float): FitSize {
        val s = min(boxW / imgW, boxH / imgH)
        return FitSize(imgW * s, imgH * s)
    }

    /**
     * 允许放大的上限：至少 4 倍，细长图在“适应宽度”之上再放大 3 倍。
     *
     * @param fit 适应后的显示尺寸
     * @param boxW 容器宽
     */
    fun maxScale(fit: FitSize, boxW: Float): Float = max(PreviewConst.MIN_MAX_SCALE, boxW / fit.w * PreviewConst.OVER_FIT_WIDTH)

    /**
     * 双击要去的倍数：已放大则回到 1；否则细长图放到适应宽度，普通图放大到默认倍数。
     *
     * @param scale 当前倍数
     * @param fit 适应后的显示尺寸
     * @param boxW 容器宽
     */
    fun doubleTapTarget(scale: Float, fit: FitSize, boxW: Float): Float {
        if (scale > PreviewConst.ZOOMED_EPS) return 1f
        val fitWidth = boxW / fit.w
        return if (fitWidth > PreviewConst.TALL_FIT_RATIO) fitWidth else PreviewConst.DOUBLE_TAP_SCALE
    }

    /**
     * 把平移量限制在图片不露出空白的范围内（图片比容器小的轴固定居中）。
     *
     * @param offset 平移量
     * @param scale 当前倍数
     * @param content 该轴上图片的适应尺寸
     * @param box 该轴上容器尺寸
     */
    fun clampOffset(offset: Float, scale: Float, content: Float, box: Float): Float {
        val half = max(0f, (content * scale - box) / 2f)
        return offset.coerceIn(-half, half)
    }

    /**
     * 以手指中心为不动点缩放后的新平移量（坐标系原点在容器中心）。
     *
     * @param offset 缩放前的平移量
     * @param centroid 手指中心相对容器中心的坐标
     * @param zoom 本次缩放系数
     */
    fun zoomAbout(offset: Float, centroid: Float, zoom: Float): Float = (offset - centroid) * zoom + centroid

    /**
     * 当前可见区域对应的图片像素矩形，向外扩 [margin] 比例并夹在图片范围内。
     *
     * @param imgW 图片宽（像素）
     * @param imgH 图片高（像素）
     * @param fit 适应后的显示尺寸
     * @param scale 当前倍数
     * @param ox 横向平移
     * @param oy 纵向平移
     * @param boxW 容器宽
     * @param boxH 容器高
     * @param margin 外扩比例
     * @return 要解码的矩形；与图片没有交集时返回 null
     */
    fun visibleRect(
        imgW: Int, imgH: Int, fit: FitSize, scale: Float, ox: Float, oy: Float, boxW: Float, boxH: Float, margin: Float,
    ): RectI? {
        // 容器两端换算到“适应图”坐标（原点在图中心）
        val qx0 = (-boxW / 2f - ox) / scale
        val qx1 = (boxW / 2f - ox) / scale
        val qy0 = (-boxH / 2f - oy) / scale
        val qy1 = (boxH / 2f - oy) / scale
        val mx = (qx1 - qx0) * margin
        val my = (qy1 - qy0) * margin
        val l = ((qx0 - mx + fit.w / 2f) / fit.w * imgW).toInt().coerceIn(0, imgW)
        val r = ((qx1 + mx + fit.w / 2f) / fit.w * imgW).toInt().coerceIn(0, imgW)
        val t = ((qy0 - my + fit.h / 2f) / fit.h * imgH).toInt().coerceIn(0, imgH)
        val b = ((qy1 + my + fit.h / 2f) / fit.h * imgH).toInt().coerceIn(0, imgH)
        return if (r > l && b > t) RectI(l, t, r, b) else null
    }

    /**
     * 局部解码的采样倍数（2 的幂）：解出来的像素与屏幕大致 1:1，不多解。
     *
     * @param rectW 区域宽（图片像素）
     * @param boxW 容器宽（屏幕像素）
     */
    fun detailSample(rectW: Int, boxW: Float): Int {
        var s = 1
        while (rectW / (s * 2) >= boxW) s *= 2
        return s
    }

    /**
     * 底图的采样倍数（2 的幂）：长边不超过 [PreviewConst.BASE_MAX_SIDE]，总像素不超过 [PreviewConst.BASE_MAX_PIXELS]。
     *
     * @param w 图片宽
     * @param h 图片高
     */
    fun baseSample(w: Int, h: Int): Int {
        var s = 1
        while (max(w, h) / s > PreviewConst.BASE_MAX_SIDE || w.toLong() / s * (h / s) > PreviewConst.BASE_MAX_PIXELS) s *= 2
        return s
    }
}
