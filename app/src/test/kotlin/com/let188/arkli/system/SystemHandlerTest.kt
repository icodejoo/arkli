package com.let188.arkli.system

import android.content.Intent
import android.net.Uri
import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.ReplyIo
import com.let188.arkli.files.ActivityHost
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 走 Bridge 分发的处理器测试：只覆盖不碰 Android 框架类的路径（参数校验、主 frame 限制、屏幕调用转发） */
@OptIn(ExperimentalCoroutinesApi::class)
class SystemHandlerTest {
    /** 记录屏幕调用的假宿主 */
    private class FakeHost : ActivityHost {
        /** 最近一次 setScreen 的参数 */
        var screen: Triple<Boolean?, Float?, Boolean?>? = null

        /** 最近一次 setOrientation 的参数 */
        var landscape: Boolean? = null

        override suspend fun pickMedia(mime: String, multiple: Boolean, max: Int): List<Uri> = emptyList()
        override suspend fun pickDirectory(): Uri? = null
        override suspend fun requestPermission(permission: String): Boolean = false
        override fun previewImages(files: List<File>, index: Int) = Unit
        override fun startIntent(intent: Intent): Boolean = false
        override fun setScreen(keepAwake: Boolean?, brightness: Float?, immersive: Boolean?) {
            screen = Triple(keepAwake, brightness, immersive)
        }
        override fun setOrientation(landscape: Boolean) {
            this.landscape = landscape
        }
    }

    /** 收集响应的假通道 */
    private class Sink : ReplyIo {
        /** 响应列表 */
        val messages = mutableListOf<JSONObject>()
        override fun send(json: String) {
            messages += JSONObject(json)
        }
    }

    /** 发一次调用并返回响应 */
    private fun call(install: (ArkliBridge) -> Unit, method: String, params: JSONObject, main: Boolean = true): JSONObject {
        val sink = Sink()
        val bridge = ArkliBridge(1, sink, false, UnconfinedTestDispatcher())
        install(bridge)
        bridge.dispatch(JSONObject().put("v", 2).put("id", "a").put("method", method).put("params", params).toString(), main)
        return sink.messages.first { it.optString("id") == "a" }
    }

    /** 错误码 */
    private fun JSONObject.code(): String = getJSONObject("error").getString("code")

    @Test
    fun screenHandlersForwardToHost() {
        val host = FakeHost()
        val install = { b: ArkliBridge ->
            b.register(SystemModule.METHOD_SCREEN_KEEP_AWAKE, KeepAwakeHandler(host))
            b.register(SystemModule.METHOD_SCREEN_BRIGHTNESS, BrightnessHandler(host))
            b.register(SystemModule.METHOD_SCREEN_IMMERSIVE, ImmersiveHandler(host))
        }
        assertTrue(call(install, SystemModule.METHOD_SCREEN_KEEP_AWAKE, JSONObject().put("on", true)).getBoolean("ok"))
        assertEquals(Triple<Boolean?, Float?, Boolean?>(true, null, null), host.screen)
        call(install, SystemModule.METHOD_SCREEN_BRIGHTNESS, JSONObject().put("value", 0.4))
        assertEquals(0.4f, host.screen!!.second!!, 0f)
        call(install, SystemModule.METHOD_SCREEN_BRIGHTNESS, JSONObject().put("value", -1))
        assertEquals(-1f, host.screen!!.second!!, 0f)
        call(install, SystemModule.METHOD_SCREEN_IMMERSIVE, JSONObject().put("on", false))
        assertEquals(Triple<Boolean?, Float?, Boolean?>(null, null, false), host.screen)
    }

