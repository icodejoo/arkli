package com.let188.arkli.media

import android.net.Uri
import android.os.SystemClock
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.FileEnv
import com.let188.arkli.files.HandleTable
import com.let188.arkli.files.requireMainFrame
import com.let188.arkli.system.SystemParams
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.ensureActive

/**
 * 媒体处理器的公共部分：句柄解析、可选数字参数、进度推送、错误转换。
 *
 * @param env 文件环境
 * @param handles 本会话的视频句柄表（与 `native.file.pick` 共用）
 */
internal abstract class MediaHandlerBase(protected val env: FileEnv, private val handles: HandleTable<Uri>) : BridgeHandler {
    /** 视频信息读取器 */
    protected val reader = MediaInfoReader(env.appContext)

    /** 缓存 `out/` 目录 */
    protected val outDir = File(env.roots.cacheRoot, com.let188.arkli.files.FileConst.DIR_OUT)

    /** 解析并校验视频句柄，无效抛 BAD_PARAMS */
    protected fun uriOf(params: JSONObject): Uri {
        val handle = SystemParams.string(params, "handle")
        return handles.get(handle) ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "无效的视频句柄，请重新选择视频")
    }

    /** 读可选整数，缺省或 null 返回 null，类型不对抛 BAD_PARAMS */
    protected fun longOrNull(p: JSONObject, key: String): Long? {
        val v = p.opt(key)
        if (v == null || v == JSONObject.NULL) return null
        return (v as? Number)?.toLong() ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "$key 必须是数字")
    }

    /** 读可选整数（Int 版本） */
    protected fun intOrNull(p: JSONObject, key: String): Int? = longOrNull(p, key)?.toInt()

    /** 新建本次产物目录 `out/<前缀><随机>/` */
    protected fun newOutDir(prefix: String): File {
        val dir = File(outDir, prefix + UUID.randomUUID().toString().take(MediaConst.DIR_ID_LENGTH))
        if (!dir.mkdirs() && !dir.isDirectory) throw BridgeException(BridgeErrors.INTERNAL, "无法创建输出目录")
        return dir
    }

    /** 产物文件转页面缓存相对路径 */
    protected fun pagePath(file: File): String =
        env.roots.pagePathOf(file) ?: throw BridgeException(BridgeErrors.INTERNAL, "产物不在缓存目录内")

    /**
     * 执行一段在 IO 线程上的原生工作，并把异常转成协议错误：
     * 可解释的失败（[MediaUserException]）为 BAD_PARAMS，其余为 INTERNAL 带中文提示，取消照常向上抛。
     */
    protected suspend fun <T> guarded(stage: FailStage, block: suspend () -> T): T = try {
        withContext(Dispatchers.IO) { block() }
    } catch (e: CancellationException) {
        throw e
    } catch (e: BridgeException) {
        throw e
    } catch (e: MediaUserException) {
        throw BridgeException(BridgeErrors.BAD_PARAMS, e.message ?: "参数不合法")
    } catch (e: Throwable) {
        throw BridgeException(BridgeErrors.INTERNAL, MediaPolicy.describeFailure(stage, e))
    }

    /** 推进度事件的节流器：至多每 200ms 一次 */
    protected fun progressEmitter(ctx: CallContext): (Long, Long, Boolean) -> Unit {
        val throttle = ProgressThrottle()
        return { done, total, force ->
            if (throttle.allow(SystemClock.elapsedRealtime(), force)) {
                ctx.emit(MediaConst.EVENT_PROGRESS, JSONObject().put("done", done).put("total", total))
            }
        }
    }
}

/**
 * `native.media.info`：`{ handle }` -> `{ durationMs, width, height, rotation, bitrate, sizeBytes, hasAudio, videoMime, audioMime, fps }`，
 * 读不到的字段为 null，宽高已按旋转摆正。
 */
internal class MediaInfoHandler(env: FileEnv, handles: HandleTable<Uri>) : MediaHandlerBase(env, handles) {
    /** 读取信息 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val uri = uriOf(params)
        return guarded(FailStage.OPEN) { reader.read(uri).toJson() }
    }
}

/**
 * `native.media.extractAudio`：`{ handle, startMs?, endMs? }` -> `{ path, name, mime, bytes, durationMs }`。
 * 只支持 AAC 直通，封装成 `.m4a`；其他编码或没有音轨返回 BAD_PARAMS。
 */
internal class ExtractAudioHandler(env: FileEnv, handles: HandleTable<Uri>) : MediaHandlerBase(env, handles) {
    /** 音频提取器 */
    private val extractor = AudioExtractor(env.appContext)

