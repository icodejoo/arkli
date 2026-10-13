package com.let188.arkli.spike

import android.annotation.SuppressLint
import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File

/** 应用内虚拟域名 */
private const val ASSET_HOST = "appassets.androidplatform.net"

/** 来源规则：只放行应用内虚拟域名 */
private const val ALLOWED_ORIGIN = "https://$ASSET_HOST"

/** 新通道在页面里的对象名 */
private const val NEW_OBJECT = "ArkliNative"

/** 旧通道（@JavascriptInterface）在页面里的对象名，与新通道并存以便对比 */
private const val LEGACY_OBJECT = "ArkliLegacy"

/** 页面接收旧通道回包的全局函数 */
private const val LEGACY_DISPATCH = "window.__spikeLegacyDispatch"

/** 用来模拟跨源 iframe 的假域名，请求被拦截后由 assets 响应，不走网络 */
private const val EVIL_HOST = "evil.example"

/** 用来探测拦截器能否读 POST body 的路径 */
private const val POST_PROBE_PATH = "/post-probe"

/** 渲染进程崩溃用的内部页 */
private const val CRASH_URL = "chrome://crash"

/** spike 页面地址 */
private const val SPIKE_PAGE = "https://$ASSET_HOST/assets/spike/spike.html"

/** 延迟注册监听的间隔（毫秒），用于验证"必须在加载前注册" */
private const val LATE_REGISTER_MS = 1500L

/** 文本日志长度上限，避免大 JSON 刷屏 */
private const val LOG_TEXT_MAX = 400

/**
 * 文档起点脚本：不支持二进制消息的 WebView 上，把非字符串消息挡在页面侧。
 * 实测旧版 WebView 收到 ArrayBuffer 会在原生回调里抛异常并使进程 abort。
 */
private const val GUARD_SCRIPT = "(function(){var o=window.ArkliNative;if(!o)return;var p=o.postMessage;" +
    "o.postMessage=function(m){if(typeof m!=='string')throw new TypeError('binary not supported');return p.call(o,m)}})();"

/** 全屏布局参数 */
private const val MATCH_PARENT = -1

/**
 * spike 宿主：一个全屏 WebView，同时挂新通道（WebMessageListener）与旧通道（@JavascriptInterface）。
 *
 * 启动示例：`adb shell am start -n com.let188.arkli/.spike.SpikeActivity --es q "t=latency"`
 */
class SpikeActivity : Activity() {

    /** 主线程 Handler */
    private val main = Handler(Looper.getMainLooper())

    /** 容器 */
    private lateinit var root: FrameLayout

    /** 当前 WebView */
    private var webView: WebView? = null

    /** 当前异步 Bridge，重建时关闭旧的 */
    private var bridge: AsyncBridge? = null

    /** 页面查询串，由 intent 传入 */
    private var query = ""

    /** 是否故意晚注册监听 */
    private var late = false

    /** 是否挂上"挡二进制"的文档起点脚本 */
    private var guard = false

    /** 文件存储，跨 WebView 重建共用 */
    private lateinit var store: SpikeFileStore

    /** 回环上传原型服务，跨 WebView 重建共用 */
    private lateinit var loop: SpikeLoopbackServer

    /** 页面会话号，每次建 WebView 加一 */
    private var session = 0

