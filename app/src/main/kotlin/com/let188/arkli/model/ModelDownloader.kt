package com.let188.arkli.model

import com.let188.arkli.net.HttpHead
import com.let188.arkli.net.HttpTransport
import com.let188.arkli.net.NetPolicy
import com.let188.arkli.net.withClosing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.URI
import java.security.MessageDigest

/** 连接与读取超时（毫秒） */
private const val IO_TIMEOUT_MS = 20_000

/** 同一下载源上连续“没有进展”的失败达到这个次数就换源 */
const val MAX_ATTEMPTS_PER_SOURCE = 3

/** 同一下载源上累计重试的硬上限，防止慢而不死的链路无限重试 */
const val MAX_TOTAL_RETRIES = 12

/** 读写缓冲大小 */
private const val BUFFER_BYTES = 64 * 1024

/** User-Agent，便于对端识别 */
private const val USER_AGENT = "Arkli-ModelDownloader"

/** 跟随的重定向状态码 */
private val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)

/** 十六进制字符表 */
private const val HEX = "0123456789abcdef"

/**
 * 文件摘要工具。
 *
 * 使用示例：`ModelFiles.sha256Hex(file)`
 */
object ModelFiles {
    /**
     * 计算文件的 sha256。
     *
     * @param file 文件
     * @param active 返回 false 时中止并抛 [CancellationException]，用于协程取消
     * @return 小写十六进制摘要
     */
    fun sha256Hex(file: File, active: () -> Boolean = { true }): String {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buf = ByteArray(BUFFER_BYTES)
            while (true) {
                if (!active()) throw CancellationException("已取消")
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        val sb = StringBuilder()
        md.digest().forEach { sb.append(HEX[(it.toInt() shr 4) and 0xF]).append(HEX[it.toInt() and 0xF]) }
        return sb.toString()
    }
}

/**
 * 模型下载器：断点续传、多源回退、逐跳校验重定向、sha256 校验、原子落盘。只用 `HttpURLConnection`（经 [HttpTransport]）。
 * 取消（协程取消）不删 .part，便于下次续传；清理由管理器的删除操作负责。
 *
 * 使用示例：`ModelDownloader(JdkHttpTransport, { it.usableSpace }).download(entry, dir) { done, phase -> }`
 *
 * @param transport 传输层，单测可换假实现
 * @param freeSpace 取目录所在分区的可用字节数，单测可换假实现
 * @param allowLoopbackHttp 是否放行回环明文，仅 debug 的覆盖下载源时为 true
 * @param sleeper 退避等待，单测可换成不真等的实现
 * @param timeoutMs 连接与读取超时
 */
internal class ModelDownloader(
    private val transport: HttpTransport,
    private val freeSpace: (File) -> Long,
    private val allowLoopbackHttp: () -> Boolean = { false },
    private val sleeper: suspend (Long) -> Unit = { delay(it) },
    private val timeoutMs: Int = IO_TIMEOUT_MS,
) {
    /**
     * 下载（或校验后确认）一个模型的全部文件。已有且校验通过的文件会跳过。
     *
     * @param entry 清单模型
     * @param dir 目标目录（已解析成绝对路径）
     * @param urlsFor 每个文件的下载源，默认取清单里的，debug 可覆盖
     * @param onProgress 进度回调：（模型级已完成字节，阶段）
     * @throws ModelDownloadException 失败；NO_SPACE、NETWORK、HASH_MISMATCH、SIZE_MISMATCH、SOURCE_REJECTED、INTERNAL
     * @throws CancellationException 被取消，.part 保留
     */
    suspend fun download(
        entry: ModelEntry,
        dir: File,
        urlsFor: (ModelFile) -> List<String> = { it.urls },
        onProgress: (Long, String) -> Unit,
    ) {
        if (!dir.isDirectory && !dir.mkdirs()) throw ModelDownloadException(ModelErrorCode.INTERNAL, "无法创建模型目录")
        val archive = entry.archive
        if (archive != null) {
            downloadPack(entry, dir, archive, urlsFor, onProgress)
            return
        }
        checkSpace(entry, dir)
        var base = 0L
        for (file in entry.files) {
            val target = File(dir, file.name)
            if (target.isFile && target.length() == file.bytes) {
                onProgress(base, ModelPolicy.PHASE_VERIFY)
                if (hashOf(target) == file.sha256) {
                    base += file.bytes
                    onProgress(base, ModelPolicy.PHASE_DOWNLOAD)
                    continue
                }
            }
            if (target.exists()) target.delete()
            fetchFile(file, dir, urlsFor(file), base, onProgress)
            base += file.bytes
        }
    }

    /**
     * 数据包：先确认解压后的文件，缺的才需要压缩包；压缩包已在目录里（下载完或 adb 放入）就校验后直接用，
     * 否则下载（沿用续传、多源、逐跳校验）；校验通过后解压并逐文件核对摘要，最后删掉压缩包。
     */
    private suspend fun downloadPack(entry: ModelEntry, dir: File, archive: ModelFile, urlsFor: (ModelFile) -> List<String>, onProgress: (Long, String) -> Unit) {
        val needed = mutableListOf<ModelFile>()
        for (f in entry.files) {
            val target = File(dir, f.name)
            if (target.isFile && target.length() == f.bytes) {
                onProgress(archive.bytes, ModelPolicy.PHASE_VERIFY)
                if (hashOf(target) == f.sha256) continue
            }
            if (target.exists()) target.delete()
            needed += f
        }
        val zip = File(dir, archive.name)
        val zipPart = File(dir, archive.name + PART_SUFFIX)
        if (needed.isEmpty()) {
            zip.delete()
            zipPart.delete()
            onProgress(archive.bytes, ModelPolicy.PHASE_DOWNLOAD)
            return
        }
        var haveZip = false
        if (zip.isFile && zip.length() == archive.bytes) {
            onProgress(archive.bytes, ModelPolicy.PHASE_VERIFY)
            haveZip = hashOf(zip) == archive.sha256
        }
        if (!haveZip) {
            zip.delete()
            val remaining = archive.bytes - zipPart.length().coerceIn(0, archive.bytes)
            requireSpace(dir, ModelPolicy.requiredFreeBytes(remaining) + needed.sumOf { it.bytes })
            fetchFile(archive, dir, urlsFor(archive), 0, onProgress)
        } else {
            requireSpace(dir, needed.sumOf { it.bytes })
        }
        onProgress(archive.bytes, ModelPolicy.PHASE_UNPACK)
        val job = currentCoroutineContext()[Job]
        val all = entry.files.map { it.name }.toSet()
        withContext(Dispatchers.IO) { PackExtractor.extract(zip, dir, needed, all) { job?.isActive != false } }
        zip.delete()
    }

    /** 剩余空间不足则抛 NO_SPACE */
    private fun checkSpace(entry: ModelEntry, dir: File) {
        val remaining = entry.files.sumOf { f ->
            val target = File(dir, f.name)
            if (target.isFile && target.length() == f.bytes) 0L else f.bytes - File(dir, f.name + PART_SUFFIX).length().coerceIn(0, f.bytes)
        }
        if (remaining <= 0) return
        requireSpace(dir, ModelPolicy.requiredFreeBytes(remaining))
    }

    /** 目录所在分区可用空间小于 [need] 抛 NO_SPACE */
    private fun requireSpace(dir: File, need: Long) {
        if (need <= 0) return
        val free = freeSpace(dir)
        if (free < need) throw ModelDownloadException(ModelErrorCode.NO_SPACE, "剩余空间不足：需要 $need 字节，只有 $free 字节")
    }

    /** 按序尝试各下载源，全部失败抛最后一个错误 */
    private suspend fun fetchFile(file: ModelFile, dir: File, urls: List<String>, base: Long, onProgress: (Long, String) -> Unit) {
        var last: ModelDownloadException? = null
        for (url in urls) {
            try {
                fetchFromSource(file, dir, url, base, onProgress)
                return
            } catch (e: ModelDownloadException) {
                last = e
            }
        }
        throw last ?: ModelDownloadException(ModelErrorCode.INTERNAL, "没有可用的下载源")
    }

    /** 同一下载源上的有限次重试，指数退避；有进展时重置“连续无进展”计数 */
    private suspend fun fetchFromSource(file: ModelFile, dir: File, url: String, base: Long, onProgress: (Long, String) -> Unit) {
        val part = File(dir, file.name + PART_SUFFIX)
        var failures = 0
        var total = 0
        while (true) {
            val before = part.length()
            val err: ModelDownloadException = try {
                attemptOnce(file, dir, url, base, onProgress)
                return
            } catch (e: ModelDownloadException) {
                if (!e.retriable) throw e
                e
            } catch (e: IOException) {
                currentCoroutineContext().ensureActive()
                ModelDownloadException(ModelErrorCode.NETWORK, "网络中断：${e.message}", true)
            }
            failures = if (part.length() > before) 1 else failures + 1
            total++
            if (failures >= MAX_ATTEMPTS_PER_SOURCE || total >= MAX_TOTAL_RETRIES) throw err
            sleeper(ModelPolicy.backoffMs(failures - 1))
        }
    }

    /** 一次尝试：续传下载 -> sha256 校验 -> 原子改名 */
    private suspend fun attemptOnce(file: ModelFile, dir: File, url: String, base: Long, onProgress: (Long, String) -> Unit) {
        val target = File(dir, file.name)
        val part = File(dir, file.name + PART_SUFFIX)
        var startAt = part.length()
        if (startAt > file.bytes) {
            part.delete()
            startAt = 0
        }
        if (startAt < file.bytes) startAt = stream(file, part, url, base, onProgress)
        onProgress(base + file.bytes, ModelPolicy.PHASE_VERIFY)
        if (hashOf(part) != file.sha256) {
            part.delete()
            // 续传拼出来的坏了，同源从头再来一次值得；从头下的就是源本身有问题
            throw ModelDownloadException(ModelErrorCode.HASH_MISMATCH, "${file.name} 的 sha256 与清单不一致", retriable = startAt > 0)
        }
        if (target.exists()) target.delete()
        if (!part.renameTo(target)) throw ModelDownloadException(ModelErrorCode.INTERNAL, "无法把 .part 改名为目标文件")
    }

    /** 在 IO 线程算 sha256，协程取消时中止 */
    private suspend fun hashOf(f: File): String {
        val job = currentCoroutineContext()[Job]
        return withContext(Dispatchers.IO) { ModelFiles.sha256Hex(f) { job?.isActive != false } }
    }

    /**
     * 发请求（逐跳校验重定向），按判定把响应体写进 .part。
     *
     * @return 实际的写入起点（0 表示服务器没做 Range，已从头下载）
     */
    private suspend fun stream(file: ModelFile, part: File, url: String, base: Long, onProgress: (Long, String) -> Unit): Long {
        var from = part.length()
        var current = url
        var hops = 0
        val job = currentCoroutineContext()[Job]
        while (true) {
            if (!NetPolicy.isAllowedDownload(current, allowLoopbackHttp())) {
                throw ModelDownloadException(ModelErrorCode.SOURCE_REJECTED, "下载地址不在白名单：${NetPolicy.redact(current)}")
            }
            val headers = mutableMapOf("User-Agent" to USER_AGENT, "Accept-Encoding" to "identity")
            if (from > 0) headers["Range"] = "bytes=$from-"
            val call = transport.newCall(URI(current), "GET", headers, timeoutMs)
            val head = withClosing(call, closeOnSuccess = false) { call.execute() }
            if (head.status in REDIRECT_CODES) {
                call.close()
                current = ModelPolicy.nextHop(current, head.header("Location"), hops, allowLoopbackHttp())
                hops++
                continue
            }
            val decision = ModelPolicy.decideRange(
                head.status, from, head.header("Content-Range"), head.header("Content-Length")?.trim()?.toLongOrNull(), file.bytes,
            )
            when (decision) {
                is RangeDecision.Write -> {
                    val written = withClosing(call) { copy(call.body(), part, decision.startAt, file.bytes, job) { onProgress(base + it, ModelPolicy.PHASE_DOWNLOAD) } }
                    if (written > file.bytes) {
                        part.delete()
                        throw ModelDownloadException(ModelErrorCode.SIZE_MISMATCH, "服务器返回的数据比清单还长")
                    }
                    if (written < file.bytes) throw ModelDownloadException(ModelErrorCode.NETWORK, "连接提前结束，已下载 $written 字节", true)
                    return decision.startAt
                }
                RangeDecision.Complete -> {
                    call.close()
                    return from
                }
                RangeDecision.Restart -> {
                    call.close()
                    part.delete()
                    from = 0
                }
                is RangeDecision.Fail -> {
                    call.close()
                    throw decision.error
                }
            }
        }
    }

    /**
     * 把响应体写进 .part：startAt 为 0 时截断重写，否则追加。每块都检查协程是否已取消。
     *
     * @return 写完后 .part 的总长度（含 startAt）
     */
    private fun copy(input: java.io.InputStream, part: File, startAt: Long, limit: Long, job: Job?, progress: (Long) -> Unit): Long {
        var written = startAt
        FileOutputStream(part, startAt > 0).use { out ->
            val buf = ByteArray(BUFFER_BYTES)
            while (written <= limit) {
                if (job != null && !job.isActive) throw CancellationException("已取消")
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                written += n
                progress(written)
            }
        }
        return written
    }

    /** 大小写不敏感地取响应头第一个值 */
    private fun HttpHead.header(name: String): String? =
        headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value?.firstOrNull()
}
