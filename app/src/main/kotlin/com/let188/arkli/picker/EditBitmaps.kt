package com.let188.arkli.picker

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.net.Uri
import android.os.Build
import android.media.ExifInterface
import com.let188.arkli.files.FileConst
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import kotlin.math.roundToInt

/**
 * 图片编辑用的位图读写：解码时按 EXIF 摆正，导出时按操作结果从原图直接取区域。
 */
internal object EditBitmaps {
    /** 全程白底，导出 JPEG 时垫在透明图下面 */
    private const val WHITE = -1

    /** PNG 压缩质量参数（PNG 无损，系统忽略，传满值） */
    private const val PNG_QUALITY = 100

    /** 一圈的角度，用于换算旋转 */
    private const val QUARTER_DEG = 90f

    /**
     * 解码并按 EXIF 摆正（API 28+ 用 ImageDecoder 自动摆正，低版本手动转）。
     *
     * @param resolver 内容解析器
     * @param uri 图片 URI
     * @param sampleOf 根据（未旋转的）原图宽高返回采样倍数
     * @return 软件位图，解码失败返回 null
     */
    fun decode(resolver: ContentResolver, uri: Uri, sampleOf: (Int, Int) -> Int): Bitmap? = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                decoder.setTargetSampleSize(sampleOf(info.size.width, info.size.height).coerceAtLeast(1))
            }
        } else {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            val opts = BitmapFactory.Options().apply { inSampleSize = sampleOf(bounds.outWidth, bounds.outHeight).coerceAtLeast(1) }
            val raw = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
            val orientation = resolver.openInputStream(uri)?.use {
                ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } ?: ExifInterface.ORIENTATION_NORMAL
            raw?.let { applyExif(it, orientation) }
        }
    } catch (_: Exception) {
        null
    }

    /** 低版本按 EXIF 方向摆正位图 */
    private fun applyExif(src: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(QUARTER_DEG)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(QUARTER_DEG * 2)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(QUARTER_DEG * 3)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                m.postRotate(QUARTER_DEG)
                m.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                m.postRotate(QUARTER_DEG * 3)
                m.postScale(-1f, 1f)
            }
            else -> return src
        }
        return Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true).also { if (it !== src) src.recycle() }
    }

    /**
     * 把旋转与翻转作用到位图上（不含裁剪），用于预览。
     *
     * @param src 原位图（不会被回收）
     * @param state 编辑状态
     * @return 变换后的新位图；状态无旋转翻转时返回 [src] 本身
     */
    fun transform(src: Bitmap, state: EditState): Bitmap {
        if (state.turns == 0 && !state.flipH) return src
        return Bitmap.createBitmap(src, 0, 0, src.width, src.height, matrixOf(state), true)
    }

    /** 状态里的旋转加镜像对应的矩阵 */
    private fun matrixOf(state: EditState): Matrix = Matrix().apply {
        postRotate(state.turns * QUARTER_DEG)
        if (state.flipH) postScale(-1f, 1f)
    }

    /**
     * 按状态导出：以不超过 [PickerConst.EDIT_EXPORT_MAX_EDGE] 的分辨率解码原图，
     * 从原图直接取裁剪区域并同时旋转翻转；带形状或套索时再抠出轮廓、写成带 alpha 的 PNG，否则写成 JPEG。
     *
     * @param resolver 内容解析器
     * @param uri 原图 URI
     * @param state 编辑状态
     * @param dest 输出文件
     * @param checkCancelled 每个阶段前调用，取消时应抛 CancellationException
     * @throws IOException 解码或写入失败
     */
    fun export(resolver: ContentResolver, uri: Uri, state: EditState, dest: File, checkCancelled: () -> Unit) {
        checkCancelled()
        val src = decode(resolver, uri) { w, h -> EditMath.exportSample(w, h, PickerConst.EDIT_EXPORT_MAX_EDGE) }
            ?: throw IOException("图片解码失败")
        var cut: Bitmap? = null
        try {
            checkCancelled()
            val c = state.sourceCrop()
            val plan = EditMath.planExport(c, src.width, src.height, PickerConst.EDIT_EXPORT_MAX_EDGE, state.exceedsImage)
            cut = if (plan.outside) {
                composeOutside(src, plan, state)
            } else {
                val x = (c.left * src.width).roundToInt().coerceIn(0, src.width - 1)
                val y = (c.top * src.height).roundToInt().coerceIn(0, src.height - 1)
                val w = (c.width * src.width).roundToInt().coerceIn(1, src.width - x)
                val h = (c.height * src.height).roundToInt().coerceIn(1, src.height - y)
                Bitmap.createBitmap(src, x, y, w, h, matrixOf(state), true)
            }
            checkCancelled()
            dest.parentFile?.mkdirs()
            val mask = EditShapes.maskPolygon(state, cut.width.toFloat(), cut.height.toFloat())
            if (mask != null || state.needsAlpha) {
                // 带透明区域（形状、套索、框超出图片）只能存 PNG
                val shaped = if (mask != null) applyMask(cut, mask) else cut
                try {
                    FileOutputStream(dest).use { shaped.compress(Bitmap.CompressFormat.PNG, PNG_QUALITY, it) }
                } finally {
                    if (shaped !== cut) shaped.recycle()
                }
            } else {
                val flat = if (cut.hasAlpha()) flatten(cut) else cut
                try {
                    FileOutputStream(dest).use { flat.compress(Bitmap.CompressFormat.JPEG, FileConst.JPEG_QUALITY, it) }
                } finally {
                    if (flat !== cut) flat.recycle()
                }
            }
        } catch (e: Exception) {
            dest.delete()
            throw e
        } finally {
            if (cut != null && cut !== src) cut.recycle()
            src.recycle()
        }
    }

    /**
     * 框超出原图时的合成：在透明画布（原图方向、框大小，最长边超限则等比缩小）上贴出原图与框相交的部分，再旋转翻转。
     * 超出图片的区域保持透明。
     */
    private fun composeOutside(src: Bitmap, plan: EditMath.ExportPlan, state: EditState): Bitmap {
        val cw = (plan.boxW * plan.scale).roundToInt().coerceAtLeast(1)
        val ch = (plan.boxH * plan.scale).roundToInt().coerceAtLeast(1)
        val canvasBmp = Bitmap.createBitmap(cw, ch, Bitmap.Config.ARGB_8888)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG)
        Canvas(canvasBmp).apply {
            scale(cw.toFloat() / plan.boxW, ch.toFloat() / plan.boxH)
            drawBitmap(src, -plan.boxX.toFloat(), -plan.boxY.toFloat(), paint)
        }
        if (state.turns == 0 && !state.flipH) return canvasBmp
        return Bitmap.createBitmap(canvasBmp, 0, 0, cw, ch, matrixOf(state), true).also { if (it !== canvasBmp) canvasBmp.recycle() }
    }

    /** 只保留多边形内的像素，外部透明（先画遮罩，再用 SRC_IN 贴原图） */
    private fun applyMask(src: Bitmap, poly: List<EditPoint>): Bitmap {
        val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
        val path = Path().apply {
            poly.forEachIndexed { i, p -> if (i == 0) moveTo(p.x, p.y) else lineTo(p.x, p.y) }
            close()
        }
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        Canvas(out).apply {
            drawPath(path, paint)
            paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
            drawBitmap(src, 0f, 0f, paint)
        }
        return out
    }

    /** 透明图垫白底，免得 JPEG 把透明处压成黑色 */
    private fun flatten(src: Bitmap): Bitmap {
        val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
        Canvas(out).apply {
            drawColor(WHITE)
            drawBitmap(src, 0f, 0f, null)
        }
        return out
    }
}
