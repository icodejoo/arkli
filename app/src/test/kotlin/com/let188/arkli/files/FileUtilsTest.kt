package com.let188.arkli.files

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.Base64

/** 文件名清洗、帧解码、句柄表、选择器分类测试 */
class FileUtilsTest {
    /** 每个用例独立的临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun sanitizeStripsPathAndIllegalChars() {
        assertEquals("evil.sh", FileNames.sanitize("../../evil.sh"))
        assertEquals("a.txt", FileNames.sanitize("C:\\dir\\a.txt"))
        assertEquals("a_b_c.png", FileNames.sanitize("a:b*c.png"))
        assertEquals("file", FileNames.sanitize(""))
        assertEquals("file", FileNames.sanitize(null))
        assertEquals("file", FileNames.sanitize("..."))
    }

    @Test
    fun sanitizeKeepsExtensionWhenTruncating() {
        val long = "x".repeat(300) + ".png"
        val s = FileNames.sanitize(long)
        assertEquals(120, s.length)
        assertTrue(s.endsWith(".png"))
    }

    @Test
    fun mimeExtensionHelpers() {
        assertEquals("jpg", FileNames.extForMime("image/jpeg; charset=x"))
        assertNull(FileNames.extForMime("foo/bar"))
        assertEquals("a.png", FileNames.withExt("a", "image/png"))
        assertEquals("a.jpg", FileNames.withExt("a.jpg", "image/png"))
        assertEquals("a", FileNames.withExt("a", "foo/bar"))
        assertEquals("IMG_1.jpg", FileNames.replaceExt("IMG_1.HEIC", "jpg"))
        assertEquals("x.jpg", FileNames.replaceExt("x", "jpg"))
        assertTrue(FileNames.isHeif("image/heic"))
        assertTrue(FileNames.isHeif("image/HEIF-sequence"))
        assertFalse(FileNames.isHeif("image/jpeg"))
    }

    @Test
    fun uniqueAppendsCounter() {
        val dir = tmp.newFolder("d")
        assertEquals("a.png", FileNames.unique(dir, "a.png").name)
        java.io.File(dir, "a.png").writeText("1")
        assertEquals("a (1).png", FileNames.unique(dir, "a.png").name)
        java.io.File(dir, "a (1).png").writeText("1")
        assertEquals("a (2).png", FileNames.unique(dir, "a.png").name)
    }

    @Test
    fun latin1FrameDecodesEveryByteValue() {
        val bytes = ByteArray(256) { it.toByte() }
        val s = String(CharArray(256) { it.toChar() })
        assertArrayEquals(bytes, FrameCodec.decode("latin1", s) { error("不该走 base64") })
    }

    @Test
    fun latin1RejectsWideChars() {
        try {
            FrameCodec.decode("latin1", "a\u4e2db") { ByteArray(0) }
            fail("应拒绝")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("0xFF"))
        }
    }

    @Test
    fun base64AndUnknownEncoding() {
        val raw = byteArrayOf(0, 1, 2, -1, -2)
        val enc = Base64.getEncoder().encodeToString(raw)
        assertArrayEquals(raw, FrameCodec.decode("base64", enc) { Base64.getDecoder().decode(it) })
        try {
            FrameCodec.decode("utf8", "x") { ByteArray(0) }
            fail("应拒绝")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun handleTableIsOpaqueAndEvictsOldest() {
        val t = HandleTable<String>(capacity = 2)
        val a = t.put("A")
        val b = t.put("B")
        assertTrue(a.startsWith("uri:"))
        assertFalse("句柄里不能带真实内容", a.contains("A".repeat(3)))
        assertEquals("A", t.get(a))
        val c = t.put("C")
        assertNull("最旧的被淘汰", t.get(a))
        assertEquals("B", t.get(b))
        assertEquals("C", t.get(c))
        assertEquals(2, t.size())
        t.clear()
        assertNull(t.get(b))
    }

    @Test
    fun pickKindMapping() {
        assertEquals(PickKind.IMAGE, PickKind.of("image/*"))
        assertEquals(PickKind.VIDEO, PickKind.of("video/*"))
        assertEquals(PickKind.IMAGE_VIDEO, PickKind.of("image/*,video/*"))
        assertEquals(PickKind.SINGLE_MEDIA, PickKind.of("image/png"))
        assertEquals(PickKind.DOCUMENT, PickKind.of("text/plain"))
        assertEquals(PickKind.DOCUMENT, PickKind.of("*/*"))
        assertTrue(PickKind.isValid("image/*"))
        assertTrue(PickKind.isValid("*/*"))
        assertTrue(PickKind.isValid("image/*,video/*"))
        assertFalse(PickKind.isValid("image"))
        assertFalse(PickKind.isValid("a b/c"))
        assertFalse(PickKind.isValid(""))
    }
}
