package com.let188.arkli.image

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.ReplyIo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.OutputStream

/** 拼接流水线与处理器测试：假后端，不碰 Android */
@OptIn(ExperimentalCoroutinesApi::class)
class ImageStitcherTest {
    /** 每个用例独立的临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 假画布：记录绘制与关闭 */
    private class FakeCanvas(val w: Int, val h: Int, val log: MutableList<String>, val onDraw: () -> Unit) : StitchCanvas {
        /** 是否已关闭 */
        var closed = false

        override fun draw(file: File, rect: StitchRect) {
            onDraw()
            log += "draw ${file.name} $rect"
        }

        override fun writeTo(out: OutputStream, format: OutFormat, quality: Int, check: () -> Unit, onRow: (Int, Int) -> Unit) {
            check()
            out.write(ByteArray(w * h) { 1 })
            for (y in 1..h) onRow(y, h)
            log += "write ${format.wire} q=$quality"
        }

        override fun thumbnail(maxEdge: Int, quality: Int): ByteArray = ByteArray(3)

        override fun close() {
            closed = true
        }
    }

    /** 假后端：按文件名给尺寸，名字以 bad 开头的无法识别 */
    private class FakeBackend(val dims: Map<String, ImageMath.Size>, val onDraw: () -> Unit = {}) : StitchBackend {
        /** 操作日志 */
        val log = ArrayList<String>()

        /** 创建的画布 */
        val canvases = ArrayList<FakeCanvas>()

        override fun probe(file: File): ImageMath.Size {
            if (file.name.startsWith("bad")) throw BridgeException(BridgeErrors.INTERNAL, "无法解码")
            return dims.getValue(file.name)
        }

        override fun newCanvas(width: Int, height: Int, bg: Int): StitchCanvas =
            FakeCanvas(width, height, log, onDraw).also { canvases += it }
    }

    /** 造源文件 */
    private fun src(vararg names: String): List<File> = names.map { tmp.newFile(it) }

    /** 造计划 */
    private fun plan(n: Int, format: String = "png", extra: JSONObject.() -> Unit = {}): StitchPlan = StitchPlan.parse(
        JSONObject().put("items", JSONArray().apply { repeat(n) { put(JSONObject().put("path", "cache/pick/$it")) } })
            .put("direction", "v").put("format", format).apply(extra),
    )

    /** 无进度 */
    private val noProgress = StitchProgress { _, _, _, _, _ -> }

    /** 输出目录 */
    private val out get() = File(tmp.root, "out")

    /** 同步跑一次并取抛出的 BridgeException */
    private fun failure(st: ImageStitcher, plan: StitchPlan, files: List<File>): BridgeException =
        runCatching { runBlocking { st.run(plan, files, noProgress) } }.exceptionOrNull() as BridgeException

    @Test
    fun writesMainAndThumbWithNamesAndResult() = runBlocking {
        val backend = FakeBackend(mapOf("a" to ImageMath.Size(100, 50), "b" to ImageMath.Size(100, 30)))
        val st = ImageStitcher(backend, out, dispatcher = Dispatchers.Unconfined, clock = { 1700000000000L })
        val r = st.run(plan(2) { put("gap", 10) }, src("a", "b"), noProgress)
        assertEquals("cache/out/stitch_1700000000000.png", r.path)
        assertEquals("cache/out/stitch_thumb_1700000000000.jpg", r.thumbPath)
        assertEquals("stitch_1700000000000.png", r.name)
        assertEquals(100, r.width)
        assertEquals(90, r.height)
        assertEquals(9000L, r.size)
        assertTrue(File(out, "stitch_1700000000000.png").isFile)
        assertEquals(3L, File(out, "stitch_thumb_1700000000000.jpg").length())
        assertTrue(out.list()!!.none { it.endsWith(".part") })
        assertTrue(backend.canvases[0].closed)
        // 同一毫秒再来一次不覆盖
        val r2 = st.run(plan(2), listOf(File(tmp.root, "a"), File(tmp.root, "b")), noProgress)
        assertTrue(r2.path != r.path)
        assertTrue(File(out, "stitch_1700000000000.png").isFile)
    }

