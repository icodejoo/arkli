package com.let188.arkli.image

import java.io.ByteArrayInputStream
import java.util.Random

/** 单测用样本图与读回工具 */
object Samples {
    /** 纯色图 */
    fun solid(w: Int, h: Int, argb: Int): IntArray = IntArray(w * h) { argb }

    /** 灰度水平渐变（不透明） */
    fun gradient(w: Int, h: Int): IntArray = IntArray(w * h) { i ->
        val v = (i % w) * 255 / (w - 1).coerceAtLeast(1)
        (0xFF shl 24) or (v shl 16) or (v shl 8) or v
    }

    /** 彩色斜向渐变（不透明） */
    fun colorGradient(w: Int, h: Int): IntArray = IntArray(w * h) { i ->
        val x = i % w
        val y = i / w
        val r = x * 255 / (w - 1).coerceAtLeast(1)
        val g = y * 255 / (h - 1).coerceAtLeast(1)
        val b = (x + y) * 255 / (w + h - 2).coerceAtLeast(1)
        (0xFF shl 24) or (r shl 16) or (g shl 8) or b
    }

    /** 带透明背景的图标样图：透明底 + 实心圆 + 半透明描边 */
    fun icon(n: Int): IntArray = IntArray(n * n) { i ->
        val x = i % n - n / 2
        val y = i / n - n / 2
        val d = Math.sqrt((x * x + y * y).toDouble())
        when {
            d < n * 0.30 -> 0xFFE53935.toInt()
            d < n * 0.36 -> 0x80E53935.toInt()
            d < n * 0.42 -> 0xFF1E88E5.toInt()
            else -> 0
        }
    }

    /** 类照片：彩色斜向渐变叠加 +-8 的轻微噪声（不透明），颜色很多但相邻像素相近 */
    fun photoLike(w: Int, h: Int, seed: Long = 3): IntArray {
        val r = Random(seed)
        val base = colorGradient(w, h)
        fun jitter(v: Int) = (v + r.nextInt(17) - 8).coerceIn(0, 255)
        return IntArray(w * h) { i ->
            val c = base[i]
            (0xFF shl 24) or (jitter((c shr 16) and 0xFF) shl 16) or (jitter((c shr 8) and 0xFF) shl 8) or jitter(c and 0xFF)
        }
    }

    /** 随机噪声（不透明） */
    fun noise(w: Int, h: Int, seed: Long = 1): IntArray {
        val r = Random(seed)
        return IntArray(w * h) { (0xFF shl 24) or (r.nextInt() and 0xFFFFFF) }
    }

    /** 随机 ARGB（含各种 alpha） */
    fun randomArgb(w: Int, h: Int, seed: Long = 2): IntArray {
        val r = Random(seed)
        return IntArray(w * h) { r.nextInt() }
    }

    /**
     * 用 ImageIO 读回 PNG，返回宽、高、ARGB 像素。
     * Android 单测的编译类路径看不到 java.awt，这里用反射调（运行时的 JDK 有 java.desktop）。
     */
    fun readBack(png: ByteArray): Triple<Int, Int, IntArray> {
        val io = Class.forName("javax.imageio.ImageIO")
        val img = io.getMethod("read", java.io.InputStream::class.java).invoke(null, ByteArrayInputStream(png))
            ?: error("ImageIO 读不出 PNG")
        val cls = img.javaClass
        val w = cls.getMethod("getWidth").invoke(img) as Int
        val h = cls.getMethod("getHeight").invoke(img) as Int
        val px = IntArray(w * h)
        val m = cls.getMethod(
            "getRGB", Int::class.java, Int::class.java, Int::class.java, Int::class.java,
            IntArray::class.java, Int::class.java, Int::class.java,
        )
        m.invoke(img, 0, 0, w, h, px, 0, w)
        return Triple(w, h, px)
    }

    /** PNG 头里的位深（文件偏移 24） */
    fun bitDepth(png: ByteArray): Int = png[24].toInt()

    /** PNG 头里的颜色类型（文件偏移 25） */
    fun colorType(png: ByteArray): Int = png[25].toInt()
}
