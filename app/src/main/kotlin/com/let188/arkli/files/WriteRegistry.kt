package com.let188.arkli.files

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * 写入成功后的产物。
 *
 * @property handle 写句柄
 * @property file 落盘文件（缓存目录内）
 * @property name 清洗后的文件名
 * @property size 字节数
 * @property sha256 小写十六进制 sha256
 */
class WriteResult(val handle: String, val file: File, val name: String, val size: Long, val sha256: String)

/**
 * 一次分块写入的确认。
 *
 * @property seq 已确认的块号
 * @property written 已写入的总字节数
 */
class WriteAck(val seq: Int, val written: Long)

/**
 * 分块写入的状态机：一个实例对应一个页面会话，管该会话打开的所有写句柄。
 *
 * 约定：块号 seq 从 0 起严格递增；offset 必须等于已写字节数；同一块重发（页面没收到确认）幂等，
 * 内容长度与偏移一致就直接再回确认，不重复写。sha256 随写入累计，关闭时不用回读文件。
 * 会话关闭、句柄空闲超时都会清掉临时文件。本类不依赖 android，纯 JVM 可测。
 *
 * 使用示例：
 * ```
 * val reg = WriteRegistry(tmpDir, outDir)
 * val h = reg.open("a.bin", expectedSize = 3, expectedSha256 = null)
 * reg.write(h, 0, 0, byteArrayOf(1, 2, 3))
 * val r = reg.close(h, null, null)   // r.file 即成品
 * ```
 *
 * @param tmpDir 临时文件目录，句柄打开期间写在这里
 * @param outDir 成品目录，每个句柄一个子目录
 * @param clock 时钟，测试可替换
 * @param maxOpen 同时打开的句柄上限
 * @param maxBytes 单文件字节数上限
 * @param idleMs 句柄空闲超时
 * @param idGen 句柄 id 发生器，测试可替换
 */
