package com.let188.arkli.bridge

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import kotlin.coroutines.CoroutineContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** ArkliBridge 的分发、错误转换、取消、会话与事件测试，全程纯 JVM，不碰 android.webkit */
@OptIn(ExperimentalCoroutinesApi::class)
class ArkliBridgeTest {

    /** 收集回传消息的假通道 */
    private class Sink : ReplyIo {
        /** 已收到的消息，按到达顺序 */
        val messages = mutableListOf<JSONObject>()

        /** 记录一条回传 */
        override fun send(json: String) {
            messages += JSONObject(json)
        }

        /** 按请求 id 找响应 */
        fun response(id: String): JSONObject = messages.first { it.optString("id") == id }
    }

    /** 造一个用测试调度器的 Bridge */
    private fun newBridge(sink: Sink, session: Int = 1, binary: Boolean = false) =
        ArkliBridge(session, sink, binary, UnconfinedTestDispatcher())

    /** 拼一条请求 JSON */
    private fun req(id: String, method: String, params: JSONObject? = null): String {
        val o = JSONObject().put("v", 2).put("id", id).put("method", method)
        if (params != null) o.put("params", params)
        return o.toString()
    }

    @Test
    fun dispatchesToRegisteredHandler() {
        val sink = Sink()
        val bridge = newBridge(sink)
        bridge.register("t.echo", BridgeHandler { _, p -> JSONObject().put("x", p.optInt("x")) })
        bridge.dispatch(req("a", "t.echo", JSONObject().put("x", 7)))
        val r = sink.response("a")
        assertTrue(r.getBoolean("ok"))
        assertEquals(2, r.getInt("v"))
        assertEquals(7, r.getJSONObject("data").getInt("x"))
    }

    @Test
    fun missingParamsBecomeEmptyObject() {
        val sink = Sink()
        val bridge = newBridge(sink)
        bridge.register("t.size", BridgeHandler { _, p -> p.length() })
        bridge.dispatch(req("a", "t.size"))
        assertEquals(0, sink.response("a").getInt("data"))
    }

    @Test
    fun nonObjectParamsRejected() {
        val sink = Sink()
        val bridge = newBridge(sink)
        bridge.register("t.x", BridgeHandler { _, _ -> null })
        bridge.dispatch("""{"v":2,"id":"a","method":"t.x","params":[1]}""")
        assertEquals("BAD_PARAMS", sink.response("a").getJSONObject("error").getString("code"))
    }

    @Test
    fun unknownMethodReturnsError() {
        val sink = Sink()
        val bridge = newBridge(sink)
        bridge.dispatch(req("a", "no.such.method"))
        val r = sink.response("a")
        assertFalse(r.getBoolean("ok"))
        assertEquals("UNKNOWN_METHOD", r.getJSONObject("error").getString("code"))
    }

    @Test
    fun malformedOrIdlessMessagesIgnored() {
        val sink = Sink()
        val bridge = newBridge(sink)
        bridge.dispatch("not json")
        bridge.dispatch("""{"v":2,"method":"native.hello"}""")
        assertTrue(sink.messages.isEmpty())
    }

    @Test
    fun bridgeExceptionKeepsItsCode() {
        val sink = Sink()
        val bridge = newBridge(sink)
        bridge.register("t.net", BridgeHandler { _, _ -> throw BridgeException(BridgeErrors.NETWORK, "断网") })
        bridge.dispatch(req("a", "t.net"))
        val e = sink.response("a").getJSONObject("error")
        assertEquals("NETWORK", e.getString("code"))
        assertEquals("断网", e.getString("message"))
    }

    @Test
    fun unexpectedExceptionBecomesInternal() {
        val sink = Sink()
        val bridge = newBridge(sink)
        bridge.register("t.boom", BridgeHandler { _, _ -> error("炸了") })
        bridge.dispatch(req("a", "t.boom"))
        val e = sink.response("a").getJSONObject("error")
        assertEquals("INTERNAL", e.getString("code"))
        assertEquals("炸了", e.getString("message"))
    }

    @Test
    fun handlerTimeoutBecomesTimeoutCode() {
        val sink = Sink()
        val bridge = newBridge(sink)
        bridge.register("t.slow", BridgeHandler { _, _ -> withTimeout(0) { delay(1) } })
        bridge.dispatch(req("a", "t.slow"))
        assertEquals("TIMEOUT", sink.response("a").getJSONObject("error").getString("code"))
    }

