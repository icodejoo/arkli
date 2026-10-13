package com.let188.arkli.image

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.Build
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException

/** 基于 Bitmap 的 [CodecImage] */
class BitmapImage(private var bitmap: Bitmap?) : CodecImage {
    /** 取底层位图，已关闭则报错 */
    val bmp: Bitmap get() = bitmap ?: throw IllegalStateException("图片已释放")

    override val width: Int get() = bmp.width
    override val height: Int get() = bmp.height

    override fun toArgb(): IntArray {
        val b = bmp
        val px = IntArray(b.width * b.height)
        b.getPixels(px, 0, b.width, 0, 0, b.width, b.height)
        return px
    }

    override fun close() {
        bitmap?.recycle()
        bitmap = null
    }
}

/**
 * 平台实现：API 28+ 用 ImageDecoder（自带 EXIF 摆正，能解 HEIC），失败或更低版本回退 BitmapFactory
 * （inSampleSize 降采样 + ExifInterface 手动摆正）。24~27 上 HEIC 解不了，报 INTERNAL 并给出可读提示。
 *
 * 缩放取舍：[Bitmap.createScaledBitmap] 带 filter（双线性），缩小倍率超过 [ImageConst.SCALE_STEP_RATIO]
 * 时逐级减半再到目标，避免单步大倍率缩小的锯齿；多花几次中间位图，用完即 recycle。
 *
 * @param jpegBackground JPEG 不支持透明，透明区域先铺这个底色，默认白
 */
