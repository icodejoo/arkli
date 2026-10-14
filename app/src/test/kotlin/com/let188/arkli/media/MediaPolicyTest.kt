package com.let188.arkli.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.FileNotFoundException
import java.io.IOException

/** 视频与音频纯逻辑：码率、采样时间表、时间窗、文件名、进度节流、预设、错误分类、转码状态机 */
class MediaPolicyTest {
    @Test
    fun presetParsing() {
        assertEquals(CompressPreset.HIGH, MediaPolicy.preset("high"))
        assertEquals(CompressPreset.MEDIUM, MediaPolicy.preset("medium"))
        assertEquals(CompressPreset.LOW, MediaPolicy.preset("low"))
        for (bad in listOf(null, "", "HIGH", "ultra")) {
            assertThrows(IllegalArgumentException::class.java) { MediaPolicy.preset(bad) }
        }
    }

    @Test
    fun targetBitrateAppliesFactor() {
        assertEquals(2_800_000L, MediaPolicy.targetBitrate(4_000_000, CompressPreset.HIGH))
        assertEquals(2_000_000L, MediaPolicy.targetBitrate(4_000_000, CompressPreset.MEDIUM))
        assertEquals(1_200_000L, MediaPolicy.targetBitrate(4_000_000, CompressPreset.LOW))
    }

    @Test
    fun targetBitrateHasFloorAndCeiling() {
        // 系数算出来低于下限，抬到 300kbps
        assertEquals(300_000L, MediaPolicy.targetBitrate(800_000, CompressPreset.LOW))
        // 源本身比下限还低：不能超过源
        assertEquals(200_000L, MediaPolicy.targetBitrate(200_000, CompressPreset.LOW))
        assertEquals(200_000L, MediaPolicy.targetBitrate(200_000, CompressPreset.HIGH))
        // 永远不超过源
        for (p in CompressPreset.values()) assertTrue(MediaPolicy.targetBitrate(1_000_000, p) <= 1_000_000L)
    }

    @Test
    fun sourceBitratePriority() {
        assertEquals(5_000_000L, MediaPolicy.resolveSourceBitrate(5_000_000, 6_000_000, 1, 1, true))
        // 无轨码率：总码率扣音频
        assertEquals(5_872_000L, MediaPolicy.resolveSourceBitrate(null, 6_000_000, null, null, true))
        assertEquals(6_000_000L, MediaPolicy.resolveSourceBitrate(0, 6_000_000, null, null, false))
        // 体积 / 时长：1MB / 8s = 1_000_000 bps，扣音频 128k
        assertEquals(872_000L, MediaPolicy.resolveSourceBitrate(null, null, 1_000_000, 8000, true))
        assertNull(MediaPolicy.resolveSourceBitrate(null, null, null, null, true))
        assertNull(MediaPolicy.resolveSourceBitrate(null, null, 1000, 0, true))
        // 扣完低于下限时抬到下限
        assertEquals(MediaConst.MIN_BITRATE_BPS, MediaPolicy.resolveSourceBitrate(null, 350_000, null, null, true))
    }

    @Test
    fun estimateOutputBytes() {
        // (2Mbps + 128kbps) * 10s / 8
        assertEquals(2_660_000L, MediaPolicy.estimateOutputBytes(4_000_000, 128_000, 10_000, CompressPreset.MEDIUM))
    }

    @Test
    fun rotationNormalizing() {
        assertEquals(0, MediaPolicy.normalizeRotation(null))
        assertEquals(90, MediaPolicy.normalizeRotation(90))
        assertEquals(270, MediaPolicy.normalizeRotation(-90))
        assertEquals(0, MediaPolicy.normalizeRotation(360))
        assertEquals(180, MediaPolicy.normalizeRotation(540))
        assertEquals(0, MediaPolicy.normalizeRotation(45))
        assertEquals(1080 to 1920, MediaPolicy.orientedSize(1920, 1080, 90))
        assertEquals(1080 to 1920, MediaPolicy.orientedSize(1920, 1080, 270))
        assertEquals(1920 to 1080, MediaPolicy.orientedSize(1920, 1080, 180))
        assertEquals(1920 to 1080, MediaPolicy.orientedSize(1920, 1080, 0))
    }

    @Test
    fun encodeFrameRate() {
        assertEquals(30, MediaPolicy.encodeFrameRate(null))
        assertEquals(30, MediaPolicy.encodeFrameRate(0.0))
        assertEquals(30, MediaPolicy.encodeFrameRate(500.0))
        assertEquals(24, MediaPolicy.encodeFrameRate(23.98))
        assertEquals(60, MediaPolicy.encodeFrameRate(60.0))
    }

