package com.let188.arkli.image

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** 假编解码：按文件名查样本像素，有损编码的体积 = 像素数 * 质量 / 100 */
class FakeCodec(
    /** 文件名 -> (宽, 高, 像素) */
    private val images: Map<String, Triple<Int, Int, IntArray>>,
    /** 每次解码前的钩子，测试用来制造取消 */
    private val onDecode: (String) -> Unit = {},
) : ImageCodec {
    /** 假图 */
    class FakeImage(override val width: Int, override val height: Int, private val px: IntArray) : CodecImage {
        /** 是否已关闭 */
        var closed = false
        override fun toArgb(): IntArray = px.copyOf()
        override fun close() {
            closed = true
        }
    }

    /** 创建过的全部图，用来检查是否都被关闭 */
    val created = ArrayList<FakeImage>()

    override fun decode(file: File, maxEdge: Int?): CodecImage {
        onDecode(file.name)
        if (file.name.startsWith("bad")) throw BridgeException(BridgeErrors.INTERNAL, "无法解码")
        val (w, h, px) = images.getValue(file.name)
        return FakeImage(w, h, px).also { created.add(it) }
    }

    override fun scale(src: CodecImage, width: Int, height: Int): CodecImage {
        val px = src.toArgb()
        val out = IntArray(width * height) { i ->
            px[(i / width * src.height / height) * src.width + (i % width) * src.width / width]
        }
        return FakeImage(width, height, out).also { created.add(it) }
    }

    override fun encodeLossy(img: CodecImage, format: OutFormat, quality: Int): ByteArray =
        ByteArray(img.width * img.height * quality / 100 + 1)
}

/** 压缩流水线：批量、部分失败、取消清理、目标体积、PNG 两种模式 */
class ImageCompressorTest {
    /** 每个用例独立的临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 在临时目录里造源文件（内容随便） */
    private fun src(name: String, size: Int = 5000): File =
        File(tmp.root, "src").apply { mkdirs() }.let { File(it, name).apply { writeBytes(ByteArray(size)) } }

    /** 成品目录 */
    private val out get() = File(tmp.root, "out")

    /** 构造计划 */
    private fun plan(names: List<String>, build: JSONObject.() -> Unit = {}): CompressPlan {
        val arr = JSONArray()
        names.forEach { arr.put(JSONObject().put("path", "cache/pick/$it")) }
        return CompressPlan.parse(JSONObject().put("items", arr).put("format", "jpeg").apply(build))
    }

    /** 造 compressor；idGen 用计数器保证可预测 */
    private fun compressor(codec: ImageCodec): ImageCompressor {
        var n = 0
        return ImageCompressor(codec, out, dispatcher = Dispatchers.Unconfined, idGen = { "id${n++}" })
    }

    @Test
    fun batchSuccessWritesFilesAndReportsProgress() = runBlocking {
        val images = mapOf(
            "a.jpg" to Triple(100, 50, Samples.gradient(100, 50)),
            "b.jpg" to Triple(60, 40, Samples.gradient(60, 40)),
        )
        val codec = FakeCodec(images)
        val files = listOf(src("a.jpg", 9000), src("b.jpg", 4000))
        val events = ArrayList<Triple<Int, Int, String>>()
        val r = compressor(codec).run(plan(listOf("a.jpg", "b.jpg")), files) { d, t, n -> events.add(Triple(d, t, n)) }
        assertEquals(2, r.items.size)
        assertTrue(r.failed.isEmpty())
        val a = r.items[0]
        assertEquals("cache/out/a-id0.jpg", a.path)
        assertEquals("a.jpg", a.name)
        assertEquals("image/jpeg", a.mime)
        assertEquals(100, a.width)
        assertEquals(9000L, a.srcBytes)
        assertEquals(100 * 50 * 80 / 100 + 1L, a.bytes)
        assertEquals(a.bytes.toDouble() / 9000, a.ratio, 1e-9)
        assertTrue(File(out, "a-id0.jpg").isFile)
        assertEquals(listOf("a.jpg", "b.jpg"), events.map { it.third })
        assertEquals(listOf(1, 2), events.map { it.first })
        assertTrue(events.all { it.second == 2 })
        assertTrue(codec.created.all { it.closed })
        assertTrue(out.listFiles()!!.none { it.name.endsWith(".part") })
        // JSON 形状
        val j = r.toJson()
        assertEquals(2, j.getJSONArray("items").length())
        assertEquals(0, j.getJSONArray("failed").length())
        assertEquals(100, j.getJSONArray("items").getJSONObject(0).getInt("width"))
    }