    @Test
    fun cancelAbortsInFlightRequest() {
        val sink = Sink()
        val bridge = newBridge(sink)
        val gate = CompletableDeferred<Unit>()
        bridge.register("t.wait", BridgeHandler { _, _ -> gate.await(); "done" })
        bridge.dispatch(req("a", "t.wait"))
        assertEquals(1, bridge.inFlight())
        bridge.dispatch(req("c", ArkliBridge.METHOD_CANCEL, JSONObject().put("id", "a")))
        assertTrue(sink.response("c").getJSONObject("data").getBoolean("cancelled"))
        assertEquals("CANCELLED", sink.response("a").getJSONObject("error").getString("code"))
        assertEquals(0, bridge.inFlight())
    }

    /** 只攒任务、不自动运行的调度器，可按任意顺序放行，模拟线程池里后到的任务先跑 */
    private class ManualDispatcher : CoroutineDispatcher() {
        /** 待运行的任务 */
        val pending = ArrayDeque<Runnable>()

        /** 入队，不执行 */
        override fun dispatch(context: CoroutineContext, block: Runnable) {
            pending.addLast(block)
        }

        /** 从队尾开始跑完所有任务（后入先出） */
        fun runLifo() {
            while (pending.isNotEmpty()) pending.removeLast().run()
        }
    }

    @Test
    fun cancelBeforeCoroutineBodyStillGetsCancelledResponse() {
        val sink = Sink()
        val dispatcher = ManualDispatcher()
        val bridge = ArkliBridge(1, sink, false, dispatcher)
        var ran = false
        bridge.register("t.wait", BridgeHandler { _, _ -> ran = true; "done" })
        bridge.dispatch(req("a", "t.wait"))
        bridge.dispatch(req("c", ArkliBridge.METHOD_CANCEL, JSONObject().put("id", "a")))
        // 取消请求的协程体先于 a 的协程体运行
        dispatcher.runLifo()
        assertTrue(sink.response("c").getJSONObject("data").getBoolean("cancelled"))
        assertEquals("CANCELLED", sink.response("a").getJSONObject("error").getString("code"))
        assertEquals(1, sink.messages.count { it.optString("id") == "a" })
        assertFalse(ran)
        assertEquals(0, bridge.inFlight())
    }

    @Test
    fun normalRequestOnManualDispatcherRespondsOnce() {
        val sink = Sink()
        val dispatcher = ManualDispatcher()
        val bridge = ArkliBridge(1, sink, false, dispatcher)
        bridge.register("t.ok", BridgeHandler { _, _ -> "ok" })
        bridge.dispatch(req("a", "t.ok"))
        dispatcher.runLifo()
        assertEquals(1, sink.messages.count { it.optString("id") == "a" })
        assertTrue(sink.response("a").getBoolean("ok"))
    }

    @Test
    fun cancelUnknownIdReportsFalse() {
        val sink = Sink()
        val bridge = newBridge(sink)
        bridge.dispatch(req("c", ArkliBridge.METHOD_CANCEL, JSONObject().put("id", "nope")))
        assertFalse(sink.response("c").getJSONObject("data").getBoolean("cancelled"))
    }

    @Test
    fun cancelWithoutIdIsBadParams() {
        val sink = Sink()
        val bridge = newBridge(sink)
        bridge.dispatch(req("c", ArkliBridge.METHOD_CANCEL))
        assertEquals("BAD_PARAMS", sink.response("c").getJSONObject("error").getString("code"))
    }

    @Test
    fun duplicateInFlightIdRejected() {
        val sink = Sink()
        val bridge = newBridge(sink)
        bridge.register("t.wait", BridgeHandler { _, _ -> CompletableDeferred<Unit>().await() })
        bridge.dispatch(req("a", "t.wait"))
        bridge.dispatch(req("a", "t.wait"))
        assertEquals("BAD_PARAMS", sink.response("a").getJSONObject("error").getString("code"))
        assertEquals(1, bridge.inFlight())
    }

    @Test
    fun helloReportsSessionAndBinaryCapability() {
        val sink = Sink()
        newBridge(sink, session = 5, binary = true).dispatch(req("h", ArkliBridge.METHOD_HELLO))
        val d = sink.response("h").getJSONObject("data")
        assertEquals(2, d.getInt("protocol"))
        assertEquals(5, d.getInt("session"))
        assertTrue(d.getJSONObject("features").getBoolean("binary"))

        val sink2 = Sink()
        newBridge(sink2).dispatch(req("h", ArkliBridge.METHOD_HELLO))
        assertFalse(sink2.response("h").getJSONObject("data").getJSONObject("features").getBoolean("binary"))
    }

    @Test
    fun sessionNumbersIncrease() {
        val a = BridgeSessions.next()
        val b = BridgeSessions.next()
        assertTrue(b > a)
    }

