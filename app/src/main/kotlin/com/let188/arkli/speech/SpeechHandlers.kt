package com.let188.arkli.speech

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.ActivityHost
import com.let188.arkli.files.requireMainFrame
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 一个页面会话里的听写状态：同一时刻只允许一路。
 * 会话关闭时由 [cancelNow] 兜底停止并释放麦克风。
 */
internal class SpeechSession {
    /** 是否已有听写在跑（含申请权限、加载模型、启动中） */
    val running = AtomicBoolean(false)

    /** 采集任务的协程，启动后赋值 */
    @Volatile
    var job: Job? = null

    /** 当前持有的 AudioRecord */
    @Volatile
    var record: AudioRecord? = null

    /** 是否已请求停止（正常停止，需要冲刷） */
    @Volatile
    var stopRequested = false

    /** 本次听写的整段文本，听写收尾后完成 */
    @Volatile
    var result: CompletableDeferred<String>? = null

    /** 上一次听写的整段文本 */
    @Volatile
    var lastText: String = ""

    /** 停止并释放 AudioRecord，可重复调用 */
    fun releaseRecord() {
        val r = record ?: return
        record = null
        runCatching { r.stop() }
        runCatching { r.release() }
    }

    /** 会话关闭或被取消：不冲刷，直接停止并释放 */
    fun cancelNow() {
        stopRequested = true
        job?.cancel()
        releaseRecord()
    }
}

/**
 * `native.speech.status`：`{}` -> `{ available, engine, modelReady, reason? }`。
 *
 * @param service 语音识别服务
 */
internal class SpeechStatusHandler(private val service: SpeechService) : BridgeHandler {
    /** 检查模型文件与引擎库，不加载模型 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return withContext(Dispatchers.IO) { service.status() }
    }
}

/**
 * `native.speech.start`：`{ lang?: 'zh-en' }` -> `{ started: true, sampleRate, taskId }`。
 * 之后推 `speech.partial { text }`（当前这句的中间结果）与 `speech.final { text }`（一句话定稿）。
 * 麦克风权限没给时先申请，被拒 PERMISSION_DENIED；模型缺失或加载失败 NOT_READY；已在听写 NOT_READY。
 * 音频只在内存里，不落盘。
 *
 * @param context 应用上下文
 * @param host 权限申请宿主
 * @param service 语音识别服务
 * @param session 本会话的听写状态
 */
internal class SpeechStartHandler(
    private val context: Context,
    private val host: ActivityHost,
    private val service: SpeechService,
    private val session: SpeechSession,
) : BridgeHandler {
    /** 校验、申请权限、起采集任务，等麦克风真正开始录音再返回 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        SpeechPolicy.parseStart(params)
        if (!session.running.compareAndSet(false, true)) {
            throw BridgeException(BridgeErrors.NOT_READY, "已经在听写中，请先停止")
        }
        session.stopRequested = false
        val result = CompletableDeferred<String>()
        session.result = result
        var launched = false
        try {
            ensureMicPermission()
            val ready = CompletableDeferred<Unit>()
            val taskId = ctx.launchTask { runSession(ctx, ready, result) }
            launched = true
            try {
                ready.await()
            } catch (e: CancellationException) {
                session.cancelNow()
                throw e
            }
            return JSONObject().put("started", true).put("sampleRate", SpeechConst.SAMPLE_RATE).put("taskId", taskId)
        } finally {
            if (!launched) {
                result.complete("")
                session.running.set(false)
            }
        }
    }

    /** 没授权就申请，被拒抛 PERMISSION_DENIED */
    private suspend fun ensureMicPermission() {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (granted || host.requestPermission(Manifest.permission.RECORD_AUDIO)) return
        throw BridgeException(BridgeErrors.PERMISSION_DENIED, "麦克风权限被拒绝，无法语音输入")
    }

    /** 采集任务体：占用识别器 -> 开麦 -> 采集解码；无论怎么退出都释放麦克风并完成结果 */
    private suspend fun runSession(ctx: CallContext, ready: CompletableDeferred<Unit>, result: CompletableDeferred<String>) {
        val merger = TranscriptMerger()
        try {
            service.withDecoder { decoder ->
                val record = createRecord()
                session.record = record
                try {
                    record.startRecording()
                    if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                        throw BridgeException(BridgeErrors.NOT_READY, "麦克风被其他应用占用，无法开始录音")
                    }
                } catch (e: Throwable) {
                    session.releaseRecord()
                    throw e
                }
                session.job = currentCoroutineContext()[Job]
                ready.complete(Unit)
                withContext(Dispatchers.IO) { captureLoop(ctx, record, decoder, merger) }
            }
        } catch (e: Throwable) {
            // start 还在等就让它抛出去；已经返回了就交给任务错误事件
            val consumed = ready.completeExceptionally(e)
            if (e is CancellationException || !consumed) throw e
        } finally {
            session.releaseRecord()
            session.job = null
            session.lastText = merger.full()
            result.complete(session.lastText)
            session.running.set(false)
        }
    }

