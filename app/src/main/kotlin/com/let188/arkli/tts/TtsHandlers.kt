package com.let188.arkli.tts

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.FileRoots
import com.let188.arkli.files.FileNames
import com.let188.arkli.files.requireMainFrame
import com.let188.arkli.system.SystemParams
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** 从调用参数里读出并校验朗读请求（speak 与 save 共用） */
private fun parseSpec(params: JSONObject): TtsSpec {
    val text = SystemParams.string(params, "text")
    val lang = SystemParams.stringOrNull(params, "lang")
    val rate = numberOrNull(params, "rate")
    val pitch = numberOrNull(params, "pitch")
    return SystemParams.validated { TtsPolicy.parse(text, lang, rate, pitch) }
}

/** 读可选数字，缺省或 null 返回 null，类型不对抛 BAD_PARAMS */
private fun numberOrNull(p: JSONObject, key: String): Double? {
    val v = p.opt(key)
    if (v == null || v == JSONObject.NULL) return null
    return (v as? Number)?.toDouble() ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "$key 必须是数字")
}

/**
 * `native.tts.speak`：`{ text(≤8000), lang?="zh-CN", rate?=1 (0.5~2), pitch?=1 (0.5~2) }` -> `{ id }`。
 * 引擎就绪后立刻返回；读完推 `tts.done { id }`，被打断推 `tts.stopped { id, error? }`。
 * 引擎或语言不可用返回 NOT_READY，消息里提示去系统设置安装语音数据。
 *
 * @param engine 当前会话的引擎
 */
internal class TtsSpeakHandler(private val engine: TtsEngine) : BridgeHandler {
    /** 校验并开始朗读 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val id = engine.speak(parseSpec(params)) { event, data -> ctx.emit(event, data) }
        return JSONObject().put("id", id)
    }
}

/**
 * `native.tts.stop`：无参 -> `{ stopped: true }`。没有在读时什么也不发生。
 *
 * @param engine 当前会话的引擎
 */
internal class TtsStopHandler(private val engine: TtsEngine) : BridgeHandler {
    /** 停止朗读 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        engine.stop()
        return JSONObject().put("stopped", true)
    }
}

/**
 * `native.tts.status`：无参 -> `{ available: boolean, langs: string[] }`。引擎起不来时 `available=false`，不抛错。
 *
 * @param engine 当前会话的引擎
 */
internal class TtsStatusHandler(private val engine: TtsEngine) : BridgeHandler {
    /** 查询引擎状态与可用语言 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val (available, langs) = engine.status()
        return JSONObject().put("available", available).put("langs", JSONArray(langs))
    }
}

/**
 * `native.tts.save`：`{ text, lang?, rate?, pitch? }` -> `{ path, name }`，wav 落在缓存 `out/` 下，
 * `path` 可交给 `native.share` / `native.file.save`。文本超过引擎单次上限（通常约 4000 字）返回 BAD_PARAMS。
 *
 * @param engine 当前会话的引擎
 * @param outDir 缓存 `out/` 目录
 * @param roots 目录根，用来把文件转成页面路径
 */
internal class TtsSaveHandler(
    private val engine: TtsEngine,
    private val outDir: File,
    private val roots: FileRoots,
) : BridgeHandler {
    /** 合成并落盘 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val spec = parseSpec(params)
        val dir = File(outDir, "tts-" + UUID.randomUUID().toString().take(DIR_ID_LENGTH))
        withContext(Dispatchers.IO) { dir.mkdirs() }
        val file = FileNames.unique(dir, "tts_${System.currentTimeMillis()}.wav")
        engine.save(spec, file)
        val path = roots.pagePathOf(file) ?: throw BridgeException(BridgeErrors.INTERNAL, "产物不在缓存目录内")
        return JSONObject().put("path", path).put("name", file.name)
    }

    private companion object {
        /** 产物子目录名里的随机串长度 */
        const val DIR_ID_LENGTH = 8
    }
}
