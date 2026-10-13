package com.let188.arkli.files

import org.junit.Assert.assertEquals
import org.junit.Test

/** /files/ 的 mime 降级与安全头 */
class ServedMimeTest {
    @Test
    fun executableTypesBecomeOctetStream() {
        listOf(
            "text/html", "application/xhtml+xml", "text/xml", "application/xml",
            "text/javascript", "application/javascript", "TEXT/HTML", "text/html; charset=utf-8",
        ).forEach { assertEquals(it, ServedMime.OCTET_STREAM, ServedMime.safe(it)) }
    }

    @Test
    fun svgAndMediaKeepType() {
        listOf("image/svg+xml", "image/png", "image/jpeg", "video/mp4", "text/plain", "application/pdf")
            .forEach { assertEquals(it, ServedMime.safe(it)) }
    }

    @Test
    fun unknownBecomesOctetStream() {
        assertEquals(ServedMime.OCTET_STREAM, ServedMime.safe(null))
        assertEquals(ServedMime.OCTET_STREAM, ServedMime.safe(""))
    }

    @Test
    fun securityHeadersPresent() {
        assertEquals("nosniff", ServedMime.SECURITY_HEADERS["X-Content-Type-Options"])
        assertEquals("sandbox", ServedMime.SECURITY_HEADERS["Content-Security-Policy"])
    }
}
