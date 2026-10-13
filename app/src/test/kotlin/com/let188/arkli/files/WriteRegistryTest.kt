package com.let188.arkli.files

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.MessageDigest

/** 分块写入状态机测试：顺序、偏移、幂等、校验、清理 */
class WriteRegistryTest {
    /** 每个用例独立的临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 可控时钟 */
    private var now = 1_000L

    private lateinit var tmpDir: File
    private lateinit var outDir: File

    /** 自增句柄 id，便于断言 */
    private var idSeq = 0

    @Before
    fun setUp() {
        tmpDir = File(tmp.root, "tmp")
        outDir = File(tmp.root, "out")
    }

    /** 造登记表，上限可调 */
    private fun reg(maxOpen: Int = 8, maxBytes: Long = 1 shl 20, idleMs: Long = 1000) =
        WriteRegistry(tmpDir, outDir, { now }, maxOpen, maxBytes, idleMs, { "h${++idSeq}" })

    /** 断言抛出指定错误码 */
    private fun assertCode(code: String, block: () -> Unit) {
        try {
            block()
            fail("应抛出 $code")
        } catch (e: BridgeException) {
            assertEquals(e.message, code, e.code)
        }
    }

    /** 计算 sha256 */
    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    @Test
    fun writesChunksInOrderAndClosesWithSha() {
        val r = reg()
        val h = r.open("a/b.bin", null, null)
        val a = byteArrayOf(1, 2, 3)
        val b = byteArrayOf(4, 5)
        assertEquals(3L, r.write(h, 0, 0, a).written)
        assertEquals(5L, r.write(h, 1, 3, b).written)
        val res = r.close(h, 5, sha(a + b))
        assertEquals("b.bin", res.name)
        assertEquals(5L, res.size)
        assertEquals(sha(a + b), res.sha256)
        assertArrayEquals(a + b, res.file.readBytes())
        assertEquals(File(File(outDir, h), "b.bin"), res.file)
        assertFalse("临时文件应已被移走", File(tmpDir, "$h.part").exists())
        assertEquals(0, r.openCount())
    }

    @Test
    fun rejectsGapAndBadOffset() {
        val r = reg()
        val h = r.open("a", null, null)
        assertCode(BridgeErrors.BAD_PARAMS) { r.write(h, 1, 0, byteArrayOf(1)) }
        assertCode(BridgeErrors.BAD_PARAMS) { r.write(h, 0, 5, byteArrayOf(1)) }
        r.write(h, 0, 0, byteArrayOf(1, 2))
        assertCode(BridgeErrors.BAD_PARAMS) { r.write(h, 1, 1, byteArrayOf(3)) }
        assertCode(BridgeErrors.BAD_PARAMS) { r.write(h, 2, 2, byteArrayOf(3)) }
        assertCode(BridgeErrors.BAD_PARAMS) { r.write(h, -1, 0, byteArrayOf(3)) }
    }

