package com.let188.arkli

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.BridgeHandler
import org.json.JSONObject

/** 应用内虚拟域名，WebView 只允许加载这个域 */
private const val ASSET_HOST = "appassets.androidplatform.net"

/** 首页地址 */
private const val START_URL = "https://$ASSET_HOST/assets/web/index.html"

/** 页面侧接收原生消息的全局函数名 */
private const val JS_DISPATCH = "window.__arkliDispatch"

/** 标记 WebView 已销毁，避免重复销毁 */
private const val TAG_DESTROYED = "destroyed"

/** 主线程 Handler，用来把 Bridge 回调切回主线程 */
private val mainHandler = Handler(Looper.getMainLooper())

/**
 * 创建一个配置好的 WebView：资源走 assets 域、锁死外链、接好 Bridge。
 *
 * @param context 上下文
 * @param onRenderGone 渲染进程崩溃时回调，宿主应销毁并重建 WebView
 * @return 已开始加载首页的 WebView
 *
 * 使用示例：`val wv = createArkliWebView(ctx) { rebuild() }`
 */
@SuppressLint("SetJavaScriptEnabled")
fun createArkliWebView(context: Context, onRenderGone: () -> Unit): WebView {
    val webView = WebView(context)
    val loader = WebViewAssetLoader.Builder()
        .setDomain(ASSET_HOST)
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
        .build()

    webView.settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        allowFileAccess = false
        allowContentAccess = false
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    }

    webView.webViewClient = object : WebViewClient() {
        /** 资源请求交给 loader，命中 appassets 域才有响应 */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            loader.shouldInterceptRequest(request.url)

        /** 非 appassets 域的导航一律拦截 */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            request.url.host != ASSET_HOST

        /** 渲染进程崩溃：交给宿主重建，返回 true 避免 App 被连带杀掉 */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            onRenderGone()
            return true
        }
    }

    webView.addJavascriptInterface(createBridge(webView), ArkliBridge.JS_OBJECT_NAME)
    webView.loadUrl(START_URL)
    return webView
}

/**
 * 构造 Bridge 并注册内置方法。
 *
 * @param webView 回传响应的目标 WebView
 * @return 已注册 native.ping 与 rust.core.version 的 Bridge
 */
private fun createBridge(webView: WebView): ArkliBridge {
    val bridge = ArkliBridge(reply = { json ->
        mainHandler.post {
            webView.evaluateJavascript("$JS_DISPATCH(${JSONObject.quote(json)})", null)
        }
    })
    bridge.register("native.ping", BridgeHandler {
        JSONObject().put("pong", true).put("ts", System.currentTimeMillis())
    })
    bridge.register("rust.core.version", BridgeHandler {
        JSONObject().put("version", uniffi.arkli_ffi.coreVersion())
    })
    return bridge
}

/**
 * 按规范销毁 WebView：先从父容器摘掉，再停止加载并销毁，可重复调用。
 *
 * @receiver 要销毁的 WebView
 */
fun WebView.destroySafely() {
    if (tag == TAG_DESTROYED) return
    tag = TAG_DESTROYED
    (parent as? android.view.ViewGroup)?.removeView(this)
    stopLoading()
    removeJavascriptInterface(ArkliBridge.JS_OBJECT_NAME)
    destroy()
}
