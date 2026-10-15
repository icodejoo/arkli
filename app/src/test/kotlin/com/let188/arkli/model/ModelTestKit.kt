package com.let188.arkli.model

import com.let188.arkli.net.HttpCall
import com.let188.arkli.net.HttpHead
import com.let188.arkli.net.HttpTransport
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.security.MessageDigest

/** 测试用的主机：在 NetPolicy.DOWNLOAD_HOSTS 白名单里 */
const val T_HOST = "github.com"

/** 测试用的 release 落点主机，也在白名单里 */
const val T_CDN = "objects.githubusercontent.com"

/** 测试用文件的 URL */
const val T_URL = "https://$T_HOST/o/r/releases/download/v1/m.bin"

/** 假响应体每次最多交出的字节数，模拟分块到达 */
private const val CHUNK = 4096

/** 算 sha256 十六进制 */
fun sha256(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

/** 造确定性的伪随机内容 */
fun content(n: Int, seed: Int = 7): ByteArray = ByteArray(n) { ((it * 31 + seed) % 251).toByte() }

/** 造单文件模型清单项，摘要按 [data] 计算 */
fun entryOf(data: ByteArray, urls: List<String> = listOf(T_URL), version: String = "1", id: String = "m1"): ModelEntry {
    val f = ModelFile("m.bin", data.size.toLong(), sha256(data), "model", urls)
    return ModelEntry(id, "测试模型", version, "models/$id", data.size.toLong(), null, listOf(f))
}

/**
 * 一次假响应。
 *
 * @property status 状态码
 * @property headers 响应头
 * @property body 响应体
 * @property failAfter 读到这么多字节后抛 IOException（模拟连接被掐断）；null 不抛
 * @property onRead 每次读取时的钩子（可用来在中途取消协程）
 */
class FakeResponse(
    val status: Int,
    val headers: Map<String, String> = emptyMap(),
    val body: ByteArray = ByteArray(0),
    val failAfter: Int? = null,
    val onRead: ((Int) -> Unit)? = null,
)

/**
 * 假传输层：每次请求交给 [handler]，记录请求的 URL 与请求头。
 *
 * @property handler 按（URI、请求头、第几次请求）返回响应
 */
internal class FakeTransport(val handler: (URI, Map<String, String>, Int) -> FakeResponse) : HttpTransport {
    /** 已发出的请求（URL 字符串） */
    val urls = mutableListOf<String>()

    /** 已发出请求的请求头 */
    val requestHeaders = mutableListOf<Map<String, String>>()

    /** 请求计数 */
    @Volatile
    var count = 0

    /** 创建假调用，计数与记录在 newCall 时发生 */
    override fun newCall(uri: URI, method: String, headers: Map<String, String>, timeoutMs: Int): HttpCall {
        val index: Int
        synchronized(this) {
            index = count++
            urls += uri.toString()
            requestHeaders += headers
        }
        return object : HttpCall {
            /** 响应，execute 时才计算 */
            private val resp by lazy { handler(uri, headers, index) }

            override fun execute(): HttpHead =
                HttpHead(resp.status, "", resp.headers.entries.associate { (k, v) -> k as String? to listOf(v) })

            override fun body(): InputStream = object : InputStream() {
                /** 底层字节流 */
                private val inner = ByteArrayInputStream(resp.body)

                /** 已读字节数 */
                private var read = 0

                override fun read(): Int = throw UnsupportedOperationException()

                override fun read(b: ByteArray, off: Int, len: Int): Int {
                    resp.onRead?.invoke(read)
                    val limit = resp.failAfter
                    if (limit != null && read >= limit) throw IOException("连接被掐断")
                    val cap = minOf(len, CHUNK, if (limit != null) limit - read else Int.MAX_VALUE)
                    val n = inner.read(b, off, cap)
                    if (n > 0) read += n
                    return n
                }
            }

            override fun close() {}
        }
    }
}

/** 解析 `bytes=N-` 的起点，没有 Range 返回 0 */
fun rangeStart(headers: Map<String, String>): Long = headers["Range"]?.removePrefix("bytes=")?.substringBefore('-')?.toLongOrNull() ?: 0L

/** 标准的支持 Range 的假服务器响应 */
fun serve(data: ByteArray, headers: Map<String, String>, failAfter: Int? = null, onRead: ((Int) -> Unit)? = null): FakeResponse {
    val from = rangeStart(headers).toInt()
    if (from == 0) return FakeResponse(200, mapOf("Content-Length" to data.size.toString()), data, failAfter, onRead)
    if (from >= data.size) return FakeResponse(416)
    val rest = data.copyOfRange(from, data.size)
    return FakeResponse(
        206,
        mapOf("Content-Range" to "bytes $from-${data.size - 1}/${data.size}", "Content-Length" to rest.size.toString()),
        rest, failAfter, onRead,
    )
}
