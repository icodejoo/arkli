package com.let188.arkli.media

import com.let188.arkli.files.FileNames
import java.io.FileNotFoundException
import java.io.IOException
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** 视频与音频能力用到的常量；字面量集中在这里 */
object MediaConst {
    /** 方法名：视频信息 */
    const val METHOD_INFO = "native.media.info"

    /** 方法名：提取音频 */
    const val METHOD_EXTRACT_AUDIO = "native.media.extractAudio"

    /** 方法名：取帧 */
    const val METHOD_FRAMES = "native.media.frames"

    /** 方法名：压缩视频 */
    const val METHOD_COMPRESS = "native.media.compress"

    /** 进度事件名 */
    const val EVENT_PROGRESS = "media.progress"

    /** 进度事件最小间隔（毫秒） */
    const val PROGRESS_MIN_INTERVAL_MS = 200L

    /** 视频 mime 前缀 */
    const val PREFIX_VIDEO = "video/"

    /** 音频 mime 前缀 */
    const val PREFIX_AUDIO = "audio/"

    /** AAC 音轨 mime，唯一支持直通提取的编码 */
    const val MIME_AAC = "audio/mp4a-latm"

    /** AMR 窄带音轨 mime，mp4 容器可直通 */
    const val MIME_AMR_NB = "audio/3gpp"

    /** AMR 宽带音轨 mime，mp4 容器可直通 */
    const val MIME_AMR_WB = "audio/amr-wb"

    /** H.264 视频 mime，压缩的目标编码 */
    const val MIME_AVC = "video/avc"

    /** 提取音频产物的 mime */
    const val MIME_M4A = "audio/mp4"

    /** 压缩产物的 mime */
    const val MIME_MP4 = "video/mp4"

    /** 音频产物扩展名 */
    const val EXT_M4A = "m4a"

    /** 视频产物扩展名 */
    const val EXT_MP4 = "mp4"

    /** 压缩产物名后缀 */
    const val SUFFIX_COMPRESSED = "_compressed"

    /** 取帧缺省起点（毫秒） */
    const val DEFAULT_FRAME_START_MS = 0L

    /** 取帧缺省时长（毫秒） */
    const val DEFAULT_FRAME_DURATION_MS = 3000L

    /** 取帧时长上限（毫秒） */
    const val MAX_FRAME_DURATION_MS = 15_000L

    /** 取帧缺省帧率 */
    const val DEFAULT_FPS = 8

    /** 取帧帧率下限 */
    const val MIN_FPS = 1

    /** 取帧帧率上限 */
    const val MAX_FPS = 15

    /** 取帧缺省最大边（像素） */
    const val DEFAULT_MAX_EDGE = 320

    /** 取帧最大边下限（像素） */
    const val MIN_MAX_EDGE = 32

    /** 取帧最大边上限（像素） */
    const val MAX_MAX_EDGE = 480

    /** 总帧数上限 */
    const val MAX_FRAMES = 150

    /** 总像素预算：帧数上限 × 最大边平方 */
    const val MAX_TOTAL_FRAME_PIXELS = MAX_FRAMES.toLong() * MAX_MAX_EDGE * MAX_MAX_EDGE

    /** 帧 JPEG 质量 */
    const val FRAME_JPEG_QUALITY = 90

    /** 帧目录名前缀 */
    const val FRAMES_DIR_PREFIX = "frames-"

    /** 音频产物目录名前缀 */
    const val AUDIO_DIR_PREFIX = "audio-"

    /** 压缩产物目录名前缀 */
    const val VIDEO_DIR_PREFIX = "video-"

    /** 随机目录名长度 */
    const val DIR_ID_LENGTH = 8

    /** 微秒与毫秒换算 */
    const val US_PER_MS = 1000L

    /** 毫秒与秒换算 */
    const val MS_PER_SEC = 1000L

    /** 压缩码率下限（bps） */
    const val MIN_BITRATE_BPS = 300_000L

    /** 源码率读不到时，估算总码率里扣掉的音频码率（bps） */
    const val ASSUMED_AUDIO_BPS = 128_000L

    /** 源帧率读不到时的缺省值 */
    const val FALLBACK_FRAME_RATE = 30

    /** 合理帧率上限，超过按读不到处理 */
    const val MAX_SANE_FRAME_RATE = 120

    /** 关键帧间隔（秒） */
    const val I_FRAME_INTERVAL_S = 2