    @Test
    fun orientationForwardsAndValidates() {
        val host = FakeHost()
        val install = { b: ArkliBridge -> b.register(SystemModule.METHOD_SCREEN_ORIENTATION, OrientationHandler(host)) }
        assertTrue(call(install, SystemModule.METHOD_SCREEN_ORIENTATION, JSONObject().put("mode", "landscape")).getBoolean("ok"))
        assertEquals(true, host.landscape)
        call(install, SystemModule.METHOD_SCREEN_ORIENTATION, JSONObject().put("mode", "portrait"))
        assertEquals(false, host.landscape)
        host.landscape = null
        assertEquals("BAD_PARAMS", call(install, SystemModule.METHOD_SCREEN_ORIENTATION, JSONObject().put("mode", "diagonal")).code())
        assertEquals("BAD_PARAMS", call(install, SystemModule.METHOD_SCREEN_ORIENTATION, JSONObject()).code())
        assertNull(host.landscape)
    }

    @Test
    fun screenHandlersRejectBadParams() {
        val host = FakeHost()
        val install = { b: ArkliBridge ->
            b.register(SystemModule.METHOD_SCREEN_KEEP_AWAKE, KeepAwakeHandler(host))
            b.register(SystemModule.METHOD_SCREEN_BRIGHTNESS, BrightnessHandler(host))
        }
        assertEquals("BAD_PARAMS", call(install, SystemModule.METHOD_SCREEN_KEEP_AWAKE, JSONObject()).code())
        assertEquals("BAD_PARAMS", call(install, SystemModule.METHOD_SCREEN_KEEP_AWAKE, JSONObject().put("on", "yes")).code())
        assertEquals("BAD_PARAMS", call(install, SystemModule.METHOD_SCREEN_BRIGHTNESS, JSONObject().put("value", 2)).code())
        assertEquals("BAD_PARAMS", call(install, SystemModule.METHOD_SCREEN_BRIGHTNESS, JSONObject()).code())
        assertNull(host.screen)
    }

    @Test
    fun nonMainFrameIsDenied() {
        val host = FakeHost()
        val install = { b: ArkliBridge ->
            b.register(SystemModule.METHOD_SCREEN_KEEP_AWAKE, KeepAwakeHandler(host))
            b.register(SystemModule.METHOD_INTENT_OPEN, IntentOpenHandler(host))
            b.register(SystemModule.METHOD_INTENT_PROCESS_TEXT, ProcessTextHandler(host))
        }
        assertEquals("PERMISSION_DENIED", call(install, SystemModule.METHOD_SCREEN_KEEP_AWAKE, JSONObject().put("on", true), main = false).code())
        assertEquals("PERMISSION_DENIED", call(install, SystemModule.METHOD_INTENT_OPEN, JSONObject().put("kind", "url").put("value", "https://a.com"), main = false).code())
        assertEquals("PERMISSION_DENIED", call(install, SystemModule.METHOD_INTENT_PROCESS_TEXT, JSONObject().put("text", "hi"), main = false).code())
        assertNull(host.screen)
    }

    @Test
    fun intentOpenRejectsBeforeTouchingAndroid() {
        val install = { b: ArkliBridge -> b.register(SystemModule.METHOD_INTENT_OPEN, IntentOpenHandler(FakeHost())) }
        fun open(kind: String, value: String) = call(install, SystemModule.METHOD_INTENT_OPEN, JSONObject().put("kind", kind).put("value", value))
        assertEquals("BAD_PARAMS", open("url", "javascript:alert(1)").code())
        assertEquals("BAD_PARAMS", open("url", "file:///etc/passwd").code())
        assertEquals("BAD_PARAMS", open("tel", "123").code())
        assertEquals("BAD_PARAMS", call(install, SystemModule.METHOD_INTENT_OPEN, JSONObject().put("kind", "url")).code())
    }

    @Test
    fun processTextRejectsEmptyText() {
        val install = { b: ArkliBridge -> b.register(SystemModule.METHOD_INTENT_PROCESS_TEXT, ProcessTextHandler(FakeHost())) }
        assertEquals("BAD_PARAMS", call(install, SystemModule.METHOD_INTENT_PROCESS_TEXT, JSONObject().put("text", "")).code())
        assertEquals("BAD_PARAMS", call(install, SystemModule.METHOD_INTENT_PROCESS_TEXT, JSONObject()).code())
    }
}
