package com.let188.arkli.model

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** 外部目录导入：扫描过滤、复制与原子改名、失败回滚、校验不被绕过、单飞 */
class ModelImportTest {
    /** 临时目录，充当 filesDir 与导入根 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 管理器用的作用域 */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 单文件模型内容 */
    private val data = content(20_000, 5)

    /** 单文件模型清单项（id 为 m1） */
    private val entry = entryOf(data)

    /** 导入根目录 */
    private val importRoot get() = File(tmp.root, "import")

    /** 模型私有目录 */
    private val modelDir get() = File(tmp.root, "files/models/m1")

    @After
    fun tearDown() = scope.cancel()

    /** 往导入目录放文件 */
    private fun put(id: String, name: String, bytes: ByteArray): File =
        File(importRoot, "$id/$name").also { it.parentFile!!.mkdirs(); it.writeBytes(bytes) }

    /** 造管理器，已设置导入根 */
    private fun manager(vararg entries: ModelEntry, free: Long = Long.MAX_VALUE): ModelManager {
        val dl = ModelDownloader(FakeTransport { _, _, _ -> error("导入不应联网") }, { free }, { false }, { })
        return ModelManager(ModelManifest(entries.toList()), File(tmp.root, "files"), dl, scope, freeSpace = { free })
            .also { it.importRoot = importRoot }
    }

    /** 等某模型任务结束 */
    private fun settle(m: ModelManager, id: String): ModelSnapshot {
        val end = System.currentTimeMillis() + 10_000
        while (m.status(id).state == ModelState.DOWNLOADING) {
            check(System.currentTimeMillis() < end) { "导入超时" }
            Thread.sleep(5)
        }
        return m.status(id)
    }

    @Test
    fun scan_onlyKnownIdsAndNonEmptyDirs() {
        put("m1", "m.bin", data)
        put("zzz", "x.bin", data)
        File(importRoot, "empty").mkdirs()
        val r = ModelImporter.scan(importRoot, ModelManifest(listOf(entry)))
        assertEquals(listOf("m1"), r.found.map { it.first.id })
        assertEquals(setOf("zzz", "empty"), r.ignored.toSet())
    }

    @Test
    fun scan_missingRootIsEmpty() {
        val r = ModelImporter.scan(File(tmp.root, "none"), ModelManifest(listOf(entry)))
        assertTrue(r.found.isEmpty() && r.ignored.isEmpty())
    }

    @Test
    fun copyInto_copiesAtomicallyAndSkipsUnknownFiles() {
        put("m1", "m.bin", data)
        put("m1", "junk.txt", byteArrayOf(1))
        val src = File(importRoot, "m1")
        val done = ModelImporter.copyInto(entry, src, modelDir, { Long.MAX_VALUE })
        assertEquals(listOf("m.bin"), done.map { it.name })
        assertArrayEquals(data, File(modelDir, "m.bin").readBytes())
        assertFalse(File(modelDir, "junk.txt").exists())
        assertFalse(File(modelDir, "m.bin$IMPORT_TMP_SUFFIX").exists())
        assertTrue(File(src, "m.bin").exists())
    }

    @Test
    fun copyInto_noSpaceLeavesNothing() {
        put("m1", "m.bin", data)
        val e = assertThrows(ModelDownloadException::class.java) {
            ModelImporter.copyInto(entry, File(importRoot, "m1"), modelDir, { 10L })
        }
        assertEquals(ModelErrorCode.NO_SPACE, e.code)
        assertFalse(File(modelDir, "m.bin").exists())
    }

    @Test
    fun copyInto_cancelRollsBack() {
        put("m1", "m.bin", data)
        assertThrows(kotlin.coroutines.cancellation.CancellationException::class.java) {
            ModelImporter.copyInto(entry, File(importRoot, "m1"), modelDir, { Long.MAX_VALUE }, { false })
        }
        assertFalse(File(modelDir, "m.bin").exists())
        assertFalse(File(modelDir, "m.bin$IMPORT_TMP_SUFFIX").exists())
    }

