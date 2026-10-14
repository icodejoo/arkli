package com.let188.arkli.image

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.media.ExifInterface
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream

/** 基于 Bitmap 的画布：整幅只在一张位图里，逐张解码绘制后立即回收 */
private class AndroidStitchCanvas(
    private var bitmap: Bitmap?,
    private val bg: Int,
    private val codec: AndroidImageCodec,
) : StitchCanvas {
    /** 画布位图，已关闭则报错 */
    private val bmp: Bitmap get() = bitmap ?: throw IllegalStateException("画布已释放")

    /** 绘制用画笔：双线性缩放 */
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)

    /** 绘制画布 */
    private val canvas = Canvas(bmp).also { it.drawColor(bg) }

    override fun draw(file: File, rect: StitchRect) {
        // 按目标矩形的最长边降采样解码，大图不会整幅进内存
        val img = codec.decode(file, maxOf(rect.w, rect.h))
        try {
            canvas.drawBitmap((img as BitmapImage).bmp, null, Rect(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h), paint)
        } finally {
            img.close()
        }
    }

    override fun writeTo(out: OutputStream, format: OutFormat, quality: Int, check: () -> Unit, onRow: (Int, Int) -> Unit) {
        val b = bmp
        when (format) {
            OutFormat.PNG -> {
                // 画布铺了不透明底色，结果一定不透明：按行读像素、边压边写，不攒整幅 IntArray / ByteArray
                PngEncoder.writeRgb(
                    out, b.width, b.height,
                    { y, row -> b.getPixels(row, 0, b.width, 0, y, b.width, 1) },
                    PngTuning.FAST, check,
                ) { done -> onRow(done, b.height) }
            }
            OutFormat.JPEG -> {
                if (!b.compress(Bitmap.CompressFormat.JPEG, quality, out)) throw BridgeException(BridgeErrors.INTERNAL, "JPEG 编码失败")
                onRow(b.height, b.height)
            }
            OutFormat.WEBP -> throw IllegalArgumentException("拼接不支持 WebP")
        }
    }

    override fun thumbnail(maxEdge: Int, quality: Int): ByteArray {
        val src = bmp
        val t = ImageMath.fitSize(src.width, src.height, maxEdge)
        var cur: Bitmap = src
        try {
            // 逐级减半再到目标，避免一步大倍率缩小的锯齿
            while (cur.width > t.width * ImageConst.SCALE_STEP_RATIO || cur.height > t.height * ImageConst.SCALE_STEP_RATIO) {
                val next = Bitmap.createScaledBitmap(
                    cur,
                    maxOf(t.width, cur.width / ImageConst.SCALE_STEP_RATIO),
                    maxOf(t.height, cur.height / ImageConst.SCALE_STEP_RATIO),
                    true,
                )
                if (cur !== src) cur.recycle()
                cur = next
            }
            val out = if (cur.width == t.width && cur.height == t.height) cur else Bitmap.createScaledBitmap(cur, t.width, t.height, true)
            try {
                val bos = ByteArrayOutputStream()
                out.compress(Bitmap.CompressFormat.JPEG, quality, bos)
                return bos.toByteArray()
            } finally {
                if (out !== src && out !== cur) out.recycle()
            }
        } finally {
            if (cur !== src) cur.recycle()
        }
    }

    override fun close() {
        bitmap?.recycle()
        bitmap = null
    }
}

/**
 * 平台实现：尺寸用 BitmapFactory 读边界 + EXIF 方向换算（不解码像素），
 * 解码复用 [AndroidImageCodec]（API 28+ 走 ImageDecoder，自带摆正；更低版本 BitmapFactory + EXIF）。
 */
class AndroidStitchBackend : StitchBackend {
    /** 解码器，复用压缩流水线的实现 */
    private val codec = AndroidImageCodec()

    override fun probe(file: File): ImageMath.Size {
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, opts)
        if (opts.outWidth <= 0 || opts.outHeight <= 0) {
            throw BridgeException(BridgeErrors.INTERNAL, "无法解码该图片，文件可能已损坏或格式不受支持：${file.name}")
        }
        val orientation = try {
            ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } catch (e: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
        // 方向 5..8 要互换宽高
        val swap = orientation in ExifInterface.ORIENTATION_TRANSPOSE..ExifInterface.ORIENTATION_ROTATE_270
        return if (swap) ImageMath.Size(opts.outHeight, opts.outWidth) else ImageMath.Size(opts.outWidth, opts.outHeight)
    }

    override fun newCanvas(width: Int, height: Int, bg: Int): StitchCanvas {
        val bmp = try {
            Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        } catch (e: OutOfMemoryError) {
            throw BridgeException(BridgeErrors.INTERNAL, "内存不足，请减少图片、开启统一宽度或调小间距后重试")
        }
        return AndroidStitchCanvas(bmp, bg, codec)
    }
}
