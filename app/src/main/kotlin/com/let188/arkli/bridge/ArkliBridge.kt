package com.let188.arkli.bridge

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Bridge v2 的原生侧核心：解析请求、按方法名分发到挂起处理器、维护在途请求以支持取消。
 *
 * 一个实例对应一个页面会话；WebView 重载或崩溃时 [close] 掉旧的，再用新会话号建新的，
 * 旧会话的在途请求被取消，迟到的响应与事件一律丢弃，不会串到新页面。
 * 本类不依赖 android.webkit，可在纯 JVM 单测里运行。
 *
 * 使用示例：
 * ```
 * val bridge = ArkliBridge(BridgeSessions.next(), ReplyIo { json -> post(json) }, binary = false)
 * bridge.register("native.ping", BridgeHandler { _, _ -> JSONObject().put("pong", true) })
 * bridge.dispatch(messageFromPage)
 * ```
 *
 * @param session 页面会话号
 * @param io 回传通道
 * @param binary 当前 WebView 是否支持 ArrayBuffer 消息，`native.hello` 原样告诉页面
 * @param dispatcher 处理器运行的调度器，测试时可换成测试调度器
 */
class ArkliBridge(
    val session: Int,
    private val io: ReplyIo,
    private val binary: Boolean = false,
    dispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    /** 吞掉后台任务里未捕获的异常，避免在 Android 上直接崩进程 */
    private val swallow = CoroutineExceptionHandler { _, _ -> }

    /** 协程作用域，[close] 时整体取消 */
    private val scope = CoroutineScope(SupervisorJob() + dispatcher + swallow)

    /** 方法名 → 处理器的白名单注册表，没注册的方法一律拒绝 */
    private val handlers = ConcurrentHashMap<String, BridgeHandler>()

    /** 在途请求与后台任务：id 或任务号 → Job */
    private val jobs = ConcurrentHashMap<String, Job>()

    /** 后台任务序号 */
    private val taskSeq = AtomicLong()

    /** 会话关闭时要执行的清理回调，如释放文件写句柄 */
    private val closeListeners = CopyOnWriteArrayList<() -> Unit>()

    /** 关闭回调是否已经跑过，保证只跑一次 */
    private val closeNotified = AtomicBoolean(false)

    /** 已关闭标记，关闭后不再收发 */
    @Volatile
    private var closed = false

    init {
        handlers[METHOD_HELLO] = BridgeHandler { _, _ ->
            JSONObject().put("protocol", PROTOCOL_VERSION).put("session", session)
                .put("features", JSONObject().put("binary", binary))
        }
        handlers[METHOD_CANCEL] = BridgeHandler { _, params ->
            val target = params.optString(KEY_ID)
            if (target.isEmpty()) throw BridgeException(BridgeErrors.BAD_PARAMS, "缺少 id")
            val job = jobs[target]
            job?.cancel()
            JSONObject().put("cancelled", job != null)
        }
    }

    /**
     * 注册一个方法处理器，同名覆盖。
     *
     * @param method 方法名，格式 `域.模块.动作`
     * @param handler 对应的处理器
     */
    fun register(method: String, handler: BridgeHandler) {
        handlers[method] = handler
    }

    /**
     * 登记会话关闭回调，[close] 时在取消在途请求之后执行一次，回调里的异常被吞掉。
     *
     * @param listener 清理动作，如丢弃未关闭的写句柄
     */
    fun onClose(listener: () -> Unit) {
        closeListeners.add(listener)
    }

    /**
     * 分发页面发来的一条请求，立即返回，结果经 io 回传。
     * 无法解析、缺少 id 的消息无处可回，直接忽略。
     *
     * @param json 请求 JSON，格式见 bridge-protocol.md
     * @param isMainFrame 消息是否来自主 frame
     */
    fun dispatch(json: String, isMainFrame: Boolean = true) {
        if (closed) return
        val request = runCatching { JSONObject(json) }.getOrNull() ?: return
        val id = request.optString(KEY_ID)
        if (id.isEmpty()) return
        val method = request.optString(KEY_METHOD)
        val handler = handlers[method]
        if (handler == null) {
            send(errorResponse(id, BridgeErrors.UNKNOWN_METHOD, "未注册的方法：$method"))
            return
        }
        val params = when (val raw = request.opt(KEY_PARAMS)) {
            null, JSONObject.NULL -> JSONObject()
            is JSONObject -> raw
            else -> {
                send(errorResponse(id, BridgeErrors.BAD_PARAMS, "params 必须是对象"))
                return
            }
        }
        val ctx = CallContext(session, id, isMainFrame, this)
        val job = scope.launch(start = CoroutineStart.LAZY) { run(id, handler, ctx, params) }
        if (jobs.putIfAbsent(id, job) != null) {
            job.cancel()
            send(errorResponse(id, BridgeErrors.BAD_PARAMS, "重复的请求 id：$id"))
            return
        }
        job.invokeOnCompletion { jobs.remove(id, job) }
        job.start()
    }

    /**
     * 向页面推一个事件，会话关闭后丢弃。
     *
     * @param event 事件名
     * @param data 事件数据，可为 null
     * @param sub 订阅号，可为 null
     */
    fun emit(event: String, data: Any? = null, sub: String? = null) {
        val msg = JSONObject().put(KEY_V, PROTOCOL_VERSION).put(KEY_EVENT, event)
        if (sub != null) msg.put(KEY_SUB, sub)
        send(msg.put(KEY_DATA, data ?: JSONObject.NULL).toString())
    }

    /**
     * 启动后台任务，见 [CallContext.launchTask]。
     *
     * @param block 任务体
     * @return 任务号
     */
    internal fun launchTask(block: suspend CoroutineScope.() -> Unit): String {
        val taskId = "task-$session-${taskSeq.incrementAndGet()}"
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: BridgeException) {
                emitTaskError(taskId, e.code, e.message)
            } catch (e: Exception) {
                emitTaskError(taskId, BridgeErrors.INTERNAL, e.message ?: e.javaClass.simpleName)
            }
        }
        jobs[taskId] = job
        job.invokeOnCompletion { jobs.remove(taskId, job) }
        job.start()
        return taskId
    }

    /**
     * 关闭会话：先置关闭标记（之后的响应与事件全部丢弃），再取消所有在途请求与任务。
     * 页面重载、渲染进程崩溃、WebView 销毁时调用，可重复调用。
     */
    fun close() {
        closed = true
        scope.cancel()
        jobs.clear()
        if (closeNotified.compareAndSet(false, true)) {
            for (l in closeListeners) runCatching { l() }
        }
    }

    /** 在途请求与任务数，供测试与诊断 */
    internal fun inFlight(): Int = jobs.size

    /** 执行一次调用并把结果转成响应 */
    private suspend fun run(id: String, handler: BridgeHandler, ctx: CallContext, params: JSONObject) {
        val response = try {
            okResponse(id, handler.handle(ctx, params))
        } catch (e: TimeoutCancellationException) {
            errorResponse(id, BridgeErrors.TIMEOUT, e.message ?: "超时")
        } catch (e: CancellationException) {
            send(errorResponse(id, BridgeErrors.CANCELLED, "已取消"))
            throw e
        } catch (e: BridgeException) {
            errorResponse(id, e.code, e.message ?: "")
        } catch (e: Exception) {
            errorResponse(id, BridgeErrors.INTERNAL, e.message ?: e.javaClass.simpleName)
        }
        send(response)
    }

    /** 推送后台任务失败事件 */
    private fun emitTaskError(taskId: String, code: String, message: String?) {
        val error = JSONObject().put("code", code).put("message", message ?: "")
        emit(EVENT_TASK_ERROR, JSONObject().put("taskId", taskId).put("error", error))
    }

    /** 回传一条消息；已关闭或页面已销毁时吞掉 */
    private fun send(json: String) {
        if (closed) return
        try {
            io.send(json)
        } catch (_: Exception) {
            // 页面已销毁，丢弃
        }
    }

    /** 拼装成功响应 */
    private fun okResponse(id: String, data: Any?): String =
        JSONObject().put(KEY_V, PROTOCOL_VERSION).put(KEY_ID, id).put("ok", true)
            .put(KEY_DATA, data ?: JSONObject.NULL).toString()

    /** 拼装失败响应 */
    private fun errorResponse(id: String, code: String, message: String): String =
        JSONObject().put(KEY_V, PROTOCOL_VERSION).put(KEY_ID, id).put("ok", false)
            .put("error", JSONObject().put("code", code).put("message", message)).toString()

    companion object {
        /** 页面侧注入的对象名，需与 web/src/native/bridge.ts 一致 */
        const val JS_OBJECT_NAME = "ArkliNative"

        /** 当前协议版本 */
        const val PROTOCOL_VERSION = 2

        /** 握手方法：返回协议版本、会话号与能力 */
        const val METHOD_HELLO = "native.hello"

        /** 通用取消方法 */
        const val METHOD_CANCEL = "native.task.cancel"

        /** 生命周期事件：App 退到后台 */
        const val EVENT_APP_PAUSE = "app.pause"

        /** 生命周期事件：App 回到前台 */
        const val EVENT_APP_RESUME = "app.resume"

        /** 后台任务失败事件 */
        const val EVENT_TASK_ERROR = "task.error"

        private const val KEY_V = "v"
        private const val KEY_ID = "id"
        private const val KEY_METHOD = "method"
        private const val KEY_PARAMS = "params"
        private const val KEY_EVENT = "event"
        private const val KEY_SUB = "sub"
        private const val KEY_DATA = "data"
    }
}
