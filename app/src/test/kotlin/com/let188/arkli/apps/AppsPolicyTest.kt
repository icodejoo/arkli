package com.let188.arkli.apps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** 应用管理的包名校验、排序、文件名清洗 */
class AppsPolicyTest {
    /** 造一个只关心名字与包名的条目 */
    private fun app(pkg: String, label: String) = AppItem(pkg, label, "1.0", 1, 0, 0, false, 10)

    @Test
    fun packageNameFormat() {
        for (ok in listOf("com.tencent.mm", "a.b", "com.example.app_1", "com.Example.A1")) AppsPolicy.requirePackage(ok)
        for (bad in listOf("", "com", "1com.a", "com..a", "com.a.", ".com.a", "com.a b", "com.a/../b", "com.1a", "com.a-b")) {
            assertThrows(bad, IllegalArgumentException::class.java) { AppsPolicy.requirePackage(bad) }
        }
    }

    @Test
    fun sortByLabelThenPackage() {
        val items = listOf(app("c.c", "banana"), app("b.b", "Apple"), app("a.a", "apple"), app("d.d", "Cherry"))
        val sorted = AppsPolicy.sortByLabel(items, String.CASE_INSENSITIVE_ORDER)
        assertEquals(listOf("a.a", "b.b", "c.c", "d.d"), sorted.map { it.pkg })
    }

    @Test
    fun apkFileNameIsSanitized() {
        assertEquals("微信_8.0.1.apk", AppsPolicy.apkFileName("微信", "8.0.1", "com.tencent.mm"))
        assertEquals("a_b_1.0.apk", AppsPolicy.apkFileName("a/b", "1.0", "x.y"))
        assertEquals("com.x.y_2.apk", AppsPolicy.apkFileName("  ", "2", "com.x.y"))
        assertEquals("App.apk", AppsPolicy.apkFileName("App", "", "x.y"))
        assertEquals("a_b_c.apk", AppsPolicy.apkFileName("a:b", "c", "x.y"))
    }

    @Test
    fun apkFileNameKeepsExtensionWhenTruncated() {
        val name = AppsPolicy.apkFileName("很长".repeat(200), "1.0", "x.y")
        assert(name.endsWith(".apk")) { name }
        assert(name.length <= 255)
    }

    @Test
    fun exportFileNameUsesCustomWhenGiven() {
        assertEquals("def.apk", AppsPolicy.exportFileName(null, "def.apk"))
        assertEquals("def.apk", AppsPolicy.exportFileName("  ", "def.apk"))
        assertEquals("Arkli-简介.apk", AppsPolicy.exportFileName("Arkli-简介", "def.apk"))
        assertEquals("a.APK", AppsPolicy.exportFileName("a.APK", "def.apk"))
        assertEquals("a_b.apk", AppsPolicy.exportFileName("x/a_b", "def.apk"))
    }

    @Test
    fun iconSizeRange() {
        assertEquals(96, AppsPolicy.iconSize(null))
        assertEquals(48, AppsPolicy.iconSize(48.0))
        assertEquals(192, AppsPolicy.iconSize(192.0))
        for (bad in listOf(47.0, 193.0, 96.5, Double.NaN)) {
            assertThrows(IllegalArgumentException::class.java) { AppsPolicy.iconSize(bad) }
        }
    }

    @Test
    fun apkSizeLimit() {
        AppsPolicy.requireApkSize(1)
        AppsPolicy.requireApkSize(AppsPolicy.MAX_APK_BYTES)
        assertThrows(IllegalArgumentException::class.java) { AppsPolicy.requireApkSize(0) }
        assertThrows(IllegalArgumentException::class.java) { AppsPolicy.requireApkSize(AppsPolicy.MAX_APK_BYTES + 1) }
    }

    @Test
    fun toJsonHasContractFields() {
        val o = AppsPolicy.toJson(listOf(AppItem("a.b", "名", "1.2", 12, 3, 4, true, 5))).getJSONObject(0)
        assertEquals("a.b", o.getString("pkg"))
        assertEquals("名", o.getString("label"))
        assertEquals(12L, o.getLong("versionCode"))
        assertEquals(true, o.getBoolean("isSystem"))
        assertEquals(5L, o.getLong("apkBytes"))
    }
}
