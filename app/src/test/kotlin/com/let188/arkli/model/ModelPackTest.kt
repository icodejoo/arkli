package com.let188.arkli.model

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.Deflater
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** 数据包（zip 下载后解压）：清单解析、解压安全、下载器与管理器的行为 */
class ModelPackTest {
    /** 临时目录，充当 filesDir */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 管理器用的作用域 */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 两个解压文件的内容 */
    private val a = content(30_000, 3)
    private val b = content(5_000, 9)

    /** 目标目录 */
    private val dir get() = File(tmp.root, "models/p1")

    @After
    fun tearDown() = scope.cancel()

    /** 把条目按 deflate 打成 zip */
    private fun zipOf(vararg items: Pair<String, ByteArray>): ByteArray {
        val bos = ByteArrayOutputStream()
        ZipOutputStream(bos).use { z ->
            z.setLevel(Deflater.BEST_COMPRESSION)
            items.forEach { (n, d) ->
                z.putNextEntry(ZipEntry(n))
                z.write(d)
                z.closeEntry()
            }
        }
        return bos.toByteArray()
    }

    /** 标准压缩包 */
    private val zipBytes get() = zipOf("a.bin" to a, "b.bin" to b)

    /** 造数据包清单项，摘要按 [zip] 与解压内容计算 */
    private fun pack(zip: ByteArray = zipBytes): ModelEntry {
        val files = listOf(
            ModelFile("a.bin", a.size.toLong(), sha256(a), "data", emptyList()),
            ModelFile("b.bin", b.size.toLong(), sha256(b), "data", emptyList()),
        )
        val archive = ModelFile("p.zip", zip.size.toLong(), sha256(zip), "archive", listOf(T_URL))
        return ModelEntry("p1", "测试包", "1", "models/p1", files.sumOf { it.bytes }, null, files, archive)
    }

    /** 造下载器 */
    private fun downloader(t: FakeTransport, free: Long = Long.MAX_VALUE) = ModelDownloader(t, { free }, { false }, { })

    /** 跑一次下载，返回进度序列 */
    private fun run(d: ModelDownloader, e: ModelEntry): List<Pair<Long, String>> {
        val seen = mutableListOf<Pair<Long, String>>()
        runBlocking { d.download(e, dir) { done, phase -> seen += done to phase } }
        return seen
    }

    /** 断言抛 [ModelDownloadException] 且码对 */
    private fun assertFails(code: ModelErrorCode, block: () -> Unit) {
        assertEquals(code, assertThrows(ModelDownloadException::class.java) { block() }.code)
    }

    /** 清单 JSON：把 [mutate] 作用在数据包条目上 */
    private fun manifestJson(mutate: (JSONObject) -> Unit = {}): String {
        val e = pack()
        val o = JSONObject().put("id", e.id).put("displayName", e.displayName).put("version", "1").put("dir", e.dir)
            .put("kind", "pack").put("totalBytes", e.totalBytes)
            .put("archive", JSONObject().put("name", "p.zip").put("bytes", e.archive!!.bytes).put("sha256", e.archive!!.sha256).put("urls", JSONArray(listOf(T_URL))))
            .put("files", JSONArray(e.files.map { JSONObject().put("name", it.name).put("bytes", it.bytes).put("sha256", it.sha256) }))
        mutate(o)
        return JSONObject().put("schema", 1).put("models", JSONArray().put(o)).toString()
    }

    @Test
    fun manifest_parsesPack() {
        val m = ModelManifestParser.parse(manifestJson()).models.single()
        assertTrue(m.isPack)
        assertEquals("p.zip", m.archive!!.name)
        assertEquals(m.archive!!.bytes, m.downloadBytes)
        assertTrue(m.files.all { it.urls.isEmpty() })
    }

