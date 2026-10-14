package com.let188.arkli.image

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.files.FileConst
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.OutputStream

/** 拼接用的画布，持有原生位图，用完必须 [close] */
interface StitchCanvas : AutoCloseable {
    /**
     * 解码一张图并缩放绘制到矩形里，绘制完立即回收那张图的位图。
     *
     * @param file 源图文件
     * @param rect 目标矩形
     */
    fun draw(file: File, rect: StitchRect)

    /**
     * 把整张画布编码写出，不在内存里再放一份整幅像素。PNG 边压边写（走 [PngTuning.FAST]，无损），
     * 目标文件随编码增长；JPEG 由系统编码器一次写完。
     *
     * @param out 目标流，不负责关闭
     * @param format PNG（无损）或 JPEG
     * @param quality JPEG 质量 1..100，PNG 忽略
     * @param check 协作式取消点
     * @param onRow 编码进度：已完成行数与总行数；JPEG 只在结束时回调一次
     */
    fun writeTo(out: OutputStream, format: OutFormat, quality: Int, check: () -> Unit, onRow: (done: Int, total: Int) -> Unit)

    /**
     * 生成缩略图（JPEG 字节）。
     *
     * @param maxEdge 最长边
     * @param quality JPEG 质量 1..100
     * @return JPEG 字节
     */
    fun thumbnail(maxEdge: Int, quality: Int): ByteArray

    /** 释放位图，可重复调用 */
    override fun close()
}

/** 拼接所需的平台能力，抽出来便于 JVM 单测注入假实现 */
interface StitchBackend {
    /**
     * 读取按 EXIF 摆正后的尺寸，不解码像素。
     *
     * @param file 源图
     * @return 摆正后的宽高
     * @throws BridgeException 无法识别该图片（INTERNAL）
     */
    fun probe(file: File): ImageMath.Size

    /**
     * 新建画布并铺满底色。
     *
     * @param width 宽
     * @param height 高
     * @param bg 不透明 ARGB 底色
     * @return 画布，由调用方关闭
     */
    fun newCanvas(width: Int, height: Int, bg: Int): StitchCanvas
}

/** 拼接进度回调，阶段见 [ImageConst.PHASE_DRAW] / [ImageConst.PHASE_ENCODE] / [ImageConst.PHASE_DONE] */
fun interface StitchProgress {
    /**
     * 上报一次进度。
     *
     * @param done 已完成的大步数（绘制 i 张为 i，编码完成为 total）
     * @param total 总步数，n 张图为 n+1
     * @param name 当前文件名
     * @param phase 阶段：draw / encode / done
     * @param percent 仅 encode 阶段有值：编码百分比 0..100（节流后上报）
     */
    fun onProgress(done: Int, total: Int, name: String, phase: String, percent: Int?)
}

/**
 * 进度节流：百分比每涨 [minStep] 个点，或距上次上报超过 [minIntervalMs] 且有进展，才放行；100 必放行，首次必放行。
 * 纯逻辑，时钟可注入，可在 JVM 单测。
 *
 * @param minStep 最小百分比步长
 * @param minIntervalMs 最小时间间隔（毫秒）
 * @param now 毫秒时钟
 */
class ProgressThrottle(
    private val minStep: Int = ImageConst.PROGRESS_MIN_STEP,
    private val minIntervalMs: Long = ImageConst.PROGRESS_MIN_INTERVAL_MS,
    private val now: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    /** 上次放行的百分比，-1 表示还没放行过 */
    private var lastPercent = -1

    /** 上次放行的时间 */
    private var lastTime = 0L

    /**
     * 判断这次百分比是否放行。
     *
     * @param percent 0..100
     * @return 放行返回 true
     */
    fun accept(percent: Int): Boolean {
        val t = now()
        val ok = when {
            lastPercent < 0 -> true
            percent <= lastPercent -> false
            percent >= PERCENT_MAX -> true
            percent - lastPercent >= minStep -> true
            else -> t - lastTime >= minIntervalMs
        }
        if (ok) {
            lastPercent = percent
            lastTime = t
        }
        return ok
    }

    private companion object {
        /** 百分比上限 */
        const val PERCENT_MAX = 100
    }
}

/**
 * 拼接结果。
 *
 * @property path 成品页面路径（`cache/out/stitch_<时间戳>.png|jpg`）
 * @property thumbPath 缩略图页面路径（最长边约 256 的 JPEG）
 * @property name 成品文件名
 * @property width 成品宽
 * @property height 成品高
 * @property size 成品字节数
 */
class StitchResult(val path: String, val thumbPath: String, val name: String, val width: Int, val height: Int, val size: Long) {
    /**
     * 转成协议返回值 `{ path, thumbPath, name, width, height, size }`。
     *
     * @return JSON 对象
     */
    fun toJson(): JSONObject = JSONObject().put("path", path).put("thumbPath", thumbPath).put("name", name)
        .put("width", width).put("height", height).put("size", size)
}

/**
 * 拼接流水线：探测尺寸、算布局、校验上限、逐张绘制、编码写出成品与缩略图。
 * 逐张解码绘制后立即回收，内存峰值约等于一张画布加一张解码图；取消或失败时清掉半成品。
 *
 * 使用示例：
 * ```
 * val r = ImageStitcher(AndroidStitchBackend(), outDir).run(plan, files) { done, total, name -> }
 * ```
 *
 * @param backend 平台实现
 * @param outDir 成品目录（调用方保证位于缓存根下）
 * @param outPagePrefix 成品页面路径前缀
 * @param dispatcher 干活的调度器
 * @param clock 时钟，用于文件名时间戳
 * @param log 分段耗时日志（探测、绘制、编码写盘、缩略图），默认不输出
 */