class AndroidImageCodec(private val jpegBackground: Int = ImageConst.JPEG_BACKGROUND) : ImageCodec {
    override fun decode(file: File, maxEdge: Int?): CodecImage {
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, opts)
        val srcW = opts.outWidth
        val srcH = opts.outHeight
        if (srcW <= 0 || srcH <= 0) throw undecodable()
        val target = ImageMath.fitSize(srcW, srcH, maxEdge)
        val sample = ImageMath.sampleSize(srcW, srcH, target.width, target.height)
        val pixels = (srcW / sample).toLong() * (srcH / sample)
        if (pixels > ImageConst.MAX_DECODE_PIXELS) {
            throw BridgeException(
                BridgeErrors.BAD_PARAMS,
                "图片太大（约 ${pixels / 10_000} 万像素），请设置更小的 maxEdge",
            )
        }
        try {
            val bmp = decodeBitmap(file, sample) ?: throw undecodable()
            return BitmapImage(bmp)
        } catch (e: OutOfMemoryError) {
            throw BridgeException(BridgeErrors.INTERNAL, "内存不足，请缩小 maxEdge 后重试")
        }
    }

    override fun scale(src: CodecImage, width: Int, height: Int): CodecImage {
        val s = (src as BitmapImage).bmp
        if (s.width == width && s.height == height) return BitmapImage(s.copy(Bitmap.Config.ARGB_8888, false))
        try {
            var cur: Bitmap = s
            var curIsSrc = true
            while (cur.width > width * ImageConst.SCALE_STEP_RATIO || cur.height > height * ImageConst.SCALE_STEP_RATIO) {
                val nw = maxOf(width, cur.width / ImageConst.SCALE_STEP_RATIO)
                val nh = maxOf(height, cur.height / ImageConst.SCALE_STEP_RATIO)
                val next = Bitmap.createScaledBitmap(cur, nw, nh, true)
                if (!curIsSrc) cur.recycle()
                cur = next
                curIsSrc = false
            }
            val out = Bitmap.createScaledBitmap(cur, width, height, true)
            // createScaledBitmap 尺寸相同时会返回原对象，别把它回收掉
            if (!curIsSrc && cur !== out) cur.recycle()
            return BitmapImage(if (out === s) s.copy(Bitmap.Config.ARGB_8888, false) else out)
        } catch (e: OutOfMemoryError) {
            throw BridgeException(BridgeErrors.INTERNAL, "内存不足，请缩小 maxEdge 后重试")
        }
    }

    override fun encodeLossy(img: CodecImage, format: OutFormat, quality: Int): ByteArray {
        val src = (img as BitmapImage).bmp
        val bos = ByteArrayOutputStream()
        when (format) {
            OutFormat.JPEG -> {
                val flat = if (src.hasAlpha()) flatten(src) else src
                try {
                    flat.compress(Bitmap.CompressFormat.JPEG, quality, bos)
                } finally {
                    if (flat !== src) flat.recycle()
                }
            }
            OutFormat.WEBP -> src.compress(webpFormat(), quality, bos)
            OutFormat.PNG -> throw IllegalArgumentException("PNG 走 PngEncoder")
        }
        return bos.toByteArray()
    }

    override fun copyExif(src: File, dst: File) {
        try {
            val from = ExifInterface(src.path)
            val to = ExifInterface(dst.path)
            for (tag in COPY_TAGS) from.getAttribute(tag)?.let { to.setAttribute(tag, it) }
            // 像素已摆正，方向复位，免得二次旋转
            to.setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL.toString())
            to.saveAttributes()
        } catch (e: Exception) {
            // EXIF 只是附带信息，复制失败不影响主流程
        }
    }

    /** WebP 有损格式：API 30+ 用 WEBP_LOSSY，更低版本只有旧的 WEBP（同样是有损） */
    @Suppress("DEPRECATION")
    private fun webpFormat(): Bitmap.CompressFormat =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Bitmap.CompressFormat.WEBP_LOSSY
        else Bitmap.CompressFormat.WEBP

    /** 透明区域铺底色，得到不透明的新位图（调用方负责回收） */
    private fun flatten(src: Bitmap): Bitmap {
        val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        canvas.drawColor(jpegBackground)
        canvas.drawBitmap(src, 0f, 0f, null)
        return out
    }

    /** 解码一张位图：优先 ImageDecoder，失败回退 BitmapFactory */
    private fun decodeBitmap(file: File, sample: Int): Bitmap? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                val source = ImageDecoder.createSource(file)
                return ImageDecoder.decodeBitmap(source) { decoder, _, _ ->
                    decoder.setTargetSampleSize(sample)
                    decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                }
            } catch (e: IOException) {
                // 回退 BitmapFactory
            } catch (e: ImageDecoder.DecodeException) {
                // 回退 BitmapFactory
            }
        }
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val raw = BitmapFactory.decodeFile(file.path, opts) ?: return null
        return orient(raw, readOrientation(file))
    }

    /** 读 EXIF 方向，失败当作正常 */
    private fun readOrientation(file: File): Int = try {
        ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    } catch (e: Exception) {
        ExifInterface.ORIENTATION_NORMAL
    }

    /** 按 EXIF 方向旋转/翻转位图，必要时回收原位图 */
    private fun orient(src: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                m.postRotate(90f)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                m.postRotate(270f)
                m.postScale(-1f, 1f)
            }
            else -> return src
        }
        val out = Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
        if (out !== src) src.recycle()
        return out
    }

    /** 无法解码的统一错误 */
    private fun undecodable() = BridgeException(
        BridgeErrors.INTERNAL,
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) "无法解码该图片（HEIC 等格式需要 Android 9 及以上）"
        else "无法解码该图片，文件可能已损坏或格式不受支持",
    )

    private companion object {
        /** keepExif 时要带走的标签；不含缩略图、方向与尺寸类标签 */
        val COPY_TAGS = listOf(
            ExifInterface.TAG_DATETIME,
            ExifInterface.TAG_DATETIME_ORIGINAL,
            ExifInterface.TAG_MAKE,
            ExifInterface.TAG_MODEL,
            ExifInterface.TAG_EXPOSURE_TIME,
            ExifInterface.TAG_F_NUMBER,
            ExifInterface.TAG_ISO_SPEED_RATINGS,
            ExifInterface.TAG_FOCAL_LENGTH,
            ExifInterface.TAG_GPS_LATITUDE,
            ExifInterface.TAG_GPS_LATITUDE_REF,
            ExifInterface.TAG_GPS_LONGITUDE,
            ExifInterface.TAG_GPS_LONGITUDE_REF,
            ExifInterface.TAG_GPS_ALTITUDE,
            ExifInterface.TAG_GPS_ALTITUDE_REF,
        )
    }
}
