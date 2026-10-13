package com.let188.arkli.spike

import android.util.Log
import java.io.BufferedInputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import kotlin.concurrent.thread

/** 只绑定本机回环地址 */
private const val LOOPBACK_ADDR = "127.0.0.1"

/** 校验令牌所在的请求头 */
private const val TOKEN_HEADER = "x-token"

/** 允许跨域访问的页面来源 */
private const val PAGE_ORIGIN = "https://appassets.androidplatform.net"

/** 请求头最大字节数，防止畸形请求撑爆内存 */
private const val MAX_HEADER_BYTES = 16 * 1024

/** 落盘读缓冲 */
private const val BODY_BUF_BYTES = 64 * 1024

/** 下行数据填充规则（与 patternBytes 一致）：乘数 */
private const val PAT_MUL = 7

/** 下行数据填充规则：加数 */
private const val PAT_ADD = 3

/**
 * 回环 HTTP 上传原型：只监听 127.0.0.1，一次性令牌校验，POST 体流式落盘。
 *
 * 仅为 spike 验证吞吐与内存，不含生产级的并发、超时、限流。
 *
 * @property dir 落盘目录
 */
class SpikeLoopbackServer(private val dir: File) {

    /** 监听套接字，端口由系统分配；首次使用才创建（无 INTERNET 权限时创建会抛 EPERM） */
    private val server by lazy { ServerSocket(0, 8, InetAddress.getByName(LOOPBACK_ADDR)) }

    /** 是否已启动接收线程 */
    @Volatile
    private var started = false

    /** 当前有效的一次性令牌，用掉即清 */
    @Volatile
    private var token: String? = null

    /** 监听端口 */
    val port: Int get() = server.localPort

    /** 启动接收线程，重复调用无副作用；无权限时抛 SocketException */
    @Synchronized
    fun start() {
        if (started) return
        server
        started = true
        thread(name = "spike-loop", isDaemon = true) {
            while (!server.isClosed) {
                val s = try { server.accept() } catch (e: Exception) { break }
                thread(name = "spike-loop-conn", isDaemon = true) { runCatching { handle(s) } }
            }
        }
    }

    /** 关闭服务 */
    fun stop() {
        if (started) runCatching { server.close() }
    }

    /**
     * 发一个一次性令牌。
     *
     * @return 新令牌
     */
    fun newToken(): String = UUID.randomUUID().toString().also { token = it }

    /** 处理一个连接：预检直接放行，POST 校验令牌后落盘 */
    private fun handle(sock: Socket) = sock.use { s ->
        val ins = BufferedInputStream(s.getInputStream(), BODY_BUF_BYTES)
        val out = s.getOutputStream()
        val head = readHead(ins) ?: return
        val lines = head.split("\r\n")
        val method = lines[0].substringBefore(' ')
        val headers = lines.drop(1).filter { ':' in it }
            .associate { it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim() }
        if (method == "OPTIONS") {
            reply(out, 204, "")
            return
        }
        val tk = headers[TOKEN_HEADER]
        if (method != "POST" || tk == null || tk != token) {
            reply(out, 403, "{\"error\":\"forbidden\"}")
            return
        }
        token = null
        val len = headers["content-length"]?.toLongOrNull() ?: -1L
        dir.mkdirs()
        val f = File(dir, "loop-${System.nanoTime()}.bin")
        val t0 = System.nanoTime()
        var total = 0L
        var bad = 0L
        f.outputStream().use { fo ->
            val buf = ByteArray(BODY_BUF_BYTES)
            while (total < len) {
                val n = ins.read(buf, 0, minOf(buf.size.toLong(), len - total).toInt())
                if (n < 0) break
                bad += countBad(buf, n, total)
                fo.write(buf, 0, n)
                total += n
            }
        }
        val ms = (System.nanoTime() - t0) / 1_000_000
        Log.i(SPIKE_TAG, "loopback received $total/$len bytes in ${ms}ms bad=$bad")
        reply(out, 200, "{\"size\":$total,\"bad\":$bad,\"nativeMs\":$ms}")
    }

    /** 统计偏离填充规则的字节数，用来确认内容一致 */
    private fun countBad(buf: ByteArray, n: Int, start: Long): Long {
        var bad = 0L
        for (i in 0 until n) {
            if (buf[i] != (((start + i) * PAT_MUL + PAT_ADD) and 0xff).toByte()) bad++
        }
        return bad
    }

    /** 读到空行为止的请求头，超限返回 null */
    private fun readHead(ins: InputStream): String? {
        val sb = StringBuilder()
        while (sb.length < MAX_HEADER_BYTES) {
            val c = ins.read()
            if (c < 0) return null
            sb.append(c.toChar())
            if (sb.endsWith("\r\n\r\n")) return sb.toString().trimEnd()
        }
        return null
    }

    /** 回一个带 CORS 头的简单响应 */
    private fun reply(out: OutputStream, code: Int, body: String) {
        val bytes = body.toByteArray()
        val h = "HTTP/1.1 $code X\r\nAccess-Control-Allow-Origin: $PAGE_ORIGIN\r\n" +
            "Access-Control-Allow-Headers: $TOKEN_HEADER, content-type\r\n" +
            "Access-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Private-Network: true\r\n" +
            "Content-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
        out.write(h.toByteArray())
        out.write(bytes)
        out.flush()
    }
}
