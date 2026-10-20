package com.let188.arkli

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.net.Uri
import android.util.Log
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.let188.arkli.ai.AiModule
import com.let188.arkli.alarm.ReminderModule
import com.let188.arkli.apps.AppsModule
import com.let188.arkli.camera.CameraModule
import com.let188.arkli.qrcode.QrModule
import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.BridgeSessions
import com.let188.arkli.bridge.ReplyIo
import com.let188.arkli.files.FileEnv
import com.let188.arkli.files.FileModule
import com.let188.arkli.image.ImageModule
import com.let188.arkli.media.MediaModule
import com.let188.arkli.shortcut.ShortcutModule
import com.let188.arkli.speech.SpeechModule
import com.let188.arkli.splash.SplashGate
import com.let188.arkli.system.SystemModule
import com.let188.arkli.theme.ThemeModule
import com.let188.arkli.tts.TtsModule
import com.let188.arkli.dircleaner.DirModule
import com.let188.arkli.net.NetModule
import com.let188.arkli.noise.NoiseModule
import com.let188.arkli.wallpaper.WallpaperModule
import com.let188.arkli.net.NetPolicy
import com.let188.arkli.net.NetVerdict
import java.io.ByteArrayInputStream
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

/** 应用内虚拟域名，WebView 只允许加载这个域 */
internal const val ASSET_HOST = "appassets.androidplatform.net"

/** 首页地址 */
private const val START_URL = "https://$ASSET_HOST/assets/web/index.html"

/** WebView 底色：与启动动画的底色一致，页面没画出来前不会透出默认的纯白 */
private const val WEBVIEW_BACKGROUND = 0xFF8B5CF6.toInt()

/** 通道允许的来源规则，只放 appassets 域 */
private const val ALLOWED_ORIGIN = "https://$ASSET_HOST"

/** 日志 tag */
private const val LOG_TAG = "ArkliBridge"

/** 拦截响应的 HTTP 状态码 */
private const val HTTP_FORBIDDEN = 403

/** HTML 的 MIME，只有文档响应才需要 CSP 头 */
private const val MIME_HTML = "text/html"

/** 给 HTML 文档响应补上 CSP 头，其它资源原样返回 */
private fun WebResourceResponse.withCsp(): WebResourceResponse {
    if (mimeType != MIME_HTML) return this
    responseHeaders = (responseHeaders ?: emptyMap()) + (NetPolicy.CSP_HEADER to NetPolicy.contentSecurityPolicy(DevAssetHook.extraConnectSrc))
    return this
}

/**
 * 页面侧守卫脚本：不支持 ArrayBuffer 的 WebView 上，页面一旦发非字符串消息会让 App 进程崩溃，
 * 这里在页面侧先挡掉。脚本验证见 docs/research/spike-webmessage-arraybuffer.md。
 */
private const val GUARD_SCRIPT = "(function(){var o=window.${ArkliBridge.JS_OBJECT_NAME};if(!o)return;" +
    "var p=o.postMessage;o.postMessage=function(m){" +
    "if(typeof m!=='string')throw new TypeError('binary not supported');return p.call(o,m)}})();"

/**
 * 一个页面：WebView 加上与之绑定的 Bridge 会话。
 *
 * 会话号随 WebView 创建、主 frame 重新加载而递增，渲染进程崩溃时 [onRenderGone] 之前
 * 先关掉旧会话，保证挂起请求被取消、旧事件不会串到重建后的新页面。
 *
 * 使用示例：`val page = ArkliPage(ctx) { rebuild() }`，销毁时 `page.destroy()`。
 *
 * @param context 上下文
 * @param files 文件能力环境（选择器、PathHandler、写句柄、缓存清理）
 * @param startRoute 首屏路由（如 /tool/ruler，调用方需已校验），为空进首页
 * @param onRenderGone 渲染进程崩溃时回调，宿主应销毁并重建页面
 */
