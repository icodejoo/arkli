package com.let188.arkli.debug

import android.content.Context
import android.os.Debug
import android.util.Log
import com.let188.arkli.speech.SpeechConst
import com.let188.arkli.speech.SpeechPolicy
import com.let188.arkli.speech.SpeechRuntime
import com.let188.arkli.speech.TranscriptMerger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** 调试日志 tag，与 DebugHooksProvider 保持一致 */
private const val TAG = "ArkliDebug"

/** wav 夹具目录（相对 cacheDir），由 adb run-as 拷入 */
private const val WAV_DIR = "asrtest"

/** 每步喂入的采样数：与麦克风路径一致（100ms） */
private const val CHUNK = SpeechConst.CHUNK_SAMPLES

/**
 * 语音转文字的真机验证命令，仅 debug 源集。
 * - `asrwav`：把 `cacheDir/asrtest` 目录下的 wav（16kHz 16bit 单声道）用与麦克风相同的解码路径离线喂入，
 *   日志（tag ArkliDebug，前缀 DBGASR）输出识别文本、耗时、实时率(RTF)、加载耗时与内存。
 * - `asrunload`：释放识别器，用于观察内存回落。
 */
object DebugSpeechCommands {
    /** 后台协程域 */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * 处理一条语音调试命令。
     *
     * @param cmd 命令名
     * @param ctx 上下文
     */
    fun handle(cmd: String, ctx: Context) {
        val service = SpeechRuntime.get(ctx)
        when (cmd) {
            "asrunload" -> scope.launch {
                val done = service.unload()
                Log.i(TAG, "DBGASR unloaded=$done ${mem()}")
            }
            "asrwav" -> scope.launch {
                runCatching { run(ctx) }.onFailure { Log.e(TAG, "DBGASR FAIL ${it.javaClass.simpleName}: ${it.message}", it) }
            }
        }
    }

    /** 逐个 wav 跑一遍并输出结果 */
    private suspend fun run(ctx: Context) {
        val service = SpeechRuntime.get(ctx)
        val files = File(ctx.cacheDir, WAV_DIR).listFiles { f -> f.extension == "wav" }?.sortedBy { it.name }.orEmpty()
        Log.i(TAG, "DBGASR start files=${files.map { it.name }} status=${service.status()} mem0=${mem()}")
        for (f in files) {
            val pcm = readWav(f)
            val audioSec = pcm.size.toDouble() / SpeechConst.SAMPLE_RATE
            val t0 = System.nanoTime()
            val merger = TranscriptMerger()
            val partials = ArrayList<String>()
            service.withDecoder { d ->
                val tLoaded = System.nanoTime()
                var i = 0
                while (i < pcm.size) {
                    val n = minOf(CHUNK, pcm.size - i)
                    val step = d.feed(SpeechPolicy.pcmToFloat(pcm.copyOfRange(i, i + n), n))
                    if (step.endpoint) merger.commit(step.text) else if (merger.partial(step.text)) partials.add(step.text)
                    i += n
                }
                merger.commit(d.finish())
                val decodeMs = (System.nanoTime() - tLoaded) / NS_PER_MS
                val totalMs = (System.nanoTime() - t0) / NS_PER_MS
                Log.i(
                    TAG,
                    "DBGASR ${f.name} audio=%.2fs decode=%dms total(含加载)=%dms RTF=%.3f partials=%d text=「%s」"
                        .format(audioSec, decodeMs, totalMs, decodeMs / 1000.0 / audioSec, partials.size, merger.full()),
                )
            }
        }
        Log.i(TAG, "DBGASR done loadMs=${service.lastLoadMs} mem=${mem()}")
    }

    /** 读 16bit PCM wav 为短整型数组（跳过头，按 chunk 找 data） */
    private fun readWav(f: File): ShortArray {
        val bb = ByteBuffer.wrap(f.readBytes()).order(ByteOrder.LITTLE_ENDIAN)
        var pos = WAV_HEADER_SKIP
        while (pos + CHUNK_HEAD <= bb.limit()) {
            val id = String(ByteArray(ID_LEN) { bb.get(pos + it) })
            val size = bb.getInt(pos + ID_LEN)
            if (id == "data") {
                val n = minOf(size, bb.limit() - pos - CHUNK_HEAD) / 2
                return ShortArray(n) { bb.getShort(pos + CHUNK_HEAD + it * 2) }
            }
            pos += CHUNK_HEAD + size
        }
        error("wav 里没找到 data 块：${f.name}")
    }

    /** 内存快照：PSS 与 native 堆（MB） */
    private fun mem(): String {
        val mi = Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }
        return "pss=${mi.totalPss / KB_PER_MB}MB nativeHeap=${Debug.getNativeHeapAllocatedSize() / BYTES_PER_MB}MB"
    }

    /** wav 头跳过：RIFF + size + WAVE */
    private const val WAV_HEADER_SKIP = 12

    /** chunk 头长度：4 字节 id + 4 字节长度 */
    private const val CHUNK_HEAD = 8

    /** chunk id 长度 */
    private const val ID_LEN = 4

    /** 纳秒换毫秒 */
    private const val NS_PER_MS = 1_000_000L

    /** KB 换 MB */
    private const val KB_PER_MB = 1024

    /** 字节换 MB */
    private const val BYTES_PER_MB = 1024L * 1024L
}
