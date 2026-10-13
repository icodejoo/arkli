package com.let188.arkli.spike

import android.util.Log
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** spike 统一日志 tag */
const val SPIKE_TAG = "ArkliSpike"

/** 协议版本（v2 草案） */
private const val PROTOCOL_V2 = 2

/** 内置取消方法名 */
private const val METHOD_CANCEL = "native.task.cancel"

/** 错误码：已取消 */
private const val ERR_CANCELLED = "CANCELLED"

/** 错误码：内部错误 */
private const val ERR_INTERNAL = "INTERNAL"

/** 错误码：方法不存在 */
private const val ERR_UNKNOWN_METHOD = "UNKNOWN_METHOD"

/** JSON 字段名：请求 id */
private const val KEY_ID = "id"

/** JSON 字段名：方法名 */
private const val KEY_METHOD = "method"

/** JSON 字段名：参数 */
private const val KEY_PARAMS = "params"

/**
 * 回传通道抽象：与具体 WebView 通道解耦，便于换传输层。
 */
interface ReplyIo {
    /** 回传一条 JSON 文本 */
    fun sendJson(json: String)

    /** 回传一帧二进制 */
    fun sendBinary(bytes: ByteArray)
}

/**
 * 一次调用的上下文：会话号、请求 id、回传通道。取消由协程 Job 承载。
 *
 * @property session 页面会话号，WebView 重建后递增
 * @property requestId 页面生成的请求 id
 * @property io 回传通道
 */
class CallContext(val session: Int, val requestId: String, val io: ReplyIo)

/**
 * 异步处理器（v2 草案）：挂起函数，可被取消。
 */
fun interface SuspendBridgeHandler {
    /**
     * 处理一次调用。
     *
     * @param ctx 调用上下文
     * @param params 页面参数
     * @return 成功时的 data；失败抛 [BridgeException]
     */
    suspend fun handle(ctx: CallContext, params: JSONObject): Any?
}

/**
 * 异步 Bridge：按方法名分发到挂起处理器，维护 id 到 Job 的表以支持 native.task.cancel。
 *
 * @property session 页面会话号
 */
class AsyncBridge(val session: Int) {

    /** 协程作用域，close 时整体取消 */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** 方法白名单注册表 */
    private val handlers = ConcurrentHashMap<String, SuspendBridgeHandler>()

    /** 在途请求：id 到 Job */
    private val jobs = ConcurrentHashMap<String, Job>()

    /**
     * 注册处理器。
     *
     * @param method 方法名
     * @param handler 处理器
     */
    fun register(method: String, handler: SuspendBridgeHandler) {
        handlers[method] = handler
    }

    /**
     * 分发一条 JSON 请求，立即返回，结果经 io 回传。
     *
     * @param json 请求 JSON
     * @param io 回传通道
     */
    fun dispatch(json: String, io: ReplyIo) {
        val req = runCatching { JSONObject(json) }.getOrNull() ?: return
        val id = req.optString(KEY_ID)
        val method = req.optString(KEY_METHOD)
        val params = req.optJSONObject(KEY_PARAMS) ?: JSONObject()
        if (method == METHOD_CANCEL) {
            val hit = jobs[params.optString(KEY_ID)]?.also { it.cancel() } != null
            safeSend(io, ok(id, JSONObject().put("cancelled", hit)))
            return
        }
        val handler = handlers[method]
        if (handler == null) {
            safeSend(io, err(id, ERR_UNKNOWN_METHOD, "未注册的方法：$method"))
            return
        }
        val ctx = CallContext(session, id, io)
        val job = scope.launch(start = CoroutineStart.LAZY) {
            val resp = try {
                ok(id, handler.handle(ctx, params))
            } catch (e: CancellationException) {
                safeSend(io, err(id, ERR_CANCELLED, "已取消"))
                throw e
            } catch (e: BridgeException) {
                err(id, e.code, e.message ?: "")
            } catch (e: Exception) {
                err(id, ERR_INTERNAL, e.message ?: e.javaClass.simpleName)
            }
            safeSend(io, resp)
        }
        jobs[id] = job
        job.invokeOnCompletion { jobs.remove(id) }
        job.start()
    }

    /** 关闭：取消所有在途请求（页面重载或 WebView 销毁时调用） */
    fun close() {
        scope.cancel()
        jobs.clear()
    }

    /** 回传时吞掉异常，避免页面已销毁导致崩溃 */
    private fun safeSend(io: ReplyIo, json: String) {
        try {
            io.sendJson(json)
        } catch (e: Exception) {
            Log.w(SPIKE_TAG, "reply failed: ${e.message}")
        }
    }

    /** 拼装成功响应 */
    private fun ok(id: String, data: Any?): String =
        JSONObject().put("v", PROTOCOL_V2).put(KEY_ID, id).put("ok", true)
            .put("data", data ?: JSONObject.NULL).toString()

    /** 拼装失败响应 */
    private fun err(id: String, code: String, msg: String): String =
        JSONObject().put("v", PROTOCOL_V2).put(KEY_ID, id).put("ok", false)
            .put("error", JSONObject().put("code", code).put("message", msg)).toString()
}