    /** 创建界面并建 WebView */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(true)
        query = intent.getStringExtra("q") ?: ""
        late = intent.getBooleanExtra("late", false)
        guard = intent.getBooleanExtra("guard", false)
        root = FrameLayout(this)
        setContentView(root)
        store = SpikeFileStore(File(cacheDir, "arkli/spike"))
        loop = SpikeLoopbackServer(File(cacheDir, "arkli/spike"))
        buildWebView()
    }

    /** 销毁旧 WebView 并按序重建：先注册监听，再加载页面 */
    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView() {
        destroyWebView()
        session++
        val wv = WebView(this)
        webView = wv
        root.addView(wv, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        val pubDir = File(cacheDir, "arkli/spike-pub")
        pubDir.mkdirs()
        val loader = WebViewAssetLoader.Builder().setDomain(ASSET_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/spike-cache/", WebViewAssetLoader.InternalStoragePathHandler(this, pubDir))
            .build()
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        wv.webChromeClient = object : WebChromeClient() {
            /** 页面 console 转 logcat，不依赖 bridge */
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.i(SPIKE_TAG, "console: ${m.message()}")
                return true
            }
        }
        wv.webViewClient = object : WebViewClient() {
            /** appassets 走 loader，evil 域用 frame.html 冒充 */
            override fun shouldInterceptRequest(view: WebView, r: WebResourceRequest): WebResourceResponse? {
                if (r.url.path == POST_PROBE_PATH) {
                    // 验证 WebResourceRequest 能拿到什么：方法与请求头有，没有读 body 的 API
                    Log.i(SPIKE_TAG, "intercept method=${r.method} headers=${r.requestHeaders}")
                    return WebResourceResponse("application/json", "utf-8", "{\"seen\":true}".byteInputStream())
                }
                if (r.url.host == EVIL_HOST) {
                    return WebResourceResponse("text/html", "utf-8", assets.open("spike/frame.html"))
                }
                return loader.shouldInterceptRequest(r.url)
            }

            /** 渲染进程崩溃：整个重建 WebView 与通道 */
            override fun onRenderProcessGone(view: WebView, d: RenderProcessGoneDetail): Boolean {
                Log.w(SPIKE_TAG, "renderProcessGone crashed=${d.didCrash()} -> rebuild")
                main.post { buildWebView() }
                return true
            }
        }
        val features = probeFeatures()
        val b = AsyncBridge(session)
        bridge = b
        registerSpikeHandlers(b, store, pubDir, features, object : SpikeActions {
            /** 重载页面 */
            override fun reload() {
                main.post { wv.reload() }
            }

            /** 触发渲染进程崩溃 */
            override fun crash() {
                main.post { wv.loadUrl(CRASH_URL) }
            }
        }, loop)
        installLegacy(wv)
        if (!late) installListener(wv, b)
        if (guard) installGuard(wv)
        wv.loadUrl("$SPIKE_PAGE?$query&late=${if (late) 1 else 0}")
        if (late) main.postDelayed({ installListener(wv, b) }, LATE_REGISTER_MS)
    }

    /** 探测各 WebViewFeature 的支持情况 */
    private fun probeFeatures(): JSONObject {
        val names = mapOf(
            "WEB_MESSAGE_LISTENER" to WebViewFeature.WEB_MESSAGE_LISTENER,
            "WEB_MESSAGE_ARRAY_BUFFER" to WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER,
            "DOCUMENT_START_SCRIPT" to WebViewFeature.DOCUMENT_START_SCRIPT,
            "POST_WEB_MESSAGE" to WebViewFeature.POST_WEB_MESSAGE,
            "WEB_MESSAGE_PORT_POST_MESSAGE" to WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE,
        )
        val o = JSONObject()
        names.forEach { (k, v) -> o.put(k, WebViewFeature.isFeatureSupported(v)) }
        Log.i(SPIKE_TAG, "features=$o")
        return o
    }

    /** 挂上新通道，来源只放行 appassets */
    private fun installListener(wv: WebView, b: AsyncBridge) {
        try {
            WebViewCompat.addWebMessageListener(wv, NEW_OBJECT, setOf(ALLOWED_ORIGIN), SpikeListener(b, store))
            Log.i(SPIKE_TAG, "addWebMessageListener ok (late=$late)")
        } catch (e: Exception) {
            Log.e(SPIKE_TAG, "addWebMessageListener failed: $e")
        }
    }

    /** 挂上文档起点脚本，仅对 appassets 来源生效 */
    private fun installGuard(wv: WebView) {
        try {
            WebViewCompat.addDocumentStartJavaScript(wv, GUARD_SCRIPT, setOf(ALLOWED_ORIGIN))
            Log.i(SPIKE_TAG, "guard script installed")
        } catch (e: Exception) {
            Log.e(SPIKE_TAG, "guard install failed: $e")
        }
    }

    /** 挂上旧通道：生产 ArkliBridge 已升到 v2，这里用本地最小对象复现旧的 `@JavascriptInterface` 通道 */
    private fun installLegacy(wv: WebView) {
        val legacy = object {
            /** 旧通道入口：只应答 native.ping */
            @android.webkit.JavascriptInterface
            fun postMessage(json: String) {
                val req = JSONObject(json)
                Log.i(SPIKE_TAG, "LEGACY native.ping invoked")
                val resp = JSONObject().put("v", 1).put("id", req.optString("id")).put("ok", true)
                    .put("data", JSONObject().put("pong", true).put("ts", System.currentTimeMillis()))
                main.post { wv.evaluateJavascript("$LEGACY_DISPATCH(${JSONObject.quote(resp.toString())})", null) }
            }
        }
        wv.addJavascriptInterface(legacy, LEGACY_OBJECT)
    }

    /** 销毁旧 WebView 与 Bridge */
    private fun destroyWebView() {
        bridge?.close()
        webView?.let {
            root.removeView(it)
            it.stopLoading()
            it.destroy()
        }
        webView = null
    }

    /** 退出时释放 */
    override fun onDestroy() {
        loop.stop()
        destroyWebView()
        super.onDestroy()
    }

    /**
     * 新通道监听器：文本进 Bridge，二进制进文件存储。
     *
     * @property b 异步 Bridge
     * @property store 二进制帧写盘存储
     */
    private class SpikeListener(private val b: AsyncBridge, private val store: SpikeFileStore) :
        WebViewCompat.WebMessageListener {
        /** 收到页面消息 */
        override fun onPostMessage(
            view: WebView,
            message: WebMessageCompat,
            sourceOrigin: Uri,
            isMainFrame: Boolean,
            replyProxy: JavaScriptReplyProxy,
        ) {
            val io = object : ReplyIo {
                /** 回 JSON */
                override fun sendJson(json: String) = replyProxy.postMessage(json)

                /** 回二进制 */
                override fun sendBinary(bytes: ByteArray) = replyProxy.postMessage(bytes)
            }
            if (message.type == WebMessageCompat.TYPE_ARRAY_BUFFER) {
                store.onFrame(message.arrayBuffer)
                return
            }
            val text = message.data ?: return
            if (text.startsWith(LATIN1_MARK)) {
                // latin1 字符串帧：标记 + 8 字节帧头 + 载荷，每个字符一个字节
                store.onFrame(text.toByteArray(Charsets.ISO_8859_1), 1)
                return
            }
            if (!text.startsWith("{")) Log.w(SPIKE_TAG, "non-json text message len=${text.length} head=${text.take(40)}")
            if (text.length < LOG_TEXT_MAX) {
                Log.i(SPIKE_TAG, "listener origin=$sourceOrigin main=$isMainFrame len=${text.length}")
            }
            b.dispatch(text, io)
        }
    }
}
