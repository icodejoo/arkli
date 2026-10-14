package com.let188.arkli.media

import android.content.Context
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.view.Surface
import java.io.File
import java.nio.ByteBuffer

/**
 * 纯平台 API 的视频转码：解码器的输出 Surface 直接接编码器（H.264）的输入 Surface，
 * 只降码率，不缩放分辨率；音轨已编码样本直通写入封装器；旋转用 `setOrientationHint` 记录而不转像素。
 * 以后引入 Media3 Transformer 后可替换成它（支持缩放、HEVC 输出、更多音频编码）。
 *
 * 保守原则：任何异常都转成中文提示，`finally` 里释放所有编解码器与封装器，失败时删除半成品。
 *
 * @param context 应用上下文
 */
internal class VideoCompressor(private val context: Context) {
    /**
     * 压缩一个视频。
     *
     * @param uri 源视频 URI
     * @param info 源视频信息（来自 [MediaInfoReader]）
     * @param preset 码率预设
     * @param out 输出文件（.mp4），失败时会被删除
     * @param check 取消检查，被取消时抛 CancellationException
     * @param onProgress 进度回调：已编码的时间（毫秒）
     * @throws MediaUserException 设备不支持、源没有视频轨、音轨编码无法直通等可解释的原因
     */
    fun compress(uri: Uri, info: VideoInfo, preset: CompressPreset, out: File, check: () -> Unit, onProgress: (Long) -> Unit) {
        val s = Session(uri, info, preset, out, check, onProgress)
        var ok = false
        try {
            s.run()
            ok = true
        } finally {
            s.release()
            if (!ok) out.delete()
        }
    }

