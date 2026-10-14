package com.let188.arkli.dircleaner

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** 文件夹清理的参数解析、授权记录编解码与扫描登记测试 */
class DirPolicyTest {
    /** 断言抛出 BAD_PARAMS */
    private fun assertBad(block: () -> Unit) {
        try {
            block()
            fail("应当抛出 BAD_PARAMS")
        } catch (e: BridgeException) {
            assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        }
    }

    @Test
    fun scanDefaults() {
        val o = DirPolicy.parseScan(JSONObject().put("mode", "large"))
        assertEquals(ScanMode.LARGE, o.mode)
        assertEquals(50L shl 20, o.minBytes)
        assertEquals(2000, o.maxItems)
        assertEquals(12, o.maxDepth)
    }

    @Test
    fun scanRejectsBadValues() {
        assertBad { DirPolicy.parseScan(JSONObject()) }
        assertBad { DirPolicy.parseScan(JSONObject().put("mode", "x")) }
        assertBad { DirPolicy.parseScan(JSONObject().put("mode", "all").put("maxItems", 5001)) }
        assertBad { DirPolicy.parseScan(JSONObject().put("mode", "all").put("maxItems", 0)) }
        assertBad { DirPolicy.parseScan(JSONObject().put("mode", "all").put("maxDepth", 21)) }
        assertBad { DirPolicy.parseScan(JSONObject().put("mode", "all").put("minBytes", -1)) }
        assertBad { DirPolicy.parseScan(JSONObject().put("mode", "all").put("maxDepth", "3")) }
    }

    @Test
    fun scanAcceptsLimits() {
        val o = DirPolicy.parseScan(JSONObject().put("mode", "apk").put("maxItems", 5000).put("maxDepth", 20).put("minBytes", 0))
        assertEquals(5000, o.maxItems)
        assertEquals(20, o.maxDepth)
        assertEquals(0L, o.minBytes)
    }

    @Test
    fun idsDedupAndLimit() {
        val ok = DirPolicy.parseIds(JSONObject().put("ids", JSONArray(listOf("a", "b", "a"))))
        assertEquals(listOf("a", "b"), ok)
        assertBad { DirPolicy.parseIds(JSONObject()) }
        assertBad { DirPolicy.parseIds(JSONObject().put("ids", JSONArray())) }
        assertBad { DirPolicy.parseIds(JSONObject().put("ids", JSONArray(listOf(1)))) }
        assertBad { DirPolicy.parseIds(JSONObject().put("ids", JSONArray((1..501).map { "i$it" }))) }
    }

    @Test
    fun deleteOrderDeepFirst() {
        fun n(rel: String, depth: Int) = DirNode(rel, rel, rel, 0, 0, true, depth)
        val order = DirPolicy.deleteOrder(listOf(n("a", 1), n("a/b/c", 3), n("a/b", 2))).map { it.relPath }
        assertEquals(listOf("a/b/c", "a/b", "a"), order)
    }

    @Test
    fun tokensAreOpaqueAndUnique() {
        val a = DirPolicy.newToken()
        assertTrue(a.startsWith("dir:"))
        assertNotEquals(a, DirPolicy.newToken())
    }

    @Test
    fun codecRoundTripAndTolerance() {
        val list = listOf(DirRecord("t1", "content://x/tree/a", "下载"), DirRecord("t2", "content://x/tree/b", ""))
        assertEquals(list, DirRecordCodec.decode(DirRecordCodec.encode(list)))
        assertTrue(DirRecordCodec.decode(null).isEmpty())
        assertTrue(DirRecordCodec.decode("not json").isEmpty())
        val partial = JSONArray().put(JSONObject().put("t", "x")).put("junk").put(JSONObject().put("t", "ok").put("u", "u")).toString()
        assertEquals(listOf(DirRecord("ok", "u", "")), DirRecordCodec.decode(partial))
    }

    @Test
    fun registryScopesIdsToLatestScanOfToken() {
        val reg = ScanRegistry()
        val n = DirNode("d1", "a", "a", 5, 0, false, 1)
        val id = reg.replace("t1", listOf(n)).single()
        assertEquals(n, reg.lookup("t1", id))
        assertNull(reg.lookup("t2", id))
        reg.replace("t1", emptyList())
        assertNull(reg.lookup("t1", id))
    }

    @Test
    fun registryDropAndClear() {
        val reg = ScanRegistry()
        val n = DirNode("d1", "a", "a", 5, 0, false, 1)
        val id = reg.replace("t1", listOf(n)).single()
        reg.drop("t1", id)
        assertNull(reg.lookup("t1", id))
        val id2 = reg.replace("t1", listOf(n)).single()
        reg.clear()
        assertNull(reg.lookup("t1", id2))
    }
}
