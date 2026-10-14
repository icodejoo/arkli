package com.let188.arkli.debug

import android.os.SystemClock
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import com.let188.arkli.DevAssetHook
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/** 日志 tag，与 [DebugHooksProvider] 一致，`adb logcat -s ArkliDebug` 过滤 */
private const val TAG = "ArkliDebug"

/**
 * 开发服务器代理的纯规则，不依赖 Android，JVM 单测直接跑。
 */
internal object DevProxyRules {

    /** 开发服务器端口，需与 `web/package.json` 的 `dev:device` 和 `adb reverse` 一致 */
    const val PORT = 5173

    /** 页面资源的路径前缀，与 vite 的 base 一致 */
    const val PAGE_PREFIX = "/assets/web/"

    /** 默认 MIME，上游没给 Content-Type 时用 */
    private const val MIME_FALLBACK = "application/octet-stream"

    /** 从 Content-Type 里取 charset 的正则 */
    private val CHARSET = Regex("charset=([^;\\s]+)", RegexOption.IGNORE_CASE)

    /**
     * 判断路径是否属于页面资源：只有 `/assets/web/` 下的才转给开发服务器，`/files/` 等不碰。
     *
     * @param path 请求路径，可为 null
     * @return 是页面资源返回 true
     */
    fun isPagePath(path: String?): Boolean = path != null && path.startsWith(PAGE_PREFIX)

    /**
     * 拼上游地址，路径与查询串原样带上（vite 的 `?v=` `?import` 都靠它）。
     *
     * @param encodedPath 已编码的路径
     * @param encodedQuery 已编码的查询串，没有为 null
     * @return 形如 `http://127.0.0.1:5173/assets/web/src/main.ts?t=1`
     */
    fun upstreamUrl(encodedPath: String, encodedQuery: String?): String =
        "http://127.0.0.1:$PORT$encodedPath" + (if (encodedQuery.isNullOrEmpty()) "" else "?$encodedQuery")

    /**
     * 取 Content-Type 里的 MIME 部分。
     *
     * @param contentType 响应头值，如 `text/html; charset=utf-8`
     * @return `text/html`；缺省或为空回落 `application/octet-stream`
     */
    fun mimeOf(contentType: String?): String =
        contentType?.substringBefore(';')?.trim().takeUnless { it.isNullOrEmpty() } ?: MIME_FALLBACK

    /**
     * 取 Content-Type 里的字符集。
     *
     * @param contentType 响应头值
     * @return 如 `utf-8`；没有返回 null
     */
    fun charsetOf(contentType: String?): String? = contentType?.let { CHARSET.find(it)?.groupValues?.get(1) }

    /**
     * 上游状态码能否原样交给 WebView：WebResourceResponse 不接受 3xx，
     * 所以只转发 2xx 与 4xx/5xx，3xx 放弃代理让页面走包内资源。
     *
     * @param code HTTP 状态码
     */
    fun isForwardable(code: Int): Boolean = code in 200..299 || code in 400..599
}

/** 关闭流时一并断开连接，避免连接泄漏 */
private class ConnectionStream(input: InputStream, private val conn: HttpURLConnection) : FilterInputStream(input) {
    /** 关流并断开 */
    override fun close() {
        try {
            super.close()
        } finally {
            conn.disconnect()
        }
    }
}

/**
 * 仅调试用：把页面资源转给电脑上的 Vite 开发服务器，改完前端保存就能在手机上看到（含 HMR）。
 *
 * 流程：电脑 `pnpm dev:device`（内含 `adb reverse tcp:5173 tcp:5173`）→ 本代理经手机的 127.0.0.1:5173 取资源。
 * 页面来源仍是 appassets，通道、CSP、`/files/` 都不变；连不上开发服务器时返回 null，自动退回包内 assets。
 * 3xx 不转发（WebResourceResponse 不接受），条件请求头也不带，保证每次拿到完整内容。
 */
internal class DevServerProxy {

    /** 开发服务器不可达的冷却截止时刻（elapsedRealtime），冷却期内直接放行，避免每个请求都等超时 */
    @Volatile
    private var downUntil = 0L

    /** 上次是否可达，只在状态变化时打日志 */
    @Volatile
    private var wasUp: Boolean? = null

    /**
     * 处理一个页面请求。
     *
     * @param request WebView 的请求
     * @return 开发服务器的响应；不接管或连不上返回 null
     */
    fun handle(request: WebResourceRequest): WebResourceResponse? {
        if (request.method != "GET" || !DevProxyRules.isPagePath(request.url.path)) return null
        val now = SystemClock.elapsedRealtime()
        if (now < downUntil) return null
        val url = URL(DevProxyRules.upstreamUrl(request.url.encodedPath.orEmpty(), request.url.encodedQuery))
        var conn: HttpURLConnection? = null
        try {
            conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                request.requestHeaders["Accept"]?.let { setRequestProperty("Accept", it) }
            }
            val code = conn.responseCode
            if (!DevProxyRules.isForwardable(code)) {
                conn.disconnect()
                return null
            }
            noteState(true)
            val type = conn.contentType
            val body = if (code >= HTTP_ERROR_MIN) conn.errorStream else conn.inputStream
            return WebResourceResponse(
                DevProxyRules.mimeOf(type), DevProxyRules.charsetOf(type), code,
                conn.responseMessage?.takeIf { it.isNotEmpty() } ?: REASON_FALLBACK,
                mapOf("Cache-Control" to "no-store"),
                ConnectionStream(body ?: return null, conn),
            )
        } catch (e: IOException) {
            conn?.disconnect()
            downUntil = now + DOWN_COOLDOWN_MS
            noteState(false)
            return null
        }
    }

    /** 状态变化时打一条日志，便于确认现在走的是电脑还是包内 */
    private fun noteState(up: Boolean) {
        if (wasUp == up) return
        wasUp = up
        Log.i(TAG, if (up) "开发服务器已连上，页面资源走 vite" else "开发服务器不可达，页面资源退回包内 assets")
    }

    companion object {
        /** 连接超时：adb reverse 在本机回环，连不上会很快失败 */
        private const val CONNECT_TIMEOUT_MS = 400

        /** 读超时：vite 首次转换大依赖可能要几秒 */
        private const val READ_TIMEOUT_MS = 30_000

        /** 不可达后的冷却时间 */
        private const val DOWN_COOLDOWN_MS = 3_000L

        /** 状态码从这里起读 errorStream */
        private const val HTTP_ERROR_MIN = 400

        /** 上游没给状态描述时的占位，WebResourceResponse 要求非空 */
        private const val REASON_FALLBACK = "OK"

        /**
         * 装上代理并放行热更新的 WebSocket。只在 debug 进程启动时调用一次。
         */
        fun install() {
            val proxy = DevServerProxy()
            DevAssetHook.proxy = { proxy.handle(it) }
            DevAssetHook.extraConnectSrc = listOf("ws://127.0.0.1:${DevProxyRules.PORT}")
            Log.i(TAG, "开发服务器代理已就绪（端口 ${DevProxyRules.PORT}），连不上时自动用包内资源")
        }
    }
}
