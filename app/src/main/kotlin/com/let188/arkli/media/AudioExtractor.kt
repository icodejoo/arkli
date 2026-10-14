package com.let188.arkli.media

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import java.io.File
import java.nio.ByteBuffer

/**
 * 音轨直通提取：只支持 AAC，原样封装进 `.m4a`，不重编码。
 * 以后引入 Media3 Transformer 后可替换成它，支持更多编码。
 *
 * @param context 应用上下文
 */
internal class AudioExtractor(private val context: Context) {
    /**
     * 提取并写出文件；任何失败都会删除半成品。
     *
     * @param uri 视频 URI
     * @param window 时间窗
     * @param totalMs 视频总时长，读不到传 null
     * @param out 输出文件
     * @param check 取消检查，被取消时抛 CancellationException
     * @param onProgress 进度回调：(已处理毫秒, 总毫秒)
     * @return 实际写入的音频时长（毫秒）
     * @throws MediaUserException 没有音轨、编码不支持、时间窗内没有音频
     */
    fun extract(
        uri: Uri,
        window: AudioWindow,
        totalMs: Long?,
        out: File,
        check: () -> Unit,
        onProgress: (Long, Long) -> Unit,
    ): Long {
        val ex = MediaExtractor()
        var muxer: MediaMuxer? = null
        var muxerStarted = false
        var ok = false
        try {
            ex.setDataSource(context, uri, null)
            val idx = findAudioTrack(ex) ?: throw MediaUserException("这个视频没有音轨，没有可提取的声音")
            val format = ex.getTrackFormat(idx)
            val mime = format.getString(MediaFormat.KEY_MIME)
            if (mime != MediaConst.MIME_AAC) {
                throw MediaUserException("该视频的音轨编码暂不支持直接提取（$mime），目前只支持 AAC")
            }
            ex.selectTrack(idx)
            if (window.startUs > 0) ex.seekTo(window.startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
            muxer = MediaMuxer(out.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            val track = muxer.addTrack(format)
            muxer.start()
            muxerStarted = true

            val buf = ByteBuffer.allocate(MediaConst.SAMPLE_BUFFER_BYTES)
            val info = MediaCodec.BufferInfo()
            val windowMs = window.durationMs(totalMs)
            var written = 0
            var lastUs = 0L
            while (true) {
                check()
                val t = ex.sampleTime
                if (t < 0 || t > window.endUs) break
                if (t < window.startUs) {
                    ex.advance()
                    continue
                }
                buf.clear()
                val n = ex.readSampleData(buf, 0)
                if (n < 0) break
                lastUs = window.shift(t)
                info.set(0, n, lastUs, sampleFlagsToCodec(ex.sampleFlags))
                muxer.writeSampleData(track, buf, info)
                written++
                ex.advance()
                if (windowMs != null) onProgress(MediaPolicy.progressDoneMs(lastUs, windowMs), windowMs)
            }
            if (written == 0) throw MediaUserException("选中的时间段里没有音频，请调整起止时间")
            muxer.stop()
            muxerStarted = false
            ok = true
            return lastUs / MediaConst.US_PER_MS
        } finally {
            if (muxerStarted) runCatching { muxer?.stop() }
            runCatching { muxer?.release() }
            runCatching { ex.release() }
            if (!ok) out.delete()
        }
    }

    /** 找第一条音轨，没有返回 null */
    private fun findAudioTrack(ex: MediaExtractor): Int? {
        for (i in 0 until ex.trackCount) {
            val mime = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith(MediaConst.PREFIX_AUDIO)) return i
        }
        return null
    }

    companion object {
        /** 把提取器的样本标志转成封装器的缓冲标志：同步样本记为关键帧 */
        internal fun sampleFlagsToCodec(sampleFlags: Int): Int =
            if (sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
    }
}
