package com.let188.arkli.noise

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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/** 采样事件名 */
internal const val EVENT_NOISE_SAMPLE = "noise.sample"

/** stop 等待录音线程释放的最长时间（毫秒） */
private const val STOP_WAIT_MS = 3000L

/** stop 轮询间隔（毫秒） */
private const val STOP_POLL_MS = 20L

/**
 * 一个会话里的噪音测量状态：同一时刻只允许一路录音。
 */
internal class NoiseSession {
    /** 是否已有录音在跑（含正在申请权限、正在启动） */
    val running = AtomicBoolean(false)

    /** 录音任务，采集任务启动后赋值 */
    @Volatile
    var job: Job? = null

    /** 当前持有的 AudioRecord，会话关闭时若任务没来得及启动，由这里兜底释放 */
    @Volatile
    var record: AudioRecord? = null

    /** 是否已请求停止，采集循环每轮检查 */
    @Volatile
    var stopRequested = false

    /**
     * 停止录音并等 AudioRecord 释放。
     *
     * @return 之前是否有录音在跑
     */
    suspend fun stop(): Boolean {
        if (!running.get()) return false
        stopRequested = true
        job?.cancel()
        withTimeoutOrNull(STOP_WAIT_MS) {
            while (running.get()) delay(STOP_POLL_MS)
        }
        return true
    }

    /** 会话关闭：取消任务，并兜底释放 AudioRecord（任务可能还没启动） */
    fun cancelNow() {
        stopRequested = true
        job?.cancel()
        releaseRecord()
    }

    /** 停止并释放 AudioRecord，可重复调用 */
    fun releaseRecord() {
        val r = record ?: return
        record = null
        runCatching { r.stop() }
        runCatching { r.release() }
    }
}

/**
 * `native.noise.start`：`{ intervalMs?: 50~1000 = 100 }` -> `{ started: true, sampleRate }`。
 * 之后每个间隔推 `noise.sample { db, peakDb, rmsDbfs }`。db 是未校准的近似声压级（dBFS + 90，夹到 0~140）。
 * 没有麦克风授权时先申请，被拒抛 PERMISSION_DENIED（message 含 `reason:denied`）；已有一路在跑返回 NOT_READY。
 *
 * @param context 应用上下文
 * @param host 权限申请宿主
 * @param session 本会话的录音状态
 */
internal class NoiseStartHandler(
    private val context: Context,
    private val host: ActivityHost,
    private val session: NoiseSession,
) : BridgeHandler {
    /** 申请权限、创建 AudioRecord、起采集任务 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val intervalMs = NoiseMath.parseInterval(params)
        if (!session.running.compareAndSet(false, true)) throw BridgeException(BridgeErrors.NOT_READY, "噪音测量已在进行")
        session.stopRequested = false
        var launched = false
        try {
            ensureMicPermission()
            val window = NoiseMath.windowSamples(intervalMs)
            val record = createRecord(window)
            try {
                record.startRecording()
                if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                    throw BridgeException(BridgeErrors.NOT_READY, "麦克风被其他应用占用，无法开始录音")
                }
            } catch (e: Throwable) {
                record.release()
                throw e
            }
            session.record = record
            ctx.launchTask { capture(ctx, record, window) }
            launched = true
        } finally {
            if (!launched) session.running.set(false)
        }
        return JSONObject().put("started", true).put("sampleRate", NoiseMath.SAMPLE_RATE)
    }

    /** 没授权就申请，被拒抛 PERMISSION_DENIED */
    private suspend fun ensureMicPermission() {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (granted || host.requestPermission(Manifest.permission.RECORD_AUDIO)) return
        throw BridgeException(BridgeErrors.PERMISSION_DENIED, "reason:denied 麦克风权限被拒绝")
    }

    /** 创建 AudioRecord：16kHz 单声道 16bit；初始化失败释放并抛 NOT_READY */
    @Suppress("MissingPermission")
    private fun createRecord(window: Int): AudioRecord {
        val min = AudioRecord.getMinBufferSize(NoiseMath.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) throw BridgeException(BridgeErrors.NOT_READY, "本机不支持 16kHz 单声道录音")
        val record = AudioRecord(
            MediaRecorder.AudioSource.MIC, NoiseMath.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT, NoiseMath.bufferBytes(min, window),
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            throw BridgeException(BridgeErrors.NOT_READY, "麦克风初始化失败")
        }
        return record
    }

    /** 采集循环：在 IO 线程读采样、攒窗口、推事件；无论怎么退出都停止并释放 AudioRecord */
    private suspend fun capture(ctx: CallContext, record: AudioRecord, window: Int) {
        session.job = currentCoroutineContext()[Job]
        try {
            withContext(Dispatchers.IO) {
                val buf = ShortArray(window)
                val acc = WindowAccumulator(window)
                while (isActive && !session.stopRequested) {
                    val n = record.read(buf, 0, buf.size)
                    ensureActive()
                    if (n < 0) throw BridgeException(BridgeErrors.INTERNAL, "读取麦克风失败（$n）")
                    acc.feed(buf, n) { s ->
                        ctx.emit(
                            EVENT_NOISE_SAMPLE,
                            JSONObject().put("db", s.db).put("peakDb", s.peakDb).put("rmsDbfs", s.rmsDbfs),
                        )
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } finally {
            session.releaseRecord()
            session.job = null
            session.running.set(false)
        }
    }
}

/**
 * `native.noise.stop`：`{}` -> `{ stopped: true }`。停止录音并等 AudioRecord 释放；没在录也返回 stopped。
 *
 * @param session 本会话的录音状态
 */
internal class NoiseStopHandler(private val session: NoiseSession) : BridgeHandler {
    /** 停止采集 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        session.stop()
        return JSONObject().put("stopped", true)
    }
}
