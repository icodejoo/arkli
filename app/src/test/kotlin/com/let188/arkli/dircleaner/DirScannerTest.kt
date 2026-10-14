package com.let188.arkli.dircleaner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** 目录扫描纯逻辑测试：用内存树代替 SAF */
class DirScannerTest {
    /** 造文件项 */
    private fun f(id: String, name: String, size: Long, mime: String = "application/octet-stream") = DirEntry(id, name, mime, size, 1000)

    /** 造文件夹项 */
    private fun d(id: String, name: String) = DirEntry(id, name, DIR_MIME, -1, 0)

    /** 以 docId 为键的内存树 */
    private class Tree(val map: Map<String, List<DirEntry>>) : DirSource {
        /** 列出子项，不存在的目录按读取失败处理 */
        override fun children(docId: String): List<DirEntry> = map[docId] ?: throw DirReadException("无此目录 $docId")
    }

    /** 缺省参数 */
    private fun opts(mode: ScanMode, minBytes: Long = 100, maxItems: Int = 100, maxDepth: Int = 12) = ScanOptions(mode, minBytes, maxItems, maxDepth)

    /** 跑一次扫描 */
    private fun run(t: Tree, o: ScanOptions, onProgress: (Int) -> Unit = {}, cancel: () -> Unit = {}) =
        DirScanner.scan(t, "root", o, onProgress, cancel)

    @Test
    fun largeFiltersByThresholdAndSortsDesc() {
        val t = Tree(
            mapOf(
                "root" to listOf(f("a", "a.bin", 500), f("b", "b.bin", 50), d("sub", "sub")),
                "sub" to listOf(f("c", "c.bin", 900)),
            ),
        )
        val r = run(t, opts(ScanMode.LARGE))
        assertEquals(listOf("sub/c.bin", "a.bin"), r.items.map { it.relPath })
        assertEquals(4, r.scanned)
        assertFalse(r.truncated)
    }

    @Test
    fun largeIgnoresUnknownSize() {
        val t = Tree(mapOf("root" to listOf(f("a", "a.bin", -1))))
        // 大小未知（-1）的文件不算大文件，即使阈值为 0
        assertTrue(run(t, opts(ScanMode.LARGE, minBytes = 0)).items.isEmpty())
    }

    @Test
    fun emptyFindsZeroByteFilesAndEmptyFolders() {
        val t = Tree(
            mapOf(
                "root" to listOf(f("z", "zero.txt", 0), d("e1", "empty1"), d("n", "nonempty")),
                "e1" to listOf(d("e2", "inner")),
                "e2" to emptyList(),
                "n" to listOf(f("k", "k.txt", 5)),
            ),
        )
        val r = run(t, opts(ScanMode.EMPTY))
        assertEquals(listOf("empty1", "empty1/inner", "zero.txt"), r.items.map { it.relPath })
    }

    @Test
    fun folderWithOnlyZeroByteFileIsNotEmpty() {
        val t = Tree(mapOf("root" to listOf(d("a", "a")), "a" to listOf(f("z", "z.txt", 0))))
        val r = run(t, opts(ScanMode.EMPTY))
        assertEquals(listOf("a/z.txt"), r.items.map { it.relPath })
    }

    @Test
    fun unreadableSubfolderIsNotReportedEmpty() {
        val t = Tree(mapOf("root" to listOf(d("bad", "bad"))))
        val r = run(t, opts(ScanMode.EMPTY))
        assertTrue(r.items.isEmpty())
        assertTrue(r.truncated)
    }

    @Test
    fun depthLimitMakesFoldersUnexplored() {
        val t = Tree(mapOf("root" to listOf(d("a", "a")), "a" to listOf(d("b", "b")), "b" to emptyList()))
        val r = run(t, opts(ScanMode.EMPTY, maxDepth = 1))
        assertTrue(r.items.isEmpty())
        assertTrue(r.truncated)
    }

