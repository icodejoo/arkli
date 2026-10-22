package com.let188.arkli.model

import com.let188.arkli.ai.CLIP_MODEL_DIR
import com.let188.arkli.ai.CLIP_MODEL_FILE
import com.let188.arkli.ai.ClipService
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.net.NetPolicy
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 清单解析、白名单、状态推断、Range 判定、重定向、序列化等纯逻辑 */
class ModelManifestPolicyTest {
    /** 合法清单模板，可替换片段做反例 */
    private fun manifestJson(
        id: String = "m1",
        dir: String = "models/m1",
        name: String = "m.bin",
        bytes: Long = 10,
        total: Long = 10,
        sha: String = "a".repeat(64),
        url: String = "https://github.com/o/r/releases/download/v1/m.bin",
        extraModel: String = "",
    ) = """
        {"schema":1,"models":[{"id":"$id","displayName":"X","version":"1","dir":"$dir","totalBytes":$total,
          "files":[{"name":"$name","bytes":$bytes,"sha256":"$sha","urls":["$url"]}]}$extraModel]}
    """.trimIndent()

    /** 断言解析被拒 */
    private fun assertRejected(json: String) {
        assertThrows(IllegalArgumentException::class.java) { ModelManifestParser.parse(json) }
    }

    @Test
    fun shippedManifest_isValid_andMatchesClipConvention() {
        val text = File("src/main/assets/ai/models.json").readText()
        val m = ModelManifestParser.parse(text)
        val e = m.find(ClipService.MODEL_ID)
        assertNotNull(e)
        assertEquals(CLIP_MODEL_DIR, e!!.dir)
        // 外置权重版：图文件 + 同名 .weight（Rust 侧自动带上）
        val model = e.files.single { it.name == CLIP_MODEL_FILE }
        val weight = e.files.single { it.name == CLIP_MODEL_FILE + ".weight" }
        assertEquals(94_777_956L, e.totalBytes)
        assertEquals("e52fa643ffc2ebffe90148ab5d43f1f82fcd8536750d3878a318297ccb4a35cb", model.sha256)
        assertEquals("7921a38ecdab60fd8ca8f2f023fbd8a07eff516d3af80d3489ce6ec56d001d8e", weight.sha256)
        assertTrue(e.files.all { f -> f.urls.all { NetPolicy.isAllowedDownload(it) } })
    }

    @Test
    fun validManifest_parses() {
        val m = ModelManifestParser.parse(manifestJson())
        assertEquals("m1", m.find("m1")!!.id)
        assertNull(m.find("nope"))
    }

    @Test
    fun rejects_badIdsDirsAndNames() {
        assertRejected(manifestJson(id = "Bad Id"))
        assertRejected(manifestJson(dir = "models/../x"))
        assertRejected(manifestJson(dir = "models/a/b"))
        assertRejected(manifestJson(dir = "/etc/m1"))
        assertRejected(manifestJson(dir = "other/m1"))
        assertRejected(manifestJson(dir = "models/.hidden"))
        assertRejected(manifestJson(name = "../m.bin"))
        assertRejected(manifestJson(name = "m.bin.part"))
        assertRejected(manifestJson(name = ".hidden"))
    }

    @Test
    fun rejects_badShaBytesAndTotals() {
        assertRejected(manifestJson(sha = "A".repeat(64)))
        assertRejected(manifestJson(sha = "a".repeat(63)))
        assertRejected(manifestJson(bytes = 0, total = 0))
        assertRejected(manifestJson(total = 11))
    }

    @Test
    fun rejects_urlsOutsideAllowList() {
        assertRejected(manifestJson(url = "http://github.com/x"))
        assertRejected(manifestJson(url = "https://evil.example.com/x"))
        assertRejected(manifestJson(url = "https://github.com.evil.com/x"))
        assertRejected(manifestJson(url = "https://user@github.com/x"))
        assertRejected(manifestJson(url = "http://127.0.0.1:8000/x"))
    }

    @Test
    fun rejects_duplicatesAndGarbage() {
        val dup = """,{"id":"m1","displayName":"Y","version":"1","dir":"models/m2","totalBytes":10,
          "files":[{"name":"m.bin","bytes":10,"sha256":"${"b".repeat(64)}","urls":["https://github.com/x"]}]}"""
        assertRejected(manifestJson(extraModel = dup))
        assertRejected("not json")
        assertRejected("""{"schema":2,"models":[]}""")
        assertRejected("""{"schema":1,"models":[]}""")
    }