    @Test
    fun closeCancelsInFlightAndDropsLateReplies() {
        val sink = Sink()
        val bridge = newBridge(sink)
        val gate = CompletableDeferred<Unit>()
        bridge.register("t.wait", BridgeHandler { _, _ -> gate.await(); "late" })
        bridge.dispatch(req("a", "t.wait"))
        bridge.close()
        gate.complete(Unit)
        bridge.emit("x.event", JSONObject().put("n", 1))
        bridge.dispatch(req("b", ArkliBridge.METHOD_HELLO))
        // 关闭后：没有 CANCELLED 响应、没有迟到结果、没有事件、不再受理新请求
        assertTrue(sink.messages.isEmpty())
        assertEquals(0, bridge.inFlight())
    }

    @Test
    fun oldSessionEventsDoNotReachNewSession() {
        val oldSink = Sink()
        val newSink = Sink()
        val old = newBridge(oldSink, session = 1)
        old.close()
        val fresh = newBridge(newSink, session = 2)
        old.emit("sensor.data", JSONObject().put("v", 1), sub = "s1")
        fresh.emit("sensor.data", JSONObject().put("v", 2), sub = "s2")
        assertTrue(oldSink.messages.isEmpty())
        assertEquals(1, newSink.messages.size)
        assertEquals("s2", newSink.messages[0].getString("sub"))
    }

    @Test
    fun eventCarriesSubAndData() {
        val sink = Sink()
        val bridge = newBridge(sink)
        bridge.emit("task.progress", JSONObject().put("percent", 42), sub = "sub-1")
        bridge.emit(ArkliBridge.EVENT_APP_PAUSE)
        val e = sink.messages[0]
        assertEquals("task.progress", e.getString("event"))
        assertEquals("sub-1", e.getString("sub"))
        assertEquals(42, e.getJSONObject("data").getInt("percent"))
        assertFalse(sink.messages[1].has("sub"))
        assertEquals(2, sink.messages[1].getInt("v"))
    }

    @Test
    fun launchTaskReturnsIdThenPushesEventsAndCanBeCancelled() {
        val sink = Sink()
        val bridge = newBridge(sink)
        val gate = CompletableDeferred<Unit>()
        bridge.register("t.job", BridgeHandler { ctx, _ ->
            val taskId = ctx.launchTask {
                ctx.emit("task.progress", JSONObject().put("percent", 1))
                gate.await()
                ctx.emit("task.done")
            }
            JSONObject().put("taskId", taskId)
        })
        bridge.dispatch(req("a", "t.job"))
        val taskId = sink.response("a").getJSONObject("data").getString("taskId")
        assertEquals("task.progress", sink.messages.last().getString("event"))
        bridge.dispatch(req("c", ArkliBridge.METHOD_CANCEL, JSONObject().put("id", taskId)))
        assertTrue(sink.response("c").getJSONObject("data").getBoolean("cancelled"))
        gate.complete(Unit)
        assertTrue(sink.messages.none { it.optString("event") == "task.done" })
    }

    @Test
    fun failingTaskEmitsTaskError() {
        val sink = Sink()
        val bridge = newBridge(sink)
        bridge.register("t.job", BridgeHandler { ctx, _ ->
            ctx.launchTask { throw BridgeException(BridgeErrors.NETWORK, "断了") }
            null
        })
        bridge.dispatch(req("a", "t.job"))
        val e = sink.messages.first { it.optString("event") == ArkliBridge.EVENT_TASK_ERROR }
        assertEquals("NETWORK", e.getJSONObject("data").getJSONObject("error").getString("code"))
    }

    @Test
    fun replyFailureIsSwallowed() {
        val bridge = ArkliBridge(1, ReplyIo { error("页面已销毁") }, false, UnconfinedTestDispatcher())
        bridge.dispatch(req("a", ArkliBridge.METHOD_HELLO))
        bridge.emit("x")
    }

    @Test
    fun contextExposesSessionAndFrame() {
        val sink = Sink()
        val bridge = newBridge(sink, session = 9)
        bridge.register("t.ctx", BridgeHandler { ctx, _ ->
            JSONObject().put("s", ctx.session).put("id", ctx.requestId).put("main", ctx.isMainFrame)
        })
        bridge.dispatch(req("a", "t.ctx"), isMainFrame = false)
        val d = sink.response("a").getJSONObject("data")
        assertEquals(9, d.getInt("s"))
        assertEquals("a", d.getString("id"))
        assertFalse(d.getBoolean("main"))
    }
}