    @Test
    fun apkMatchesMimeAndExtension() {
        assertTrue(DirScanner.isApk("x.APK", "application/octet-stream"))
        assertTrue(DirScanner.isApk("x.apks", ""))
        assertTrue(DirScanner.isApk("x.xapk", ""))
        assertTrue(DirScanner.isApk("noext", APK_MIME))
        assertFalse(DirScanner.isApk("x.apk.txt", "text/plain"))
        assertFalse(DirScanner.isApk("apk", ""))
    }

    @Test
    fun apkModeListsOnlyPackages() {
        val t = Tree(mapOf("root" to listOf(f("a", "a.apk", 10), f("b", "b.txt", 20), f("c", "c.xapk", 30))))
        assertEquals(listOf("c.xapk", "a.apk"), run(t, opts(ScanMode.APK)).items.map { it.relPath })
    }

    @Test
    fun allListsFilesAndFolders() {
        val t = Tree(mapOf("root" to listOf(f("a", "a.txt", 1), d("s", "s")), "s" to emptyList()))
        assertEquals(listOf("a.txt", "s"), run(t, opts(ScanMode.ALL)).items.map { it.relPath })
    }

    @Test
    fun folderBytesAreZeroEvenIfProviderReportsDirSize() {
        // 真机上目录项的 size 是 3440 这类文件系统值，不是内容体积
        val dirWithSize = DirEntry("s", "s", DIR_MIME, 3440, 0)
        val t = Tree(mapOf("root" to listOf(dirWithSize), "s" to emptyList()))
        val items = run(t, opts(ScanMode.EMPTY)).items
        assertEquals(1, items.size)
        assertEquals(0L, items[0].bytes)
    }

    @Test
    fun maxItemsTruncates() {
        val t = Tree(mapOf("root" to (1..10).map { f("i$it", "f$it", 1000L + it) }))
        val r = run(t, opts(ScanMode.LARGE, maxItems = 3))
        assertEquals(3, r.items.size)
        assertEquals(1010L, r.items[0].bytes)
        assertTrue(r.truncated)
    }

    @Test
    fun nodeCapStopsTraversal() {
        val n = DirScanner.MAX_NODES + 10
        val t = Tree(mapOf("root" to (1..n).map { f("i$it", "f$it", 1) }))
        val r = run(t, opts(ScanMode.ALL, maxItems = 5000))
        assertEquals(DirScanner.MAX_NODES, r.scanned)
        assertTrue(r.truncated)
    }

    @Test
    fun progressEveryStep() {
        val t = Tree(mapOf("root" to (1..1200).map { f("i$it", "f$it", 1) }))
        val seen = ArrayList<Int>()
        run(t, opts(ScanMode.ALL, maxItems = 5000), onProgress = { seen.add(it) })
        assertEquals(listOf(500, 1000), seen)
    }

    @Test
    fun cancellationPropagates() {
        val t = Tree(mapOf("root" to listOf(d("a", "a")), "a" to emptyList()))
        try {
            run(t, opts(ScanMode.ALL), cancel = { throw IllegalStateException("cancelled") })
            fail("应当抛出")
        } catch (e: IllegalStateException) {
            assertEquals("cancelled", e.message)
        }
    }

    @Test
    fun rootReadFailureThrows() {
        try {
            DirScanner.scan(Tree(emptyMap()), "root", opts(ScanMode.ALL), {}, {})
            fail("应当抛出")
        } catch (e: DirReadException) {
            assertTrue(e.message!!.contains("root"))
        }
    }

    @Test
    fun emptyFoldersBottomUp() {
        // 0 根下；1 是 0 的子；2 是 1 的子且含文件
        val r = DirScanner.emptyFolders(intArrayOf(-1, 0, 1, -1), booleanArrayOf(false, false, true, false), booleanArrayOf(true, true, true, true))
        assertEquals(listOf(false, false, false, true), r.toList())
    }
}
