package com.let188.arkli.preview

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.ImageDecoder
import android.graphics.Rect
import android.media.ExifInterface
import android.os.Build
import java.io.File

/**
 * 一张待预览的图：整图只解一份缩小的底图，放大后按可见区域再解高清局部，
 * 这样超长拼图（如 1080×20000）也不会爆内存、放大后仍清晰。
 *
 * 局部解码不处理 EXIF 方向，所以带旋转标记的图只显示底图（底图用 ImageDecoder 会摆正）。
 * 非线程安全的 [BitmapRegionDecoder] 由 [decodeRegion] 内部串行化；用完必须 [close]。
 *
 * @param file 图片文件
 */
internal class PreviewImage(private val file: File) : AutoCloseable {
    /** 图片宽（像素，未应用 EXIF 方向），读不出为 0 */
    val width: Int

    /** 图片高（像素，未应用 EXIF 方向），读不出为 0 */
    val height: Int

    /** 局部解码器，创建失败或有旋转标记时为 null */
    private val region: BitmapRegionDecoder?

    init {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        width = bounds.outWidth.coerceAtLeast(0)
        height = bounds.outHeight.coerceAtLeast(0)
        region = if (width > 0 && height > 0 && !hasOrientation()) openRegion() else null
    }

    /** 是否支持放大后的高清局部 */
    val hasDetail: Boolean get() = region != null

    /** 读 EXIF 方向，非正常（不是 1 / 未定义）视为有旋转 */
    private fun hasOrientation(): Boolean = try {
        val o = ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        o != ExifInterface.ORIENTATION_NORMAL && o != ExifInterface.ORIENTATION_UNDEFINED
    } catch (_: Exception) {
        false
    }

    /** 打开局部解码器，格式不支持时返回 null */
    @Suppress("DEPRECATION")
    private fun openRegion(): BitmapRegionDecoder? = try {
        BitmapRegionDecoder.newInstance(file.path, false)
    } catch (_: Exception) {
        null
    }

    /**
     * 解出缩小的底图。
     *
     * @return 位图，解码失败返回 null
     */
    fun decodeBase(): Bitmap? = try {
        val sample = ZoomMath.baseSample(width, height)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, _, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                decoder.setTargetSampleSize(sample)
            }
        } else {
            BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
        }
    } catch (_: Exception) {
        null
    } catch (_: OutOfMemoryError) {
        null
    }

    /**
     * 解出某个区域的高清局部。
     *
     * @param rect 图片像素坐标的区域
     * @param sample 采样倍数（2 的幂）
     * @return 位图，不支持或失败返回 null
     */
    fun decodeRegion(rect: RectI, sample: Int): Bitmap? {
        val r = region ?: return null
        return try {
            synchronized(r) {
                r.decodeRegion(Rect(rect.left, rect.top, rect.right, rect.bottom), BitmapFactory.Options().apply { inSampleSize = sample })
            }
        } catch (_: Exception) {
            null
        } catch (_: OutOfMemoryError) {
            null
        }
    }

    /** 释放局部解码器 */
    override fun close() {
        region?.let { synchronized(it) { it.recycle() } }
    }
}