@SuppressLint("SetJavaScriptEnabled")
class ArkliPage(context: Context, private val files: FileEnv, startRoute: String? = null, private val onRenderGone: () -> Unit) {

    /** 承载页面的 WebView */
    val webView: WebView = WebView(context)

    /**
     * 当前会话的回传代理容器。每个会话建桥时各捕获自己的一份，换会话时整个换掉，
     * 旧会话迟到的回包只会写到旧代理，不会串到新页面。
     */
    @Volatile
    private var proxyRef = AtomicReference<JavaScriptReplyProxy?>()

    /** 当前会话的 Bridge */
    @Volatile
    private var bridge: ArkliBridge = newBridge()

    /** 是否已经历首次页面开始加载，首次加载沿用初始会话，不再换号 */
    private var firstLoadSeen = false

    /** 当前 WebView 是否支持 ArrayBuffer 消息，以原生探测为准 */
    private val binarySupported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)

    init {
        // 让 Compose 的 onRelease 能从 View 找回页面
        webView.tag = this
        // 必须显式 MATCH_PARENT：默认的 WRAP_CONTENT 会让 Chromium 把主文档布局高度强制置 0
        // （AwLayoutSizer.updateLayoutSettings 按 layoutParams 高度是否 wrap_content 调 setForceZeroLayoutHeight），
        // 页面里的 vh / dvh / svh 因此全变成 0px，Vant 弹窗、各工具的 max-height: 60vh 都会失效
        webView.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        // 仅 debuggable 构建开启远程调试（chrome://inspect / CDP），release 不受影响
        if ((context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true)
        val loader = WebViewAssetLoader.Builder()
            .setDomain(ASSET_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()

        webView.setBackgroundColor(WEBVIEW_BACKGROUND)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }

        webView.webViewClient = object : WebViewClient() {
            /**
             * appassets 域：`/files/` 前缀由 [FileEnv.server] 响应（支持 Range），其余交给 loader，HTML 加 CSP 头；
             * 白名单出站返回 null 让 WebView 自己发（CORS 由浏览器处理）；其余一律 403 并记日志。
             */
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                when (NetPolicy.classify(request.url.toString(), ASSET_HOST)) {
                    NetVerdict.APP ->
                        (files.server.intercept(request) ?: DevAssetHook.proxy?.invoke(request) ?: loader.shouldInterceptRequest(request.url))?.withCsp()
                    NetVerdict.ALLOW -> null
                    NetVerdict.BLOCK -> {
                        Log.w(LOG_TAG, "拦截出站请求 ${NetPolicy.redact(request.url.toString())}")
                        WebResourceResponse("text/plain", "utf-8", HTTP_FORBIDDEN, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                    }
                }

            /** 非 appassets 域的导航一律拦截 */
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.host != ASSET_HOST

            /** 主文档开始加载：重载时换新会话，旧会话的请求被取消 */
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if (firstLoadSeen) rotateSession() else firstLoadSeen = true
            }

            /** 新文档首次可见：写入安全区，页面第一帧就有正确的留白 */
            override fun onPageCommitVisible(view: WebView, url: String?) = applySafeInsets()

            /** 文档加载完成：再写一次兜底 */
            override fun onPageFinished(view: WebView, url: String?) = applySafeInsets()

            /** 渲染进程崩溃：先关会话，再交给宿主重建，返回 true 避免 App 被连带杀掉 */
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                bridge.close()
                onRenderGone()
                return true
            }
        }

        // 顺序固定：先注册通道与守卫，最后才 loadUrl（通道必须在页面加载前注册）
        installChannel()
        webView.loadUrl(if (startRoute == null) START_URL else "$START_URL#$startRoute")
    }

    /**
     * 向页面推一个事件，如生命周期事件。
     *
     * @param event 事件名，如 [ArkliBridge.EVENT_APP_PAUSE]
     * @param data 事件数据，可为 null
     */
    fun emit(event: String, data: Any? = null) = bridge.emit(event, data)

    /** 当前安全区；文档重新加载后要重写，所以要记住 */
    private var safeInsets = SafeInsets.ZERO

    /**
     * 更新页面的安全区（`--safe-*` CSS 变量）。必须在主线程调用。
     *
     * @param insets 系统栏与刘海挡住的四边尺寸（dp）
     */
    fun setSafeInsets(insets: SafeInsets) {
        safeInsets = insets
        applySafeInsets()
    }

    /** 把记住的安全区写进当前文档 */
    private fun applySafeInsets() {
        if (!destroyed) webView.evaluateJavascript(safeInsets.toScript(), null)
    }

    /** 是否已销毁，避免重复销毁 */
    private var destroyed = false

    /** 销毁：先关会话取消在途请求，再从父容器摘掉、停止加载并销毁 WebView，可重复调用 */
    fun destroy() {
        if (destroyed) return
        destroyed = true
        bridge.close()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.stopLoading()
        webView.destroy()
    }

    /** 换新会话：关旧建新，回传代理在新页面的第一条消息到达时刷新 */
    private fun rotateSession() {
        bridge.close()
        bridge = newBridge()
    }

    /** 新建一个会话的 Bridge 并注册内置方法 */
    private fun newBridge(): ArkliBridge {
        val ref = AtomicReference<JavaScriptReplyProxy?>()
        proxyRef = ref
        val io = ReplyIo { json -> ref.get()?.postMessage(json) }
        val created = ArkliBridge(BridgeSessions.next(), io, binary = binarySupported)
        created.register("native.ping", BridgeHandler { _, _ ->
            JSONObject().put("pong", true).put("ts", System.currentTimeMillis())
        })
        // 页面挂载完成：通知启动动画可以淡出
        created.register("native.app.ready", BridgeHandler { _, _ ->
            SplashGate.markReady()
            JSONObject().put("ready", true)
        })
        created.register("rust.core.version", BridgeHandler { _, _ ->
            JSONObject().put("version", uniffi.arkli_ffi.coreVersion())
        })
        val fileHandles = FileModule.install(created, files)
        MediaModule.install(created, files, fileHandles)
        ImageModule.install(created, files)
        SystemModule.install(created, files)
        ThemeModule.install(created, files)
        ReminderModule.install(created, files)
        TtsModule.install(created, files)
        ShortcutModule.install(created, files)
        AppsModule.install(created, files)
        QrModule.install(created, files)
        CameraModule.install(created, files)
        NetModule.install(created)
        DirModule.install(created, files)
        NoiseModule.install(created, files)
        WallpaperModule.install(created, files)
        AiModule.install(created, files)
        SpeechModule.install(created, files)
        return created
    }

    /** 注册 WebMessageListener 与守卫脚本；设备不支持时只记日志，页面会得到 NOT_READY */
    private fun installChannel() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Log.e(LOG_TAG, "WebView 不支持 WEB_MESSAGE_LISTENER，bridge 不可用")
            return
        }
        WebViewCompat.addWebMessageListener(
            webView, ArkliBridge.JS_OBJECT_NAME, setOf(ALLOWED_ORIGIN),
            object : WebViewCompat.WebMessageListener {
                /** 收到页面消息：只认字符串帧，记下回传代理后交给当前会话 */
                override fun onPostMessage(
                    view: WebView,
                    message: WebMessageCompat,
                    sourceOrigin: Uri,
                    isMainFrame: Boolean,
                    proxy: JavaScriptReplyProxy,
                ) {
                    val text = message.data ?: return
                    proxyRef.set(proxy)
                    bridge.dispatch(text, isMainFrame)
                }
            },
        )
        if (!binarySupported && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, GUARD_SCRIPT, setOf(ALLOWED_ORIGIN))
        }
    }
}