    @Test
    fun copyInto_emptySourceFails() {
        put("m1", "junk.txt", byteArrayOf(1))
        val e = assertThrows(ModelDownloadException::class.java) {
            ModelImporter.copyInto(entry, File(importRoot, "m1"), modelDir, { Long.MAX_VALUE })
        }
        assertEquals(ModelErrorCode.INTERNAL, e.code)
    }

    @Test
    fun scanImports_installsVerifiesAndDeletesImportDir() {
        put("m1", "m.bin", data)
        val m = manager(entry)
        assertEquals(listOf("m1"), m.scanImports())
        assertEquals(ModelState.INSTALLED, settle(m, "m1").state)
        assertFalse(File(importRoot, "m1").exists())
        assertTrue(File(modelDir, "m.bin").exists())
        // 已安装后再扫不会重复启动
        put("m1", "m.bin", data)
        assertTrue(m.scanImports().isEmpty())
    }

    @Test
    fun scanImports_badShaIsRejectedRolledBackAndKept() {
        val bad = data.copyOf().also { it[0] = (it[0] + 1).toByte() }
        put("m1", "m.bin", bad)
        val m = manager(entry)
        assertEquals(listOf("m1"), m.scanImports())
        val s = settle(m, "m1")
        // 任务收尾后错误才可见，稍等
        Thread.sleep(50)
        val s2 = m.status("m1")
        assertTrue(s.state != ModelState.INSTALLED && s2.state != ModelState.INSTALLED)
        assertEquals(ModelErrorCode.HASH_MISMATCH.wire, s2.errorCode)
        assertFalse(File(modelDir, "m.bin").exists())
        assertTrue(File(importRoot, "m1/m.bin").exists())
        // 本进程内不自动重试
        assertTrue(m.scanImports().isEmpty())
    }

    @Test
    fun scanImports_noSpaceReportsCodeAndKeepsImportDir() {
        put("m1", "m.bin", data)
        val m = manager(entry, free = 10L)
        assertEquals(listOf("m1"), m.scanImports())
        settle(m, "m1")
        Thread.sleep(50)
        assertEquals(ModelErrorCode.NO_SPACE.wire, m.status("m1").errorCode)
        assertTrue(File(importRoot, "m1/m.bin").exists())
    }

    @Test
    fun scanImports_zipPackIsExtractedAndShaChecked() {
        val a = content(3_000, 1)
        val bos = ByteArrayOutputStream()
        ZipOutputStream(bos).use { z -> z.putNextEntry(ZipEntry("a.bin")); z.write(a); z.closeEntry() }
        val zip = bos.toByteArray()
        val files = listOf(ModelFile("a.bin", a.size.toLong(), sha256(a), "data", emptyList()))
        val pack = ModelEntry("p1", "包", "1", "models/p1", a.size.toLong(), null, files, ModelFile("p.zip", zip.size.toLong(), sha256(zip), "archive", listOf(T_URL)))
        put("p1", "p.zip", zip)
        val m = manager(pack)
        assertEquals(listOf("p1"), m.scanImports())
        assertEquals(ModelState.INSTALLED, settle(m, "p1").state)
        assertArrayEquals(a, File(tmp.root, "files/models/p1/a.bin").readBytes())
        assertFalse(File(importRoot, "p1").exists())
    }

    @Test
    fun scanImports_singleFlightPerModel() {
        put("m1", "m.bin", data)
        val m = manager(entry)
        val first = m.scanImports()
        val second = m.scanImports()
        assertEquals(1, first.size + second.size)
        settle(m, "m1")
    }

    @Test
    fun scanImports_withoutRootDoesNothing() {
        val m = manager(entry).also { it.importRoot = null }
        assertTrue(m.scanImports().isEmpty())
    }
}
