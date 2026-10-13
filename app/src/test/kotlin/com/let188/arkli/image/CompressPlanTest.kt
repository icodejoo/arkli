package com.let188.arkli.image

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** 参数解析与校验 */
class CompressPlanTest {
    /** 一个合法的最小参数，可在其上改字段 */
    private fun base(): JSONObject = JSONObject()
        .put("items", JSONArray().put(JSONObject().put("path", "cache/pick/a.jpg")))
        .put("format", "jpeg")

    /** 断言解析抛 BAD_PARAMS */
    private fun assertBad(p: JSONObject) {
        try {
            CompressPlan.parse(p)
            fail("应抛 BAD_PARAMS：$p")
        } catch (e: BridgeException) {
            assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        }
    }

    @Test
    fun defaults() {
        val p = CompressPlan.parse(base())
        assertEquals(1, p.items.size)
        assertEquals(OutFormat.JPEG, p.format)
        assertEquals(80, p.quality)
        assertNull(p.maxEdge)
        assertNull(p.targetBytes)
        assertEquals(PngMode.LOSSLESS, p.pngMode)
        assertEquals(256, p.colors)
        assertFalse(p.dither)
        assertFalse(p.keepExif)
    }

    @Test
    fun fullParams() {
        val p = CompressPlan.parse(
            base().put("format", "png").put("quality", 50).put("maxEdge", 1024).put("targetBytes", 1000)
                .put("keepExif", true)
                .put("png", JSONObject().put("mode", "palette").put("colors", 64).put("dither", true)),
        )
        assertEquals(OutFormat.PNG, p.format)
        assertEquals(1024, p.maxEdge)
        assertNull("png 不吃 targetBytes", p.targetBytes)
        assertEquals(PngMode.PALETTE, p.pngMode)
        assertEquals(64, p.colors)
        assertTrue(p.dither)
        assertTrue(p.keepExif)
    }

    @Test
    fun targetBytesKeptForJpeg() {
        assertEquals(5000L, CompressPlan.parse(base().put("targetBytes", 5000)).targetBytes)
    }

    @Test
    fun itemsValidation() {
        assertBad(base().put("items", JSONArray()))
        assertBad(base().put("items", "x"))
        assertBad(base().put("items", JSONArray().put("cache/a.jpg")))
        assertBad(base().put("items", JSONArray().put(JSONObject().put("path", ""))))
        assertBad(base().put("items", JSONArray().put(JSONObject().put("path", 3))))
        assertBad(base().put("items", JSONArray().put(JSONObject().put("path", "a").put("name", 5))))
        val many = JSONArray()
        repeat(ImageConst.MAX_ITEMS + 1) { many.put(JSONObject().put("path", "cache/pick/$it.jpg")) }
        assertBad(base().put("items", many))
        val ok = JSONArray()
        repeat(ImageConst.MAX_ITEMS) { ok.put(JSONObject().put("path", "cache/pick/$it.jpg")) }
        assertEquals(ImageConst.MAX_ITEMS, CompressPlan.parse(base().put("items", ok)).items.size)
    }

    @Test
    fun rangeValidation() {
        assertBad(base().put("format", "gif"))
        assertBad(base().put("format", 1))
        assertBad(base().put("quality", 0))
        assertBad(base().put("quality", 101))
        assertBad(base().put("quality", 80.5))
        assertBad(base().put("quality", "80"))
        assertBad(base().put("maxEdge", 63))
        assertBad(base().put("maxEdge", 16385))
        assertBad(base().put("targetBytes", 0))
        assertBad(base().put("targetBytes", -5))
        assertBad(base().put("targetBytes", "1"))
        assertBad(base().put("keepExif", "yes"))
        assertBad(base().put("png", "x"))
        assertBad(base().put("png", JSONObject().put("mode", "fast")))
        assertBad(base().put("png", JSONObject().put("colors", 1)))
        assertBad(base().put("png", JSONObject().put("colors", 257)))
        assertBad(base().put("png", JSONObject().put("dither", 1)))
        // 边界值合法
        CompressPlan.parse(base().put("quality", 1).put("maxEdge", 64))
        CompressPlan.parse(base().put("quality", 100).put("maxEdge", 16384))
        CompressPlan.parse(base().put("png", JSONObject().put("colors", 2)))
        CompressPlan.parse(base().put("png", JSONObject().put("colors", 256)))
    }
}
