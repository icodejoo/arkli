package com.let188.arkli.spike

import android.os.Debug
import android.util.Base64
import android.util.Log
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** 二进制帧头长度：handle(4) + seq(4)，大端 */
const val FRAME_HEADER_BYTES = 8

/** 内存采样间隔（毫秒） */
private const val MEM_SAMPLE_MS = 10L

/** 错误码：参数错误 */
private const val ERR_BAD_PARAMS = "BAD_PARAMS"

/** 读文件算哈希的缓冲区大小 */
private const val HASH_BUF_BYTES = 256 * 1024

/** 下行测试数据填充规则：字节 i = (i*7+3) & 0xff，乘数 */
private const val PATTERN_MUL = 7

/** 下行测试数据填充规则：加数 */
private const val PATTERN_ADD = 3

/** 参数名：handle */
private const val KEY_HANDLE = "handle"

/** latin1 字符串帧的标记字符（U+0001），区别于 JSON 文本 */
const val LATIN1_MARK = "\u0001"

/** 纳秒转毫秒 */
private const val NS_PER_MS = 1_000_000L

/**
 * 一个正在写入的文件。
 *
 * @property file 目标文件
 * @property out 输出流
 */
private class WriteEntry(val file: File, val out: FileOutputStream) {
    /** 期望的下一个序号 */
    var expectSeq = 0

    /** 已写帧数 */
    var frames = 0

    /** 已写字节数 */
    var bytes = 0L

    /** 乱序或丢块计数 */
    var badSeq = 0
}

/**
 * spike 用的文件存储：按 handle 顺序追加，所有写操作串行在单线程上，保证帧序。
 *
 * @property dir 缓存目录
 */
class SpikeFileStore(private val dir: File) {

    /** 单线程写盘队列，同时作为协程调度器 */
    private val writeExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "spike-write") }

    /** 协程用的写盘调度器，与帧写入共用同一线程，FIFO 保序 */
    val writeDispatcher = writeExecutor.asCoroutineDispatcher()

    /** handle 到写入状态 */
    private val entries = ConcurrentHashMap<Int, WriteEntry>()

    /** handle 自增源 */
    private val nextHandle = AtomicInteger(1)

    /**
     * 打开一个待写文件。
     *
     * @param name 文件名（只取末段）
     * @return 新 handle
     */
    fun open(name: String): Int {
        dir.mkdirs()
        val h = nextHandle.getAndIncrement()
        val f = File(dir, "$h-${File(name).name}")
        entries[h] = WriteEntry(f, FileOutputStream(f))
        return h
    }

    /**
     * 追加一个数据块（须在写盘线程上调用）。
     *
     * @param handle 句柄
     * @param seq 块序号，必须连续
     * @param buf 数据缓冲
     * @param off 起始偏移
     * @param len 长度
     */
    fun append(handle: Int, seq: Int, buf: ByteArray, off: Int, len: Int) {
        val e = entries[handle] ?: return
        if (seq != e.expectSeq) e.badSeq++
        e.expectSeq = seq + 1
        e.out.write(buf, off, len)
        e.frames++
        e.bytes += len
    }

    /**
     * 解析二进制帧并投递到写盘队列，可在任意线程调用。
     *
     * @param frame 8 字节帧头加载荷
     * @param start 帧在数组中的起始偏移（latin1 字符串帧带 1 字节标记）
     * @return 帧是否合法
     */
    fun onFrame(frame: ByteArray, start: Int = 0): Boolean {
        if (frame.size - start < FRAME_HEADER_BYTES) return false
        val bb = ByteBuffer.wrap(frame, start, FRAME_HEADER_BYTES)
        val handle = bb.int
        val seq = bb.int
        val off = start + FRAME_HEADER_BYTES
        writeExecutor.execute { append(handle, seq, frame, off, frame.size - off) }
        return true
    }

    /**
     * 关闭文件，返回统计。
     *
     * @param handle 句柄
     * @return 路径、大小、帧数与乱序数
     */
    fun close(handle: Int): JSONObject {
        val e = entries[handle] ?: throw BridgeException(ERR_BAD_PARAMS, "无效 handle")
        e.out.close()
        return JSONObject().put("path", e.file.absolutePath).put("size", e.file.length())
            .put("frames", e.frames).put("badSeq", e.badSeq).put("bytes", e.bytes)
    }

    /**
     * 核对已落盘文件的内容是否符合填充规则。
     *
     * @param handle 句柄
     * @return 偏离字节数，0 表示完全一致
     */
    fun badBytes(handle: Int): Long {
        val e = entries[handle] ?: throw BridgeException(ERR_BAD_PARAMS, "无效 handle")
        return badBytesOf(e.file)
    }

    /**
     * 对已落盘文件做 sha256。
     *
     * @param handle 句柄
     * @return 十六进制摘要
     */
    fun sha256(handle: Int): String {
        val e = entries[handle] ?: throw BridgeException(ERR_BAD_PARAMS, "无效 handle")
        return sha256Of(e.file)
    }
}

