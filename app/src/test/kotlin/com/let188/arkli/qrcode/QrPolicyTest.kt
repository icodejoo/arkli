package com.let188.arkli.qrcode

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** [QrPolicy] 的纯逻辑单测 */
class QrPolicyTest {
    /** 测试用 base64：直接用十六进制，免依赖 android */
    private fun enc(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    @Test
    fun 实时取景关掉三个慢选项() {
        val s = QrPolicy.LIVE_SPEC
        assertFalse(s.tryHarder)
        assertFalse(s.tryRotate)
        assertFalse(s.tryInvert)
    }

    @Test
    fun 相册识图全部打开() {
        val s = QrPolicy.IMAGE_SPEC
        assertTrue(s.tryHarder && s.tryRotate && s.tryInvert && s.tryDownscale && s.tryDenoise)
    }

    @Test
    fun 映射保留码种文本与字节() {
        val hit = QrPolicy.mapHit("QR_CODE", "hi", "hi".toByteArray(), ::enc)
        assertEquals(QrHit("hi", "QR_CODE", "6869"), hit)
    }

    @Test
    fun 文本为空但有字节也保留() {
        val hit = QrPolicy.mapHit("DATA_MATRIX", null, byteArrayOf(1, 2), ::enc)
        assertEquals(QrHit("", "DATA_MATRIX", "0102"), hit)
    }

    @Test
    fun 文本和字节都没有视为无效() {
        assertNull(QrPolicy.mapHit("QR_CODE", "", null, ::enc))
        assertNull(QrPolicy.mapHit("QR_CODE", null, ByteArray(0), ::enc))
    }

    @Test
    fun 去重按码种加字节且保持顺序() {
        val a = QrHit("a", "QR_CODE", "61")
        val b = QrHit("b", "QR_CODE", "62")
        val aOther = QrHit("a", "EAN_13", "61")
        assertEquals(listOf(a, b, aOther), QrPolicy.dedupe(listOf(a, b, a, aOther)))
    }

    @Test
    fun JSON往返不丢字段() {
        val hits = listOf(QrHit("你好", "QR_CODE", "AAA="), QrHit("123", "EAN_13", "MTIz"))
        assertEquals(hits, QrPolicy.hitsFromJson(QrPolicy.hitsToJson(hits).toString()))
    }

    @Test
    fun 坏JSON与缺码种的项被跳过() {
        assertTrue(QrPolicy.hitsFromJson(null).isEmpty())
        assertTrue(QrPolicy.hitsFromJson("不是json").isEmpty())
        assertEquals(listOf(QrHit("x", "QR_CODE", "")), QrPolicy.hitsFromJson("""[{"text":"x","format":"QR_CODE"},{"text":"y"},1]"""))
    }

    @Test
    fun 扫码回复三种结局() {
        val hit = QrHit("t", "QR_CODE", "74")
        val ok = QrPolicy.scanReply(QrScanOutcome.Scanned(listOf(hit)))
        assertFalse(ok.getBoolean("cancelled"))
        assertEquals("QR_CODE", ok.getJSONArray("results").getJSONObject(0).getString("format"))
        val cancelled = QrPolicy.scanReply(QrScanOutcome.Cancelled)
        assertTrue(cancelled.getBoolean("cancelled"))
        assertEquals(0, cancelled.getJSONArray("results").length())
        try {
            QrPolicy.scanReply(QrScanOutcome.Denied)
            fail("应抛 PERMISSION_DENIED")
        } catch (e: BridgeException) {
            assertEquals(BridgeErrors.PERMISSION_DENIED, e.code)
        }
    }

    @Test
    fun 识图回复无结果时是空数组() {
        assertEquals(0, QrPolicy.decodeReply(emptyList()).getJSONArray("results").length())
    }

    @Test
    fun path必须是非空字符串() {
        assertEquals("cache/pick/a.jpg", QrPolicy.requirePath(JSONObject().put("path", "cache/pick/a.jpg")))
        for (p in listOf(JSONObject(), JSONObject().put("path", "  "))) {
            try {
                QrPolicy.requirePath(p)
                fail("应抛 BAD_PARAMS")
            } catch (e: BridgeException) {
                assertEquals(BridgeErrors.BAD_PARAMS, e.code)
            }
        }
    }
}