    /** 编解码器等待缓冲区的超时（微秒） */
    const val DEQUEUE_TIMEOUT_US = 10_000L

    /** 转码无任何进展多久判为卡死（毫秒） */
    const val STALL_LIMIT_MS = 20_000L

    /** 样本缓冲区大小（字节） */
    const val SAMPLE_BUFFER_BYTES = 1 shl 20

    /** 位数换算：1 字节 8 位 */
    const val BITS_PER_BYTE = 8L

    /** 旋转取值的整圈度数 */
    const val FULL_TURN = 360

    /** 错误信息里附带的原始说明最大长度 */
    const val DETAIL_MAX = 80
}

/**
 * 压缩预设：码率系数。
 *
 * @property key 页面传的预设名
 * @property factor 目标码率 = 源视频码率 × 系数
 */
enum class CompressPreset(val key: String, val factor: Double) {
    /** 高质量 */
    HIGH("high", 0.7),

    /** 均衡 */
    MEDIUM("medium", 0.5),

    /** 小体积 */
    LOW("low", 0.3),
}

/**
 * 音频裁剪窗口，单位微秒。
 *
 * @property startUs 起点
 * @property endUs 终点，`Long.MAX_VALUE` 表示到结尾
 */
class AudioWindow(val startUs: Long, val endUs: Long) {
    /** 样本时间是否在窗口内（含起点，含终点） */
    fun contains(timeUs: Long): Boolean = timeUs in startUs..endUs

    /** 样本时间减去起点后的输出时间戳，不小于 0 */
    fun shift(timeUs: Long): Long = max(0L, timeUs - startUs)

    /**
     * 窗口时长。
     *
     * @param totalMs 源总时长（毫秒），读不到传 null
     * @return 毫秒；终点是结尾且总时长未知返回 null
     */
    fun durationMs(totalMs: Long?): Long? {
        val end = if (endUs == Long.MAX_VALUE) (totalMs?.times(MediaConst.US_PER_MS) ?: return null) else endUs
        return max(0L, end - startUs) / MediaConst.US_PER_MS
    }
}

/** 转码失败发生的阶段，用来挑选提示语 */
enum class FailStage {
    /** 打开源文件、读轨道 */
    OPEN,

    /** 创建或配置解码器 */
    DECODER,

    /** 创建或配置编码器 */
    ENCODER,

    /** 转码循环中 */
    RUNNING,

    /** 写输出文件 */
    MUXER,
}

/** 用户能看懂的失败：消息直接给页面，对应 BAD_PARAMS */
class MediaUserException(message: String) : Exception(message)

/** 转码运行时失败（设备、编解码器、写文件等）：消息已是中文提示，对应 INTERNAL */
class MediaFailedException(message: String) : Exception(message)

/** 转码长时间没有进展 */
class MediaStalledException : Exception("转码长时间没有进展，已中止")

/** 视频与音频的纯逻辑：码率、采样时间表、时间窗、文件名、进度、错误分类 */
object MediaPolicy {
    /**
     * 解析压缩预设。
     *
     * @param key 预设名，`high` / `medium` / `low`
     * @return 预设
     * @throws IllegalArgumentException 缺失或不认识
     */
    fun preset(key: String?): CompressPreset =
        CompressPreset.values().firstOrNull { it.key == key } ?: throw IllegalArgumentException("preset 必须是 high、medium 或 low")

    /**
     * 目标视频码率：源码率 × 系数，不低于 300kbps，但不超过源码率。
     *
     * @param srcBps 源视频码率（bps）
     * @param preset 压缩预设
     * @return 目标码率（bps）；源码率本身低于下限时原样返回
     * @example targetBitrate(4_000_000, CompressPreset.MEDIUM) // 2_000_000
     */
    fun targetBitrate(srcBps: Long, preset: CompressPreset): Long {
        val scaled = (srcBps * preset.factor).roundToLong()
        return min(srcBps, max(MediaConst.MIN_BITRATE_BPS, scaled))
    }