    @Test
    fun jpegUsesJpgExtAndQuality() = runBlocking {
        val backend = FakeBackend(mapOf("a" to ImageMath.Size(10, 10), "b" to ImageMath.Size(10, 10)))
        val r = ImageStitcher(backend, out, dispatcher = Dispatchers.Unconfined).run(plan(2, "jpeg") { put("quality", 0.8) }, src("a", "b"), noProgress)
        assertTrue(r.name.endsWith(".jpg"))
        assertTrue(backend.log.contains("write jpeg q=80"))
    }

    @Test
    fun reportsProgressForEachDrawAndEncode() = runBlocking {
        val backend = FakeBackend(mapOf("a" to ImageMath.Size(10, 10), "b" to ImageMath.Size(10, 10)))
        val seen = ArrayList<Pair<Int, Int>>()
        ImageStitcher(backend, out, dispatcher = Dispatchers.Unconfined).run(plan(2), src("a", "b")) { d, t, _, phase, _ ->
            if (phase != ImageConst.PHASE_ENCODE) seen += d to t
        }
        assertEquals(listOf(1 to 3, 2 to 3, 3 to 3), seen)
    }

    @Test
    fun encodePhaseReportsThrottledPercentBetweenDrawAndDone() = runBlocking {
        // 画布高 1000 行，假画布每行回调一次：节流（步长 2 个百分点）后应是 0 起、单调递增、以 100 收尾的有限几十条
        val backend = FakeBackend(mapOf("a" to ImageMath.Size(1, 500), "b" to ImageMath.Size(1, 500)))
        val events = ArrayList<Triple<String, Int, Int?>>()
        ImageStitcher(backend, out, dispatcher = Dispatchers.Unconfined).run(plan(2), src("a", "b")) { d, t, _, phase, pct ->
            events += Triple(phase, d, pct)
            assertEquals(3, t)
        }
        val enc = events.filter { it.first == ImageConst.PHASE_ENCODE }
        assertTrue(enc.isNotEmpty() && enc.size <= 60)
        assertEquals(enc.map { it.third }.sortedBy { it }, enc.map { it.third })
        assertEquals(100, enc.last().third)
        assertTrue(enc.all { it.second == 2 })
        assertEquals(listOf(ImageConst.PHASE_DRAW, ImageConst.PHASE_DRAW), events.take(2).map { it.first })
        assertEquals(Triple(ImageConst.PHASE_DONE, 3, null), events.last())
    }

    @Test
    fun oversizedCanvasRejectedBeforeAllocation() {
        val backend = FakeBackend(mapOf("a" to ImageMath.Size(10000, 10000), "b" to ImageMath.Size(10000, 10000)))
        val e = failure(ImageStitcher(backend, out, dispatcher = Dispatchers.Unconfined), plan(2), src("a", "b"))
        assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        assertTrue(e.message!!.contains("超出上限"))
        assertTrue(backend.canvases.isEmpty())
    }

    @Test
    fun edgeLimitAlsoRejects() {
        val backend = FakeBackend(mapOf("a" to ImageMath.Size(10, 20000), "b" to ImageMath.Size(10, 20000)))
        val e = failure(ImageStitcher(backend, out, dispatcher = Dispatchers.Unconfined), plan(2), src("a", "b"))
        assertEquals(BridgeErrors.BAD_PARAMS, e.code)
    }

    @Test
    fun undecodableSourceFailsWholeCallWithoutLeftovers() {
        val backend = FakeBackend(mapOf("a" to ImageMath.Size(10, 10)))
        val e = failure(ImageStitcher(backend, out, dispatcher = Dispatchers.Unconfined), plan(2), src("a", "bad1"))
        assertEquals(BridgeErrors.INTERNAL, e.code)
        assertTrue(out.list().orEmpty().isEmpty())
    }

