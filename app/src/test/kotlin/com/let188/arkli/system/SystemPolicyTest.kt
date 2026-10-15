package com.let188.arkli.system

import android.content.Intent
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** 系统能力里的纯逻辑：外部跳转、设置页、震动、亮度、权限映射、分享参数、参数读取 */
class SystemPolicyTest {

    // ---- IntentPolicy ----

    @Test
    fun intentUrlNeedsSchemeAndAllowsHttpHttps() {
        assertEquals(IntentTarget(Intent.ACTION_VIEW, "https://a.com/x?y=1"), IntentPolicy.validate("url", "https://a.com/x?y=1"))
        assertEquals("HTTP://a.com", IntentPolicy.validate("url", " HTTP://a.com ").uri)
        assertThrows(IllegalArgumentException::class.java) { IntentPolicy.validate("url", "a.com") }
        assertThrows(IllegalArgumentException::class.java) { IntentPolicy.validate("url", "ftp://a.com") }
    }

    @Test
    fun intentBareValuesGetSchemePrefix() {
        assertEquals(IntentTarget(Intent.ACTION_DIAL, "tel:10086"), IntentPolicy.validate("dial", "10086"))
        assertEquals("smsto:10086", IntentPolicy.validate("sms", "10086").uri)
        assertEquals("mailto:a@b.com", IntentPolicy.validate("mail", "a@b.com").uri)
        assertEquals("geo:39.9,116.4", IntentPolicy.validate("map", "39.9,116.4").uri)
        assertEquals("market://details?id=com.x", IntentPolicy.validate("market", "com.x").uri)
        assertEquals(Intent.ACTION_SENDTO, IntentPolicy.validate("mail", "a@b.com").action)
    }

    @Test
    fun intentKeepsOwnSchemeWhenAllowedForKind() {
        assertEquals("tel:+8613800000000", IntentPolicy.validate("dial", "tel:+8613800000000").uri)
        assertEquals("mailto:a@b.com?subject=hi", IntentPolicy.validate("mail", "mailto:a@b.com?subject=hi").uri)
        // 种类与 scheme 不匹配
        assertThrows(IllegalArgumentException::class.java) { IntentPolicy.validate("dial", "https://a.com") }
        assertThrows(IllegalArgumentException::class.java) { IntentPolicy.validate("url", "tel:123") }
    }

    @Test
    fun intentRejectsDangerousSchemes() {
        for (v in listOf("javascript:alert(1)", "JavaScript:x", "file:///sdcard/a", "content://x/y", "intent:#Intent;end", "data:text/html,a")) {
            for (kind in IntentPolicy.KINDS) {
                assertThrows("$kind $v", IllegalArgumentException::class.java) { IntentPolicy.validate(kind, v) }
            }
        }
    }

    @Test
    fun intentRejectsBadInput() {
        assertThrows(IllegalArgumentException::class.java) { IntentPolicy.validate("nope", "x") }
        assertThrows(IllegalArgumentException::class.java) { IntentPolicy.validate("dial", "   ") }
        assertThrows(IllegalArgumentException::class.java) { IntentPolicy.validate("dial", "1\n2") }
        assertThrows(IllegalArgumentException::class.java) { IntentPolicy.validate("url", "https://a.com/" + "a".repeat(2000)) }
        // 恰好 2000 字符通过
        val ok = "https://a.com/" + "a".repeat(IntentPolicy.MAX_VALUE_LENGTH - 14)
        assertEquals(IntentPolicy.MAX_VALUE_LENGTH, IntentPolicy.validate("url", ok).uri.length)
    }

    // ---- SettingsPages ----

    @Test
    fun settingsWhitelistCoversAllPages() {
        val pages = setOf("wifi", "display", "battery", "developer", "app", "notification", "date", "locale", "accessibility", "bluetooth", "storage")
        assertEquals(pages, SettingsPages.ACTIONS.keys)
        pages.forEach { assertNotNull(SettingsPages.actionOf(it, 34)) }
        assertEquals("android.settings.WIFI_SETTINGS", SettingsPages.actionOf("wifi", 34))
        assertNull(SettingsPages.actionOf("root", 34))
        assertNull(SettingsPages.actionOf("", 34))
    }

    @Test
    fun settingsNotificationFallsBackBeforeApi26() {
        assertEquals(SettingsPages.ACTIONS["app"], SettingsPages.actionOf("notification", 25))
        assertEquals(SettingsPages.ACTIONS["notification"], SettingsPages.actionOf("notification", 26))
        assertTrue(SettingsPages.needsPackageUri(SettingsPages.ACTIONS.getValue("app")))
        assertFalse(SettingsPages.needsPackageUri(SettingsPages.ACTIONS.getValue("wifi")))
    }

    // ---- VibratePolicy ----

    @Test
    fun vibrateAcceptsValidPattern() {
        val s = VibratePolicy.parse(listOf(0, 100, 50.0, 100L), null)
        assertEquals(listOf(0L, 100L, 50L, 100L), s.timings.toList())
        assertEquals(-1, s.repeat)
        assertEquals(1, VibratePolicy.parse(listOf(0, 100, 50, 100), 1).repeat)
    }

    @Test
    fun vibrateRejectsBadPattern() {
        fun bad(p: List<Any?>, r: Int? = null) = assertThrows(IllegalArgumentException::class.java) { VibratePolicy.parse(p, r) }
        bad(emptyList())
        bad(List(101) { 1 })
        bad(listOf(-1, 5))
        bad(listOf(10_001))
        bad(listOf(1.5))
        bad(listOf("a"))
        bad(listOf(null))
        bad(listOf(0, 0))
        bad(List(4) { 9_000 })
        bad(listOf(0, 100), 2)
        bad(listOf(0, 100), -2)
    }

