package com.let188.arkli.files

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/** 带上限的流拷贝 */
class StreamCopyTest {
    @Test
    fun copiesWithinLimit() {
        val data = ByteArray(FileConst.COPY_BUF_BYTES * 2 + 5) { it.toByte() }
        val out = ByteArrayOutputStream()
        val n = StreamCopy.copy(ByteArrayInputStream(data), out, data.size.toLong())
        assertEquals(data.size.toLong(), n)
        assertArrayEquals(data, out.toByteArray())
    }

    @Test
    fun abortsWhenOverLimit() {
        val data = ByteArray(1000)
        try {
            StreamCopy.copy(ByteArrayInputStream(data), ByteArrayOutputStream(), 999)
            fail("应抛 SizeLimitException")
        } catch (_: SizeLimitException) {
        }
    }

    @Test
    fun checkpointCanAbort() {
        var calls = 0
        try {
            StreamCopy.copy(ByteArrayInputStream(ByteArray(10)), ByteArrayOutputStream(), 100) {
                calls++
                error("取消")
            }
            fail("应抛异常")
        } catch (_: IllegalStateException) {
        }
        assertEquals(1, calls)
    }
}
