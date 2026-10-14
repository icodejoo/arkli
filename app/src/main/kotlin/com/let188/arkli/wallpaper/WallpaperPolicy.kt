package com.let188.arkli.wallpaper

import kotlin.math.sqrt

/** 获取失败的原因 */
internal enum class WallpaperFailure(val wire: String) {
    /** 系统出于隐私限制，不让应用读取 */
    RESTRICTED("restricted"),

    /** 设备或当前壁纸类型不支持读取 */
    UNSUPPORTED("unsupported"),

    /** 其他错误 */
    ERROR("error"),
}

/**
 * 壁纸读取的分类与缩放计算，纯函数，可单测。
 *
 * 使用示例：`WallpaperPolicy.sampleSize(8000, 6000)`
 */
internal object WallpaperPolicy {
    /** 像素数上限（2400 万），超过要缩小防 OOM */
    const val MAX_PIXELS = 24_000_000L

    /** 当前壁纸 */
    const val KIND_CURRENT = "current"

    /** 系统默认壁纸 */
    const val KIND_DEFAULT = "default"

    /** 受限版本：API 33 起系统不再把当前壁纸给没有特殊权限的应用 */
    const val SDK_RESTRICTED = 33

    /**
     * 异常归类：SecurityException 算受限，UnsupportedOperationException 算不支持，其余算错误。
     *
     * @param t 读取壁纸时抛出的异常
     * @return 失败原因
     */
    fun classify(t: Throwable): WallpaperFailure = when (t) {
        is SecurityException -> WallpaperFailure.RESTRICTED
        is UnsupportedOperationException -> WallpaperFailure.UNSUPPORTED
        else -> WallpaperFailure.ERROR
    }

    /**
     * 失败原因对应的中文提示。
     *
     * @param f 失败原因
     * @return 一句话说明
     */
    fun message(f: WallpaperFailure): String = when (f) {
        WallpaperFailure.RESTRICTED -> "系统不允许应用读取当前壁纸"
        WallpaperFailure.UNSUPPORTED -> "本机不支持读取壁纸"
        WallpaperFailure.ERROR -> "读取壁纸失败"
    }

    /**
     * 本次读到的壁纸类型：API 33 及以上系统通常只会交出默认壁纸；更低版本按当前壁纸算。
     *
     * @param sdk 当前 API 级别
     * @param fromFile 是否来自壁纸文件（有文件说明确实是当前壁纸）
     * @return [KIND_CURRENT] 或 [KIND_DEFAULT]
     */
    fun kindOf(sdk: Int, fromFile: Boolean): String = if (fromFile || sdk < SDK_RESTRICTED) KIND_CURRENT else KIND_DEFAULT

    /**
     * 超限时的缩放比例。
     *
     * @param width 原宽
     * @param height 原高
     * @param maxPixels 像素数上限
     * @return 不超限返回 1.0，超限返回使像素数不超过上限的比例（0~1）
     */
    fun scaleFor(width: Int, height: Int, maxPixels: Long = MAX_PIXELS): Double {
        val px = width.toLong() * height
        if (px <= maxPixels || px <= 0) return 1.0
        return sqrt(maxPixels.toDouble() / px)
    }

    /**
     * 解码用的采样倍数（2 的幂），保证解码后像素数不超过上限。
     *
     * @param width 原宽
     * @param height 原高
     * @param maxPixels 像素数上限
     * @return 至少为 1
     */
    fun sampleSize(width: Int, height: Int, maxPixels: Long = MAX_PIXELS): Int {
        var s = 1
        while ((width.toLong() / s) * (height.toLong() / s) > maxPixels) s *= 2
        return s
    }
}