    @Test
    fun missingSourceIsBadParams() {
        val backend = FakeBackend(mapOf("a" to ImageMath.Size(10, 10)))
        val e = failure(ImageStitcher(backend, out, dispatcher = Dispatchers.Unconfined), plan(2), listOf(tmp.newFile("a"), File(tmp.root, "nope")))
        assertEquals(BridgeErrors.BAD_PARAMS, e.code)
    }

    @Test
    fun cancellationClosesCanvasAndCleansPartial() = runBlocking {
        lateinit var job: Job
        val backend = FakeBackend(mapOf("a" to ImageMath.Size(10, 10), "b" to ImageMath.Size(10, 10))) { job.cancel() }
        val st = ImageStitcher(backend, out, dispatcher = Dispatchers.Unconfined)
        var failure: Throwable? = null
        val files = src("a", "b")
        job = launch(Dispatchers.Unconfined, start = CoroutineStart.LAZY) {
            try {
                st.run(plan(2), files, noProgress)
            } catch (e: Throwable) {
                failure = e
            }
        }
        job.start()
        job.join()
        assertTrue(failure is CancellationException)
        assertTrue(backend.canvases[0].closed)
        assertTrue(out.list().orEmpty().isEmpty())
    }

    /** 收集响应的假通道 */
    private class Sink : ReplyIo {
        /** 响应列表 */
        val messages = mutableListOf<JSONObject>()
        override fun send(json: String) {
            messages += JSONObject(json)
        }
    }

    /** 经 Bridge 调一次 stitch，返回响应 */
    private fun callHandler(params: JSONObject, resolver: SourceResolver, main: Boolean = true): JSONObject {
        val backend = FakeBackend(mapOf("a" to ImageMath.Size(10, 10), "b" to ImageMath.Size(10, 10)))
        val sink = Sink()
        val bridge = ArkliBridge(1, sink, false, UnconfinedTestDispatcher())
        bridge.register(ImageModule.METHOD_STITCH, ImageStitchHandler(resolver, ImageStitcher(backend, out, dispatcher = Dispatchers.Unconfined)))
        bridge.dispatch(JSONObject().put("v", 2).put("id", "a").put("method", ImageModule.METHOD_STITCH).put("params", params).toString(), main)
        return sink.messages.first { it.optString("id") == "a" }
    }

    /** 造两项的 items */
    private fun items(vararg paths: String) = JSONArray().apply { paths.forEach { put(JSONObject().put("path", it)) } }

    @Test
    fun handlerRejectsWholeCallWhenAnyPathInvalid() {
        val a = tmp.newFile("a")
        val r = callHandler(
            JSONObject().put("items", items("cache/pick/ok", "cache/../../etc/passwd")).put("direction", "v"),
            { if (it == "cache/pick/ok") a else null },
        )
        assertEquals(BridgeErrors.BAD_PARAMS, r.getJSONObject("error").getString("code"))
        assertTrue(r.getJSONObject("error").getString("message").contains("items[1]"))
        assertTrue(out.list().orEmpty().isEmpty())
    }

    @Test
    fun handlerRejectsNonMainFrame() {
        val r = callHandler(JSONObject(), { null }, main = false)
        assertEquals(BridgeErrors.PERMISSION_DENIED, r.getJSONObject("error").getString("code"))
    }

    @Test
    fun handlerHappyPathReturnsContract() {
        val files = mapOf("cache/pick/a" to tmp.newFile("a"), "cache/pick/b" to tmp.newFile("b"))
        val r = callHandler(JSONObject().put("items", items("cache/pick/a", "cache/pick/b")).put("direction", "h"), { files[it] })
        assertFalse(r.has("error"))
        val data = r.getJSONObject("data")
        assertEquals(setOf("path", "thumbPath", "name", "width", "height", "size"), data.keys().asSequence().toSet())
        assertEquals(20, data.getInt("width"))
    }
}
