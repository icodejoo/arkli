package com.let188.arkli.files

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Range 解析、响应计划与限长流测试 */
class FileServeTest {
    /** 每个用例独立的临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun parsesThreeRangeForms() {
        assertEquals(RangeResult.Partial(0, 99), RangeHeader.parse("bytes=0-99", 1000))
        assertEquals(RangeResult.Partial(900, 999), RangeHeader.parse("bytes=900-", 1000))
        assertEquals(RangeResult.Partial(500, 999, fromEnd = true), RangeHeader.parse("bytes=-500", 1000))
    }

    @Test
    fun clampsEndAndOversizedSuffix() {
        assertEquals(RangeResult.Partial(10, 49), RangeHeader.parse("bytes=10-9999", 50))
        assertEquals(RangeResult.Partial(0, 49, fromEnd = true), RangeHeader.parse("bytes=-9999", 50))
    }

    @Test
    fun unsatisfiableWhenStartBeyondEnd() {
        assertEquals(RangeResult.Unsatisfiable, RangeHeader.parse("bytes=50-60", 50))
        assertEquals(RangeResult.Unsatisfiable, RangeHeader.parse("bytes=-0", 50))
        assertEquals(RangeResult.Unsatisfiable, RangeHeader.parse("bytes=99999999999999999999-", 50))
    }

    @Test
    fun malformedOrUnsupportedFallsBackToFull() {
        for (h in listOf(null, "", "items=0-1", "bytes=", "bytes=-", "bytes=a-b", "bytes=5-2", "bytes=0-1,5-6", "bytes=1")) {
            assertEquals("头：$h", RangeResult.Full, RangeHeader.parse(h, 100))
        }
        assertEquals(RangeResult.Full, RangeHeader.parse("bytes=0-1", 0))
    }

    @Test
    fun planFullPartialAndErrors() {
        val f = tmp.newFile("v.bin").apply { writeBytes(ByteArray(1000) { it.toByte() }) }
        val full = FileServe.plan(f, "GET", null)
        assertEquals(200, full.status)
        assertEquals("1000", full.headers["Content-Length"])
        assertEquals("bytes", full.headers["Accept-Ranges"])

        val part = FileServe.plan(f, "GET", "bytes=100-199")
        assertEquals(206, part.status)
        assertEquals("bytes 100-199/1000", part.headers["Content-Range"])
        assertEquals("100", part.headers["Content-Length"])
        assertEquals(100L, part.start)

        val bad = FileServe.plan(f, "GET", "bytes=1000-")
        assertEquals(416, bad.status)
        assertEquals("bytes */1000", bad.headers["Content-Range"])
        assertNull(bad.file)

        assertEquals(404, FileServe.plan(null, "GET", null).status)
        assertEquals(404, FileServe.plan(tmp.root, "GET", null).status)
        assertEquals(405, FileServe.plan(f, "POST", null).status)
    }

    @Test
    fun webViewModeAddsVirtualPrefixOnlyForStartForms() {
        val f = tmp.newFile("v.bin").apply { writeBytes(ByteArray(1000) { (it % 251).toByte() }) }
        val mid = FileServe.plan(f, "GET", "bytes=100-199", webViewSkipsStart = true)
        assertEquals(206, mid.status)
        assertEquals("bytes 100-199/1000", mid.headers["Content-Range"])
        assertEquals(100L, mid.virtualPrefix)
        assertEquals(100L, FileServe.plan(f, "GET", "bytes=100-", webViewSkipsStart = true).virtualPrefix)
        assertEquals(0L, FileServe.plan(f, "GET", "bytes=-10", webViewSkipsStart = true).virtualPrefix)
        assertEquals(0L, FileServe.plan(f, "GET", "bytes=100-199").virtualPrefix)
    }

    @Test
    fun rangeStreamWhenViewSkipsFirst() {
        val data = ByteArray(1000) { (it % 251).toByte() }
        val f = tmp.newFile("v.bin").apply { writeBytes(data) }
        val plan = FileServe.plan(f, "GET", "bytes=300-399", webViewSkipsStart = true)
        FileServe.open(plan).use { s ->
            // 模拟 Chromium：先 skip 起点，再读
            assertEquals(400, s.available())
            var left = 300L
            while (left > 0) left -= s.skip(left)
            assertEquals(100, s.available())
            assertArrayEquals(data.copyOfRange(300, 400), s.readBytes())
        }
    }

    @Test
    fun rangeStreamWhenViewDoesNotSkip() {
        val data = ByteArray(1000) { (it % 251).toByte() }
        val f = tmp.newFile("v.bin").apply { writeBytes(data) }
        val plan = FileServe.plan(f, "GET", "bytes=300-399", webViewSkipsStart = true)
        // 不 skip 直接读：虚拟前缀作废，照样得到正确区间
        assertArrayEquals(data.copyOfRange(300, 400), FileServe.open(plan).use { it.readBytes() })
        // 后缀形式没有前缀
        val tail = FileServe.plan(f, "GET", "bytes=-10", webViewSkipsStart = true)
        assertArrayEquals(data.copyOfRange(990, 1000), FileServe.open(tail).use { it.readBytes() })
    }

    @Test
    fun rangeStreamPartialSkipsAndLimit() {
        val s = RangeStream(ByteArray(100) { it.toByte() }.inputStream(), 10, 5)
        assertEquals(3L, s.skip(3))
        assertEquals(2L, s.skip(10))
        assertEquals(10, s.available())
        assertEquals(4L, s.skip(4))
        assertEquals(6, s.readBytes().size)
        assertEquals(-1, s.read())
    }

    @Test
    fun headHasHeadersButNoBody() {
        val f = tmp.newFile("a").apply { writeBytes(ByteArray(10)) }
        val p = FileServe.plan(f, "HEAD", "bytes=0-4")
        assertEquals(206, p.status)
        assertNull(p.file)
        assertEquals(0, FileServe.open(p).read(ByteArray(4)).coerceAtLeast(0))
    }

    @Test
    fun openReturnsExactlyTheRequestedBytes() {
        val data = ByteArray(1000) { (it % 251).toByte() }
        val f = tmp.newFile("v.bin").apply { writeBytes(data) }
        val plan = FileServe.plan(f, "GET", "bytes=300-399")
        val got = FileServe.open(plan).use { it.readBytes() }
        assertArrayEquals(data.copyOfRange(300, 400), got)
        val tail = FileServe.open(FileServe.plan(f, "GET", "bytes=-10")).use { it.readBytes() }
        assertArrayEquals(data.copyOfRange(990, 1000), tail)
    }

    @Test
    fun boundedStreamStopsAtLimit() {
        val s = BoundedInputStream(ByteArray(100).inputStream(), 10)
        assertEquals(10, s.readBytes().size)
        assertEquals(-1, s.read())
    }
}
