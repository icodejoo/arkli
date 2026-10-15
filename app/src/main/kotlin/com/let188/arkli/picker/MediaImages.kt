package com.let188.arkli.picker

import android.content.ContentResolver
import android.content.ContentUris
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Size
import kotlin.math.max
import kotlin.math.min

/**
 * 相册里的一项（图片或视频）。
 *
 * @property id MediaStore 里的 _ID（图片表与视频表各自编号，可能重复）
 * @property uri 内容 URI
 * @property video 是否视频
 * @property durationMs 视频时长（毫秒），图片为 0
 * @property addedAt 添加时间（秒），用于图片视频混排
 */
internal data class MediaImage(val id: Long, val uri: Uri, val video: Boolean = false, val durationMs: Long = 0, val addedAt: Long = 0) {
    /** 列表里的唯一键：图片与视频的 _ID 可能撞车，用最低位区分 */
    val key: Long get() = id * 2 + if (video) 1 else 0
}

/** 读相册图片列表与缩略图 */
internal object MediaImages {
    /**
     * 按添加时间倒序列出图片和/或视频，只取轻量字段。
     *
     * @param resolver 内容解析器
     * @param media 要列出的媒体种类
     * @return 列表，查询失败的那一类当作没有
     */
    fun list(resolver: ContentResolver, media: PickerMedia = PickerMedia.IMAGE): List<MediaImage> {
        val out = ArrayList<MediaImage>()
        if (media != PickerMedia.VIDEO) out += query(resolver, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, false)
        if (media != PickerMedia.IMAGE) out += query(resolver, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
        return if (media == PickerMedia.IMAGE_VIDEO) out.sortedByDescending { it.addedAt } else out
    }

    /** 查一张表：图片表没有时长，视频表多取 DURATION */
    private fun query(resolver: ContentResolver, base: Uri, video: Boolean): List<MediaImage> {
        val out = ArrayList<MediaImage>()
        val cols = if (video) arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATE_ADDED, MediaStore.Video.VideoColumns.DURATION)
        else arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATE_ADDED)
        try {
            resolver.query(base, cols, null, null, "${MediaStore.MediaColumns.DATE_ADDED} DESC")?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    out += MediaImage(id, ContentUris.withAppendedId(base, id), video, if (video) c.getLong(2) else 0, c.getLong(1))
                }
            }
        } catch (_: Exception) {
            // 查询失败当作没有
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
    fun thumbnail(resolver: ContentResolver, uri: Uri, px: Int, video: Boolean = false): Bitmap? = try {
        if (video) videoThumbnail(resolver, uri, px)
        else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
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

    /** 视频封面：API 29+ 用系统缩略图，低版本取第一帧 */
    private fun videoThumbnail(resolver: ContentResolver, uri: Uri, px: Int): Bitmap? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            resolver.loadThumbnail(uri, Size(px, px), null)
        } else {
            val r = MediaMetadataRetriever()
            try {
                resolver.openFileDescriptor(uri, "r")?.use { r.setDataSource(it.fileDescriptor) }
                r.getFrameAtTime(0)
            } finally {
                r.release()
            }
        }

    /** 短边缩到不小于 [px] 的最大采样倍数，至少 1 */
    internal fun sampleSize(shortSide: Int, px: Int): Int = max(1, shortSide / px)
}