    @Test
    fun downloadHosts_areSeparateFromPageHosts_andStrict() {
        assertTrue(NetPolicy.isAllowedDownload("https://github.com/a/b/releases/download/v1/x"))
        assertTrue(NetPolicy.isAllowedDownload("https://GitHub.com:443/a"))
        assertTrue(NetPolicy.isAllowedDownload("https://objects.githubusercontent.com/x"))
        assertTrue(NetPolicy.isAllowedDownload("https://release-assets.githubusercontent.com/x"))
        assertFalse(NetPolicy.isAllowedDownload("https://api.wikimedia.org/x"))
        assertFalse(NetPolicy.isAllowedDownload("https://github.com:8443/x"))
        assertFalse(NetPolicy.isAllowedDownload("https://github.com./x"))
        assertFalse(NetPolicy.isAllowedDownload("ftp://github.com/x"))
        assertFalse(NetPolicy.isAllowedDownload("not a url"))
        // 页面出站放行任意 https，但脚本仍只允许同源，下载白名单不因此变宽
        assertFalse(NetPolicy.isAllowedDownload("https://example.com/x"))
    }

    @Test
    fun loopbackHttp_needsExplicitSwitch_andOnlyOnLoopback() {
        assertFalse(NetPolicy.isAllowedDownload("http://127.0.0.1:8765/x"))
        assertTrue(NetPolicy.isAllowedDownload("http://127.0.0.1:8765/x", allowLoopbackHttp = true))
        assertFalse(NetPolicy.isAllowedDownload("http://localhost:8765/x", allowLoopbackHttp = true))
        assertFalse(NetPolicy.isAllowedDownload("http://github.com/x", allowLoopbackHttp = true))
        assertFalse(NetPolicy.isAllowedDownload("http://u@127.0.0.1/x", allowLoopbackHttp = true))
    }

    @Test
    fun requireEntry_validatesId() {
        val m = ModelManifestParser.parse(manifestJson())
        assertEquals("m1", ModelPolicy.requireEntry(JSONObject().put("id", "m1"), m).id)
        listOf(JSONObject(), JSONObject().put("id", 5), JSONObject().put("id", "../x"), JSONObject().put("id", "m2")).forEach {
            val e = assertThrows(BridgeException::class.java) { ModelPolicy.requireEntry(it, m) }
            assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        }
    }

    @Test
    fun requiredFreeBytes_is1p2xRoundedUp() {
        assertEquals(65_595_366L, ModelPolicy.requiredFreeBytes(54_662_805L))
        assertEquals(0L, ModelPolicy.requiredFreeBytes(0))
        assertEquals(2L, ModelPolicy.requiredFreeBytes(1))
    }