    /**
     * 估算源视频码率：优先用视频轨自带值，其次总码率扣掉音频，最后按体积除时长。
     *
     * @param trackBps 视频轨码率，读不到传 null
     * @param totalBps 容器总码率，读不到传 null
     * @param sizeBytes 文件体积，读不到传 null
     * @param durationMs 时长（毫秒），读不到传 null
     * @param hasAudio 是否有音轨
     * @return bps；全部读不到返回 null
     */
    fun resolveSourceBitrate(trackBps: Long?, totalBps: Long?, sizeBytes: Long?, durationMs: Long?, hasAudio: Boolean): Long? {
        if (trackBps != null && trackBps > 0) return trackBps
        val audio = if (hasAudio) MediaConst.ASSUMED_AUDIO_BPS else 0L
        val total = when {
            totalBps != null && totalBps > 0 -> totalBps
            sizeBytes != null && sizeBytes > 0 && durationMs != null && durationMs > 0 ->
                sizeBytes * MediaConst.BITS_PER_BYTE * MediaConst.MS_PER_SEC / durationMs
            else -> return null
        }
        return max(MediaConst.MIN_BITRATE_BPS, total - audio)
    }

    /**
     * 预计压缩后体积（页面也有同一公式）：视频码率 × 系数 × 时长 + 音频。
     *
     * @param srcVideoBps 源视频码率
     * @param audioBps 音频码率，没有音轨传 0
     * @param durationMs 时长（毫秒）
     * @param preset 预设
     * @return 字节数
     */
    fun estimateOutputBytes(srcVideoBps: Long, audioBps: Long, durationMs: Long, preset: CompressPreset): Long =
        (targetBitrate(srcVideoBps, preset) + audioBps) * durationMs / MediaConst.MS_PER_SEC / MediaConst.BITS_PER_BYTE

    /**
     * 规整旋转角。
     *
     * @param raw 原始值，可为 null 或负数
     * @return 0 / 90 / 180 / 270；不是 90 的整数倍按 0
     */
    fun normalizeRotation(raw: Int?): Int {
        if (raw == null) return 0
        val r = ((raw % MediaConst.FULL_TURN) + MediaConst.FULL_TURN) % MediaConst.FULL_TURN
        return if (r % 90 == 0) r else 0
    }

    /**
     * 按旋转摆正宽高。
     *
     * @param width 编码宽
     * @param height 编码高
     * @param rotation 规整后的旋转角
     * @return 显示用 (宽, 高)
     */
    fun orientedSize(width: Int, height: Int, rotation: Int): Pair<Int, Int> =
        if (rotation == 90 || rotation == 270) height to width else width to height

    /**
     * 编码用帧率：源帧率合理就沿用，否则 30。
     *
     * @param sourceFps 源帧率，读不到传 null
     * @return 整数帧率
     */
    fun encodeFrameRate(sourceFps: Double?): Int {
        if (sourceFps == null || sourceFps < 1 || sourceFps > MediaConst.MAX_SANE_FRAME_RATE) return MediaConst.FALLBACK_FRAME_RATE
        return max(1, sourceFps.roundToInt())
    }

    /**
     * 校验取帧参数范围。
     *
     * @param durationMs 取帧时长
     * @param fps 帧率
     * @param maxEdge 最大边
     * @throws IllegalArgumentException 超范围
     */
    fun requireFrameParams(durationMs: Long, fps: Int, maxEdge: Int) {
        require(durationMs in 1..MediaConst.MAX_FRAME_DURATION_MS) { "durationMs 必须在 1..${MediaConst.MAX_FRAME_DURATION_MS}" }
        require(fps in MediaConst.MIN_FPS..MediaConst.MAX_FPS) { "fps 必须在 ${MediaConst.MIN_FPS}..${MediaConst.MAX_FPS}" }
        require(maxEdge in MediaConst.MIN_MAX_EDGE..MediaConst.MAX_MAX_EDGE) {
            "maxEdge 必须在 ${MediaConst.MIN_MAX_EDGE}..${MediaConst.MAX_MAX_EDGE}"
        }
    }

    /**
     * 取帧时间表：从起点按 `1000/fps` 毫秒间隔取样，不超过时长窗口、视频结尾和总帧数上限。
     *
     * @param startMs 起点（毫秒，>= 0）
     * @param durationMs 取帧时长（毫秒）
     * @param fps 帧率
     * @param totalMs 视频总时长，读不到传 null
     * @return 每帧的时间点（毫秒）；起点已超出视频时长时为空
     * @example frameTimes(0, 1000, 4, null) // [0, 250, 500, 750]
     */
    fun frameTimes(startMs: Long, durationMs: Long, fps: Int, totalMs: Long?): List<Long> {
        val windowEnd = startMs + durationMs
        val end = if (totalMs != null) min(windowEnd, totalMs) else windowEnd
        val out = ArrayList<Long>()
        var i = 0
        while (out.size < MediaConst.MAX_FRAMES) {
            val t = startMs + i * MediaConst.MS_PER_SEC / fps
            if (t >= end) break
            out.add(t)
            i++
        }
        return out
    }

