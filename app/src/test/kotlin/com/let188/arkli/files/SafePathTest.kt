package com.let188.arkli.files

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assume.assumeFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** 路径归一化与防目录穿越测试 */
class SafePathTest {
    /** 每个用例独立的临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 造一个带 cache 与 packs 两个根的环境 */
    private fun roots(): FileRoots = FileRoots(tmp.newFolder("cache"), tmp.newFolder("packs"))

    @Test
    fun acceptsPlainRelativePath() {
        val root = tmp.newFolder("r")
        val f = SafePath.resolve(root, "a/b.txt")
        assertNotNull(f)
        assertEquals(File(root.canonicalFile, "a/b.txt"), f)
    }

    @Test
    fun rejectsTraversalAndOddInput() {
        val root = tmp.newFolder("r")
        val bad = listOf(
            "", "/etc/passwd", "../x", "a/../../x", "a/..", "./a", "a//b", "a/", "a\\b", "..\\x", "a\u0000b",
            "..", ".",
        )
        for (p in bad) assertNull("应拒绝：$p", SafePath.resolve(root, p))
    }

    @Test
    fun rejectsSiblingDirectoryWithSamePrefix() {
        val root = tmp.newFolder("cache")
        tmp.newFolder("cache-evil")
        // 兄弟目录名以根目录名为前缀，不能因前缀相同被放行
        assertNull(SafePath.resolve(root, "../cache-evil/x"))
    }

    @Test
    fun rejectsSymlinkEscape() {
        // Windows 的 canonicalFile 不解析符号链接，只在 Linux/macOS（含 Android）验证
        assumeFalse(System.getProperty("os.name").startsWith("Windows"))
        val root = tmp.newFolder("r")
        val outside = tmp.newFolder("outside")
        File(outside, "secret").writeText("x")
        val link = File(root, "link")
        try {
            java.nio.file.Files.createSymbolicLink(link.toPath(), outside.toPath())
        } catch (e: Exception) {
            // Windows 没有创建符号链接的权限时跳过
            return
        }
        assertNull(SafePath.resolve(root, "link/secret"))
    }

    @Test
    fun rootsMapPrefixes() {
        val r = roots()
        assertEquals(File(r.cacheRoot.canonicalFile, "pick/a.jpg"), r.resolve("cache/pick/a.jpg"))
        assertEquals(File(r.packsRoot.canonicalFile, "m/x.bin"), r.resolve("packs/m/x.bin"))
        assertNull(r.resolve("other/a"))
        assertNull(r.resolve("cache"))
        assertNull(r.resolve("cache/../packs/x"))
    }

    @Test
    fun resolveCacheRefusesPacks() {
        val r = roots()
        assertNull(r.resolveCache("packs/x"))
        assertNotNull(r.resolveCache("cache/x"))
    }

    @Test
    fun pagePathRoundTrip() {
        val r = roots()
        val f = r.resolve("cache/out/h/a.png")!!
        assertEquals("cache/out/h/a.png", r.pagePathOf(f))
        assertNull(r.pagePathOf(File(r.packsRoot, "x")))
    }
}