    @Test
    fun partialFailureDoesNotStopOthers() = runBlocking {
        val codec = FakeCodec(mapOf("ok.jpg" to Triple(10, 10, Samples.gradient(10, 10))))
        val files = listOf(src("bad1.jpg"), src("ok.jpg"), File(tmp.root, "src/missing.jpg"))
        val p = plan(listOf("bad1.jpg", "ok.jpg", "missing.jpg"))
        val r = compressor(codec).run(p, files) { _, _, _ -> }
        assertEquals(1, r.items.size)
        assertEquals(listOf(0, 2), r.failed.map { it.index })
        assertEquals(BridgeErrors.INTERNAL, r.failed[0].code)
        assertEquals(BridgeErrors.BAD_PARAMS, r.failed[1].code)
        assertEquals("bad1.jpg", r.failed[0].name)
        assertEquals(2, r.toJson().getJSONArray("failed").length())
    }

    @Test
    fun displayNameDecidesOutputName() = runBlocking {
        val codec = FakeCodec(mapOf("x.jpg" to Triple(10, 10, Samples.gradient(10, 10))))
        val arr = JSONArray().put(JSONObject().put("path", "cache/pick/x.jpg").put("name", "../我的 照片:1.png"))
        val p = CompressPlan.parse(JSONObject().put("items", arr).put("format", "webp"))
        val r = compressor(codec).run(p, listOf(src("x.jpg"))) { _, _, _ -> }
        assertEquals("我的 照片_1.webp", r.items[0].name)
        assertEquals("cache/out/我的 照片_1-id0.webp", r.items[0].path)
        assertEquals("image/webp", r.items[0].mime)
    }

    @Test
    fun cancelRemovesAllOutputsAndPartials() {
        val names = listOf("a.jpg", "b.jpg", "c.jpg")
        val images = names.associateWith { Triple(20, 20, Samples.gradient(20, 20)) }
        val files = names.map { src(it) }
        var job: Job? = null
        val codec = FakeCodec(images) { if (it == "b.jpg") job!!.cancel() }
        var cancelled = false
        runBlocking {
            // 懒启动：先把 job 赋给外部变量，钩子里才拿得到
            val j = launch(Dispatchers.Unconfined, start = CoroutineStart.LAZY) {
                try {
                    compressor(codec).run(plan(names), files) { _, _, _ -> }
                } catch (e: CancellationException) {
                    cancelled = true
                    throw e
                }
            }
            job = j
            j.start()
            j.join()
        }
        assertTrue(cancelled)
        assertEquals("已写出的成品也要清掉", 0, out.listFiles()!!.size)
        assertTrue(codec.created.all { it.closed })
    }

    @Test
    fun maxEdgeScalesDown() = runBlocking {
        val codec = FakeCodec(mapOf("big.jpg" to Triple(400, 200, Samples.gradient(400, 200))))
        val p = plan(listOf("big.jpg")) { put("maxEdge", 100) }
        val r = compressor(codec).run(p, listOf(src("big.jpg"))) { _, _, _ -> }
        assertEquals(100, r.items[0].width)
        assertEquals(50, r.items[0].height)
        assertTrue(codec.created.all { it.closed })
    }

    @Test
    fun targetBytesPicksHighestQualityThatFits() = runBlocking {
        // 体积 = 10000 * q / 100 + 1 = 100q + 1；目标 4500 -> q=44
        val codec = FakeCodec(mapOf("t.jpg" to Triple(100, 100, Samples.gradient(100, 100))))
        val p = plan(listOf("t.jpg")) { put("targetBytes", 4500) }
        val r = compressor(codec).run(p, listOf(src("t.jpg", 99999))) { _, _, _ -> }
        assertEquals(4401L, r.items[0].bytes)
        assertEquals(true, r.items[0].targetReached)
        assertTrue(r.toJson().getJSONArray("items").getJSONObject(0).getBoolean("targetReached"))
    }

    @Test
    fun targetBytesUnreachableStillOutputsLowestQuality() = runBlocking {
        val codec = FakeCodec(mapOf("t.jpg" to Triple(100, 100, Samples.gradient(100, 100))))
        val p = plan(listOf("t.jpg")) { put("targetBytes", 10) }
        val r = compressor(codec).run(p, listOf(src("t.jpg"))) { _, _, _ -> }
        assertEquals(false, r.items[0].targetReached)
        assertEquals(101L, r.items[0].bytes)
    }

