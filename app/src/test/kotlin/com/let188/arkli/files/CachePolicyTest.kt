package com.let188.arkli.files

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** 缓存清理策略与执行器测试 */
class CachePolicyTest {
    /** 每个用例独立的临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    private val hour = 3_600_000L
    private val now = 100 * hour

    /** 造一个缓存条目，age 是距今多久 */
    private fun e(path: String, size: Long = 1, age: Long = 0, part: Boolean = false) =
        CacheEntry(path, size, now - age, part)

    /** 用小上限跑一次策略，返回被删路径 */
    private fun plan(entries: List<CacheEntry>, active: Set<String> = emptySet(), total: Long = 1000, partAge: Long = hour) =
        CachePolicy.plan(entries, now, active, maxAgeMs = 24 * hour, maxTotal = total, keepRecentMs = 10 * 60_000L, partOrphanAgeMs = partAge)
            .map { it.path }.toSet()

    @Test
    fun deletesExpiredKeepsFresh() {
        val del = plan(listOf(e("out/old", age = 25 * hour), e("out/new", age = 23 * hour)))
        assertEquals(setOf("out/old"), del)
    }

    @Test
    fun activePartsAreNeverDeleted() {
        val parts = listOf(e("tmp/a.part", age = 50 * hour, part = true), e("tmp/b.part", age = 50 * hour, part = true))
        assertEquals(setOf("tmp/b.part"), plan(parts, active = setOf("tmp/a.part")))
    }

    @Test
    fun orphanPartDeletedOnlyAfterAgeUnlessStartup() {
        val young = e("tmp/y.part", age = 30 * 60_000L, part = true)
        assertEquals(emptySet<String>(), plan(listOf(young)))
        // 启动时孤儿存活时间要求为 0
        assertEquals(setOf("tmp/y.part"), plan(listOf(young), partAge = 0))
    }

    @Test
    fun overLimitDeletesOldestFirstAndSparesRecent() {
        val list = listOf(
            e("a", size = 400, age = 5 * hour),
            e("b", size = 400, age = 3 * hour),
            e("c", size = 400, age = 1 * hour),
            e("d", size = 400, age = 60_000L),
        )
        // 总 1600 > 1000：先删最旧 a、b，剩 800 即停
        assertEquals(setOf("a", "b"), plan(list))
    }

    @Test
    fun overLimitNeverTouchesRecentFiles() {
        val list = listOf(e("x", size = 900, age = 60_000L), e("y", size = 900, age = 120_000L))
        assertEquals(emptySet<String>(), plan(list))
    }

    @Test
    fun activePartCountsTowardTotalButIsKept() {
        val list = listOf(e("tmp/a.part", size = 800, age = hour, part = true), e("out/z", size = 400, age = 2 * hour))
        assertEquals(setOf("out/z"), plan(list, active = setOf("tmp/a.part")))
    }

    @Test
    fun janitorScansDeletesAndPrunesEmptyDirs() {
        val root = tmp.newFolder("arkli")
        val old = File(root, "out/h1/a.bin").apply { parentFile.mkdirs(); writeText("x"); setLastModified(now - 30 * hour) }
        val fresh = File(root, "out/h2/b.bin").apply { parentFile.mkdirs(); writeText("y"); setLastModified(now - hour) }
        val orphan = File(root, "tmp/dead.part").apply { parentFile.mkdirs(); writeText("z"); setLastModified(now - 1000) }
        val live = File(root, "tmp/live.part").apply { writeText("w"); setLastModified(now - 1000) }
        val j = CacheJanitor(root, { setOf("tmp/live.part") }, { now })

        assertEquals(4, j.scan().size)
        // 启动清理：过期文件与孤儿临时文件都删，活跃的留下
        assertEquals(2, j.run(startup = true))
        assertFalse(old.exists())
        assertFalse(orphan.exists())
        assertTrue(fresh.exists())
        assertTrue(live.exists())
        assertFalse("空目录应被清掉", File(root, "out/h1").exists())
        assertTrue(root.exists())
    }

    @Test
    fun idleCleanupSpareYoungOrphans() {
        val root = tmp.newFolder("arkli")
        val young = File(root, "tmp/y.part").apply { parentFile.mkdirs(); writeText("z"); setLastModified(now - 1000) }
        assertEquals(0, CacheJanitor(root, { emptySet() }, { now }).run(startup = false))
        assertTrue(young.exists())
    }

    @Test
    fun missingRootIsHarmless() {
        assertEquals(0, CacheJanitor(File(tmp.root, "nope"), { emptySet() }, { now }).run(true))
    }
}