class WriteRegistry(
    private val tmpDir: File,
    private val outDir: File,
    private val clock: () -> Long = System::currentTimeMillis,
    private val maxOpen: Int = FileConst.MAX_OPEN_WRITES,
    private val maxBytes: Long = FileConst.MAX_WRITE_BYTES,
    private val idleMs: Long = FileConst.WRITE_IDLE_MS,
    private val idGen: () -> String = { randomId() },
) {
    /** 一个打开的写句柄 */
    private class Entry(
        val handle: String,
        val name: String,
        val tmp: File,
        val expectedSize: Long?,
        val expectedSha: String?,
        val out: FileOutputStream,
    ) {
        /** 下一个期望的块号 */
        var nextSeq = 0

        /** 已写字节数 */
        var written = 0L

        /** 各块的起点与长度，用来识别重发 */
        val chunks = ArrayList<LongArray>()

        /** 随写入累计的摘要 */
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256")

        /** 最近活动时间 */
        var lastActive = 0L

        /** 已被丢弃（异常、取消、超时）标记 */
        var dead = false
    }

    /** 保护 [entries] 与 [done] */
    private val lock = Any()

    /** 打开中的句柄 */
    private val entries = HashMap<String, Entry>()

    /** 已成功关闭的句柄结果，用于 closeWrite 重发时幂等 */
    private val done = HashMap<String, WriteResult>()

    /**
     * 打开一个写句柄。
     *
     * @param name 期望文件名，会被清洗（去路径、控制字符）
     * @param expectedSize 声明的总字节数，可为 null；声明了会在关闭时校验
     * @param expectedSha256 声明的 sha256，可为 null；声明了会在关闭时校验
     * @return 句柄 id
     * @throws BridgeException 参数不合法（BAD_PARAMS）、句柄过多（NOT_READY）、磁盘错误（INTERNAL）
     */
    fun open(name: String, expectedSize: Long?, expectedSha256: String?): String {
        if (expectedSize != null && (expectedSize < 0 || expectedSize > maxBytes)) {
            throw BridgeException(BridgeErrors.BAD_PARAMS, "size 超出上限 $maxBytes")
        }
        if (expectedSha256 != null && !SHA256_RE.matches(expectedSha256)) {
            throw BridgeException(BridgeErrors.BAD_PARAMS, "sha256 必须是 64 位十六进制")
        }
        sweepIdle()
        synchronized(lock) {
            if (entries.size >= maxOpen) throw BridgeException(BridgeErrors.NOT_READY, "打开的写句柄过多")
            val handle = idGen()
            tmpDir.mkdirs()
            val tmp = File(tmpDir, handle + FileConst.PART_SUFFIX)
            val out = try {
                FileOutputStream(tmp)
            } catch (e: IOException) {
                throw BridgeException(BridgeErrors.INTERNAL, "无法创建临时文件：${e.message}")
            }
            val entry = Entry(handle, FileNames.sanitize(name), tmp, expectedSize, expectedSha256?.lowercase(), out)
            entry.lastActive = clock()
            entries[handle] = entry
            return handle
        }
    }

    /**
     * 写入一块。
     *
     * @param handle 写句柄
     * @param seq 块号，从 0 起
     * @param offset 本块在文件中的字节偏移，必须等于已写字节数（重发则等于原偏移）
     * @param data 本块内容，1 字节到 [FileConst.CHUNK_BYTES] 字节
     * @return 确认；重发的块直接确认，不重复写
     * @throws BridgeException 句柄无效、块号/偏移不连续、超限（BAD_PARAMS）；磁盘错误（INTERNAL，句柄随即作废）
     */
    fun write(handle: String, seq: Int, offset: Long, data: ByteArray): WriteAck {
        val entry = synchronized(lock) { entries[handle] } ?: throw badHandle()
        synchronized(entry) {
            if (entry.dead) throw badHandle()
            if (seq < 0) throw BridgeException(BridgeErrors.BAD_PARAMS, "seq 不能为负")
            if (data.isEmpty() || data.size > FileConst.CHUNK_BYTES) {
                throw BridgeException(BridgeErrors.BAD_PARAMS, "单块必须是 1..${FileConst.CHUNK_BYTES} 字节")
            }
            entry.lastActive = clock()
            if (seq < entry.nextSeq) {
                val old = entry.chunks[seq]
                if (old[0] != offset || old[1] != data.size.toLong()) {
                    throw BridgeException(BridgeErrors.BAD_PARAMS, "seq=$seq 已写入，但 offset 或长度与原块不一致")
                }
                return WriteAck(seq, entry.written)
            }
            if (seq != entry.nextSeq) {
                throw BridgeException(BridgeErrors.BAD_PARAMS, "seq 不连续，期望 ${entry.nextSeq}，收到 $seq")
            }
            if (offset != entry.written) {
                throw BridgeException(BridgeErrors.BAD_PARAMS, "offset 不连续，期望 ${entry.written}，收到 $offset")
            }
            val total = entry.written + data.size
            val limit = entry.expectedSize ?: maxBytes
            if (total > limit) throw BridgeException(BridgeErrors.BAD_PARAMS, "累计 $total 字节超出上限 $limit")
            try {
                entry.out.write(data)
            } catch (e: IOException) {
                discard(entry)
                throw BridgeException(BridgeErrors.INTERNAL, "写入失败：${e.message}")
            }
            entry.digest.update(data)
            entry.chunks.add(longArrayOf(entry.written, data.size.toLong()))
            entry.written = total
            entry.nextSeq = seq + 1
            return WriteAck(seq, total)
        }
    }

    /**
     * 关闭句柄，校验并落盘到成品目录。重复关闭同一句柄返回同一结果。
     *
     * @param handle 写句柄
     * @param size 期望总字节数，可为 null（默认取 open 时声明的值）
     * @param sha256 期望 sha256，可为 null（默认取 open 时声明的值）
     * @return 成品信息
     * @throws BridgeException 句柄无效或校验失败（BAD_PARAMS，临时文件随即删除）；落盘失败（INTERNAL）
     */
    fun close(handle: String, size: Long?, sha256: String?): WriteResult {
        val entry = synchronized(lock) {
            done[handle]?.let { return it }
            entries[handle]
        } ?: throw badHandle()
        synchronized(entry) {
            if (entry.dead) throw badHandle()
            val wantSize = size ?: entry.expectedSize
            val wantSha = (sha256 ?: entry.expectedSha)?.lowercase()
            if (wantSha != null && !SHA256_RE.matches(wantSha)) {
                throw BridgeException(BridgeErrors.BAD_PARAMS, "sha256 必须是 64 位十六进制")
            }
            val actualSha = entry.digest.digest().joinToString("") { "%02x".format(it) }
            if (wantSize != null && wantSize != entry.written) {
                discard(entry)
                throw BridgeException(BridgeErrors.BAD_PARAMS, "大小不符：期望 $wantSize，实收 ${entry.written}")
            }
            if (wantSha != null && wantSha != actualSha) {
                discard(entry)
                throw BridgeException(BridgeErrors.BAD_PARAMS, "sha256 校验失败")
            }
            val dir = File(outDir, handle)
            val target = File(dir, entry.name)
            try {
                entry.out.close()
                if (!dir.mkdirs() && !dir.isDirectory) throw IOException("无法创建 ${dir.name}")
                if (!entry.tmp.renameTo(target)) throw IOException("重命名失败")
            } catch (e: IOException) {
                discard(entry)
                throw BridgeException(BridgeErrors.INTERNAL, "落盘失败：${e.message}")
            }
            entry.dead = true
            val result = WriteResult(handle, target, entry.name, entry.written, actualSha)
            synchronized(lock) {
                entries.remove(handle)
                done[handle] = result
            }
            return result
        }
    }

    /**
     * 放弃一个写句柄，删除临时文件。
     *
     * @param handle 写句柄
     * @return 句柄存在且已丢弃返回 true
     */
    fun abort(handle: String): Boolean {
        val entry = synchronized(lock) { entries[handle] } ?: return false
        synchronized(entry) {
            if (entry.dead) return false
            discard(entry)
        }
        return true
    }

    /**
     * 丢弃所有打开中的句柄，会话关闭、渲染进程崩溃重建时调用。
     *
     * @return 被清理的句柄数
     */
    fun abortAll(): Int {
        val all = synchronized(lock) { entries.values.toList() }
        var n = 0
        for (e in all) synchronized(e) { if (!e.dead) { discard(e); n++ } }
        synchronized(lock) { done.clear() }
        return n
    }

    /**
     * 清掉空闲超时的句柄。
     *
     * @return 被清理的句柄数
     */
    fun sweepIdle(): Int {
        val now = clock()
        val stale = synchronized(lock) { entries.values.filter { now - it.lastActive > idleMs } }
        var n = 0
        for (e in stale) synchronized(e) { if (!e.dead && now - e.lastActive > idleMs) { discard(e); n++ } }
        return n
    }

    /**
     * 打开中的句柄数。
     *
     * @return 数量
     */
    fun openCount(): Int = synchronized(lock) { entries.size }

    /**
     * 打开中句柄的临时文件，相对缓存根的路径（如 `tmp/ab12.part`），清理器据此跳过活跃文件。
     *
     * @return 路径集合
     */
    fun activeParts(): Set<String> = synchronized(lock) { entries.values.map { FileConst.DIR_TMP + "/" + it.tmp.name }.toSet() }

    /** 丢弃句柄：标记作废、关流、删临时文件、移出表 */
    private fun discard(entry: Entry) {
        entry.dead = true
        try { entry.out.close() } catch (_: IOException) { }
        entry.tmp.delete()
        synchronized(lock) { entries.remove(entry.handle) }
    }

    /** 句柄不存在的错误 */
    private fun badHandle() = BridgeException(BridgeErrors.BAD_PARAMS, "写句柄不存在或已失效")

    companion object {
        /** sha256 十六进制格式 */
        private val SHA256_RE = Regex("^[0-9a-fA-F]{64}$")

        /** 句柄 id 的随机字节数 */
        private const val ID_BYTES = 8

        /** 安全随机源 */
        private val random = SecureRandom()

        /** 生成 `w` 开头的随机句柄 id */
        private fun randomId(): String {
            val b = ByteArray(ID_BYTES)
            random.nextBytes(b)
            return "w" + b.joinToString("") { "%02x".format(it) }
        }
    }
}