    /**
     * 按最大边缩小，不放大，保持比例。
     *
     * @param width 源宽
     * @param height 源高
     * @param maxEdge 最大边
     * @return 缩小后的 (宽, 高)，每边至少 1
     */
    fun scaledSize(width: Int, height: Int, maxEdge: Int): Pair<Int, Int> {
        val longest = max(width, height)
        if (longest <= maxEdge) return width to height
        val k = maxEdge.toDouble() / longest
        return max(1, (width * k).roundToInt()) to max(1, (height * k).roundToInt())
    }

    /**
     * 校验取帧总量：帧数与总像素都要在预算内。
     *
     * @param count 帧数
     * @param width 单帧宽
     * @param height 单帧高
     * @throws IllegalArgumentException 超预算或没有帧
     */
    fun requireFramePlan(count: Int, width: Int, height: Int) {
        require(count > 0) { "起点超出视频时长，没有可取的帧" }
        require(count <= MediaConst.MAX_FRAMES) { "帧数超过上限 ${MediaConst.MAX_FRAMES}" }
        require(count.toLong() * width * height <= MediaConst.MAX_TOTAL_FRAME_PIXELS) { "帧总像素超出预算，请降低最大边或时长" }
    }

    /**
     * 换算音频时间窗。
     *
     * @param startMs 起点（毫秒），null 视为 0
     * @param endMs 终点（毫秒），null 视为到结尾
     * @param totalMs 视频总时长，读不到传 null
     * @return 微秒窗口；终点超过总时长时收到总时长
     * @throws IllegalArgumentException 起点为负、终点不大于起点、起点不在视频内
     */
    fun audioWindow(startMs: Long?, endMs: Long?, totalMs: Long?): AudioWindow {
        val s = startMs ?: 0L
        require(s >= 0) { "startMs 不能为负" }
        if (endMs != null) require(endMs > s) { "endMs 必须大于 startMs" }
        if (totalMs != null && totalMs > 0) require(s < totalMs) { "startMs 超出视频时长" }
        val e = when {
            endMs == null -> Long.MAX_VALUE
            totalMs != null && totalMs > 0 -> min(endMs, totalMs) * MediaConst.US_PER_MS
            else -> endMs * MediaConst.US_PER_MS
        }
        return AudioWindow(s * MediaConst.US_PER_MS, e)
    }

    /**
     * 产物文件名：源名主体清洗后换扩展名。
     *
     * @param sourceName 源文件名，可为 null
     * @param ext 扩展名，不带点
     * @param suffix 加在主体后面的后缀，可为空
     * @return 如 `旅行.mp4` -> `旅行.m4a`；源名为空用 `file`
     */
    fun outputName(sourceName: String?, ext: String, suffix: String = ""): String {
        val clean = FileNames.sanitize(sourceName)
        val dot = clean.lastIndexOf('.')
        val base = if (dot > 0) clean.substring(0, dot) else clean
        return FileNames.sanitize("$base$suffix.$ext")
    }

    /**
     * 把样本时间换算成已处理毫秒，夹在 0..总时长。
     *
     * @param timeUs 当前样本时间（微秒）
     * @param totalMs 总时长（毫秒）
     * @return 已处理毫秒
     */
    fun progressDoneMs(timeUs: Long, totalMs: Long): Long =
        (timeUs / MediaConst.US_PER_MS).coerceIn(0L, max(0L, totalMs))

    /**
     * 压缩比。
     *
     * @param outBytes 产物字节数
     * @param srcBytes 源字节数
     * @return 产物 / 源；源体积未知（<=0）返回 1.0
     */
    fun ratio(outBytes: Long, srcBytes: Long): Double = if (srcBytes <= 0) 1.0 else outBytes.toDouble() / srcBytes

    /**
     * 压缩后没变小时的说明。
     *
     * @param ratio 压缩比
     * @return 提示语；已变小返回 null
     */
    fun notSmallerNote(ratio: Double): String? =
        if (ratio >= 1.0) "视频已经压得很小了，再压反而更大，建议保留原视频" else null

