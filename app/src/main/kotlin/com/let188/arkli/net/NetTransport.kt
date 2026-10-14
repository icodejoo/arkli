package com.let188.arkli.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.util.concurrent.atomic.AtomicBoolean

/** DNS 解析器：阻塞调用，须在 IO 线程使用；可换成假实现做单测 */
fun interface Resolver {
    /**
     * 解析主机的全部地址。
     *
     * @param host 域名或 IP 字面量（已归一化，无方括号）
     * @return 地址列表
     * @throws java.net.UnknownHostException 解析失败
     */
    fun resolve(host: String): List<InetAddress>
}

/** 系统 DNS 解析器 */
internal object SystemResolver : Resolver {
    /** 走 `InetAddress.getAllByName`，IP 字面量不会发 DNS 请求 */
    override fun resolve(host: String): List<InetAddress> = InetAddress.getAllByName(host).toList()
}

/** 一次响应的头部信息 */
internal class HttpHead(
    /** 状态码 */
    val status: Int,
    /** 状态描述，可能为空 */
    val statusText: String,
    /** 原始响应头（键可能为 null，值为同名头的各个值） */
    val headers: Map<String?, List<String>>,
)

/** 一次出站 HTTP 调用：执行后读 [body]，[close] 随时可调用（用于取消），连接中调用会让阻塞的 I/O 抛异常 */
internal interface HttpCall : Closeable {
    /** 发请求并等到响应头（阻塞，受超时约束） */
    fun execute(): HttpHead

    /** 响应体流；须在 [execute] 之后取，状态码 >= 400 时取错误流，没有体返回空流 */
    fun body(): InputStream
}

/** HTTP 传输层：只负责「发一跳、不跟随重定向」，可换成假实现做单测 */
internal fun interface HttpTransport {
    /**
     * 创建一次调用（此时不发起网络 I/O）。
     *
     * @param uri 目标地址
     * @param method GET 或 HEAD
     * @param headers 请求头
     * @param timeoutMs 连接与读取超时（毫秒）
     * @return 可关闭的调用对象
     */
    fun newCall(uri: URI, method: String, headers: Map<String, String>, timeoutMs: Int): HttpCall
}

/** 基于 `HttpURLConnection` 的传输：不跟随重定向、不用缓存、不带 Cookie */
internal object JdkHttpTransport : HttpTransport {
    /** 创建连接对象 */
    override fun newCall(uri: URI, method: String, headers: Map<String, String>, timeoutMs: Int): HttpCall {
        val conn = uri.toURL().openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.requestMethod = method
        headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
        return JdkCall(conn)
    }

    /** 包一层 HttpURLConnection */
    private class JdkCall(private val conn: HttpURLConnection) : HttpCall {
        /** 发请求取响应头 */
        override fun execute(): HttpHead =
            HttpHead(conn.responseCode, conn.responseMessage ?: "", conn.headerFields)

        /** 取响应体流 */
        override fun body(): InputStream =
            (if (conn.responseCode >= HTTP_ERROR_FLOOR) conn.errorStream else conn.inputStream) ?: java.io.ByteArrayInputStream(ByteArray(0))

        /** 断开连接 */
        override fun close() = conn.disconnect()

        private companion object {
            /** 从这个状态码起 HttpURLConnection 只给错误流 */
            const val HTTP_ERROR_FLOOR = 400
        }
    }
}

/** 一个可连接、可收发、可随时关闭的 TCP 套接字 */
internal interface TcpSocket : Closeable {
    /**
     * 连接（阻塞）。
     *
     * @param address 目标 IP
     * @param port 端口
     * @param timeoutMs 连接超时与之后的读超时（毫秒）
     */
    fun connect(address: InetAddress, port: Int, timeoutMs: Int)

    /** 输入流，连接后可用 */
    val input: InputStream

    /** 输出流，连接后可用 */
    val output: OutputStream
}

/** TCP 套接字工厂，可换成假实现做单测 */
internal fun interface TcpDialer {
    /** 新建一个未连接的套接字 */
    fun newSocket(): TcpSocket
}

/** 基于 `java.net.Socket` 的实现 */
internal object JdkTcpDialer : TcpDialer {
    /** 新建套接字 */
    override fun newSocket(): TcpSocket = object : TcpSocket {
        /** 底层套接字 */
        private val socket = Socket()

        override fun connect(address: InetAddress, port: Int, timeoutMs: Int) {
            socket.soTimeout = timeoutMs
            socket.connect(InetSocketAddress(address, port), timeoutMs)
        }

        override val input: InputStream get() = socket.getInputStream()
        override val output: OutputStream get() = socket.getOutputStream()
        override fun close() = socket.close()
    }
}

/**
 * 在 IO 线程跑阻塞代码，协程被取消或块抛异常时立刻 [Closeable.close] 目标，让阻塞的 I/O 抛异常返回。
 *
 * @param target 要在取消时关闭的连接
 * @param closeOnSuccess 块正常结束后是否也关闭目标，默认关；传 false 可让调用方继续用它
 * @param block 阻塞代码
 * @return block 的结果
 */
internal suspend fun <T> withClosing(target: Closeable, closeOnSuccess: Boolean = true, block: () -> T): T = coroutineScope {
    val finished = AtomicBoolean(false)
    val guard = launch(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
        try {
            awaitCancellation()
        } finally {
            if (!finished.get() || closeOnSuccess) runCatching { target.close() }
        }
    }
    try {
        val result = withContext(Dispatchers.IO) { block() }
        finished.set(true)
        result
    } finally {
        guard.cancel()
    }
}
