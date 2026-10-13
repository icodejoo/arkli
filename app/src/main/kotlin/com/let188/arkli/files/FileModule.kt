package com.let188.arkli.files

import android.net.Uri
import android.util.Base64
import android.util.Log
import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 把文件相关方法注册进一个会话的 Bridge：pick / save / openWrite / write / closeWrite。
 *
 * 每个会话一份写句柄登记与不透明句柄表，会话关闭（页面重载、渲染进程崩溃、销毁）时
 * 自动丢弃未关闭的写句柄及其临时文件。
 *
 * 使用示例：`FileModule.install(bridge, env)`
 */
object FileModule {
    /** 方法名：选文件 */
    const val METHOD_PICK = "native.file.pick"

    /** 方法名：保存到公共目录 */
    const val METHOD_SAVE = "native.file.save"

    /** 方法名：打开写句柄 */
    const val METHOD_OPEN_WRITE = "native.file.openWrite"

    /** 方法名：写一块 */
    const val METHOD_WRITE = "native.file.write"

    /** 方法名：关闭写句柄 */
    const val METHOD_CLOSE_WRITE = "native.file.closeWrite"

    /**
     * 注册文件方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        val cacheRoot = env.roots.cacheRoot
        val registry = WriteRegistry(File(cacheRoot, FileConst.DIR_TMP), File(cacheRoot, FileConst.DIR_OUT))
        val handles = HandleTable<Uri>()
        env.registries += registry
        bridge.onClose {
            val n = registry.abortAll()
            handles.clear()
            env.registries -= registry
            Log.i(FILE_LOG_TAG, "会话 ${bridge.session} 关闭，清理未关闭写句柄 $n 个")
        }
        bridge.register(METHOD_PICK, PickHandler(env, handles))
        bridge.register(METHOD_SAVE, SaveHandler(env))
        bridge.register(METHOD_OPEN_WRITE, OpenWrite(registry))
        bridge.register(METHOD_WRITE, Write(registry))
        bridge.register(METHOD_CLOSE_WRITE, CloseWrite(registry, env))
    }

    /**
     * `native.file.openWrite`：`{ name: string, size?: number, sha256?: string }`
     * -> `{ handle, chunkBytes, encodings }`。size / sha256 声明后在关闭时校验。
     */
    private class OpenWrite(private val registry: WriteRegistry) : BridgeHandler {
        /** 打开写句柄 */
        override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
            requireMainFrame(ctx)
            val name = params.opt("name") as? String ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "缺少 name")
            val size = longOrNull(params, "size")
            val raw = params.opt("sha256")
            val sha = if (raw == null || raw == JSONObject.NULL) null
            else raw as? String ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "sha256 必须是字符串")
            val handle = withContext(Dispatchers.IO) { registry.open(name, size, sha) }
            return JSONObject().put("handle", handle).put("chunkBytes", FileConst.CHUNK_BYTES)
                .put("encodings", JSONArray(listOf(FileConst.ENCODING_LATIN1, FileConst.ENCODING_BASE64)))
        }
    }

    /**
     * `native.file.write`：`{ handle, seq, offset, data, encoding?: "latin1"|"base64" }` -> `{ seq, written }`。
     * 必须按 seq 顺序串行发送（等上一块确认再发下一块）；同一块重发是幂等的。
     */
    private class Write(private val registry: WriteRegistry) : BridgeHandler {
        /** 解码并写入一块 */
        override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
            requireMainFrame(ctx)
            val handle = params.opt("handle") as? String ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "缺少 handle")
            val seq = (params.opt("seq") as? Number)?.toInt() ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "缺少 seq")
            val offset = longOrNull(params, "offset") ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "缺少 offset")
            val data = params.opt("data") as? String ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "data 必须是字符串")
            val encoding = params.optString("encoding", FileConst.ENCODING_LATIN1)
            val bytes = try {
                FrameCodec.decode(encoding, data) { Base64.decode(it, Base64.NO_WRAP) }
            } catch (e: IllegalArgumentException) {
                throw BridgeException(BridgeErrors.BAD_PARAMS, e.message ?: "数据解码失败")
            }
            val ack = withContext(Dispatchers.IO) { registry.write(handle, seq, offset, bytes) }
            return JSONObject().put("seq", ack.seq).put("written", ack.written)
        }
    }

    /**
     * `native.file.closeWrite`：`{ handle, size?, sha256?, abort?: boolean }`。
     * 正常关闭 -> `{ path, url, name, size, sha256 }`；`abort: true` -> `{ aborted }`，丢弃已写内容。
     */
    private class CloseWrite(private val registry: WriteRegistry, private val env: FileEnv) : BridgeHandler {
        /** 关闭或放弃写句柄 */
        override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
            requireMainFrame(ctx)
            val handle = params.opt("handle") as? String ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "缺少 handle")
            if (params.optBoolean("abort", false)) return JSONObject().put("aborted", registry.abort(handle))
            val size = longOrNull(params, "size")
            val sha = params.opt("sha256") as? String
            val r = withContext(Dispatchers.IO) { registry.close(handle, size, sha) }
            val pagePath = env.roots.pagePathOf(r.file) ?: throw BridgeException(BridgeErrors.INTERNAL, "产物路径异常")
            return JSONObject().put("path", pagePath).put("url", env.urlOf(pagePath))
                .put("name", r.name).put("size", r.size).put("sha256", r.sha256)
        }
    }

    /** 读可选的整数参数，类型不对抛 BAD_PARAMS */
    private fun longOrNull(p: JSONObject, key: String): Long? {
        val v = p.opt(key)
        if (v == null || v == JSONObject.NULL) return null
        return (v as? Number)?.toLong() ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "$key 必须是数字")
    }
}
