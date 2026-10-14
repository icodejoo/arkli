package com.let188.arkli.picker

import android.content.ContentResolver
import android.content.ContentUris
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import kotlin.math.max
import kotlin.math.min

/** 相册里的一张图 */
internal data class MediaImage(val id: Long, val uri: Uri)

/** 读相册图片列表与缩略图 */
internal object MediaImages {
    /**
     * 按添加时间倒序列出全部图片，只取 id，轻量。
     *
     * @param resolver 内容解析器
     * @return 图片列表，查询失败返回空
     */
    fun list(resolver: ContentResolver): List<MediaImage> {
        val base = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val out = ArrayList<MediaImage>()
        try {
            resolver.query(base, arrayOf(MediaStore.Images.Media._ID), null, null, "${MediaStore.Images.Media.DATE_ADDED} DESC")?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    out += MediaImage(id, ContentUris.withAppendedId(base, id))
                }
            }
        } catch (_: Exception) {
            // 查询失败当作没有图片
        }
        return out
    }

    /**
     * 解出缩略图，API 28+ 用 ImageDecoder（自动摆正方向），低版本用 BitmapFactory 采样。
     *
     * @param resolver 内容解析器
     * @param uri 图片 URI
     * @param px 目标边长
     * @return 位图，解码失败返回 null
     */
    fun thumbnail(resolver: ContentResolver, uri: Uri, px: Int): Bitmap? = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                decoder.setTargetSampleSize(sampleSize(min(info.size.width, info.size.height), px))
            }
        } else {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(min(bounds.outWidth, bounds.outHeight), px) }
            resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
        }
    } catch (_: Exception) {
        null
    }

    /** 短边缩到不小于 [px] 的最大采样倍数，至少 1 */
    internal fun sampleSize(shortSide: Int, px: Int): Int = max(1, shortSide / px)
}
