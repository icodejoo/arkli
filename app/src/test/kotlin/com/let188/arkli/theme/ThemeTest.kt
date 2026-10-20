package com.let188.arkli.theme

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.ReplyIo
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 主题模式解析与 native.theme.set 处理器 */
@OptIn(ExperimentalCoroutinesApi::class)
class ThemeTest {
    @Test
    fun parseFallsBackToSystem() {
        for (m in ThemeMode.ALL) assertEquals(m, ThemeMode.parse(m))
        assertEquals(ThemeMode.SYSTEM, ThemeMode.parse(null))
        assertEquals(ThemeMode.SYSTEM, ThemeMode.parse("blue"))
    }

    @Test
    fun isDarkFollowsModeThenSystem() {
        assertFalse(ThemeMode.isDark(ThemeMode.LIGHT, true))
        assertTrue(ThemeMode.isDark(ThemeMode.DARK, false))
        assertTrue(ThemeMode.isDark(ThemeMode.SYSTEM, true))
        assertFalse(ThemeMode.isDark(ThemeMode.SYSTEM, false))
        assertTrue(ThemeMode.isDark("bad", true))
    }

    /** 发一次调用并返回响应 */
    private fun call(params: JSONObject, saved: MutableList<String>, changed: IntArray, main: Boolean = true): JSONObject {
        val msgs = mutableListOf<JSONObject>()
        val bridge = ArkliBridge(1, ReplyIo { msgs += JSONObject(it) }, false, UnconfinedTestDispatcher())
        bridge.register(ThemeModule.METHOD_THEME_SET, ThemeSetHandler({ saved += it }) { changed[0]++ })
        bridge.dispatch(JSONObject().put("v", 2).put("id", "a").put("method", ThemeModule.METHOD_THEME_SET).put("params", params).toString(), main)
        return msgs.first { it.optString("id") == "a" }
    }

    @Test
    fun setSavesAndNotifies() {
        val saved = mutableListOf<String>()
        val changed = intArrayOf(0)
        val r = call(JSONObject().put("mode", "dark"), saved, changed)
        assertTrue(r.getBoolean("ok"))
        assertEquals(listOf("dark"), saved)
        assertEquals(1, changed[0])
    }

    @Test
    fun setRejectsBadModeAndSubFrame() {
        val saved = mutableListOf<String>()
        val changed = intArrayOf(0)
        val bad = call(JSONObject().put("mode", "blue"), saved, changed)
        assertEquals("BAD_PARAMS", bad.getJSONObject("error").getString("code"))
        assertEquals("BAD_PARAMS", call(JSONObject(), saved, changed).getJSONObject("error").getString("code"))
        assertEquals("PERMISSION_DENIED", call(JSONObject().put("mode", "dark"), saved, changed, main = false).getJSONObject("error").getString("code"))
        assertTrue(saved.isEmpty())
        assertEquals(0, changed[0])
    }
}