    @Test
    fun manifest_rejectsBadPacks() {
        val bad = listOf<(JSONObject) -> Unit>(
            { it.remove("archive") },
            { it.getJSONObject("archive").put("name", "p.tar") },
            { it.getJSONObject("archive").put("urls", JSONArray()) },
            { it.getJSONArray("files").getJSONObject(0).put("urls", JSONArray(listOf(T_URL))) },
            { it.getJSONObject("archive").put("name", "a.bin") },
            { it.put("kind", "zip") },
        )
        bad.forEachIndexed { i, m -> assertThrows("case $i", IllegalArgumentException::class.java) { ModelManifestParser.parse(manifestJson(m)) } }
        assertThrows(IllegalArgumentException::class.java) {
            ModelManifestParser.parse(manifestJson { it.remove("kind"); it.put("archive", JSONObject()) })
        }
    }

    @Test
    fun download_fetchesZipThenExtractsAndRemovesZip() {
        val z = zipBytes
        val t = FakeTransport { _, h, _ -> serve(z, h) }
        val progress = run(downloader(t), pack(z))
        assertArrayEquals(a, File(dir, "a.bin").readBytes())
        assertArrayEquals(b, File(dir, "b.bin").readBytes())
        assertFalse(File(dir, "p.zip").exists())
        assertFalse(File(dir, "a.bin.part").exists())
        assertEquals(1, t.count)
        assertTrue(progress.any { it.second == ModelPolicy.PHASE_UNPACK })
        assertEquals(z.size.toLong(), progress.maxOf { it.first })
    }

    @Test
    fun download_prePlacedZipSkipsNetwork() {
        val z = zipBytes
        dir.mkdirs()
        File(dir, "p.zip").writeBytes(z)
        val t = FakeTransport { _, _, _ -> error("不应发请求") }
        run(downloader(t), pack(z))
        assertEquals(0, t.count)
        assertArrayEquals(a, File(dir, "a.bin").readBytes())
    }

    @Test
    fun download_corruptPrePlacedZipIsRedownloaded() {
        val z = zipBytes
        dir.mkdirs()
        File(dir, "p.zip").writeBytes(ByteArray(z.size) { 1 })
        val t = FakeTransport { _, h, _ -> serve(z, h) }
        run(downloader(t), pack(z))
        assertEquals(1, t.count)
        assertArrayEquals(b, File(dir, "b.bin").readBytes())
    }

    @Test
    fun download_existingGoodFilesSkipZipEntirely() {
        val z = zipBytes
        dir.mkdirs()
        File(dir, "a.bin").writeBytes(a)
        File(dir, "b.bin").writeBytes(b)
        val t = FakeTransport { _, _, _ -> error("不应发请求") }
        run(downloader(t), pack(z))
        assertEquals(0, t.count)
    }

    @Test
    fun download_onlyMissingFileIsExtracted() {
        val z = zipBytes
        dir.mkdirs()
        File(dir, "a.bin").writeBytes(a)
        File(dir, "p.zip").writeBytes(z)
        run(downloader(FakeTransport { _, _, _ -> error("不应发请求") }), pack(z))
        assertArrayEquals(b, File(dir, "b.bin").readBytes())
    }

    @Test
    fun extract_rejectsExtraEntry() {
        val z = zipOf("a.bin" to a, "b.bin" to b, "evil.sh" to byteArrayOf(1))
        val t = FakeTransport { _, h, _ -> serve(z, h) }
        assertFails(ModelErrorCode.UNPACK_FAILED) { run(downloader(t), pack(z)) }
        assertFalse(File(dir, "a.bin").exists())
    }

    @Test
    fun extract_rejectsPathTraversalAndDirectories() {
        for (name in listOf("../a.bin", "sub/a.bin", "sub/")) {
            val z = zipOf(name to ByteArray(0), "b.bin" to b)
            val t = FakeTransport { _, h, _ -> serve(z, h) }
            assertFails(ModelErrorCode.UNPACK_FAILED) { run(downloader(t), pack(z)) }
        }
        assertFalse(File(tmp.root, "models/a.bin").exists())
    }

    @Test
    fun extract_rejectsMissingEntry() {
        val z = zipOf("a.bin" to a)
        val t = FakeTransport { _, h, _ -> serve(z, h) }
        assertFails(ModelErrorCode.UNPACK_FAILED) { run(downloader(t), pack(z)) }
    }