    @Test
    fun frameParamRanges() {
        MediaPolicy.requireFrameParams(3000, 8, 320)
        MediaPolicy.requireFrameParams(15_000, 15, 480)
        MediaPolicy.requireFrameParams(1, 1, 32)
        assertThrows(IllegalArgumentException::class.java) { MediaPolicy.requireFrameParams(0, 8, 320) }
        assertThrows(IllegalArgumentException::class.java) { MediaPolicy.requireFrameParams(15_001, 8, 320) }
        assertThrows(IllegalArgumentException::class.java) { MediaPolicy.requireFrameParams(3000, 0, 320) }
        assertThrows(IllegalArgumentException::class.java) { MediaPolicy.requireFrameParams(3000, 16, 320) }
        assertThrows(IllegalArgumentException::class.java) { MediaPolicy.requireFrameParams(3000, 8, 481) }
        assertThrows(IllegalArgumentException::class.java) { MediaPolicy.requireFrameParams(3000, 8, 8) }
    }

    @Test
    fun frameTimesBasic() {
        assertEquals(listOf(0L, 250L, 500L, 750L), MediaPolicy.frameTimes(0, 1000, 4, null))
        assertEquals(listOf(1000L, 1500L), MediaPolicy.frameTimes(1000, 1000, 2, null))
        // 8fps 3 秒 = 24 帧，间隔 125ms
        val t = MediaPolicy.frameTimes(0, 3000, 8, null)
        assertEquals(24, t.size)
        assertEquals(125L, t[1])
        assertEquals(2875L, t.last())
    }

    @Test
    fun frameTimesClampedByVideoEnd() {
        assertEquals(listOf(1000L, 1500L), MediaPolicy.frameTimes(1000, 5000, 2, 2000))
        assertTrue(MediaPolicy.frameTimes(5000, 1000, 8, 2000).isEmpty())
    }

    @Test
    fun frameTimesCappedAtMaxFrames() {
        // 15 秒 15fps = 225 帧，截到 150
        val t = MediaPolicy.frameTimes(0, 15_000, 15, null)
        assertEquals(MediaConst.MAX_FRAMES, t.size)
        assertEquals(0L, t.first())
        // 非整除帧率（7fps）时间点取整且单调
        val t7 = MediaPolicy.frameTimes(0, 1000, 7, null)
        assertEquals(7, t7.size)
        assertEquals(listOf(0L, 142L, 285L, 428L, 571L, 714L, 857L), t7)
    }

    @Test
    fun scaledSize() {
        assertEquals(320 to 180, MediaPolicy.scaledSize(1920, 1080, 320))
        assertEquals(180 to 320, MediaPolicy.scaledSize(1080, 1920, 320))
        // 不放大
        assertEquals(200 to 100, MediaPolicy.scaledSize(200, 100, 320))
        // 极端比例至少 1 像素
        assertEquals(320 to 1, MediaPolicy.scaledSize(10_000, 1, 320))
    }

    @Test
    fun framePlanBudget() {
        MediaPolicy.requireFramePlan(150, 480, 480)
        MediaPolicy.requireFramePlan(24, 320, 180)
        assertThrows(IllegalArgumentException::class.java) { MediaPolicy.requireFramePlan(0, 320, 180) }
        assertThrows(IllegalArgumentException::class.java) { MediaPolicy.requireFramePlan(151, 10, 10) }
        assertThrows(IllegalArgumentException::class.java) { MediaPolicy.requireFramePlan(150, 481, 480) }
    }

    @Test
    fun audioWindowDefaults() {
        val w = MediaPolicy.audioWindow(null, null, 60_000)
        assertEquals(0L, w.startUs)
        assertEquals(Long.MAX_VALUE, w.endUs)
        assertEquals(60_000L, w.durationMs(60_000))
        assertNull(w.durationMs(null))
    }

    @Test
    fun audioWindowConvertsAndShifts() {
        val w = MediaPolicy.audioWindow(5_000, 15_000, 60_000)
        assertEquals(5_000_000L, w.startUs)
        assertEquals(15_000_000L, w.endUs)
        assertEquals(10_000L, w.durationMs(60_000))
        assertTrue(w.contains(5_000_000))
        assertTrue(w.contains(15_000_000))
        assertFalse(w.contains(4_999_999))
        assertFalse(w.contains(15_000_001))
        assertEquals(0L, w.shift(5_000_000))
        assertEquals(1_000L, w.shift(5_001_000))
        // 前面的样本（seek 回到关键帧前）不会出现负时间戳
        assertEquals(0L, w.shift(4_000_000))
    }

    @Test
    fun audioWindowClampsAndValidates() {
        assertEquals(60_000_000L, MediaPolicy.audioWindow(0, 90_000, 60_000).endUs)
        assertEquals(90_000_000L, MediaPolicy.audioWindow(0, 90_000, null).endUs)
        assertThrows(IllegalArgumentException::class.java) { MediaPolicy.audioWindow(-1, null, 1000) }
        assertThrows(IllegalArgumentException::class.java) { MediaPolicy.audioWindow(500, 500, 1000) }
        assertThrows(IllegalArgumentException::class.java) { MediaPolicy.audioWindow(600, 500, 1000) }
        assertThrows(IllegalArgumentException::class.java) { MediaPolicy.audioWindow(1000, null, 1000) }
    }

