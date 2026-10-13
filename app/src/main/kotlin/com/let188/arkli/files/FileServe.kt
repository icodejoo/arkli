package com.let188.arkli.files

import java.io.File
import java.io.FileInputStream
import java.io.FilterInputStream
import java.io.InputStream

/** Range 请求头的解析结果 */
sealed interface RangeResult {
    /** 没有 Range、格式不认识或多段范围：按完整内容返回 200 */
    data object Full : RangeResult

    /**
     * 单段合法范围。
     *
     * @property start 起始字节（含）
     * @property end 结束字节（含）
     * @property fromEnd 是否后缀写法（`bytes=-N`，取最后 N 个字节）
     */
    data class Partial(val start: Long, val end: Long, val fromEnd: Boolean = false) : RangeResult

    /** 范围越界，应返回 416 */
    data object Unsatisfiable : RangeResult
}

/** HTTP Range 头解析，只支持单段 `bytes=` 范围 */
object RangeHeader {
    /** 范围头的单位前缀 */
    private const val UNIT = "bytes="

    /**
     * 解析 Range 头。
     *
     * @param header 原始头值，可为 null
     * @param length 文件总长度
     * @return 解析结果；`bytes=0-99`、`bytes=100-`、`bytes=-500` 三种写法均支持
     */
    fun parse(header: String?, length: Long): RangeResult {
        if (header == null || length <= 0) return RangeResult.Full
        val spec = header.trim()
        if (!spec.startsWith(UNIT, ignoreCase = true)) return RangeResult.Full
        val body = spec.substring(UNIT.length).trim()
        if (body.contains(',')) return RangeResult.Full
        val dash = body.indexOf('-')
        if (dash < 0) return RangeResult.Full
        val a = body.substring(0, dash).trim()
        val b = body.substring(dash + 1).trim()
        if (a.isEmpty() && b.isEmpty()) return RangeResult.Full
        if (!a.all { it in '0'..'9' } || !b.all { it in '0'..'9' }) return RangeResult.Full
        if (a.isEmpty()) {
            // 后缀范围：最后 n 个字节
            val n = b.toLongOrNull() ?: return RangeResult.Full
            if (n == 0L) return RangeResult.Unsatisfiable
            return RangeResult.Partial(maxOf(0L, length - n), length - 1, fromEnd = true)
        }
        val start = a.toLongOrNull() ?: return RangeResult.Unsatisfiable
        val end = if (b.isEmpty()) length - 1 else (b.toLongOrNull() ?: return RangeResult.Full)
        if (b.isNotEmpty() && end < start) return RangeResult.Full
        if (start >= length) return RangeResult.Unsatisfiable
        return RangeResult.Partial(start, minOf(end, length - 1))
    }
}

/**
 * 一次文件响应的计划：状态码、响应头、要读的文件与区间。纯数据，不碰 android.webkit。
 *
 * @property status HTTP 状态码（200/206/404/405/416）
 * @property headers 响应头（不含 Content-Type，由调用方按扩展名补）
 * @property file 要读的文件，没有正文（HEAD、错误响应）时为 null
 * @property start 读取起点
 * @property length 读取字节数
 * @property virtualPrefix 流开头要垫的虚拟字节数，见 [FileServe.plan] 的 webViewSkipsStart
 */
class ServePlan(
    val status: Int,
    val headers: Map<String, String>,
    val file: File?,
    val start: Long = 0,
    val length: Long = 0,
    val virtualPrefix: Long = 0,
)

/** 文件响应计划与读取 */
object FileServe {
    /** 响应头名：是否支持范围请求 */
    private const val H_ACCEPT_RANGES = "Accept-Ranges"

    /** 响应头名：正文长度 */
    private const val H_CONTENT_LENGTH = "Content-Length"

    /** 响应头名：返回的区间 */
    private const val H_CONTENT_RANGE = "Content-Range"

    /** 范围单位 */
    private const val BYTES = "bytes"