    @Test
    fun backoff_doublesAndCaps() {
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 8_000L), (0..4).map { ModelPolicy.backoffMs(it) })
        assertEquals(1_000L, ModelPolicy.backoffMs(-3))
    }

    /** 造一个单文件模型（10 字节） */
    private val entry = ModelManifestParser.parse(manifestJson()).find("m1")!!

    @Test
    fun diskState_coversAllCases() {
        val ok = VerifiedMarker("1", mapOf("m.bin" to Pair(10L, 500L)))
        fun s(final: Long?, mtime: Long? = 500L, part: Long = 0, marker: VerifiedMarker? = ok) =
            ModelPolicy.diskState(entry, listOf(FileFacts("m.bin", final, mtime, part)), marker)
        assertEquals(ModelState.INSTALLED, s(10))
        assertEquals(ModelState.UNVERIFIED, s(10, marker = null))
        assertEquals(ModelState.UNVERIFIED, s(10, mtime = 999))
        assertEquals(ModelState.UNVERIFIED, s(10, marker = VerifiedMarker("2", ok.files)))
        assertEquals(ModelState.CORRUPT, s(9))
        assertEquals(ModelState.ABSENT, s(null, null))
        assertEquals(ModelState.ABSENT, s(null, null, part = 5))
    }

    @Test
    fun downloadedAndDiskBytes() {
        val f = { final: Long?, part: Long -> listOf(FileFacts("m.bin", final, 1L, part)) }
        assertEquals(10L, ModelPolicy.downloadedBytes(entry, f(10, 0)))
        assertEquals(4L, ModelPolicy.downloadedBytes(entry, f(null, 4)))
        assertEquals(10L, ModelPolicy.downloadedBytes(entry, f(null, 99)))
        assertEquals(14L, ModelPolicy.diskBytes(f(10, 4)))
    }

    @Test
    fun markerRoundTrip_andGarbageIsNull() {
        val m = VerifiedMarker("1", mapOf("a" to Pair(1L, 2L), "b" to Pair(3L, 4L)))
        assertEquals(m, ModelPolicy.markerFromJson(ModelPolicy.markerToJson(m)))
        assertNull(ModelPolicy.markerFromJson("{oops"))
        assertNull(ModelPolicy.markerFromJson(null))
        assertNull(ModelPolicy.markerFromJson("""{"version":"1"}"""))
    }

    @Test
    fun decideRange_table() {
        val total = 100L
        assertEquals(RangeDecision.Write(0), ModelPolicy.decideRange(200, 0, null, 100, total))
        assertEquals(RangeDecision.Write(0), ModelPolicy.decideRange(200, 40, null, null, total))
        assertTrue(ModelPolicy.decideRange(200, 0, null, 99, total) is RangeDecision.Fail)
        assertEquals(RangeDecision.Write(40), ModelPolicy.decideRange(206, 40, "bytes 40-99/100", 60, total))
        assertEquals(RangeDecision.Write(40), ModelPolicy.decideRange(206, 40, "bytes 40-99/*", 60, total))
        listOf("bytes 41-99/100", "bytes 40-98/100", "bytes 40-99/101", "garbage", null).forEach {
            val d = ModelPolicy.decideRange(206, 40, it, 60, total)
            assertTrue("应失败：$it", d is RangeDecision.Fail)
        }
        assertEquals(RangeDecision.Complete, ModelPolicy.decideRange(416, 100, null, null, total))
        assertEquals(RangeDecision.Restart, ModelPolicy.decideRange(416, 40, null, null, total))
        assertTrue(ModelPolicy.decideRange(416, 0, null, null, total) is RangeDecision.Fail)
        assertTrue((ModelPolicy.decideRange(503, 0, null, null, total) as RangeDecision.Fail).error.retriable)
        assertTrue((ModelPolicy.decideRange(429, 0, null, null, total) as RangeDecision.Fail).error.retriable)
        assertFalse((ModelPolicy.decideRange(404, 0, null, null, total) as RangeDecision.Fail).error.retriable)
        assertTrue(ModelPolicy.decideRange(206, 0, "bytes 0-99/100", 100, total) is RangeDecision.Fail)
    }

    @Test
    fun nextHop_resolvesAndValidates() {
        val cur = "https://github.com/a/b"
        assertEquals("https://objects.githubusercontent.com/x?y=1", ModelPolicy.nextHop(cur, "https://objects.githubusercontent.com/x?y=1", 0, false))
        assertEquals("https://github.com/c", ModelPolicy.nextHop(cur, "/c", 0, false))
        listOf("https://evil.com/x", "http://github.com/x", null, " ").forEach {
            val e = assertThrows(ModelDownloadException::class.java) { ModelPolicy.nextHop(cur, it, 0, false) }
            assertEquals(ModelErrorCode.SOURCE_REJECTED, e.code)
        }
        assertThrows(ModelDownloadException::class.java) { ModelPolicy.nextHop(cur, "/c", MAX_REDIRECTS, false) }
        assertEquals("http://127.0.0.1:1/x", ModelPolicy.nextHop("http://127.0.0.1:1/a", "/x", 0, true))
    }

    @Test
    fun snapshotJson_hasNoPaths_andShowsError() {
        val s = ModelSnapshot("m1", "名", "1", ModelState.ABSENT, 10, 4, 4, errorCode = "NETWORK", errorMessage = "断了")
        val o = ModelPolicy.snapshotJson(s)
        assertEquals("absent", o.getString("state"))
        assertEquals("NETWORK", o.getJSONObject("error").getString("code"))
        assertFalse(o.has("phase"))
        assertFalse(o.toString().contains("/"))
        val d = ModelPolicy.snapshotJson(ModelSnapshot("m1", "名", "1", ModelState.DOWNLOADING, 10, 4, 4, "download", 1234))
        assertEquals(1234L, d.getLong("speedBps"))
        assertEquals("download", d.getString("phase"))
        assertFalse(d.has("error"))
    }
}
