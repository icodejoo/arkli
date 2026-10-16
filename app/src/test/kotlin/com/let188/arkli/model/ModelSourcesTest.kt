package com.let188.arkli.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** `native.model.sources` 的纯逻辑：release 页面推导与来源序列化 */
class ModelSourcesTest {
    /** 标准 release 下载地址 */
    private val dl = "https://github.com/icodejoo/arkli/releases/download/v1/a.bin"

    /** 造一个单文件模型，urls 可指定 */
    private fun entry(vararg urls: String): ModelEntry {
        val f = ModelFile("a.bin", 10, "a".repeat(64), null, urls.toList())
        return ModelEntry("m1", "X", "1", "models/m1", 10, null, listOf(f))
    }

    /** release 下载地址推出 tag 页 */
    @Test
    fun releasePageFromDownloadUrl() {
        assertEquals("https://github.com/icodejoo/arkli/releases/tag/v1", ModelPolicy.releasePageOf(dl))
    }

    /** 非 github 或非 release 形态不给页面 */
    @Test
    fun releasePageRejectsOthers() {
        assertNull(ModelPolicy.releasePageOf("https://objects.githubusercontent.com/x/y/releases/download/v1/a"))
        assertNull(ModelPolicy.releasePageOf("https://github.com/o/r/blob/main/a"))
        assertNull(ModelPolicy.releasePageOf("not a url"))
        assertNull(ModelPolicy.releasePageOf("http://github.com/o/r/releases/download/v1/a"))
    }

    /** 序列化含文件信息、相对目录，releasePages 去重 */
    @Test
    fun sourcesJsonShape() {
        val o = ModelPolicy.sourcesJson(entry(dl, "https://github.com/icodejoo/arkli/releases/download/v1/b.bin"))
        assertEquals("m1", o.getString("id"))
        assertEquals("models/m1", o.getString("dir"))
        val f = o.getJSONArray("files").getJSONObject(0)
        assertEquals(10L, f.getLong("bytes"))
        assertEquals(2, f.getJSONArray("urls").length())
        assertEquals(1, o.getJSONArray("releasePages").length())
    }

    /** 查询串被去掉，非白名单与回环明文地址不回显 */
    @Test
    fun sourcesJsonRedactsAndFilters() {
        val o = ModelPolicy.sourcesJson(entry("$dl?token=SECRET", "http://127.0.0.1:8080/a.bin", "https://evil.com/a.bin"))
        val urls = o.getJSONArray("files").getJSONObject(0).getJSONArray("urls")
        assertEquals(1, urls.length())
        assertEquals(dl, urls.getString(0))
        assertTrue(!o.toString().contains("SECRET"))
    }
}
