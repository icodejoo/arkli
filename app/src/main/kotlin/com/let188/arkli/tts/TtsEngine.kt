package com.let188.arkli.tts

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger

/** 事件名：朗读自然结束 */
internal const val EVENT_TTS_DONE = "tts.done"

/** 事件名：朗读被打断（用户停止、被新朗读顶掉、引擎出错） */
internal const val EVENT_TTS_STOPPED = "tts.stopped"

/**
 * 一个会话里的系统 TextToSpeech 引擎封装：异步初始化、分段朗读、保存为 wav、事件推送。
 * 随会话关闭由 [shutdown] 释放。
 *
 * @param context 应用上下文
 */
internal class TtsEngine(private val context: Context) {
    /** 一次朗读任务：id 供页面对应 done / stopped 事件，[last] 是最后一段的下标 */
    private class SpeakJob(val id: String, val last: Int, val emit: (String, Any?) -> Unit)

    /** 保护 [active]、[init]、[closed] 的锁 */
    private val lock = Any()

    /** 系统引擎，初始化成功后才有值 */
    @Volatile
    private var tts: TextToSpeech? = null

    /** 初始化进度，null 表示还没开始或上次失败 */
    private var init: CompletableDeferred<Boolean>? = null

    /** 是否已释放 */
    private var closed = false

    /** 当前朗读任务 */
    private var active: SpeakJob? = null

    /** 进行中的保存任务：utteranceId -> 是否成功 */
    private val saves = HashMap<String, CompletableDeferred<Boolean>>()

    /** 朗读 / 保存的自增编号 */
    private val counter = AtomicInteger(0)

