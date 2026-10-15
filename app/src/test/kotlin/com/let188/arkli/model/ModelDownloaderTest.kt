package com.let188.arkli.model

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** 下载器：续传状态机、多源回退、重定向、校验、空间、取消，全部用假传输层 */
class ModelDownloaderTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 记录退避等待的时长，并且不真等 */
    private val sleeps = mutableListOf<Long>()

    /** 内容 20000 字节 */
    private val data = content(20_000)

    /** 目标目录 */
    private val dir get() = File(tmp.root, "models/m1")

    /** 造下载器，空间默认充足 */
    private fun downloader(t: FakeTransport, free: Long = Long.MAX_VALUE, loopback: Boolean = false) =
        ModelDownloader(t, { free }, { loopback }, { sleeps += it })

    /** 跑一次下载，返回进度序列 */
    private fun run(d: ModelDownloader, e: ModelEntry): List<Pair<Long, String>> {
        val seen = mutableListOf<Pair<Long, String>>()
        runBlocking { d.download(e, dir) { done, phase -> seen += done to phase } }
        return seen
    }

    /** 断言抛 [ModelDownloadException] 且码对 */
    private fun assertFails(code: ModelErrorCode, block: () -> Unit) {
        val e = assertThrows(ModelDownloadException::class.java) { block() }
        assertEquals(code, e.code)
    }

    @Test
    fun freshDownload_succeeds_withoutRangeAndNoLeftover() {
        val t = FakeTransport { _, h, _ -> serve(data, h) }
        val progress = run(downloader(t), entryOf(data))
        assertArrayEquals(data, File(dir, "m.bin").readBytes())
        assertFalse(File(dir, "m.bin.part").exists())
        assertEquals(1, t.count)
        assertFalse(t.requestHeaders[0].containsKey("Range"))
        assertEquals("identity", t.requestHeaders[0]["Accept-Encoding"])
        assertEquals(data.size.toLong(), progress.filter { it.second == "download" }.maxOf { it.first })
        assertEquals("verify", progress.first { it.second == "verify" }.second)
    }

    @Test
    fun resume_usesRangeFromPartLength() {
        dir.mkdirs()
        File(dir, "m.bin.part").writeBytes(data.copyOfRange(0, 7_000))
        val t = FakeTransport { _, h, _ -> serve(data, h) }
        run(downloader(t), entryOf(data))
        assertEquals("bytes=7000-", t.requestHeaders[0]["Range"])
        assertArrayEquals(data, File(dir, "m.bin").readBytes())
    }

    @Test
    fun serverIgnoresRange_restartsFromZero() {
        dir.mkdirs()
        File(dir, "m.bin.part").writeBytes(data.copyOfRange(0, 7_000))
        // 无视 Range，永远回 200 全量
        val t = FakeTransport { _, _, _ -> FakeResponse(200, mapOf("Content-Length" to data.size.toString()), data) }
        run(downloader(t), entryOf(data))
        assertEquals(1, t.count)
        assertArrayEquals(data, File(dir, "m.bin").readBytes())
    }

    @Test
    fun connectionDropsMidStream_retriesWithRangeAndBackoff() {
        val t = FakeTransport { _, h, i -> serve(data, h, failAfter = if (i == 0) 5_000 else null) }
        run(downloader(t), entryOf(data))
        assertEquals(2, t.count)
        assertEquals("bytes=5000-", t.requestHeaders[1]["Range"])
        assertEquals(listOf(ModelPolicy.backoffMs(0)), sleeps)
        assertArrayEquals(data, File(dir, "m.bin").readBytes())
    }

    @Test
    fun repeatedFailuresWithoutProgress_giveUpAfterMaxAttempts_withExponentialBackoff() {
        val t = FakeTransport { _, _, _ -> FakeResponse(503) }
        assertFails(ModelErrorCode.NETWORK) { run(downloader(t), entryOf(data)) }
        assertEquals(MAX_ATTEMPTS_PER_SOURCE, t.count)
        assertEquals(listOf(1_000L, 2_000L), sleeps)
    }

    @Test
    fun clientError_notRetried_andFallsBackToNextSource() {
        val bad = "https://$T_HOST/bad"
        val good = "https://$T_CDN/good"
        val t = FakeTransport { u, h, _ -> if (u.path == "/bad") FakeResponse(404) else serve(data, h) }
        run(downloader(t), entryOf(data, listOf(bad, good)))
        assertEquals(listOf(bad, good), t.urls)
        assertTrue(sleeps.isEmpty())
        assertArrayEquals(data, File(dir, "m.bin").readBytes())
    }

    @Test
    fun allSourcesFail_reportsLastError() {
        val t = FakeTransport { _, _, _ -> FakeResponse(404) }
        assertFails(ModelErrorCode.NETWORK) { run(downloader(t), entryOf(data, listOf(T_URL, "https://$T_CDN/x"))) }
        assertEquals(2, t.count)
    }

    @Test
    fun sourceNotInAllowList_isRejectedWithoutAnyRequest_thenFallsBack() {
        val t = FakeTransport { _, h, _ -> serve(data, h) }
        run(downloader(t), entryOf(data, listOf("https://evil.example.com/m.bin", T_URL)))
        assertEquals(listOf(T_URL), t.urls)
        File(dir, "m.bin").delete()
        val t2 = FakeTransport { _, h, _ -> serve(data, h) }
        assertFails(ModelErrorCode.SOURCE_REJECTED) { run(downloader(t2), entryOf(data, listOf("http://$T_HOST/m.bin"))) }
        assertEquals(0, t2.count)
    }

    @Test
    fun shaMismatch_deletesPart_andFails() {
        val wrong = content(data.size, seed = 99)
        val t = FakeTransport { _, h, _ -> serve(wrong, h) }
        assertFails(ModelErrorCode.HASH_MISMATCH) { run(downloader(t), entryOf(data)) }
        assertFalse(File(dir, "m.bin.part").exists())
        assertFalse(File(dir, "m.bin").exists())
        assertEquals(1, t.count)
    }

    @Test
    fun shaMismatchAfterResume_retriesOnceFromScratch() {
        dir.mkdirs()
        // 旧 .part 前缀是坏的：续传拼出来必然校验失败
        File(dir, "m.bin.part").writeBytes(ByteArray(7_000) { 1 })
        val t = FakeTransport { _, h, _ -> serve(data, h) }
        run(downloader(t), entryOf(data))
        assertEquals(2, t.count)
        assertEquals("bytes=7000-", t.requestHeaders[0]["Range"])
        assertFalse(t.requestHeaders[1].containsKey("Range"))
        assertArrayEquals(data, File(dir, "m.bin").readBytes())
    }

    @Test
    fun partAlreadyComplete_skipsNetworkAndJustVerifies() {
        dir.mkdirs()
        File(dir, "m.bin.part").writeBytes(data)
        val t = FakeTransport { _, h, _ -> serve(data, h) }
        run(downloader(t), entryOf(data))
        assertEquals(0, t.count)
        assertArrayEquals(data, File(dir, "m.bin").readBytes())
    }

    @Test
    fun range416_restartsFromZero() {
        dir.mkdirs()
        File(dir, "m.bin.part").writeBytes(data.copyOfRange(0, 7_000))
        val t = FakeTransport { _, h, _ -> if (rangeStart(h) > 0) FakeResponse(416) else serve(data, h) }
        run(downloader(t), entryOf(data))
        assertEquals(2, t.count)
        assertArrayEquals(data, File(dir, "m.bin").readBytes())
    }

    @Test
    fun oversizedPart_isDiscarded() {
        dir.mkdirs()
        File(dir, "m.bin.part").writeBytes(ByteArray(data.size + 10))
        val t = FakeTransport { _, h, _ -> serve(data, h) }
        run(downloader(t), entryOf(data))
        assertFalse(t.requestHeaders[0].containsKey("Range"))
        assertArrayEquals(data, File(dir, "m.bin").readBytes())
    }

    @Test
    fun serverSendsMoreThanManifest_isSizeMismatch() {
        val t = FakeTransport { _, _, _ -> FakeResponse(200, body = data + ByteArray(100)) }
        assertFails(ModelErrorCode.SIZE_MISMATCH) { run(downloader(t), entryOf(data)) }
    }

    @Test
    fun contentRangeTotalMismatch_isSizeMismatch() {
        dir.mkdirs()
        File(dir, "m.bin.part").writeBytes(data.copyOfRange(0, 7_000))
        val t = FakeTransport { _, _, _ -> FakeResponse(206, mapOf("Content-Range" to "bytes 7000-19999/99999"), data.copyOfRange(7_000, data.size)) }
        assertFails(ModelErrorCode.SIZE_MISMATCH) { run(downloader(t), entryOf(data)) }
    }

    @Test
    fun insufficientSpace_failsBeforeAnyRequest() {
        val t = FakeTransport { _, h, _ -> serve(data, h) }
        val need = ModelPolicy.requiredFreeBytes(data.size.toLong())
        assertFails(ModelErrorCode.NO_SPACE) { run(downloader(t, free = need - 1), entryOf(data)) }
        assertEquals(0, t.count)
        run(downloader(t, free = need), entryOf(data))
        assertEquals(1, t.count)
    }

    @Test
    fun spaceCheck_countsOnlyRemainingBytes() {
        dir.mkdirs()
        File(dir, "m.bin.part").writeBytes(data.copyOfRange(0, 19_000))
        val t = FakeTransport { _, h, _ -> serve(data, h) }
        // 只剩 1000 字节要下，1200 字节的余量就够
        run(downloader(t, free = 1_200), entryOf(data))
        assertEquals(1, t.count)
    }

    @Test
    fun redirect_followedAcrossAllowedHosts_withRelativeLocation() {
        val t = FakeTransport { u, h, _ ->
            when (u.path) {
                "/o/r/releases/download/v1/m.bin" -> FakeResponse(302, mapOf("Location" to "https://$T_CDN/blob/abc?sig=1"))
                "/blob/abc" -> FakeResponse(302, mapOf("Location" to "/real/abc"))
                else -> serve(data, h)
            }
        }
        run(downloader(t), entryOf(data))
        assertEquals(listOf(T_URL, "https://$T_CDN/blob/abc?sig=1", "https://$T_CDN/real/abc"), t.urls)
    }

    @Test
    fun redirect_toDisallowedHostOrScheme_isRejected_withoutRequestingIt() {
        listOf("https://evil.example.com/x", "http://$T_CDN/x", "https://user@$T_CDN/x", "https://$T_CDN:8443/x").forEach { loc ->
            val t = FakeTransport { _, _, _ -> FakeResponse(302, mapOf("Location" to loc)) }
            assertFails(ModelErrorCode.SOURCE_REJECTED) { run(downloader(t), entryOf(data)) }
            assertEquals("只应请求初始地址：$loc", 1, t.count)
        }
    }

    @Test
    fun redirect_loopBeyondMaxHops_isRejected() {
        val t = FakeTransport { _, _, _ -> FakeResponse(302, mapOf("Location" to "https://$T_CDN/again")) }
        assertFails(ModelErrorCode.SOURCE_REJECTED) { run(downloader(t), entryOf(data)) }
        assertEquals(MAX_REDIRECTS + 1, t.count)
    }

    @Test
    fun redirect_withoutLocation_isRejected() {
        val t = FakeTransport { _, _, _ -> FakeResponse(302) }
        assertFails(ModelErrorCode.SOURCE_REJECTED) { run(downloader(t), entryOf(data)) }
    }

    @Test
    fun loopbackHttp_onlyAllowedWhenSwitchedOn() {
        val local = "http://127.0.0.1:8765/m.bin"
        val off = FakeTransport { _, h, _ -> serve(data, h) }
        assertFails(ModelErrorCode.SOURCE_REJECTED) {
            runBlocking { downloader(off, loopback = false).download(entryOf(data), dir, { listOf(local) }) { _, _ -> } }
        }
        assertEquals(0, off.count)
        val on = FakeTransport { _, h, _ -> serve(data, h) }
        runBlocking { downloader(on, loopback = true).download(entryOf(data), dir, { listOf(local) }) { _, _ -> } }
        assertEquals(listOf(local), on.urls)
    }

    @Test
    fun existingValidTarget_isSkipped_andCorruptOneIsRedownloaded() {
        dir.mkdirs()
        File(dir, "m.bin").writeBytes(data)
        val t = FakeTransport { _, h, _ -> serve(data, h) }
        run(downloader(t), entryOf(data))
        assertEquals(0, t.count)
        // 长度对、内容坏
        File(dir, "m.bin").writeBytes(ByteArray(data.size) { 5 })
        run(downloader(t), entryOf(data))
        assertEquals(1, t.count)
        assertArrayEquals(data, File(dir, "m.bin").readBytes())
    }

    @Test
    fun cancel_keepsPart_thenNextRunResumes() {
        lateinit var job: kotlinx.coroutines.Job
        val t1 = FakeTransport { _, h, _ -> serve(data, h, onRead = { n -> if (n >= 6_000) job.cancel() }) }
        runBlocking {
            job = launch(Dispatchers.IO, start = kotlinx.coroutines.CoroutineStart.LAZY) {
                downloader(t1).download(entryOf(data), dir) { _, _ -> }
            }
            job.start()
            job.join()
        }
        val part = File(dir, "m.bin.part")
        assertTrue(part.exists())
        val kept = part.length()
        assertTrue("取消后应保留部分数据：$kept", kept in 1 until data.size)
        assertFalse(File(dir, "m.bin").exists())
        val t2 = FakeTransport { _, h, _ -> serve(data, h) }
        run(downloader(t2), entryOf(data))
        assertEquals("bytes=$kept-", t2.requestHeaders[0]["Range"])
        assertArrayEquals(data, File(dir, "m.bin").readBytes())
    }

    @Test
    fun multiFileModel_downloadsEachAndReportsModelLevelProgress() {
        val a = content(3_000, 1)
        val b = content(5_000, 2)
        val entry = ModelEntry(
            "mm", "多文件", "1", "models/mm", 8_000, null,
            listOf(
                ModelFile("a.bin", 3_000, sha256(a), null, listOf("https://$T_HOST/a")),
                ModelFile("b.bin", 5_000, sha256(b), null, listOf("https://$T_HOST/b")),
            ),
        )
        val t = FakeTransport { u, h, _ -> serve(if (u.path == "/a") a else b, h) }
        val seen = mutableListOf<Long>()
        val d = File(tmp.root, "models/mm")
        runBlocking { downloader(t).download(entry, d) { done, phase -> if (phase == "download") seen += done } }
        assertArrayEquals(a, File(d, "a.bin").readBytes())
        assertArrayEquals(b, File(d, "b.bin").readBytes())
        assertEquals(8_000L, seen.max())
        assertNotNull(seen.firstOrNull { it in 3_001..7_999 })
    }
}