    /** 一次转码的全部可释放对象与循环，只在 [compress] 内使用 */
    private inner class Session(
        private val uri: Uri,
        private val info: VideoInfo,
        private val preset: CompressPreset,
        private val out: File,
        private val check: () -> Unit,
        private val onProgress: (Long) -> Unit,
    ) {
        /** 视频提取器 */
        private val videoEx = MediaExtractor()

        /** 音频提取器，没有音轨时为 null */
        private var audioEx: MediaExtractor? = null

        /** 解码器 */
        private var decoder: MediaCodec? = null

        /** 编码器 */
        private var encoder: MediaCodec? = null

        /** 编码器的输入 Surface，同时是解码器的输出 Surface */
        private var surface: Surface? = null

        /** 封装器 */
        private var muxer: MediaMuxer? = null

        /** 封装器是否已 start，决定 release 前要不要 stop */
        private var muxerStarted = false

        /** 当前阶段，出错时用来挑提示语 */
        private var stage = FailStage.OPEN

        /** 视频轨在封装器里的序号 */
        private var videoOut = -1

        /** 音轨在封装器里的序号 */
        private var audioOut = -1

        /** 音轨已读完 */
        private var audioDone = true

        /** 音频样本缓冲 */
        private var audioBuf: ByteBuffer? = null

        /** 音频样本信息，与视频的分开用 */
        private val audioInfo = MediaCodec.BufferInfo()

        /** 状态机 */
        private val phase = TranscodePhase()

        /** 已写入的最后一个视频时间戳（微秒） */
        private var lastVideoUs = 0L

        /** 执行转码，异常统一转成中文提示 */
        fun run() {
            try {
                doRun()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: MediaUserException) {
                throw e
            } catch (e: Throwable) {
                throw MediaFailedException(MediaPolicy.describeFailure(stage, e))
            }
        }

        /** 依次：读轨道、配编码器、配解码器、封装器、转码循环 */
        private fun doRun() {
            videoEx.setDataSource(context, uri, null)
            val vIdx = findTrack(videoEx, MediaConst.PREFIX_VIDEO) ?: throw MediaUserException("没有找到视频轨，无法压缩")
            val vFormat = videoEx.getTrackFormat(vIdx)
            val vMime = vFormat.getString(MediaFormat.KEY_MIME) ?: throw MediaUserException("读不到视频编码信息")
            val width = (MediaInfoReader.numberOrNull(vFormat, MediaFormat.KEY_WIDTH) ?: info.codedWidth?.toDouble())?.toInt()
                ?: throw MediaUserException("读不到视频分辨率")
            val height = (MediaInfoReader.numberOrNull(vFormat, MediaFormat.KEY_HEIGHT) ?: info.codedHeight?.toDouble())?.toInt()
                ?: throw MediaUserException("读不到视频分辨率")
            val totalMs = info.durationMs ?: 0L

            val srcBps = MediaPolicy.resolveSourceBitrate(info.videoBitrate, info.bitrate, info.sizeBytes, info.durationMs, info.hasAudio)
                ?: throw MediaUserException("读不到源视频码率，无法估算压缩目标")
            val fps = MediaPolicy.encodeFrameRate(MediaInfoReader.numberOrNull(vFormat, MediaFormat.KEY_FRAME_RATE) ?: info.fps)

            val aFormat = prepareAudio()
            videoEx.selectTrack(vIdx)

            stage = FailStage.ENCODER
            val enc = MediaCodec.createEncoderByType(MediaConst.MIME_AVC)
            encoder = enc
            val bitrate = fitBitrate(enc, width, height, MediaPolicy.targetBitrate(srcBps, preset))
            val encFormat = MediaFormat.createVideoFormat(MediaConst.MIME_AVC, width, height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, MediaConst.I_FRAME_INTERVAL_S)
                if (supportsVbr(enc)) setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
            }
            enc.configure(encFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            val inSurface = enc.createInputSurface()
            surface = inSurface
            enc.start()

            stage = FailStage.DECODER
            // 旋转交给封装器记录：清掉解码器格式里的旋转，避免输出 Surface 被转一次、封装器又转一次
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) vFormat.setInteger(MediaFormat.KEY_ROTATION, 0)
            val dec = MediaCodec.createDecoderByType(vMime)
            decoder = dec
            dec.configure(vFormat, inSurface, null, 0)
            dec.start()

            stage = FailStage.MUXER
            val mux = MediaMuxer(out.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            muxer = mux
            if (info.rotation != 0) mux.setOrientationHint(info.rotation)
            if (aFormat != null) audioOut = mux.addTrack(aFormat)

            stage = FailStage.RUNNING
            loop(enc, dec, mux, totalMs)
            pumpAudio(Long.MAX_VALUE)
            stage = FailStage.MUXER
            mux.stop()
            muxerStarted = false
        }

        /** 找并选中音轨，返回其格式；没有音轨返回 null。编码无法直通封装时直接报错，不悄悄丢声音 */
        private fun prepareAudio(): MediaFormat? {
            val ex = MediaExtractor()
            audioEx = ex
            ex.setDataSource(context, uri, null)
            val idx = findTrack(ex, MediaConst.PREFIX_AUDIO) ?: return null
            val format = ex.getTrackFormat(idx)
            val mime = format.getString(MediaFormat.KEY_MIME)
            if (mime !in PASSTHROUGH_AUDIO) throw MediaUserException("该视频的音轨编码（$mime）暂不支持直接保留，当前只支持 AAC 音轨的视频压缩")
            ex.selectTrack(idx)
            audioDone = false
            audioBuf = ByteBuffer.allocate(MediaConst.SAMPLE_BUFFER_BYTES)
            return format
        }

        /** 转码主循环：喂解码器、排空解码器（渲染到编码器 Surface）、排空编码器（写封装器） */
        private fun loop(enc: MediaCodec, dec: MediaCodec, mux: MediaMuxer, totalMs: Long) {
            val bi = MediaCodec.BufferInfo()
            val guard = StallGuard()
            while (!phase.encoderDone) {
                check()
                var progressed = false
                if (!phase.extractorDone) progressed = feedDecoder(dec) || progressed
                if (!phase.decoderDone) progressed = drainDecoder(dec, enc, bi) || progressed
                progressed = drainEncoder(enc, mux, bi, totalMs) || progressed
                if (guard.stalled(SystemClock.elapsedRealtime(), progressed)) throw MediaStalledException()
            }
        }

        /** 给解码器喂一个样本；读完时送结束标记。返回是否有进展 */
        private fun feedDecoder(dec: MediaCodec): Boolean {
            val i = dec.dequeueInputBuffer(MediaConst.DEQUEUE_TIMEOUT_US)
            if (i < 0) return false
            val buf = dec.getInputBuffer(i) ?: return false
            val n = videoEx.readSampleData(buf, 0)
            if (n < 0) {
                dec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                phase.onSourceEnd()
            } else {
                dec.queueInputBuffer(i, 0, n, videoEx.sampleTime, 0)
                videoEx.advance()
            }
            return true
        }

        /** 取解码器输出，按样本时间戳渲染到编码器 Surface；结束时让编码器结束输入 */
        private fun drainDecoder(dec: MediaCodec, enc: MediaCodec, bi: MediaCodec.BufferInfo): Boolean {
            val o = dec.dequeueOutputBuffer(bi, MediaConst.DEQUEUE_TIMEOUT_US)
            if (o < 0) return false
            val eos = bi.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            if (bi.size > 0) dec.releaseOutputBuffer(o, bi.presentationTimeUs * MediaConst.US_PER_MS) else dec.releaseOutputBuffer(o, false)
            if (eos && phase.onDecoderEos()) enc.signalEndOfInputStream()
            return true
        }

        /** 排空编码器：首次输出格式时启动封装器，其后的数据写入封装器并穿插音频。返回是否有进展 */
        private fun drainEncoder(enc: MediaCodec, mux: MediaMuxer, bi: MediaCodec.BufferInfo, totalMs: Long): Boolean {
            var progressed = false
            var timeout = MediaConst.DEQUEUE_TIMEOUT_US
            while (!phase.encoderDone) {
                val e = enc.dequeueOutputBuffer(bi, timeout)
                timeout = 0
                if (e == MediaCodec.INFO_TRY_AGAIN_LATER) break
                progressed = true
                if (e == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    videoOut = mux.addTrack(enc.outputFormat)
                    mux.start()
                    muxerStarted = true
                    phase.onEncoderFormatChanged()
                    continue
                }
                if (e < 0) continue
                val data = enc.getOutputBuffer(e)
                // 配置数据已包含在输出格式里，不写进样本
                if (bi.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) bi.size = 0
                if (bi.size > 0 && data != null) {
                    phase.requireMuxerStarted()
                    data.position(bi.offset)
                    data.limit(bi.offset + bi.size)
                    mux.writeSampleData(videoOut, data, bi)
                    lastVideoUs = bi.presentationTimeUs
                    onProgress(MediaPolicy.progressDoneMs(lastVideoUs, totalMs))
                    pumpAudio(lastVideoUs)
                }
                val eos = bi.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                enc.releaseOutputBuffer(e, false)
                if (eos) phase.onEncoderEos()
            }
            return progressed
        }

        /** 把时间戳不超过 [untilUs] 的音频样本直通写入封装器，封装器未启动时不动 */
        private fun pumpAudio(untilUs: Long) {
            val ex = audioEx ?: return
            val buf = audioBuf ?: return
            val mux = muxer ?: return
            if (!muxerStarted) return
            while (!audioDone) {
                val t = ex.sampleTime
                if (t < 0) {
                    audioDone = true
                    break
                }
                if (t > untilUs) break
                buf.clear()
                val n = ex.readSampleData(buf, 0)
                if (n < 0) {
                    audioDone = true
                    break
                }
                audioInfo.set(0, n, t, AudioExtractor.sampleFlagsToCodec(ex.sampleFlags))
                mux.writeSampleData(audioOut, buf, audioInfo)
                ex.advance()
            }
        }

        /** 找第一条指定类别的轨道 */
        private fun findTrack(ex: MediaExtractor, prefix: String): Int? {
            for (i in 0 until ex.trackCount) {
                val mime = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
                if (mime.startsWith(prefix)) return i
            }
            return null
        }

        /** 检查编码器支持该分辨率，并把码率收进它支持的范围；不支持时给出可解释的错误 */
        private fun fitBitrate(enc: MediaCodec, w: Int, h: Int, target: Long): Int {
            val vc = enc.codecInfo.getCapabilitiesForType(MediaConst.MIME_AVC).videoCapabilities
                ?: return target.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
            if (!vc.isSizeSupported(w, h)) {
                throw MediaUserException("设备的视频编码器不支持 ${w}x$h 的分辨率，当前版本不缩放分辨率，无法压缩这个视频")
            }
            val range = vc.bitrateRange
            return target.coerceIn(range.lower.toLong(), range.upper.toLong()).toInt()
        }

        /** 编码器是否支持 VBR 码率模式 */
        private fun supportsVbr(enc: MediaCodec): Boolean = try {
            enc.codecInfo.getCapabilitiesForType(MediaConst.MIME_AVC).encoderCapabilities
                ?.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR) == true
        } catch (_: Exception) {
            false
        }

        /** 释放所有对象，每一步各自兜底，互不影响 */
        fun release() {
            runCatching { decoder?.stop() }
            runCatching { decoder?.release() }
            runCatching { encoder?.stop() }
            runCatching { encoder?.release() }
            runCatching { surface?.release() }
            if (muxerStarted) runCatching { muxer?.stop() }
            runCatching { muxer?.release() }
            runCatching { videoEx.release() }
            runCatching { audioEx?.release() }
        }
    }

    private companion object {
        /** 可直通写入 mp4 的音轨编码 */
        val PASSTHROUGH_AUDIO = setOf(MediaConst.MIME_AAC, MediaConst.MIME_AMR_NB, MediaConst.MIME_AMR_WB)
    }
}