class ImageStitcher(
    private val backend: StitchBackend,
    private val outDir: File,
    private val outPagePrefix: String = ImageConst.OUT_PAGE_PREFIX,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val clock: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = {},
) {
    /**
     * 执行一次拼接。
     *
     * @param plan 已校验的计划
     * @param sources 与 plan.paths 一一对应的源文件
     * @param progress 进度回调，共 n+1 大步（n 张绘制 + 编码）；编码阶段另有节流后的百分比
     * @return 成品信息
     * @throws BridgeException 画布超限（BAD_PARAMS）、源图无法解码或写入失败（INTERNAL）
     * @throws CancellationException 被取消（已清理半成品）
     */
    suspend fun run(plan: StitchPlan, sources: List<File>, progress: StitchProgress): StitchResult = withContext(dispatcher) {
        require(plan.paths.size == sources.size) { "items 与源文件数量不符" }
        val ctx = currentCoroutineContext()
        val t0 = System.nanoTime()
        val sizes = sources.mapIndexed { i, f ->
            if (!f.isFile) throw BridgeException(BridgeErrors.BAD_PARAMS, "items[$i] 文件不存在")
            backend.probe(f)
        }
        val layout = StitchLayout.compute(sizes, plan.vertical, plan.gap, plan.unify, plan.align)
        checkLimits(layout)
        outDir.mkdirs()
        val t1 = System.nanoTime()
        val total = sources.size + 1
        val written = ArrayList<File>()
        try {
            backend.newCanvas(layout.width, layout.height, plan.bg).use { canvas ->
                for (i in sources.indices) {
                    ctx.ensureActive()
                    try {
                        canvas.draw(sources[i], layout.items[i])
                    } catch (e: OutOfMemoryError) {
                        throw BridgeException(BridgeErrors.INTERNAL, "内存不足，请减少图片、开启统一宽度或调小间距后重试")
                    }
                    progress.onProgress(i + 1, total, sources[i].name, ImageConst.PHASE_DRAW, null)
                }
                ctx.ensureActive()
                val t2 = System.nanoTime()
                val id = uniqueId()
                val main = File(outDir, "${FileConst.OUT_STITCH_PREFIX}$id.${plan.format.ext}")
                val thumb = File(outDir, "${FileConst.OUT_STITCH_THUMB_PREFIX}$id.jpg")
                val throttle = ProgressThrottle()
                atomicWrite(main, written) { out ->
                    canvas.writeTo(out, plan.format, plan.quality, { ctx.ensureActive() }) { done, rows ->
                        val percent = (done.toLong() * PERCENT_FULL / rows).toInt()
                        if (throttle.accept(percent)) progress.onProgress(sources.size, total, main.name, ImageConst.PHASE_ENCODE, percent)
                    }
                }
                ctx.ensureActive()
                val t3 = System.nanoTime()
                atomicWrite(thumb, written) { out -> out.write(canvas.thumbnail(ImageConst.THUMB_EDGE, ImageConst.THUMB_QUALITY)) }
                progress.onProgress(total, total, main.name, ImageConst.PHASE_DONE, null)
                val t4 = System.nanoTime()
                log("拼接 ${layout.width}x${layout.height} ${plan.format.wire} 探测=${ms(t1 - t0)}ms 解码绘制=${ms(t2 - t1)}ms 编码写盘=${ms(t3 - t2)}ms 缩略图=${ms(t4 - t3)}ms 成品=${main.length()}B")
                StitchResult(
                    path = "$outPagePrefix/${main.name}",
                    thumbPath = "$outPagePrefix/${thumb.name}",
                    name = main.name,
                    width = layout.width,
                    height = layout.height,
                    size = main.length(),
                )
            }
        } catch (e: Throwable) {
            written.forEach { it.delete() }
            if (e is OutOfMemoryError) throw BridgeException(BridgeErrors.INTERNAL, "内存不足，请减少图片、开启统一宽度或调小间距后重试")
            throw e
        }
    }

    private companion object {
        /** 百分比满值 */
        const val PERCENT_FULL = 100
    }

    /** 纳秒转毫秒 */
    private fun ms(ns: Long): Long = ns / 1_000_000

    /** 校验画布边长与像素数，超出抛 BAD_PARAMS 并给出可操作的提示 */
    private fun checkLimits(layout: StitchLayoutResult) {
        val pixels = layout.width.toLong() * layout.height
        if (layout.width > ImageConst.STITCH_MAX_EDGE || layout.height > ImageConst.STITCH_MAX_EDGE || pixels > ImageConst.STITCH_MAX_PIXELS) {
            throw BridgeException(
                BridgeErrors.BAD_PARAMS,
                "拼接后画布 ${layout.width}x${layout.height}（约 ${pixels / 10_000} 万像素）超出上限，" +
                    "请减少图片、开启统一宽度/高度或调小间距",
            )
        }
    }

    /** 取一个目录里还没用过的时间戳 id；同一毫秒撞名时追加序号 */
    private fun uniqueId(): String {
        val base = clock().toString()
        var id = base
        var n = 0
        while (File(outDir, "${FileConst.OUT_STITCH_PREFIX}$id.png").exists() || File(outDir, "${FileConst.OUT_STITCH_PREFIX}$id.jpg").exists()) {
            id = "$base-${++n}"
        }
        return id
    }

    /** 先写 .part 再改名；成功后登记进 [written]，失败时删掉半成品 */
    private inline fun atomicWrite(target: File, written: MutableList<File>, write: (OutputStream) -> Unit) {
        val part = File(target.parentFile, target.name + ImageConst.PART_SUFFIX)
        written += part
        part.outputStream().buffered().use { write(it) }
        if (!part.renameTo(target)) throw BridgeException(BridgeErrors.INTERNAL, "写入成品失败")
        written.remove(part)
        written += target
    }
}
