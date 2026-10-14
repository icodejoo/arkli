package com.let188.arkli.media

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import org.json.JSONObject

/**
 * 视频基本信息，读不到的字段为 null。
 *
 * @property durationMs 时长（毫秒）
 * @property width 摆正后的宽
 * @property height 摆正后的高
 * @property codedWidth 编码宽（未旋转）
 * @property codedHeight 编码高（未旋转）
 * @property rotation 旋转角 0/90/180/270
 * @property bitrate 容器总码率（bps）
 * @property videoBitrate 视频轨码率（bps）
 * @property sizeBytes 文件体积
 * @property hasAudio 是否有音轨
 * @property videoMime 视频编码 mime
 * @property audioMime 音频编码 mime
 * @property fps 帧率
 */
internal class VideoInfo(
    val durationMs: Long?,
    val width: Int?,
    val height: Int?,
    val codedWidth: Int?,
    val codedHeight: Int?,
    val rotation: Int,
    val bitrate: Long?,
    val videoBitrate: Long?,
    val sizeBytes: Long?,
    val hasAudio: Boolean,
    val videoMime: String?,
    val audioMime: String?,
    val fps: Double?,
) {
    /** 转成页面用的 JSON，未知字段写 null */
    fun toJson(): JSONObject {
        val o = JSONObject()
        o.put("durationMs", durationMs ?: JSONObject.NULL)
        o.put("width", width ?: JSONObject.NULL)
        o.put("height", height ?: JSONObject.NULL)
        o.put("rotation", rotation)
        o.put("bitrate", bitrate ?: JSONObject.NULL)
        o.put("sizeBytes", sizeBytes ?: JSONObject.NULL)
        o.put("hasAudio", hasAudio)
        o.put("videoMime", videoMime ?: JSONObject.NULL)
        o.put("audioMime", audioMime ?: JSONObject.NULL)
        o.put("fps", fps ?: JSONObject.NULL)
        return o
    }
}

/**
 * 读取视频信息：MediaMetadataRetriever 取容器元数据，MediaExtractor 取轨道格式。任何一步失败都只留 null，不抛。
 *
 * @param context 应用上下文
 */
internal class MediaInfoReader(private val context: Context) {
    /**
     * 读取信息。
     *
     * @param uri 视频的 content URI
     * @return 信息；全部读不到时各字段为 null
     */
    fun read(uri: Uri): VideoInfo {
        var duration: Long? = null
        var rawW: Int? = null
        var rawH: Int? = null
        var rotation = 0
        var bitrate: Long? = null
        var hasAudioMeta = false
        var frameCount: Long? = null
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(context, uri)
            duration = meta(r, MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
            rawW = meta(r, MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
            rawH = meta(r, MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
            rotation = MediaPolicy.normalizeRotation(meta(r, MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull())
            bitrate = meta(r, MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toLongOrNull()
            hasAudioMeta = meta(r, MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                frameCount = meta(r, MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)?.toLongOrNull()
            }
        } catch (_: Exception) {
            // 元数据读不出来不算失败
        } finally {
            runCatching { r.release() }
        }

        var videoMime: String? = null
        var audioMime: String? = null
        var trackFps: Double? = null
        var trackBps: Long? = null
        var codedW = rawW
        var codedH = rawH
        val ex = MediaExtractor()
        try {
            ex.setDataSource(context, uri, null)
            for (i in 0 until ex.trackCount) {
                val f = ex.getTrackFormat(i)
                val mime = f.getString(MediaFormat.KEY_MIME) ?: continue
                if (mime.startsWith(MediaConst.PREFIX_VIDEO) && videoMime == null) {
                    videoMime = mime
                    trackFps = numberOrNull(f, MediaFormat.KEY_FRAME_RATE)
                    trackBps = numberOrNull(f, MediaFormat.KEY_BIT_RATE)?.toLong()
                    numberOrNull(f, MediaFormat.KEY_WIDTH)?.toInt()?.let { codedW = it }
                    numberOrNull(f, MediaFormat.KEY_HEIGHT)?.toInt()?.let { codedH = it }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && f.containsKey(MediaFormat.KEY_ROTATION) && rotation == 0) {
                        rotation = MediaPolicy.normalizeRotation(numberOrNull(f, MediaFormat.KEY_ROTATION)?.toInt())
                    }
                    if (duration == null) numberOrNull(f, MediaFormat.KEY_DURATION)?.let { duration = it.toLong() / MediaConst.US_PER_MS }
                } else if (mime.startsWith(MediaConst.PREFIX_AUDIO) && audioMime == null) {
                    audioMime = mime
                }
            }
        } catch (_: Exception) {
            // 轨道读不出来：保留元数据里拿到的
        } finally {
            runCatching { ex.release() }
        }

        val fps = trackFps ?: frameRateFromCount(frameCount, duration)
        val oriented = if (codedW != null && codedH != null) MediaPolicy.orientedSize(codedW!!, codedH!!, rotation) else null
        return VideoInfo(
            durationMs = duration,
            width = oriented?.first,
            height = oriented?.second,
            codedWidth = codedW,
            codedHeight = codedH,
            rotation = rotation,
            bitrate = bitrate,
            videoBitrate = trackBps,
            sizeBytes = sizeOf(uri),
            hasAudio = audioMime != null || hasAudioMeta,
            videoMime = videoMime,
            audioMime = audioMime,
            fps = fps,
        )
    }

    /**
     * 查文件显示名。
     *
     * @param uri 视频 URI
     * @return 名字；查不到返回 null
     */
    fun displayName(uri: Uri): String? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }

    /**
     * 查文件体积。
     *
     * @param uri 视频 URI
     * @return 字节数；查不到返回 null
     */
    fun sizeOf(uri: Uri): Long? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use {
            if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else null
        }
    } catch (_: Exception) {
        null
    }

    /** 取元数据，异常当 null */
    private fun meta(r: MediaMetadataRetriever, key: Int): String? = try {
        r.extractMetadata(key)
    } catch (_: Exception) {
        null
    }

    /** 帧数 / 时长换算帧率，数据不足返回 null */
    private fun frameRateFromCount(count: Long?, durationMs: Long?): Double? {
        if (count == null || count <= 0 || durationMs == null || durationMs <= 0) return null
        return count * MediaConst.MS_PER_SEC.toDouble() / durationMs
    }

    companion object {
        /** 轨道格式里的数字字段可能是整数或浮点，统一读成 Double；没有或类型不对返回 null */
        internal fun numberOrNull(f: MediaFormat, key: String): Double? {
            if (!f.containsKey(key)) return null
            return try {
                f.getInteger(key).toDouble()
            } catch (_: Exception) {
                try {
                    f.getFloat(key).toDouble()
                } catch (_: Exception) {
                    try {
                        f.getLong(key).toDouble()
                    } catch (_: Exception) {
                        null
                    }
                }
            }
        }
    }
}