    /** 引擎回调：binder 线程调用，只做状态流转与推事件 */
    private val listener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) = Unit

        override fun onDone(utteranceId: String?) {
            utteranceId ?: return
            if (finishSave(utteranceId, true)) return
            val job = takeJobIfLast(utteranceId, requireLast = true) ?: return
            job.emit(EVENT_TTS_DONE, JSONObject().put("id", job.id))
        }

        @Deprecated("系统要求实现的旧回调，新引擎走带错误码的版本")
        override fun onError(utteranceId: String?) = fail(utteranceId)

        override fun onError(utteranceId: String?, errorCode: Int) = fail(utteranceId)

        override fun onStop(utteranceId: String?, interrupted: Boolean) {
            utteranceId ?: return
            if (finishSave(utteranceId, false)) return
            val job = takeJobIfLast(utteranceId, requireLast = false) ?: return
            job.emit(EVENT_TTS_STOPPED, JSONObject().put("id", job.id))
        }
    }

    /** 引擎出错：保存任务判失败，朗读任务当作被打断并带 error 标记 */
    private fun fail(utteranceId: String?) {
        utteranceId ?: return
        if (finishSave(utteranceId, false)) return
        val job = takeJobIfLast(utteranceId, requireLast = false) ?: return
        job.emit(EVENT_TTS_STOPPED, JSONObject().put("id", job.id).put("error", true))
    }

    /** 结束保存任务；utteranceId 属于保存任务时返回 true */
    private fun finishSave(utteranceId: String, ok: Boolean): Boolean {
        val d = synchronized(lock) { saves.remove(utteranceId) } ?: return false
        d.complete(ok)
        return true
    }

    /**
     * 回调里取出当前任务：utteranceId 属于当前任务才返回并清空 [active]（任务就此结束，只会触发一次事件）。
     *
     * @param requireLast 为 true 时只有最后一段才算任务结束
     */
    private fun takeJobIfLast(utteranceId: String, requireLast: Boolean): SpeakJob? = synchronized(lock) {
        val job = active ?: return null
        if (TtsIds.jobOf(utteranceId) != job.id) return null
        if (requireLast && TtsIds.indexOf(utteranceId) != job.last) return null
        active = null
        job
    }

    /**
     * 等引擎初始化完成。
     *
     * @return 就绪的引擎；初始化失败或超时返回 null（下次调用会重试）
     * @throws BridgeException 会话已关闭
     */
    private suspend fun engineOrNull(): TextToSpeech? {
        val d = synchronized(lock) {
            if (closed) throw BridgeException(BridgeErrors.NOT_READY, "会话已关闭")
            init ?: CompletableDeferred<Boolean>().also {
                init = it
                Handler(Looper.getMainLooper()).post { create(it) }
            }
        }
        val ok = withTimeoutOrNull(INIT_TIMEOUT_MS) { d.await() } ?: false
        if (!ok) {
            synchronized(lock) { if (init === d) init = null }
            return null
        }
        return tts
    }

    /** 主线程创建系统引擎，回调里记录是否成功 */
    private fun create(d: CompletableDeferred<Boolean>) {
        try {
            var created: TextToSpeech? = null
            created = TextToSpeech(context) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    created?.setOnUtteranceProgressListener(listener)
                    tts = created
                    d.complete(true)
                } else {
                    created?.shutdown()
                    d.complete(false)
                }
            }
        } catch (e: Exception) {
            d.complete(false)
        }
    }

    /**
     * 引擎是否可用及可用语言。
     *
     * @return 引擎不可用时 `available=false`、语言空
     */
    suspend fun status(): Pair<Boolean, List<String>> {
        val t = engineOrNull() ?: return false to emptyList()
        val tags = try {
            t.availableLanguages?.map { it.toLanguageTag() }.orEmpty()
        } catch (e: Exception) {
            emptyList()
        }
        return true to TtsPolicy.cleanLangs(tags)
    }

    /**
     * 取就绪引擎并套上语言、语速、音调。
     *
     * @throws BridgeException NOT_READY：引擎起不来，或该语言没有语音数据
     */
    private suspend fun prepare(spec: TtsSpec): TextToSpeech {
        val t = engineOrNull() ?: throw BridgeException(BridgeErrors.NOT_READY, "文字转语音引擎不可用，请在系统设置里安装或启用语音引擎")
        val code = try {
            t.setLanguage(Locale.forLanguageTag(spec.lang))
        } catch (e: Exception) {
            TextToSpeech.LANG_NOT_SUPPORTED
        }
        if (!TtsPolicy.languageUsable(code)) {
            throw BridgeException(BridgeErrors.NOT_READY, "没有 ${spec.lang} 的语音数据，请到系统设置 > 语言和输入法 > 文字转语音 里安装")
        }
        t.setSpeechRate(spec.rate)
        t.setPitch(spec.pitch)
        return t
    }

    /**
     * 开始朗读，立刻返回；会打断正在进行的朗读（旧任务推 `tts.stopped`）。
     * 文本超过引擎单次上限时自动分段排队，全部读完推一次 `tts.done`。
     *
     * @param spec 朗读请求
     * @param emit 推事件的函数，事件数据含 `id`
     * @return 本次朗读的 id
     * @throws BridgeException NOT_READY 引擎或语言不可用；INTERNAL 入队失败
     */
    suspend fun speak(spec: TtsSpec, emit: (String, Any?) -> Unit): String {
        val t = prepare(spec)
        val parts = TtsPolicy.chunk(spec.text, TextToSpeech.getMaxSpeechInputLength())
        val job = SpeakJob("s${counter.incrementAndGet()}", parts.size - 1, emit)
        val previous = synchronized(lock) { active.also { active = job } }
        previous?.emit?.invoke(EVENT_TTS_STOPPED, JSONObject().put("id", previous.id))
        parts.forEachIndexed { i, part ->
            val mode = if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            if (t.speak(part, mode, null, TtsIds.of(job.id, i)) != TextToSpeech.SUCCESS) {
                synchronized(lock) { if (active === job) active = null }
                t.stop()
                throw BridgeException(BridgeErrors.INTERNAL, "引擎拒绝了朗读请求")
            }
        }
        return job.id
    }

    /** 停止朗读；有进行中的任务时立刻推 `tts.stopped`，没有则什么也不发 */
    fun stop() {
        val job = synchronized(lock) { active.also { active = null } }
        tts?.stop()
        job?.emit?.invoke(EVENT_TTS_STOPPED, JSONObject().put("id", job.id))
    }

    /**
     * 把文本合成为 wav 文件（不出声）。文本不能超过引擎单次输入上限。
     *
     * @param spec 请求
     * @param file 目标文件，父目录须已存在
     * @throws BridgeException BAD_PARAMS 文本过长；NOT_READY 引擎或语言不可用；INTERNAL / TIMEOUT 合成失败
     */
    suspend fun save(spec: TtsSpec, file: File) {
        val t = prepare(spec)
        val max = TextToSpeech.getMaxSpeechInputLength()
        if (spec.text.length > max) throw BridgeException(BridgeErrors.BAD_PARAMS, "保存音频单次最多 $max 字，请分段保存")
        stop()
        val uid = "save${counter.incrementAndGet()}"
        val done = CompletableDeferred<Boolean>()
        synchronized(lock) { saves[uid] = done }
        try {
            if (t.synthesizeToFile(spec.text, Bundle(), file, uid) != TextToSpeech.SUCCESS) {
                throw BridgeException(BridgeErrors.INTERNAL, "引擎拒绝了合成请求")
            }
            val ok = withTimeoutOrNull(SAVE_TIMEOUT_MS) { done.await() }
                ?: throw BridgeException(BridgeErrors.TIMEOUT, "合成超时")
            if (!ok || !file.isFile || file.length() == 0L) throw BridgeException(BridgeErrors.INTERNAL, "合成失败")
        } catch (e: Throwable) {
            file.delete()
            throw e
        } finally {
            synchronized(lock) { saves.remove(uid) }
        }
    }

    /** 释放引擎（会话关闭时调用）；进行中的朗读直接作废，不再推事件 */
    fun shutdown() {
        val engine: TextToSpeech?
        synchronized(lock) {
            closed = true
            active = null
            engine = tts
            tts = null
            init = null
            saves.values.forEach { it.complete(false) }
            saves.clear()
        }
        try {
            engine?.stop()
            engine?.shutdown()
        } catch (e: Exception) {
            // 释放阶段的异常无需处理
        }
    }

    private companion object {
        /** 等引擎初始化的上限（毫秒） */
        const val INIT_TIMEOUT_MS = 10_000L

        /** 等合成完成的上限（毫秒） */
        const val SAVE_TIMEOUT_MS = 120_000L
    }
}

/** utteranceId 的拼装与解析：`<任务 id>#<段下标>`，纯函数，可单测 */
internal object TtsIds {
    /** 任务 id 与段下标的分隔符 */
    private const val SEP = '#'

    /** 拼出某任务第 [index] 段的 utteranceId */
    fun of(jobId: String, index: Int): String = "$jobId$SEP$index"

    /** 取任务 id */
    fun jobOf(utteranceId: String): String = utteranceId.substringBeforeLast(SEP)

    /** 取段下标，格式不对返回 -1 */
    fun indexOf(utteranceId: String): Int = utteranceId.substringAfterLast(SEP, "").toIntOrNull() ?: -1
}