    /**
     * 按请求方法与 Range 头生成响应计划。
     *
     * @param file 已通过 [SafePath] 校验的文件；null 表示路径非法，按 404 处理
     * @param method 请求方法，只接受 GET/HEAD
     * @param rangeHeader 请求的 Range 头，可为 null
     * @param webViewSkipsStart 为 true 表示运行在 Chromium 的拦截响应层之下：它会对返回的流按 Range 起点
     *   再 skip 一次（实测 Chromium 114 对 `bytes=a-b`、`bytes=a-` 如此，对后缀 `bytes=-N` 不跳）。
     *   此时 206 计划带上 [ServePlan.virtualPrefix]，由 [FileServe.open] 返回自适应流消化这次 skip
     * @return 响应计划
     */
    fun plan(file: File?, method: String, rangeHeader: String?, webViewSkipsStart: Boolean = false): ServePlan {
        if (method != "GET" && method != "HEAD") return ServePlan(405, mapOf("Allow" to "GET, HEAD"), null)
        if (file == null || !file.isFile) return ServePlan(404, emptyMap(), null)
        val total = file.length()
        val head = method == "HEAD"
        return when (val r = RangeHeader.parse(rangeHeader, total)) {
            RangeResult.Full -> ServePlan(
                200,
                mapOf(H_ACCEPT_RANGES to BYTES, H_CONTENT_LENGTH to total.toString()),
                if (head) null else file, 0, total,
            )
            is RangeResult.Partial -> {
                val len = r.end - r.start + 1
                ServePlan(
                    206,
                    mapOf(
                        H_ACCEPT_RANGES to BYTES,
                        H_CONTENT_LENGTH to len.toString(),
                        H_CONTENT_RANGE to "bytes ${r.start}-${r.end}/$total",
                    ),
                    if (head) null else file, r.start, len,
                    virtualPrefix = if (webViewSkipsStart && !r.fromEnd) r.start else 0L,
                )
            }
            RangeResult.Unsatisfiable -> ServePlan(
                416, mapOf(H_ACCEPT_RANGES to BYTES, H_CONTENT_RANGE to "bytes */$total"), null,
            )
        }
    }

    /**
     * 打开计划里的文件区间。
     *
     * @param plan 响应计划
     * @return 只产出 `[start, start+length)` 的输入流；没有正文返回空流。调用方负责关闭
     */
    fun open(plan: ServePlan): InputStream {
        val file = plan.file ?: return EmptyStream
        val input = FileInputStream(file)
        try {
            var left = plan.start
            while (left > 0) {
                val n = input.skip(left)
                if (n <= 0) break
                left -= n
            }
        } catch (e: Exception) {
            input.close()
            throw e
        }
        return RangeStream(input, plan.length, plan.virtualPrefix)
    }

    /** 空输入流 */
    private object EmptyStream : InputStream() {
        /** 永远在末尾 */
        override fun read(): Int = -1
    }
}

/**
 * 限长输入流：最多产出 [limit] 字节，之后返回 -1。
 *
 * @param input 底层流
 * @param limit 最大字节数
 */
class BoundedInputStream(input: InputStream, private var limit: Long) : FilterInputStream(input) {
    /** 读一个字节，超出限长返回 -1 */
    override fun read(): Int {
        if (limit <= 0) return -1
        val b = super.read()
        if (b >= 0) limit--
        return b
    }

    /** 读一段，超出限长截断 */
    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (limit <= 0) return -1
        val n = super.read(b, off, minOf(len.toLong(), limit).toInt())
        if (n > 0) limit -= n
        return n
    }

    /** 不支持 mark */
    override fun markSupported(): Boolean = false
}

/**
 * 自适应的范围流：对外表现为 `[virtualLeft 个虚拟字节][limit 个真实字节]`。
 *
 * Chromium 拦截响应层会先对流 `skip(start)` 再读，所以流头垫 start 个虚拟字节，skip 只消耗虚拟前缀，
 * 之后读到的就是正确区间；如果某个 WebView 不 skip，第一次 read 时虚拟前缀作废，同样读到正确区间。
 *
 * @param input 已定位到区间起点的底层流
 * @param limit 区间真实字节数
 * @param virtualLeft 虚拟前缀字节数
 */
class RangeStream(private val input: InputStream, private var limit: Long, private var virtualLeft: Long) : InputStream() {
    /** 读一个字节；第一次 read 即放弃剩余的虚拟前缀 */
    override fun read(): Int {
        virtualLeft = 0
        if (limit <= 0) return -1
        val b = input.read()
        if (b >= 0) limit--
        return b
    }

    /** 读一段，超出区间截断 */
    override fun read(b: ByteArray, off: Int, len: Int): Int {
        virtualLeft = 0
        if (limit <= 0) return -1
        if (len == 0) return 0
        val n = input.read(b, off, minOf(len.toLong(), limit).toInt())
        if (n > 0) limit -= n
        return n
    }

    /** 优先消耗虚拟前缀，之后才真跳过 */
    override fun skip(n: Long): Long {
        if (n <= 0) return 0
        if (virtualLeft > 0) {
            val k = minOf(n, virtualLeft)
            virtualLeft -= k
            return k
        }
        val k = input.skip(minOf(n, limit))
        if (k > 0) limit -= k
        return k
    }

    /** 剩余可读字节数（含尚未消耗的虚拟前缀） */
    override fun available(): Int = minOf(Int.MAX_VALUE.toLong(), virtualLeft + limit).toInt()

    /** 关闭底层流 */
    override fun close() = input.close()
}
