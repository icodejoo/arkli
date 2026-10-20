package com.let188.arkli.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** 退役模型：清单解析、回收规则、回收执行 */
class ModelRetiredTest {
    /** 临时 filesDir */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 带可选 retired 片段的清单文本 */
    private fun json(retired: String? = null) = """
        {"schema":1,${if (retired != null) "\"retired\":$retired," else ""}"models":[{"id":"m1","displayName":"X","version":"1","dir":"models/m1","totalBytes":10,
          "files":[{"name":"m.bin","bytes":10,"sha256":"${"a".repeat(64)}","urls":["https://github.com/o/r/releases/download/v1/m.bin"]}]}]}
    """.trimIndent()

    /** 造一份只带 retired 的清单 */
    private fun manifest(vararg dirs: String) =
        ModelManifest(ModelManifestParser.parse(json()).models, dirs.mapIndexed { i, d -> RetiredModel("old$i", d) })

    @Test
    fun parse_noRetired_isEmpty() {
        assertTrue(ModelManifestParser.parse(json()).retired.isEmpty())
    }

    @Test
    fun parse_withRetired() {
        val m = ModelManifestParser.parse(json("""[{"id":"old-a","dir":"models/old-a"}]"""))
        assertEquals(listOf(RetiredModel("old-a", "models/old-a")), m.retired)
    }

    @Test
    fun parse_invalidRetired_dropsEntriesButKeepsManifest() {
        val bad = """[1,{"id":"x","dir":"models/../etc"},{"id":"Y","dir":"models/y"},{"id":"ok","dir":"models/ok"},{"dir":"models/z"}]"""
        val m = ModelManifestParser.parse(json(bad))
        assertEquals(listOf(RetiredModel("ok", "models/ok")), m.retired)
        assertEquals(1, m.models.size)
    }

    @Test
    fun parse_retiredNotArray_isEmpty() {
        assertTrue(ModelManifestParser.parse(json("\"oops\"")).retired.isEmpty())
    }

    @Test
    fun policy_emptyRetired_noop() {
        assertTrue(ModelPolicy.retiredDirsToDelete(manifest(), setOf("models/a")).isEmpty())
    }

    @Test
    fun policy_onlyExisting_andDedup() {
        val r = ModelPolicy.retiredDirsToDelete(manifest("models/a", "models/b", "models/a"), setOf("models/a"))
        assertEquals(listOf("models/a"), r)
    }

    @Test
    fun policy_skipsLiveEntryDir() {
        val r = ModelPolicy.retiredDirsToDelete(manifest("models/m1", "models/a"), setOf("models/m1", "models/a"))
        assertEquals(listOf("models/a"), r)
    }

    @Test
    fun policy_rejectsMaliciousPaths() {
        val evil = listOf("", "models/", "models", "/models/a", "models/../a", "models/a/b", "models\\a", "models/.", "models/..", "models/.hidden", "../models/a", "/etc", "C:\\x")
        val m = manifest(*evil.toTypedArray())
        assertTrue(ModelPolicy.retiredDirsToDelete(m, evil.toSet()).isEmpty())
    }

    @Test
    fun cleaner_deletesViaFs_andSwallowsFailures() {
        val fs = object : RetiredFs {
            val deleted = mutableListOf<String>()
            override fun existingDirs() = setOf("models/a", "models/b", "models/c")
            override fun delete(dir: String): Boolean {
                if (dir == "models/a") throw IllegalStateException("boom")
                deleted += dir
                return dir != "models/c"
            }
        }
        val out = ModelRetiredCleaner.run(manifest("models/a", "models/b", "models/c"), fs)
        assertEquals(listOf("models/b"), out)
    }

    @Test
    fun cleaner_existingDirsThrows_doesNotThrow() {
        val fs = object : RetiredFs {
            override fun existingDirs(): Set<String> = throw IllegalStateException("x")
            override fun delete(dir: String) = true
        }
        assertTrue(ModelRetiredCleaner.run(manifest("models/a"), fs).isEmpty())
    }

    @Test
    fun fileFs_deletesOnlyUnderModelsRoot() {
        val files = tmp.newFolder("files")
        val old = File(files, "models/old").apply { mkdirs() }
        File(old, "x.bin").writeText("1")
        val outside = File(files, "keep").apply { mkdirs() }
        val fs = FileRetiredFs(files)
        assertEquals(setOf("models/old"), fs.existingDirs())
        assertFalse(fs.delete("models/../keep"))
        assertTrue(outside.exists())
        assertFalse(fs.delete("models/old/sub"))
        assertTrue(fs.delete("models/old"))
        assertFalse(old.exists())
    }

    /** 尝试建符号链接；没权限（Windows 普通用户）时跳过用例 */
    private fun linkOrSkip(link: File, target: File) {
        try {
            java.nio.file.Files.createSymbolicLink(link.toPath(), target.toPath())
        } catch (e: Exception) {
            Assume.assumeNoException("本机不能建符号链接，跳过", e)
        }
    }

    @Test
    fun fileFs_symlinkToLiveModel_removesOnlyTheLink() {
        val files = tmp.newFolder("files")
        val live = File(files, "models/m1").apply { mkdirs() }
        File(live, "m.bin").writeText("1")
        linkOrSkip(File(files, "models/old"), live)
        val fs = FileRetiredFs(files, setOf("models/m1"))
        assertTrue(fs.delete("models/old"))
        assertFalse(File(files, "models/old").exists())
        assertTrue("现行模型不能被连带删除", File(live, "m.bin").exists())
    }

    @Test
    fun fileFs_symlinkInsideOldDir_notFollowed() {
        val files = tmp.newFolder("files")
        val keep = tmp.newFolder("keep")
        File(keep, "k.txt").writeText("1")
        val old = File(files, "models/old").apply { mkdirs() }
        linkOrSkip(File(old, "inner"), keep)
        assertTrue(FileRetiredFs(files).delete("models/old"))
        assertFalse(old.exists())
        assertTrue("子目录里的链接只删链接，不钻进去", File(keep, "k.txt").exists())
    }

    @Test
    fun fileFs_liveDir_refused() {
        val files = tmp.newFolder("files")
        File(files, "models/m1").apply { mkdirs() }
        assertFalse(FileRetiredFs(files, setOf("models/m1")).delete("models/m1"))
        assertTrue(File(files, "models/m1").exists())
    }

    /** M9：随包清单把四个旧 ONNX 时代目录退役；另有 1024 版 BiRefNet 实验模型（真机内存峰值约 5.2GB）也已退役；均不与现行模型目录重名 */
    @Test
    fun shippedManifest_retiresOldOnnxDirs() {
        val m = ModelManifestParser.parse(File("src/main/assets/ai/models.json").readText())
        val expected = setOf("siglip2-q4_half", "nllb600m-un6-ccm-int4", "asr-zipformer-zh-en-int8", "ppocrv5-mnn-fp16", "matting-birefnet-lite-mnn-w8")
        assertEquals(expected, m.retired.map { it.id }.toSet())
        assertTrue(m.retired.all { it.dir == "models/${it.id}" })
        assertTrue(m.models.none { it.id in expected || it.dir in m.retired.map { r -> r.dir } })
    }
}
