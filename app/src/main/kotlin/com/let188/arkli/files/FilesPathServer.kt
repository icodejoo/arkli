package com.let188.arkli.files

import android.webkit.MimeTypeMap
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import com.let188.arkli.ASSET_HOST
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException

/**
 * appassets 域下 `/files/` 前缀的响应器，暴露缓存与数据包目录（只读）。
 *
 * WebViewAssetLoader 的 PathHandler 拿不到请求头，没法支持 Range，所以这里直接在
 * `shouldInterceptRequest` 里接管 `/files/` 前缀，视频预览靠 206 才能拖进度条。
 * 路径经 [FileRoots] 规范化，穿越一律按 404 处理。
 *
 * 使用示例：在 WebViewClient 里 `server.intercept(request) ?: loader.shouldInterceptRequest(request.url)`。
 *
 * @param roots 目录根
 */
class FilesPathServer(private val roots: FileRoots) {
    /**
     * 拦截一个 WebView 请求。
     *
     * @param request 页面发起的请求
     * @return 命中 `/files/` 前缀返回响应；不是本类负责的请求返回 null，交给下一级
     */
    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (url.scheme != "https" || url.host != ASSET_HOST) return null
        val path = url.path ?: return null
        if (!path.startsWith(FileConst.URL_PREFIX)) return null
        val range = request.requestHeaders?.entries?.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
        return respond(path.removePrefix(FileConst.URL_PREFIX), request.method ?: "GET", range)
    }

    /**
     * 按页面路径生成响应。
     *
     * @param pagePath `/files/` 之后的部分，如 `cache/out/a.mp4`
     * @param method 请求方法
     * @param range Range 请求头，可为 null
     * @return 响应；文件不存在或路径非法为 404
     */
    fun respond(pagePath: String, method: String, range: String?): WebResourceResponse {
        val file = roots.resolve(pagePath)
        val plan = FileServe.plan(file, method, range, webViewSkipsStart = true)
        val headers = HashMap(plan.headers)
        headers["Cache-Control"] = "no-cache"
        val mime = if (plan.status == 200 || plan.status == 206) mimeOf(file) else "text/plain"
        val stream = try {
            FileServe.open(plan)
        } catch (e: IOException) {
            return WebResourceResponse("text/plain", null, 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
        return WebResourceResponse(mime, null, plan.status, reason(plan.status), headers, stream)
    }

    /** 按扩展名猜 mime，猜不出按二进制流 */
    private fun mimeOf(file: File?): String {
        val ext = file?.extension?.lowercase().orEmpty()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }

    /** 状态码对应的原因短语 */
    private fun reason(status: Int): String = when (status) {
        200 -> "OK"
        206 -> "Partial Content"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        416 -> "Range Not Satisfiable"
        else -> "Error"
    }
}
