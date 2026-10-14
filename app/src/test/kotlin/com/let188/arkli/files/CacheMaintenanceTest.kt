package com.let188.arkli.files

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** 缓存统计、手动清空与 out/ 丢弃、拼图遗留清理测试 */
class CacheMaintenanceTest {
    /** 每个用例独立的临时目录，充当缓存根 */
    @get:Rule
    val tmp = TemporaryFolder()

    private val now = 1_000_000L

    /** 造条目，age 是距今毫秒 */
    private fun e(path: String, size: Long = 1, age: Long = 10 * FileConst.CLEAR_BUSY_MS, part: Boolean = false) =
        CacheEntry(path, size, now - age, part)

    /** 缓存根 */
    private val root get() = File(tmp.root, "arkli")

    /** 在缓存根下造文件 */
    private fun file(rel: String, bytes: Int = 3, ageMs: Long = 10 * FileConst.CLEAR_BUSY_MS): File {
        val f = File(root, rel)
        f.parentFile.mkdirs()
        f.writeBytes(ByteArray(bytes))
        f.setLastModified(System.currentTimeMillis() - ageMs)
        return f
    }

    /** 路径解析：与 FileRoots.resolveCache 同款防穿越 */
    private fun roots() = FileRoots(root.apply { mkdirs() }, File(tmp.root, "packs"))

    @Test
    fun statsGroupsByFirstLevelDir() {
        val s = CacheMaintenance.stats(listOf(e("pick/a", 10), e("pick/b", 5), e("out/x/c", 7), e("top", 1), e("tmp/p.part", 2, part = true)))
        assertEquals(25L, s.bytes)
        assertEquals(5, s.files)
        assertEquals(DirStat(15, 2), s.byDir["pick"])
        assertEquals(DirStat(7, 1), s.byDir["out"])
        assertEquals(DirStat(1, 1), s.byDir[CacheMaintenance.ROOT_KEY])
        assertEquals(DirStat(2, 1), s.byDir["tmp"])
    }

    @Test
    fun statsOfEmptyCache() {
        val s = CacheMaintenance.stats(emptyList())
        assertEquals(0L, s.bytes)
        assertEquals(0, s.files)
        assertTrue(s.byDir.isEmpty())
    }

    @Test
    fun planClearSkipsActivePartsAndBusyFiles() {
        val list = listOf(
            e("out/old"),
            e("tmp/active.part", part = true),
            e("tmp/orphan.part", part = true),
            e("out/fresh", age = 1000),
            e("pick/old"),
        )
        val plan = CacheMaintenance.planClear(list, now, setOf("tmp/active.part"))
        assertEquals(setOf("out/old", "tmp/orphan.part", "pick/old"), plan.victims.map { it.path }.toSet())
        assertEquals(2, plan.skipped)
    }

    @Test
    fun janitorClearDeletesFilesAndPrunesDirsButKeepsActive() {
        file("pick/a.jpg", 4)
        file("out/b.png", 6)
        file("tmp/live.part", 8)
        file("tmp/dead.part", 2)
        file("out/just-written.png", 5, ageMs = 1000)
        val janitor = CacheJanitor(root, { setOf("tmp/live.part") })
        val before = janitor.stats()
        assertEquals(25L, before.bytes)
        val r = janitor.clear()
        assertEquals(3, r.deleted)
        assertEquals(12L, r.freedBytes)
        assertEquals(2, r.skipped)
        assertTrue(File(root, "tmp/live.part").isFile)
        assertTrue(File(root, "out/just-written.png").isFile)
        assertFalse(File(root, "pick").exists())
        assertEquals(13L, janitor.stats().bytes)
    }

    @Test
    fun discardDeletesOnlyInsideOutAndCountsMissingAsZero() {
        val r = roots()
        val a = file("out/a.png")
        file("pick/p.png")
        val n = OutFiles.discard(File(root, "out"), r::resolveCache, listOf("cache/out/a.png", "cache/out/not-there.png"))
        assertEquals(1, n)
        assertFalse(a.exists())
        assertTrue(File(root, "pick/p.png").exists())
    }

    @Test
    fun discardRejectsWholeCallOnTraversalOrOutsideOut() {
        val r = roots()
        val a = file("out/a.png")
        val p = file("pick/p.png")
        for (bad in listOf("cache/pick/p.png", "cache/out/../pick/p.png", "cache/../x", "packs/a", "/etc/passwd", "cache/out", "cache/out/")) {
            val e = runCatching { OutFiles.discard(File(root, "out"), r::resolveCache, listOf("cache/out/a.png", bad)) }.exceptionOrNull()
            assertTrue("应拒绝 $bad", e is BridgeException && e.code == BridgeErrors.BAD_PARAMS)
        }
        assertTrue(a.exists())
        assertTrue(p.exists())
    }

    @Test
    fun discardRejectsDirectoryAndBadCounts() {
        val r = roots()
        file("out/sub/x.bin")
        val dirErr = runCatching { OutFiles.discard(File(root, "out"), r::resolveCache, listOf("cache/out/sub")) }.exceptionOrNull() as BridgeException
        assertEquals(BridgeErrors.BAD_PARAMS, dirErr.code)
        assertTrue(runCatching { OutFiles.discard(File(root, "out"), r::resolveCache, emptyList()) }.exceptionOrNull() is BridgeException)
        assertTrue(runCatching { OutFiles.discard(File(root, "out"), r::resolveCache, List(OutFiles.MAX_DISCARD + 1) { "cache/out/a$it" }) }.exceptionOrNull() is BridgeException)
    }

    @Test
    fun discardingStitchResultAlsoRemovesItsThumb() {
        val r = roots()
        file("out/stitch_123.png")
        file("out/stitch_thumb_123.jpg")
        file("out/stitch_thumb_999.jpg")
        val n = OutFiles.discard(File(root, "out"), r::resolveCache, listOf("cache/out/stitch_123.png"))
        assertEquals(2, n)
        assertTrue(File(root, "out/stitch_thumb_999.jpg").exists())
    }

    @Test
    fun discardThumbPathDirectlyDoesNotCascade() {
        val r = roots()
        file("out/stitch_5.jpg")
        file("out/stitch_thumb_5.jpg")
        assertEquals(1, OutFiles.discard(File(root, "out"), r::resolveCache, listOf("cache/out/stitch_thumb_5.jpg")))
        assertTrue(File(root, "out/stitch_5.jpg").exists())
    }

    @Test
    fun purgeStitchOnlyTouchesStitchPrefixInOutTopLevel() {
        file("out/stitch_1.png")
        file("out/stitch_thumb_1.jpg")
        file("out/stitch_2.png.part")
        file("out/photo-1f2e.jpg")
        file("out/wallpaper/stitch_x.png")
        file("pick/stitch_y.png")
        val n = OutFiles.purgeStitch(File(root, "out"))
        assertEquals(3, n)
        assertTrue(File(root, "out/photo-1f2e.jpg").exists())
        assertTrue(File(root, "out/wallpaper/stitch_x.png").exists())
        assertTrue(File(root, "pick/stitch_y.png").exists())
    }

    @Test
    fun purgeStitchOnMissingDirIsZero() {
        assertEquals(0, OutFiles.purgeStitch(File(root, "out")))
    }
}