    @Test
    fun targetBytesCappedByQuality() = runBlocking {
        val codec = FakeCodec(mapOf("t.jpg" to Triple(100, 100, Samples.gradient(100, 100))))
        val p = plan(listOf("t.jpg")) { put("targetBytes", 1_000_000).put("quality", 30) }
        val r = compressor(codec).run(p, listOf(src("t.jpg"))) { _, _, _ -> }
        assertEquals(3001L, r.items[0].bytes)
    }

    /** 读回成品 PNG */
    private fun readOut(item: CompressedItem): ByteArray = File(out, item.path.substringAfterLast('/')).readBytes()

    @Test
    fun pngLosslessIconBecomesIndexedAndStaysIdentical() = runBlocking {
        val icon = Samples.icon(64)
        val codec = FakeCodec(mapOf("i.png" to Triple(64, 64, icon)))
        val p = plan(listOf("i.png")) { put("format", "png") }
        val r = compressor(codec).run(p, listOf(src("i.png"))) { _, _, _ -> }
        val png = readOut(r.items[0])
        assertEquals(3, Samples.colorType(png))
        val (_, _, px) = Samples.readBack(png)
        for (i in icon.indices) {
            if ((icon[i] ushr 24) == 0) assertEquals(0, px[i] ushr 24) else assertEquals(icon[i], px[i])
        }
        assertEquals("image/png", r.items[0].mime)
    }

    @Test
    fun pngLosslessNoiseStaysTrueColorAndIdentical() = runBlocking {
        val noise = Samples.noise(40, 40)
        val codec = FakeCodec(mapOf("n.png" to Triple(40, 40, noise)))
        val p = plan(listOf("n.png")) { put("format", "png") }
        val r = compressor(codec).run(p, listOf(src("n.png"))) { _, _, _ -> }
        val png = readOut(r.items[0])
        assertEquals(2, Samples.colorType(png))
        assertArrayEquals(noise, Samples.readBack(png).third)
    }

    @Test
    fun pngPaletteModeLimitsColorsAndShrinks() = runBlocking {
        val grad = Samples.photoLike(80, 60)
        val codec = FakeCodec(mapOf("g.png" to Triple(80, 60, grad)))
        val lossless = plan(listOf("g.png")) { put("format", "png") }
        val palette = plan(listOf("g.png")) {
            put("format", "png").put("png", JSONObject().put("mode", "palette").put("colors", 32).put("dither", true))
        }
        val c = compressor(codec)
        val a = c.run(lossless, listOf(src("g.png"))) { _, _, _ -> }.items[0]
        val b = c.run(palette, listOf(src("g.png"))) { _, _, _ -> }.items[0]
        val png = readOut(b)
        assertEquals(3, Samples.colorType(png))
        val colors = Samples.readBack(png).third.toSet()
        assertTrue("颜色数 ${colors.size}", colors.size <= 32)
        assertTrue("缩色 ${b.bytes} 应小于无损 ${a.bytes}", b.bytes < a.bytes)
    }

    @Test
    fun pngTooLargeFailsGracefully() = runBlocking {
        val codec = FakeCodec(mapOf("h.png" to Triple(5000, 4000, IntArray(1))))
        val p = plan(listOf("h.png")) { put("format", "png") }
        val r = compressor(codec).run(p, listOf(src("h.png"))) { _, _, _ -> }
        assertTrue(r.items.isEmpty())
        assertEquals(BridgeErrors.BAD_PARAMS, r.failed[0].code)
        assertFalse(out.listFiles()!!.any())
    }

    @Test
    fun stemOfSanitizes() {
        assertEquals("a", ImageCompressor.stemOf("a.jpg"))
        assertEquals("a.b", ImageCompressor.stemOf("a.b.png"))
        assertEquals("image", ImageCompressor.stemOf("..."))
        assertEquals("png", ImageCompressor.stemOf(".png"))
        assertEquals("image", ImageCompressor.stemOf("///"))
        assertEquals("b", ImageCompressor.stemOf("a/../b.png"))
        assertEquals(ImageConst.MAX_NAME_LEN, ImageCompressor.stemOf("x".repeat(500)).length)
    }
}