    @Test
    fun extract_rejectsContentThatDoesNotMatchManifestHash() {
        val bad = a.copyOf().also { it[0] = (it[0] + 1).toByte() }
        val z = zipOf("a.bin" to bad, "b.bin" to b)
        val t = FakeTransport { _, h, _ -> serve(z, h) }
        // 压缩包本身的摘要按坏包算，所以通过整体校验，由解压后的逐文件摘要拦下
        assertFails(ModelErrorCode.HASH_MISMATCH) { run(downloader(t), pack(z)) }
        assertFalse(File(dir, "a.bin").exists())
        assertFalse(File(dir, "a.bin.part").exists())
    }

    @Test
    fun extract_rejectsWrongLength() {
        val z = zipOf("a.bin" to a.copyOf(a.size - 1), "b.bin" to b)
        val t = FakeTransport { _, h, _ -> serve(z, h) }
        assertFails(ModelErrorCode.UNPACK_FAILED) { run(downloader(t), pack(z)) }
    }

    @Test
    fun download_noSpace_beforeAnyRequest() {
        val z = zipBytes
        val t = FakeTransport { _, h, _ -> serve(z, h) }
        assertFails(ModelErrorCode.NO_SPACE) { run(downloader(t, free = 10), pack(z)) }
        assertEquals(0, t.count)
    }

    @Test
    fun manager_snapshotUsesArchiveSizeAndInstalls() {
        val z = zipBytes
        val e = pack(z)
        val t = FakeTransport { _, h, _ -> serve(z, h) }
        val m = ModelManager(ModelManifest(listOf(e)), tmp.root, downloader(t), scope)
        assertEquals(ModelState.ABSENT, m.status("p1").state)
        assertEquals(z.size.toLong(), m.status("p1").totalBytes)
        m.ensure("p1")
        val deadline = System.currentTimeMillis() + 10_000
        while (m.status("p1").state != ModelState.INSTALLED && System.currentTimeMillis() < deadline) Thread.sleep(20)
        val s = m.status("p1")
        assertEquals(ModelState.INSTALLED, s.state)
        assertEquals(z.size.toLong(), s.downloadedBytes)
        assertEquals((a.size + b.size).toLong(), s.diskBytes)
        assertNull(s.errorCode)
    }