    /** 提取音频 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val uri = uriOf(params)
        val startMs = longOrNull(params, "startMs")
        val endMs = longOrNull(params, "endMs")
        val emit = progressEmitter(ctx)
        val cc = coroutineContext
        return guarded(FailStage.RUNNING) {
            val info = reader.read(uri)
            val window = SystemParams.validated { MediaPolicy.audioWindow(startMs, endMs, info.durationMs) }
            val dir = newOutDir(MediaConst.AUDIO_DIR_PREFIX)
            val file = File(dir, MediaPolicy.outputName(reader.displayName(uri), MediaConst.EXT_M4A))
            var ok = false
            try {
                val durationMs = extractor.extract(uri, window, info.durationMs, file, { cc.ensureActive() }, { d, t -> emit(d, t, false) })
                ok = true
                window.durationMs(info.durationMs)?.let { emit(it, it, true) }
                JSONObject().put("path", pagePath(file)).put("name", file.name).put("mime", MediaConst.MIME_M4A)
                    .put("bytes", file.length()).put("durationMs", durationMs)
            } finally {
                if (!ok) FrameExtractor.deleteDir(dir)
            }
        }
    }
}

/**
 * `native.media.frames`：`{ handle, startMs?, durationMs?, fps?, maxEdge? }` -> `{ frames: [{ path, timeMs }], width, height }`。
 * 帧是 JPEG，写在缓存 `out/frames-<随机>/` 下；总帧数最多 150。
 */
internal class FramesHandler(env: FileEnv, handles: HandleTable<Uri>) : MediaHandlerBase(env, handles) {
    /** 取帧器 */
    private val extractor = FrameExtractor(env.appContext)

    /** 取帧 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val uri = uriOf(params)
        val startMs = longOrNull(params, "startMs") ?: MediaConst.DEFAULT_FRAME_START_MS
        val durationMs = longOrNull(params, "durationMs") ?: MediaConst.DEFAULT_FRAME_DURATION_MS
        val fps = intOrNull(params, "fps") ?: MediaConst.DEFAULT_FPS
        val maxEdge = intOrNull(params, "maxEdge") ?: MediaConst.DEFAULT_MAX_EDGE
        SystemParams.validated {
            require(startMs >= 0) { "startMs 不能为负" }
            MediaPolicy.requireFrameParams(durationMs, fps, maxEdge)
        }
        val emit = progressEmitter(ctx)
        val cc = coroutineContext
        return guarded(FailStage.RUNNING) {
            val info = reader.read(uri)
            val times = MediaPolicy.frameTimes(startMs, durationMs, fps, info.durationMs)
            val (srcW, srcH) = (info.width ?: 0) to (info.height ?: 0)
            val (w, h) = if (srcW > 0 && srcH > 0) MediaPolicy.scaledSize(srcW, srcH, maxEdge) else maxEdge to maxEdge
            SystemParams.validated { MediaPolicy.requireFramePlan(times.size, w, h) }
            val dir = newOutDir(MediaConst.FRAMES_DIR_PREFIX)
            val got = extractor.extract(uri, times, w, h, dir, { cc.ensureActive() }, { n -> emit(n.toLong(), times.size.toLong(), n == times.size) })
            val frames = JSONArray()
            for ((file, t) in got.files) frames.put(JSONObject().put("path", pagePath(file)).put("timeMs", t))
            JSONObject().put("frames", frames).put("width", got.width).put("height", got.height)
        }
    }
}

/**
 * `native.media.compress`：`{ handle, preset: "high"|"medium"|"low" }`
 * -> `{ path, name, bytes, srcBytes, ratio, durationMs, message? }`。
 * 只降码率不缩放分辨率；`ratio >= 1` 表示没压小，此时带 `message` 说明。
 */
internal class CompressHandler(env: FileEnv, handles: HandleTable<Uri>) : MediaHandlerBase(env, handles) {
    /** 转码器 */
    private val compressor = VideoCompressor(env.appContext)

    /** 压缩 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val uri = uriOf(params)
        val preset = SystemParams.validated { MediaPolicy.preset(SystemParams.stringOrNull(params, "preset")) }
        val emit = progressEmitter(ctx)
        val cc = coroutineContext
        return guarded(FailStage.RUNNING) {
            val info = reader.read(uri)
            val total = info.durationMs ?: 0L
            val dir = newOutDir(MediaConst.VIDEO_DIR_PREFIX)
            val file = File(dir, MediaPolicy.outputName(reader.displayName(uri), MediaConst.EXT_MP4, MediaConst.SUFFIX_COMPRESSED))
            var ok = false
            try {
                compressor.compress(uri, info, preset, file, { cc.ensureActive() }, { d -> emit(d, total, false) })
                ok = true
                emit(total, total, true)
                val bytes = file.length()
                val src = info.sizeBytes ?: 0L
                val ratio = MediaPolicy.ratio(bytes, src)
                val r = JSONObject().put("path", pagePath(file)).put("name", file.name).put("bytes", bytes)
                    .put("srcBytes", src).put("ratio", ratio).put("durationMs", total)
                MediaPolicy.notSmallerNote(ratio)?.let { r.put("message", it) }
                r
            } finally {
                if (!ok) FrameExtractor.deleteDir(dir)
            }
        }
    }
}