/**
 * 统计文件中偏离填充规则的字节数。
 *
 * @param f 文件
 * @return 偏离字节数
 */
fun badBytesOf(f: File): Long {
    var bad = 0L
    var idx = 0L
    f.inputStream().use { ins ->
        val buf = ByteArray(HASH_BUF_BYTES)
        while (true) {
            val n = ins.read(buf)
            if (n < 0) break
            for (i in 0 until n) {
                if (buf[i] != (((idx + i) * PATTERN_MUL + PATTERN_ADD) and 0xff).toByte()) bad++
            }
            idx += n
        }
    }
    return bad
}

/**
 * 计算文件 sha256。
 *
 * @param f 文件
 * @return 十六进制摘要
 */
fun sha256Of(f: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    f.inputStream().use { ins ->
        val buf = ByteArray(HASH_BUF_BYTES)
        while (true) {
            val n = ins.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
}

/**
 * 内存采样器：后台线程定时记录 Java 堆、native 堆、进程 RSS 的峰值。
 */
class SpikeMemSampler {

    /** 采样线程 */
    private var thread: Thread? = null

    /** 运行标志 */
    @Volatile
    private var running = false

    /** Java 堆峰值 */
    @Volatile
    private var javaPeak = 0L

    /** native 堆峰值 */
    @Volatile
    private var nativePeak = 0L

    /** 进程 RSS 峰值（KB） */
    @Volatile
    private var rssPeakKb = 0L

    /** 起始基线 */
    private var base = JSONObject()

    /** 读 /proc/self/status 的 VmRSS（KB） */
    private fun rssKb(): Long = runCatching {
        File("/proc/self/status").useLines { ls ->
            ls.first { it.startsWith("VmRSS") }.filter { it.isDigit() }.toLong()
        }
    }.getOrDefault(0L)

    /** 当前 Java 堆已用字节 */
    private fun javaUsed(): Long = Runtime.getRuntime().let { it.totalMemory() - it.freeMemory() }

    /**
     * 开始采样并记下基线。
     *
     * @return 基线（MB）
     */
    fun begin(): JSONObject {
        System.gc()
        javaPeak = javaUsed()
        nativePeak = Debug.getNativeHeapAllocatedSize()
        rssPeakKb = rssKb()
        base = JSONObject().put("javaMb", mb(javaPeak)).put("nativeMb", mb(nativePeak))
            .put("rssMb", rssPeakKb / 1024.0)
        running = true
        thread = Thread {
            while (running) {
                javaPeak = maxOf(javaPeak, javaUsed())
                nativePeak = maxOf(nativePeak, Debug.getNativeHeapAllocatedSize())
                rssPeakKb = maxOf(rssPeakKb, rssKb())
                Thread.sleep(MEM_SAMPLE_MS)
            }
        }.also { it.start() }
        return base
    }

    /**
     * 停止采样。
     *
     * @return 基线与峰值（MB）
     */
    fun end(): JSONObject {
        running = false
        thread?.join()
        return JSONObject().put("base", base).put("javaPeakMb", mb(javaPeak))
            .put("nativePeakMb", mb(nativePeak)).put("rssPeakMb", rssPeakKb / 1024.0)
    }

    /** 字节转 MB，保留三位小数 */
    private fun mb(b: Long): Double = Math.round(b / 1048.576) / 1000.0
}

/**
 * 生成下行测试数据。
 *
 * @param size 字节数
 * @return 按固定规则填充的数组
 */
fun patternBytes(size: Int): ByteArray = ByteArray(size) { i -> ((i * PATTERN_MUL + PATTERN_ADD) and 0xff).toByte() }

/**
 * 需要 Activity/WebView 配合的动作。
 */
interface SpikeActions {
    /** 重载当前页面 */
    fun reload()

    /** 触发渲染进程崩溃 */
    fun crash()
}

/**
 * 注册 spike 全部处理器。
 *
 * @param bridge 目标 Bridge
 * @param store 文件存储
 * @param pubDir 经 PathHandler 暴露给页面的目录
 * @param features 能力探测结果
 * @param actions 需要 Activity 配合的动作
 * @param loop 回环 HTTP 上传原型服务
 */
fun registerSpikeHandlers(
    bridge: AsyncBridge,
    store: SpikeFileStore,
    pubDir: File,
    features: JSONObject,
    actions: SpikeActions,
    loop: SpikeLoopbackServer,
) {
    val mem = SpikeMemSampler()
    bridge.register("native.ping") { _, _ ->
        JSONObject().put("pong", true).put("ts", System.currentTimeMillis())
    }
    bridge.register("spike.hello") { ctx, _ ->
        JSONObject().put("session", ctx.session).put("features", features)
    }
    bridge.register("spike.log") { _, p ->
        Log.i(SPIKE_TAG, "page: ${p.optString("line")}")
        null
    }
    bridge.register("native.file.openWrite") { _, p ->
        JSONObject().put(KEY_HANDLE, store.open(p.optString("name", "f.bin")))
    }
    bridge.register("native.file.closeWrite") { _, p ->
        // 切到写盘线程，排在已投递的帧之后
        withContext(store.writeDispatcher) { store.close(p.optInt(KEY_HANDLE)) }
    }
    bridge.register("spike.file.sha") { _, p ->
        val t0 = System.nanoTime()
        val sha = withContext(store.writeDispatcher) { store.sha256(p.optInt(KEY_HANDLE)) }
        JSONObject().put("sha256", sha).put("hashMs", (System.nanoTime() - t0) / NS_PER_MS)
    }
    bridge.register("spike.file.writeB64") { _, p ->
        val bytes = Base64.decode(p.optString("data"), Base64.NO_WRAP)
        withContext(store.writeDispatcher) {
            store.append(p.optInt(KEY_HANDLE), p.optInt("seq"), bytes, 0, bytes.size)
        }
        JSONObject().put("n", bytes.size)
    }
    bridge.register("spike.down") { ctx, p ->
        val data = patternBytes(p.optInt("size"))
        ctx.io.sendBinary(data)
        JSONObject().put("n", data.size)
    }
    bridge.register("spike.downB64") { _, p ->
        JSONObject().put("b64", Base64.encodeToString(patternBytes(p.optInt("size")), Base64.NO_WRAP))
    }
    bridge.register("spike.downLatin1") { ctx, p ->
        // 字节按 ISO-8859-1 变成字符串，前缀 1 个标记字符，走纯文本消息
        ctx.io.sendJson(LATIN1_MARK + String(patternBytes(p.optInt("size")), Charsets.ISO_8859_1))
        JSONObject().put("n", p.optInt("size"))
    }
    bridge.register("spike.makeFile") { _, p ->
        val size = p.optInt("size")
        pubDir.mkdirs()
        val f = File(pubDir, p.optString("name", "f.bin"))
        withContext(store.writeDispatcher) { f.writeBytes(patternBytes(size)) }
        JSONObject().put("n", size)
    }
    bridge.register("spike.file.checkPattern") { _, p ->
        // 在写盘线程上逐字节核对填充规则，返回偏离的字节数
        val bad = withContext(store.writeDispatcher) { store.badBytes(p.optInt(KEY_HANDLE)) }
        JSONObject().put("bad", bad)
    }
    bridge.register("spike.loop.open") { _, _ ->
        loop.start()
        JSONObject().put("port", loop.port).put("token", loop.newToken())
    }
    bridge.register("spike.sleep") { _, p ->
        delay(p.optLong("ms"))
        JSONObject().put("slept", true)
    }
    bridge.register("spike.mem.begin") { _, _ -> mem.begin() }
    bridge.register("spike.mem.end") { _, _ -> mem.end() }
    bridge.register("spike.reload") { _, _ ->
        actions.reload()
        null
    }
    bridge.register("spike.crash") { _, _ ->
        actions.crash()
        null
    }
}