    @Test
    fun manager_prePlacedZipThenEnsureInstalls_removeCleansAll() {
        val z = zipBytes
        val e = pack(z)
        dir.mkdirs()
        File(dir, "p.zip").writeBytes(z)
        val m = ModelManager(ModelManifest(listOf(e)), tmp.root, downloader(FakeTransport { _, _, _ -> error("不应发请求") }), scope)
        assertEquals(z.size.toLong(), m.status("p1").downloadedBytes)
        m.ensure("p1")
        val deadline = System.currentTimeMillis() + 10_000
        while (m.status("p1").state != ModelState.INSTALLED && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertEquals(ModelState.INSTALLED, m.status("p1").state)
        File(dir, "p.zip").writeBytes(z) // 残留的压缩包也要被 remove 清掉
        runBlocking { m.remove("p1") }
        assertFalse(dir.exists())
    }

    @Test
    fun sources_listsArchiveOnly() {
        val s = ModelPolicy.sourcesJson(pack())
        val files = s.getJSONArray("files")
        assertEquals(1, files.length())
        assertEquals("p.zip", files.getJSONObject(0).getString("name"))
        assertNotNull(s.getJSONArray("releasePages"))
    }

    /** 随包清单里登记了语料包，目录与读取器约定一致，解压文件与读取器要的五个文件对得上 */
    @Test
    fun shippedManifest_hasCoupletCorpusPack() {
        val m = ModelManifestParser.parse(File("src/main/assets/ai/models.json").readText())
        val e = m.find(com.let188.arkli.corpus.COUPLET_CORPUS_MODEL_ID)!!
        assertTrue(e.isPack)
        assertEquals(com.let188.arkli.corpus.COUPLET_CORPUS_DIR, e.dir)
        assertEquals(setOf("lines.txt", "offsets.u32", "flags.u32", "pools.u32", "meta.json"), e.files.map { it.name }.toSet())
        assertTrue(e.archive!!.urls.single().endsWith("/couplet-corpus.zip"))
    }

    // ---- 普通模型的“单个 zip 包”安装（kind 缺省、带 archive）----

    /** 自转模型的 id，随包清单里必须全部是单包安装 */
    private val ownModelIds = listOf(
        "siglip2-mnn-w8", "nllb600m-un6-mnn-w6", "asr-zipformer-zh-en-mnn-w8", "ppocrv6-small-mnn-fp16",
        "couplet-gpt2-mnn-w6", "matting-modnet-mnn-fp32", "matting-u2netp-mnn-f16",
    )

    /** 把 [pack] 的条目改成不带 kind 的普通模型清单（单包安装） */
    private fun plainManifestJson(): String = manifestJson { it.remove("kind") }

    /** 轮询到管理器进入 [want] 状态，最多等 10 秒 */
    private fun awaitState(m: ModelManager, want: ModelState) {
        val deadline = System.currentTimeMillis() + 10_000
        while (m.status("p1").state != want && System.currentTimeMillis() < deadline) Thread.sleep(20)
    }

    @Test
    fun manifest_plainModelWithArchiveIsSinglePackage() {
        val m = ModelManifestParser.parse(plainManifestJson()).models.single()
        assertTrue(m.isPack)
        assertEquals("p.zip", m.archive!!.name)
        assertTrue(m.files.all { it.urls.isEmpty() })
    }

    @Test
    fun manifest_legacyFilesFormatStillParses() {
        val e = entryOf(content(1000))
        val o = JSONObject().put("id", e.id).put("displayName", "旧").put("version", "1").put("dir", e.dir).put("totalBytes", e.totalBytes)
            .put("files", JSONArray(e.files.map { JSONObject().put("name", it.name).put("bytes", it.bytes).put("sha256", it.sha256).put("urls", JSONArray(it.urls)) }))
        val m = ModelManifestParser.parse(JSONObject().put("schema", 1).put("models", JSONArray().put(o)).toString()).models.single()
        assertFalse(m.isPack)
        assertNull(m.archive)
    }

    @Test
    fun manifest_archiveMustBeObjectAndZip() {
        assertThrows(IllegalArgumentException::class.java) { ModelManifestParser.parse(manifestJson { it.remove("kind"); it.put("archive", "x") }) }
        assertThrows(IllegalArgumentException::class.java) { ModelManifestParser.parse(manifestJson { it.remove("kind"); it.getJSONObject("archive").put("name", "p.tar") }) }
    }

    @Test
    fun shippedManifest_ownModelsAreAllSinglePackage() {
        val m = ModelManifestParser.parse(File("src/main/assets/ai/models.json").readText())
        ownModelIds.forEach { id ->
            val e = m.find(id) ?: error("清单缺 $id")
            assertTrue("$id 应是单包安装", e.isPack)
            assertTrue("$id 的包名应为 <id>-<version>.zip", e.archive!!.name == "$id-${e.version}.zip")
            assertTrue("$id 解压文件不应带 urls", e.files.all { it.urls.isEmpty() })
        }
    }

    @Test
    fun sources_singlePackageCarriesUnpackedInfo() {
        val s = ModelPolicy.sourcesJson(ModelManifestParser.parse(plainManifestJson()).models.single())
        assertEquals("zip", s.getString("format"))
        assertEquals((a.size + b.size).toLong(), s.getLong("unpackedBytes"))
        assertEquals(2, s.getInt("entryCount"))
        assertEquals(1, s.getJSONArray("files").length())
    }

    @Test
    fun legacyInstalledLayout_staysInstalledUnderSinglePackageManifest() {
        val z = zipBytes
        val legacy = ModelEntry("p1", "旧", "1", "models/p1", (a.size + b.size).toLong(), null, listOf(
            ModelFile("a.bin", a.size.toLong(), sha256(a), "data", listOf("$T_URL/a.bin")),
            ModelFile("b.bin", b.size.toLong(), sha256(b), "data", listOf("$T_URL/b.bin")),
        ))
        val t1 = FakeTransport { u, h, _ -> serve(if (u.path.endsWith("a.bin")) a else b, h) }
        val m1 = ModelManager(ModelManifest(listOf(legacy)), tmp.root, downloader(t1), scope)
        m1.ensure("p1")
        awaitState(m1, ModelState.INSTALLED)
        assertEquals(ModelState.INSTALLED, m1.status("p1").state)
        // 换成单包清单后，已装的旧布局不重下、仍就绪
        val t2 = FakeTransport { _, _, _ -> error("不应发请求") }
        val m2 = ModelManager(ModelManifest(listOf(pack(z))), tmp.root, downloader(t2), scope)
        assertEquals(ModelState.INSTALLED, m2.status("p1").state)
        m2.ensure("p1")
        assertEquals(0, t2.count)
    }

    @Test
    fun ensureTwice_isIdempotent() {
        val z = zipBytes
        val t = FakeTransport { _, h, _ -> serve(z, h) }
        val m = ModelManager(ModelManifest(listOf(pack(z))), tmp.root, downloader(t), scope)
        m.ensure("p1")
        awaitState(m, ModelState.INSTALLED)
        m.ensure("p1")
        assertEquals(ModelState.INSTALLED, m.status("p1").state)
        assertEquals(1, t.count)
        assertFalse(File(dir, "p.zip").exists())
    }

    @Test
    fun download_resumesPartialZipThenUnpacks() {
        val z = zipBytes
        dir.mkdirs()
        File(dir, "p.zip.part").writeBytes(z.copyOf(z.size / 2))
        val ranges = mutableListOf<Long>()
        val t = FakeTransport { _, h, _ -> ranges += rangeStart(h); serve(z, h) }
        run(downloader(t), pack(z))
        assertEquals(listOf((z.size / 2).toLong()), ranges)
        assertArrayEquals(a, File(dir, "a.bin").readBytes())
        assertFalse(File(dir, "p.zip.part").exists())
    }

    @Test
    fun extract_cancelMidwayLeavesNoPartFiles() {
        val z = zipBytes
        dir.mkdirs()
        val zip = File(dir, "p.zip").also { it.writeBytes(z) }
        var calls = 0
        assertThrows(kotlinx.coroutines.CancellationException::class.java) {
            PackExtractor.extract(zip, dir, pack(z).files, setOf("a.bin", "b.bin")) { ++calls < 3 }
        }
        assertTrue(dir.listFiles()!!.none { it.name.endsWith(".part") })
        // 取消后下一次完整解压仍能成功（会话不残留）
        PackExtractor.extract(zip, dir, pack(z).files, setOf("a.bin", "b.bin"))
        assertArrayEquals(b, File(dir, "b.bin").readBytes())
    }

    @Test
    fun download_noSpaceForUnpackedFiles_failsBeforeUnpack() {
        val z = zipBytes
        dir.mkdirs()
        File(dir, "p.zip").writeBytes(z)
        // 包已在盘上，只差解压空间：空闲不足解压后总字节时直接 NO_SPACE
        assertFails(ModelErrorCode.NO_SPACE) { run(downloader(FakeTransport { _, _, _ -> error("不应发请求") }, free = 100), pack(z)) }
        assertFalse(File(dir, "a.bin").exists())
    }

    @Test
    fun sweepResidue_removesUnpackFragmentsAndKeepsResumableZip() {
        val z = zipBytes
        val m = ModelManager(ModelManifest(listOf(pack(z))), tmp.root, downloader(FakeTransport { _, _, _ -> error("不应发请求") }), scope)
        dir.mkdirs()
        File(dir, "p.zip").writeBytes(z)
        File(dir, "a.bin.part").writeBytes(ByteArray(10))
        File(dir, "p.zip.part").writeBytes(ByteArray(5))
        // 未就绪：只清解压碎片，压缩包与 .zip.part 留给续传
        assertEquals(listOf("p1/a.bin.part"), m.sweepResidue())
        assertTrue(File(dir, "p.zip").exists() && File(dir, "p.zip.part").exists())
        // 就绪后：遗留的压缩包也清掉
        m.ensure("p1")
        awaitState(m, ModelState.INSTALLED)
        File(dir, "p.zip").writeBytes(z)
        File(dir, "b.bin.part").writeBytes(ByteArray(3))
        assertEquals(setOf("p1/p.zip", "p1/p.zip.part", "p1/b.bin.part"), m.sweepResidue().toSet())
        assertEquals(ModelState.INSTALLED, m.status("p1").state)
    }
}