    @Test
    fun outputNames() {
        assertEquals("旅行.m4a", MediaPolicy.outputName("旅行.mp4", "m4a"))
        assertEquals("a.b.m4a", MediaPolicy.outputName("a.b.mp4", "m4a"))
        assertEquals("clip_compressed.mp4", MediaPolicy.outputName("clip.MOV", "mp4", "_compressed"))
        assertEquals("file.m4a", MediaPolicy.outputName(null, "m4a"))
        assertEquals("x_y.m4a", MediaPolicy.outputName("x:y.mp4", "m4a"))
        assertEquals("evil.m4a", MediaPolicy.outputName("../../evil.mp4", "m4a"))
        assertEquals("noext.m4a", MediaPolicy.outputName("noext", "m4a"))
    }

    @Test
    fun progressConversion() {
        assertEquals(500L, MediaPolicy.progressDoneMs(500_000, 1000))
        assertEquals(1000L, MediaPolicy.progressDoneMs(2_000_000, 1000))
        assertEquals(0L, MediaPolicy.progressDoneMs(-5, 1000))
        assertEquals(0L, MediaPolicy.progressDoneMs(500_000, 0))
    }

    @Test
    fun progressThrottle() {
        val t = ProgressThrottle(200)
        assertTrue(t.allow(1000))
        assertFalse(t.allow(1100))
        assertFalse(t.allow(1199))
        assertTrue(t.allow(1200))
        assertFalse(t.allow(1300))
        // 强制放行（完成时）
        assertTrue(t.allow(1301, force = true))
        assertFalse(t.allow(1400))
    }

    @Test
    fun stallGuard() {
        val g = StallGuard(1000)
        assertFalse(g.stalled(0, false))
        assertFalse(g.stalled(1000, false))
        assertTrue(g.stalled(1001, false))
        // 有进展后重新计时
        assertFalse(g.stalled(1500, true))
        assertFalse(g.stalled(2500, false))
        assertTrue(g.stalled(2501, false))
    }

    @Test
    fun ratioAndNote() {
        assertEquals(0.5, MediaPolicy.ratio(50, 100), 1e-9)
        assertEquals(1.0, MediaPolicy.ratio(50, 0), 1e-9)
        assertNull(MediaPolicy.notSmallerNote(0.99))
        assertTrue(MediaPolicy.notSmallerNote(1.0)!!.contains("已经压得很小"))
        assertTrue(MediaPolicy.notSmallerNote(1.3)!!.isNotEmpty())
    }

    @Test
    fun failureClassification() {
        assertEquals("自定义", MediaPolicy.describeFailure(FailStage.RUNNING, MediaUserException("自定义")))
        assertEquals("读取不到这个视频，请重新选择", MediaPolicy.describeFailure(FailStage.OPEN, FileNotFoundException("x")))
        assertEquals("读取不到这个视频，请重新选择", MediaPolicy.describeFailure(FailStage.OPEN, SecurityException("x")))
        assertEquals("存储空间不足，请清理后重试", MediaPolicy.describeFailure(FailStage.MUXER, IOException("write failed: ENOSPC (No space left on device)")))
        assertTrue(MediaPolicy.describeFailure(FailStage.DECODER, IllegalStateException("boom")).startsWith("设备的视频解码器"))
        assertTrue(MediaPolicy.describeFailure(FailStage.ENCODER, IllegalArgumentException()).startsWith("设备的视频编码器"))
        assertEquals("写入输出文件失败", MediaPolicy.describeFailure(FailStage.MUXER, RuntimeException()))
        assertTrue(MediaPolicy.describeFailure(FailStage.OPEN, RuntimeException("bad")).contains("（bad）"))
        // 原始说明过长会截断
        val long = MediaPolicy.describeFailure(FailStage.RUNNING, RuntimeException("x".repeat(500)))
        assertTrue(long.length < 200)
        assertTrue(MediaPolicy.describeFailure(FailStage.RUNNING, MediaStalledException()).contains("没有进展"))
    }

    @Test
    fun transcodeStateMachineHappyPath() {
        val p = TranscodePhase()
        assertFalse(p.extractorDone)
        // 封装器未启动时不允许写数据
        assertThrows(IllegalStateException::class.java) { p.requireMuxerStarted() }
        p.onEncoderFormatChanged()
        assertTrue(p.muxerStarted)
        p.requireMuxerStarted()
        p.onSourceEnd()
        assertTrue(p.extractorDone)
        // EOS 只传播一次
        assertTrue(p.onDecoderEos())
        assertFalse(p.onDecoderEos())
        assertTrue(p.decoderDone)
        assertFalse(p.encoderDone)
        p.onEncoderEos()
        assertTrue(p.encoderDone)
    }

    @Test
    fun transcodeStateMachineRejectsDoubleFormatChange() {
        val p = TranscodePhase()
        p.onEncoderFormatChanged()
        assertThrows(IllegalStateException::class.java) { p.onEncoderFormatChanged() }
    }

    @Test
    fun constantsAreConsistent() {
        assertEquals(150L * 480 * 480, MediaConst.MAX_TOTAL_FRAME_PIXELS)
        assertEquals("audio/mp4a-latm", MediaConst.MIME_AAC)
        assertEquals("media.progress", MediaConst.EVENT_PROGRESS)
    }
}