    @Test
    fun vibrateLimitsAreInclusive() {
        // 100 项、单项 10000 上限、总长恰好 30 秒
        val three = VibratePolicy.parse(listOf(10_000, 10_000, 10_000), null)
        assertEquals(30_000L, three.timings.sum())
        assertEquals(100, VibratePolicy.parse(List(100) { 1 }, null).timings.size)
    }

    // ---- ScreenParams ----

    @Test
    fun orientationMapping() {
        assertTrue(ScreenParams.landscape("landscape"))
        assertFalse(ScreenParams.landscape("portrait"))
        assertThrows(IllegalArgumentException::class.java) { ScreenParams.landscape("diagonal") }
    }

    @Test
    fun brightnessMapping() {
        assertEquals(0.5f, ScreenParams.brightness(0.5), 0f)
        assertEquals(1f, ScreenParams.brightness(1.0), 0f)
        assertEquals(ScreenParams.MIN_BRIGHTNESS, ScreenParams.brightness(0.0), 0f)
        assertEquals(ScreenParams.FOLLOW_SYSTEM, ScreenParams.brightness(-1.0), 0f)
        assertThrows(IllegalArgumentException::class.java) { ScreenParams.brightness(1.1) }
        assertThrows(IllegalArgumentException::class.java) { ScreenParams.brightness(-0.5) }
        assertThrows(IllegalArgumentException::class.java) { ScreenParams.brightness(Double.NaN) }
    }

    // ---- PermissionMap ----

    @Test
    fun permissionMapBySdk() {
        assertEquals("android.permission.CAMERA", PermissionMap.permissionOf("camera", 24))
        assertEquals("android.permission.RECORD_AUDIO", PermissionMap.permissionOf("microphone", 34))
        assertEquals(PermissionMap.NOT_REQUIRED, PermissionMap.permissionOf("notifications", 32))
        assertEquals("android.permission.POST_NOTIFICATIONS", PermissionMap.permissionOf("notifications", 33))
        assertEquals("android.permission.READ_EXTERNAL_STORAGE", PermissionMap.permissionOf("media_images", 32))
        assertEquals("android.permission.READ_MEDIA_IMAGES", PermissionMap.permissionOf("media_images", 33))
        assertNull(PermissionMap.permissionOf("location", 34))
        PermissionMap.NAMES.forEach { assertNotNull(PermissionMap.permissionOf(it, 34)) }
    }

    // ---- ShareParams / ClipboardKeys ----

    @Test
    fun shareParamsNeedTextOrPath() {
        assertThrows(IllegalArgumentException::class.java) { ShareParams.parse(null, null, null, null) { null } }
        assertThrows(IllegalArgumentException::class.java) { ShareParams.parse("", "", null, null) { null } }
        val t = ShareParams.parse("hi", null, null, "标题") { null }
        assertEquals(ShareParams.MIME_TEXT, t.mime)
        assertEquals("标题", t.title)
    }

    @Test
    fun shareParamsMimeResolution() {
        assertEquals("image/png", ShareParams.parse(null, "cache/out/a.png", null, null) { "image/png" }.mime)
        assertEquals(ShareParams.MIME_BINARY, ShareParams.parse(null, "cache/out/a.zzz", null, null) { null }.mime)
        assertEquals("image/jpeg", ShareParams.parse(null, "cache/out/a.png", "image/jpeg", null) { "image/png" }.mime)
        assertThrows(IllegalArgumentException::class.java) { ShareParams.parse("x", null, "bad mime", null) { null } }
        assertThrows(IllegalArgumentException::class.java) { ShareParams.parse("x", null, "a/b/c", null) { null } }
        assertThrows(IllegalArgumentException::class.java) { ShareParams.parse("x".repeat(ShareParams.MAX_TEXT + 1), null, null, null) { null } }
    }

    @Test
    fun clipboardSensitiveKey() {
        assertEquals("android.content.extra.IS_SENSITIVE", ClipboardKeys.sensitiveKey(24))
        assertEquals("android.content.extra.IS_SENSITIVE", ClipboardKeys.sensitiveKey(32))
        // API 33+ 取系统常量；JVM 桩里常量被内联，值与旧键一致
        assertEquals("android.content.extra.IS_SENSITIVE", ClipboardKeys.sensitiveKey(34))
    }

    // ---- SystemParams ----

    @Test
    fun paramsReadersThrowBadParams() {
        val p = JSONObject().put("s", "a").put("n", 1.5).put("b", true).put("x", JSONObject.NULL).put("bad", 3)
        assertEquals("a", SystemParams.string(p, "s"))
        assertNull(SystemParams.stringOrNull(p, "x"))
        assertNull(SystemParams.stringOrNull(p, "missing"))
        assertEquals(1.5, SystemParams.number(p, "n"), 0.0)
        assertTrue(SystemParams.bool(p, "b"))
        for (f in listOf<() -> Any?>(
            { SystemParams.string(p, "missing") }, { SystemParams.string(p, "bad") }, { SystemParams.bool(p, "s") },
            { SystemParams.bool(p, "missing") }, { SystemParams.number(p, "s") },
        )) {
            assertEquals(BridgeErrors.BAD_PARAMS, assertThrows(BridgeException::class.java) { f() }.code)
        }
        assertEquals(BridgeErrors.BAD_PARAMS, assertThrows(BridgeException::class.java) { SystemParams.validated { require(false) { "x" } } }.code)
    }
}
