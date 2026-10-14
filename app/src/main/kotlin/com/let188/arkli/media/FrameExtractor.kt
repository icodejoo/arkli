package com.let188.arkli.media

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import java.io.File
import java.io.FileOutputStream

/**
 * 一批取好的帧。
 *
 * @property files 帧文件与对应时间点（毫秒），按时间排序
 * @property width 第一帧宽
 * @property height 第一帧高
 */
internal class ExtractedFrames(val files: List<Pair<File, Long>>, val width: Int, val height: Int)

/**
 * 按时间表从视频取帧存成 JPEG，供页面送进 JS 的 GIF 编码器。
 *
 * @param context 应用上下文
 */
internal class FrameExtractor(private val context: Context) {
    /**
     * 取帧；失败或取消时删除已写的帧与目录。
     *
     * @param uri 视频 URI
     * @param times 每帧的时间点（毫秒）
     * @param outW 目标宽
     * @param outH 目标高
     * @param dir 输出目录，由调用方创建
     * @param check 取消检查
     * @param onProgress 进度回调：已取帧数
     * @return 帧文件列表与实际尺寸
     * @throws MediaUserException 一帧都取不到
     */
    fun extract(uri: Uri, times: List<Long>, outW: Int, outH: Int, dir: File, check: () -> Unit, onProgress: (Int) -> Unit): ExtractedFrames {
        val r = MediaMetadataRetriever()
        var ok = false
        try {
            r.setDataSource(context, uri)
            val files = ArrayList<Pair<File, Long>>()
            var w = 0
            var h = 0
            for ((i, t) in times.withIndex()) {
                check()
                val bmp = grab(r, t * MediaConst.US_PER_MS, outW, outH)
                if (bmp != null) {
                    val f = File(dir, "f%03d.jpg".format(i))
                    try {
                        FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.JPEG, MediaConst.FRAME_JPEG_QUALITY, it) }
                    } catch (e: Throwable) {
                        f.delete()
                        throw e
                    }
                    if (files.isEmpty()) {
                        w = bmp.width
                        h = bmp.height
                    }
                    files.add(f to t)
                    bmp.recycle()
                }
                onProgress(i + 1)
            }
            if (files.isEmpty()) throw MediaUserException("取不到这个视频的画面，可能是设备不支持它的编码")
            ok = true
            return ExtractedFrames(files, w, h)
        } finally {
            runCatching { r.release() }
            if (!ok) deleteDir(dir)
        }
    }

    /** 取一帧并缩放；API 27+ 直接取缩放帧，更低的先取原帧再缩 */
    private fun grab(r: MediaMetadataRetriever, timeUs: Long, w: Int, h: Int): Bitmap? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            return r.getScaledFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST, w, h)
        }
        val full = r.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST) ?: return null
        if (full.width == w && full.height == h) return full
        val scaled = Bitmap.createScaledBitmap(full, w, h, true)
        if (scaled !== full) full.recycle()
        return scaled
    }

    companion object {
        /** 递归删除目录，忽略失败 */
        internal fun deleteDir(dir: File) {
            runCatching { dir.deleteRecursively() }
        }
    }
}
