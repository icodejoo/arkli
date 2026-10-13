package com.let188.arkli.files

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.ReplyIo
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** openWrite / closeWrite 的参数校验与 abort 分支，经 ArkliBridge 走一遍真实分发 */
@OptIn(ExperimentalCoroutinesApi::class)
class FileModuleTest {
    /** 每个用例独立的临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 收到的回包 */
    private val replies = java.util.Collections.synchronizedList(mutableListOf<JSONObject>())

    /** 造桥并注册两个被测处理器 */
    private fun newBridge(): ArkliBridge {
        val registry = WriteRegistry(File(tmp.root, "tmp"), File(tmp.root, "out"))
        val bridge = ArkliBridge(1, ReplyIo { replies += JSONObject(it) }, false, UnconfinedTestDispatcher())
        bridge.register("t.open", FileModule.OpenWrite(registry))
        bridge.register("t.close", FileModule.CloseWrite(registry) { f -> "cache/out/${f.name}" to "https://x/${f.name}" })
        return bridge
    }

    /** 发一条请求并返回对应回包 */
    private fun call(bridge: ArkliBridge, id: String, method: String, params: JSONObject): JSONObject {
        bridge.dispatch(JSONObject().put("v", 2).put("id", id).put("method", method).put("params", params).toString())
        // 处理器里有 withContext(IO)，回包是异步的，轮询等到
        val deadline = System.currentTimeMillis() + WAIT_MS
        while (System.currentTimeMillis() < deadline) {
            replies.toList().firstOrNull { it.optString("id") == id }?.let { return it }
            Thread.sleep(POLL_MS)
        }
        throw AssertionError("等不到回包：$id")
    }

    /** 打开一个句柄 */
    private fun open(bridge: ArkliBridge, id: String): String =
        call(bridge, id, "t.open", JSONObject().put("name", "a.bin")).getJSONObject("data").getString("handle")

    /** 断言是 BAD_PARAMS 错误 */
    private fun assertBad(r: JSONObject) {
        assertFalse(r.toString(), r.getBoolean("ok"))
        assertEquals("BAD_PARAMS", r.getJSONObject("error").getString("code"))
    }

    @Test
    fun closeWriteRejectsNonStringSha256() {
        val b = newBridge()
        val bad = listOf<Any>(123, JSONObject().put("a", 1), true)
        bad.forEachIndexed { i, v ->
            val h = open(b, "o$i")
            assertBad(call(b, "c$i", "t.close", JSONObject().put("handle", h).put("sha256", v)))
        }
    }

    @Test
    fun closeWriteAcceptsNullAndMissingSha256() {
        val b = newBridge()
        val h1 = open(b, "o1")
        assertTrue(call(b, "c1", "t.close", JSONObject().put("handle", h1)).getBoolean("ok"))
        val h2 = open(b, "o2")
        assertTrue(call(b, "c2", "t.close", JSONObject().put("handle", h2).put("sha256", JSONObject.NULL)).getBoolean("ok"))
    }

    @Test
    fun openWriteRejectsNonStringSha256AndNonNumberSize() {
        val b = newBridge()
        assertBad(call(b, "a", "t.open", JSONObject().put("name", "a").put("sha256", 5)))
        assertBad(call(b, "b", "t.open", JSONObject().put("name", "a").put("size", "12")))
        assertBad(call(b, "c", "t.open", JSONObject()))
    }

    @Test
    fun closeWriteRejectsNonNumberSize() {
        val b = newBridge()
        val h = open(b, "o")
        assertBad(call(b, "c", "t.close", JSONObject().put("handle", h).put("size", "abc")))
    }

    @Test
    fun closeWriteRequiresHandle() {
        assertBad(call(newBridge(), "c", "t.close", JSONObject()))
    }

    @Test
    fun abortDiscardsHandle() {
        val b = newBridge()
        val h = open(b, "o")
        val first = call(b, "a1", "t.close", JSONObject().put("handle", h).put("abort", true))
        assertTrue(first.getJSONObject("data").getBoolean("aborted"))
        val second = call(b, "a2", "t.close", JSONObject().put("handle", h).put("abort", true))
        assertFalse(second.getJSONObject("data").getBoolean("aborted"))
        assertBad(call(b, "c", "t.close", JSONObject().put("handle", h)))
    }

    private companion object {
        /** 等回包的最长时间 */
        const val WAIT_MS = 5000L

        /** 轮询间隔 */
        const val POLL_MS = 5L
    }
}