    @Test
    fun resendOfSameChunkIsIdempotent() {
        val r = reg()
        val h = r.open("a", null, null)
        r.write(h, 0, 0, byteArrayOf(1, 2, 3))
        val again = r.write(h, 0, 0, byteArrayOf(1, 2, 3))
        assertEquals(3L, again.written)
        r.write(h, 1, 3, byteArrayOf(4))
        // 已写过的旧块重发，也只回确认，written 是当前总量
        assertEquals(4L, r.write(h, 0, 0, byteArrayOf(9, 9, 9)).written)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), r.close(h, null, null).file.readBytes())
    }

    @Test
    fun resendWithDifferentShapeRejected() {
        val r = reg()
        val h = r.open("a", null, null)
        r.write(h, 0, 0, byteArrayOf(1, 2, 3))
        assertCode(BridgeErrors.BAD_PARAMS) { r.write(h, 0, 0, byteArrayOf(1, 2)) }
        assertCode(BridgeErrors.BAD_PARAMS) { r.write(h, 0, 1, byteArrayOf(1, 2, 3)) }
    }

    @Test
    fun rejectsEmptyAndOversizedChunk() {
        val r = reg()
        val h = r.open("a", null, null)
        assertCode(BridgeErrors.BAD_PARAMS) { r.write(h, 0, 0, ByteArray(0)) }
        assertCode(BridgeErrors.BAD_PARAMS) { r.write(h, 0, 0, ByteArray(FileConst.CHUNK_BYTES + 1)) }
    }

    @Test
    fun enforcesTotalLimitAndDeclaredSize() {
        val r = reg(maxBytes = 10)
        val h = r.open("a", null, null)
        r.write(h, 0, 0, ByteArray(8))
        assertCode(BridgeErrors.BAD_PARAMS) { r.write(h, 1, 8, ByteArray(3)) }
        assertCode(BridgeErrors.BAD_PARAMS) { r.open("big", 11, null) }

        val h2 = r.open("b", 4, null)
        r.write(h2, 0, 0, ByteArray(4))
        assertCode(BridgeErrors.BAD_PARAMS) { r.write(h2, 1, 4, ByteArray(1)) }
    }

    @Test
    fun closeSizeMismatchDiscardsEverything() {
        val r = reg()
        val h = r.open("a", 5, null)
        r.write(h, 0, 0, byteArrayOf(1, 2, 3))
        assertCode(BridgeErrors.BAD_PARAMS) { r.close(h, null, null) }
        assertFalse(File(tmpDir, "$h.part").exists())
        assertCode(BridgeErrors.BAD_PARAMS) { r.write(h, 1, 3, byteArrayOf(4)) }
    }

    @Test
    fun closeShaMismatchDiscards() {
        val r = reg()
        val h = r.open("a", null, "0".repeat(64))
        r.write(h, 0, 0, byteArrayOf(1))
        assertCode(BridgeErrors.BAD_PARAMS) { r.close(h, null, null) }
        assertFalse(File(tmpDir, "$h.part").exists())
        assertFalse(File(outDir, h).exists())
    }

    @Test
    fun closeIsIdempotent() {
        val r = reg()
        val h = r.open("a.txt", null, null)
        r.write(h, 0, 0, byteArrayOf(7))
        val first = r.close(h, null, null)
        assertSame(first, r.close(h, null, null))
    }

    @Test
    fun unknownHandleRejected() {
        val r = reg()
        assertCode(BridgeErrors.BAD_PARAMS) { r.write("nope", 0, 0, byteArrayOf(1)) }
        assertCode(BridgeErrors.BAD_PARAMS) { r.close("nope", null, null) }
        assertFalse(r.abort("nope"))
    }

    @Test
    fun rejectsBadShaFormatAtOpen() {
        assertCode(BridgeErrors.BAD_PARAMS) { reg().open("a", null, "xyz") }
    }

    @Test
    fun tooManyOpenHandles() {
        val r = reg(maxOpen = 2)
        r.open("a", null, null)
        r.open("b", null, null)
        assertCode(BridgeErrors.NOT_READY) { r.open("c", null, null) }
    }

    @Test
    fun abortDeletesTempFile() {
        val r = reg()
        val h = r.open("a", null, null)
        r.write(h, 0, 0, byteArrayOf(1))
        assertTrue(File(tmpDir, "$h.part").exists())
        assertTrue(r.abort(h))
        assertFalse(File(tmpDir, "$h.part").exists())
        assertEquals(0, r.openCount())
    }

    @Test
    fun abortAllCleansEveryOpenHandleButKeepsFinishedFiles() {
        val r = reg()
        val done = r.open("done", null, null)
        r.write(done, 0, 0, byteArrayOf(1))
        val res = r.close(done, null, null)
        val h1 = r.open("a", null, null)
        val h2 = r.open("b", null, null)
        r.write(h1, 0, 0, byteArrayOf(1))
        assertEquals(setOf("tmp/$h1.part", "tmp/$h2.part"), r.activeParts())
        assertEquals(2, r.abortAll())
        assertEquals(0, tmpDir.listFiles()?.size ?: 0)
        assertTrue("已完成的产物不受影响", res.file.exists())
    }

    @Test
    fun sweepIdleDropsOnlyStaleHandles() {
        val r = reg(idleMs = 1000)
        val old = r.open("old", null, null)
        now += 600
        val fresh = r.open("fresh", null, null)
        now += 600
        // old 已 1200ms 没动，fresh 才 600ms
        assertEquals(1, r.sweepIdle())
        assertFalse(File(tmpDir, "$old.part").exists())
        assertTrue(File(tmpDir, "$fresh.part").exists())
        assertEquals(1, r.openCount())
    }

    @Test
    fun writeRefreshesActivity() {
        val r = reg(idleMs = 1000)
        val h = r.open("a", null, null)
        now += 800
        r.write(h, 0, 0, byteArrayOf(1))
        now += 800
        assertEquals(0, r.sweepIdle())
    }

    @Test
    fun nameIsSanitizedAgainstTraversal() {
        val r = reg()
        val h = r.open("../../evil.sh", null, null)
        r.write(h, 0, 0, byteArrayOf(1))
        val res = r.close(h, null, null)
        assertEquals("evil.sh", res.name)
        assertTrue(res.file.canonicalPath.startsWith(outDir.canonicalPath))
    }

    @Test
    fun largeFileSequentialWriteKeepsShaConsistent() {
        val r = reg(maxBytes = 8L shl 20)
        val total = 5 * FileConst.CHUNK_BYTES + 123
        val data = ByteArray(total) { (it * 31 + 7).toByte() }
        val h = r.open("big.bin", total.toLong(), sha(data))
        var off = 0
        var seq = 0
        while (off < total) {
            val n = minOf(FileConst.CHUNK_BYTES, total - off)
            r.write(h, seq++, off.toLong(), data.copyOfRange(off, off + n))
            off += n
        }
        val res = r.close(h, null, null)
        assertEquals(total.toLong(), res.size)
        assertEquals(sha(data), res.sha256)
    }
}