    /**
     * 把异常转成中文提示。
     *
     * @param stage 出错阶段
     * @param error 异常
     * @return 给页面看的一句话
     */
    fun describeFailure(stage: FailStage, error: Throwable): String {
        if (error is MediaUserException || error is MediaFailedException || error is MediaStalledException) return error.message ?: "处理失败"
        val raw = error.message.orEmpty()
        if (error is FileNotFoundException || error is SecurityException) return "读取不到这个视频，请重新选择"
        if (error is IOException && (raw.contains("ENOSPC") || raw.contains("No space"))) return "存储空间不足，请清理后重试"
        val head = when (stage) {
            FailStage.OPEN -> "无法读取这个视频，文件可能已损坏或格式不支持"
            FailStage.DECODER -> "设备的视频解码器无法处理这个视频"
            FailStage.ENCODER -> "设备的视频编码器无法按当前参数压缩这个视频"
            FailStage.MUXER -> "写入输出文件失败"
            FailStage.RUNNING -> "处理过程中出错"
        }
        val detail = raw.trim().take(MediaConst.DETAIL_MAX)
        return if (detail.isEmpty()) head else "$head（$detail）"
    }
}

/**
 * 进度节流：至多每隔 [minIntervalMs] 放行一次，结束时强制放行。
 *
 * @param minIntervalMs 最小间隔（毫秒）
 */
class ProgressThrottle(private val minIntervalMs: Long = MediaConst.PROGRESS_MIN_INTERVAL_MS) {
    /** 上次放行的时刻 */
    private var lastMs = Long.MIN_VALUE

    /**
     * 是否该推这一次进度。
     *
     * @param nowMs 当前时刻（毫秒，单调即可）
     * @param force 为 true 时一定放行（如完成时）
     * @return 放行返回 true，并记下时刻
     */
    fun allow(nowMs: Long, force: Boolean = false): Boolean {
        if (!force && lastMs != Long.MIN_VALUE && nowMs - lastMs < minIntervalMs) return false
        lastMs = nowMs
        return true
    }
}

/**
 * 卡死检测：连续 [limitMs] 毫秒没有任何进展就报警。
 *
 * @param limitMs 允许的最长无进展时间
 */
class StallGuard(private val limitMs: Long = MediaConst.STALL_LIMIT_MS) {
    /** 最近一次有进展的时刻 */
    private var lastProgressMs = Long.MIN_VALUE

    /**
     * 记一次循环。
     *
     * @param nowMs 当前时刻（毫秒）
     * @param progressed 本轮是否有进展
     * @return 已卡死返回 true
     */
    fun stalled(nowMs: Long, progressed: Boolean): Boolean {
        if (lastProgressMs == Long.MIN_VALUE || progressed) lastProgressMs = nowMs
        return nowMs - lastProgressMs > limitMs
    }
}

/**
 * 转码流程的阶段状态：输入结束、EOS 传播、封装器只在编码器给出输出格式后启动。
 * 只记状态，不碰任何 Android 对象，便于单测。
 */
class TranscodePhase {
    /** 源数据已读完并送出结束标记 */
    var extractorDone = false
        private set

    /** 解码器已输出结束标记 */
    var decoderDone = false
        private set

    /** 编码器已输出结束标记，整个流程结束 */
    var encoderDone = false
        private set

    /** 封装器是否已启动 */
    var muxerStarted = false
        private set

    /** 源数据读完 */
    fun onSourceEnd() {
        extractorDone = true
    }

    /**
     * 解码器输出了结束标记。
     *
     * @return 第一次返回 true，调用方此时应让编码器结束输入；之后返回 false
     */
    fun onDecoderEos(): Boolean {
        if (decoderDone) return false
        decoderDone = true
        return true
    }

    /**
     * 编码器报告了输出格式，封装器此时才能启动。
     *
     * @throws IllegalStateException 重复报告
     */
    fun onEncoderFormatChanged() {
        check(!muxerStarted) { "编码器重复报告输出格式" }
        muxerStarted = true
    }

    /**
     * 编码器给出了数据前确认封装器已启动。
     *
     * @throws IllegalStateException 还没拿到输出格式
     */
    fun requireMuxerStarted() {
        check(muxerStarted) { "编码器在报告输出格式之前就输出了数据" }
    }

    /** 编码器输出了结束标记 */
    fun onEncoderEos() {
        encoderDone = true
    }
}