    /** 采集循环：读 100ms 一块，喂解码器，推中间结果与定稿；被请求停止时冲刷剩余音频 */
    private suspend fun captureLoop(ctx: CallContext, record: AudioRecord, decoder: SpeechDecoder, merger: TranscriptMerger) {
        val buf = ShortArray(SpeechConst.CHUNK_SAMPLES)
        while (currentCoroutineContext().isActive && !session.stopRequested) {
            val n = record.read(buf, 0, buf.size)
            currentCoroutineContext().ensureActive()
            if (session.stopRequested) break
            if (n < 0) throw BridgeException(BridgeErrors.INTERNAL, "读取麦克风失败（$n）")
            if (n == 0) continue
            val step = decoder.feed(SpeechPolicy.pcmToFloat(buf, n))
            if (step.endpoint) {
                merger.commit(step.text)?.let { ctx.emit(SpeechConst.EVENT_FINAL, SpeechPolicy.textPayload(it)) }
            } else if (merger.partial(step.text)) {
                ctx.emit(SpeechConst.EVENT_PARTIAL, SpeechPolicy.textPayload(step.text))
            }
        }
        currentCoroutineContext().ensureActive()
        session.releaseRecord()
        merger.commit(decoder.finish())?.let { ctx.emit(SpeechConst.EVENT_FINAL, SpeechPolicy.textPayload(it)) }
    }

    /** 创建 AudioRecord：16kHz 单声道 16bit，缓冲至少 1 秒；初始化失败抛 NOT_READY */
    @Suppress("MissingPermission")
    private fun createRecord(): AudioRecord {
        val min = AudioRecord.getMinBufferSize(SpeechConst.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) throw BridgeException(BridgeErrors.NOT_READY, "本机不支持 16kHz 单声道录音")
        val bytes = maxOf(min * 2, SpeechConst.SAMPLE_RATE * 2)
        val record = AudioRecord(
            MediaRecorder.AudioSource.MIC, SpeechConst.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT, bytes,
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            throw BridgeException(BridgeErrors.NOT_READY, "麦克风初始化失败")
        }
        return record
    }
}

/**
 * `native.speech.stop`：`{}` -> `{ text }`。停止采集、冲刷剩余音频，返回整段定稿文本；没在听写也返回上次的文本。
 *
 * @param session 本会话的听写状态
 */
internal class SpeechStopHandler(private val session: SpeechSession) : BridgeHandler {
    /** 请求停止并等收尾，最多等 [SpeechConst.STOP_WAIT_MS] */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val pending = session.result
        if (!session.running.get() || pending == null) return SpeechPolicy.textPayload(session.lastText)
        session.stopRequested = true
        val text = withTimeoutOrNull(SpeechConst.STOP_WAIT_MS) { pending.await() }
        if (text == null) session.cancelNow()
        return SpeechPolicy.textPayload(text ?: session.lastText)
    }
}
