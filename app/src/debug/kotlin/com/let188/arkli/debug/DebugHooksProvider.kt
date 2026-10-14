package com.let188.arkli.debug

import android.app.Activity
import android.app.Application
import android.content.BroadcastReceiver
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import com.let188.arkli.MainActivity
import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.BridgeHandler
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import org.json.JSONObject

/** 调试日志 tag，`adb logcat -s ArkliDebug` 过滤 */
private const val TAG = "ArkliDebug"

/** 调试广播 action，仅 debug 构建存在 */
private const val ACTION = "com.let188.arkli.debug.CMD"

/** 调试用长挂起方法名 */
private const val METHOD_SLEEP = "native.debug.sleep"

/** 调试用持续推事件的方法名 */
private const val METHOD_TICKER = "native.debug.ticker"

/** 网络测试：白名单接口（应成功） */
private const val NET_URL_WIKI = "https://api.wikimedia.org/feed/v1/wikipedia/zh/onthisday/events/09/17"

/** 网络测试：非白名单域名（应被拦） */
private const val NET_URL_EXAMPLE = "https://example.com/"

/** 网络测试：白名单域名的明文版本（应被拦） */
private const val NET_URL_PLAIN = "http://api.wikimedia.org/feed/v1/wikipedia/zh/onthisday/events/09/17"

/**
 * 仅调试用：借 ContentProvider 在进程启动时注册调试广播，用于真机验证渲染进程崩溃重建等场景。
 * 只在 debug 源集，release 包不含。通过反射读取主代码里的私有字段，不改动主代码。
 *
 * 触发示例：`adb shell am broadcast -a com.let188.arkli.debug.CMD --es cmd crash`
 * 命令：nettest / crash / hello / ping / sleep(--ei ms) / ticker / cancel(--es id) / state，
 * 文件类见 [DebugFileCommands]：filepick(--es mime --ez multiple) / filesave / writetest(--ei mb --es enc) / writeopen / rangetest / securitytest / videotest / listcache / previewtest
 */
class DebugHooksProvider : ContentProvider() {

    /** 当前在前台的 MainActivity */
    @Volatile
    private var activity: MainActivity? = null

    /** 主线程 Handler */
    private val main = Handler(Looper.getMainLooper())

    /** 请求序号，用于生成页面请求 id */
    private var seq = 0

    /** 注册生命周期回调与调试广播 */
    override fun onCreate(): Boolean {
        val ctx = context ?: return false
        (ctx.applicationContext as Application).registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            /** 记下 MainActivity */
            override fun onActivityCreated(a: Activity, s: Bundle?) { if (a is MainActivity) activity = a }
            /** 销毁时清掉引用 */
            override fun onActivityDestroyed(a: Activity) { if (a === activity) activity = null }
            override fun onActivityStarted(a: Activity) {}
            override fun onActivityResumed(a: Activity) {}
            override fun onActivityPaused(a: Activity) {}
            override fun onActivityStopped(a: Activity) {}
            override fun onActivitySaveInstanceState(a: Activity, o: Bundle) {}
        })
        val receiver = object : BroadcastReceiver() {
            /** 收到命令，切到主线程执行 */
            override fun onReceive(c: Context, i: Intent) {
                val cmd = i.getStringExtra("cmd") ?: return
                main.post { runCatching { handle(cmd, i) }.onFailure { Log.e(TAG, "命令失败 $cmd", it) } }
            }
        }
        val filter = IntentFilter(ACTION)
        // adb shell 发的广播需要接收器导出
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        else ctx.registerReceiver(receiver, filter)
        DevServerProxy.install()
        Log.i(TAG, "调试钩子已就绪")
        return true
    }

    /**
     * 让页面分别 fetch 白名单接口、非白名单域名与明文白名单域名，结果以 `DBGNET` 前缀输出到 console（logcat 的 chromium tag）。
     * 预期：wikimedia 成功且含 1894；example.com 与 http 版均失败。
     */
    private fun netTest(wv: WebView) {
        val js = "(function(){var t=function(n,u){fetch(u).then(function(r){return r.text().then(function(b){" +
            "console.log('DBGNET '+n+' status='+r.status+' len='+b.length+' has1894='+(b.indexOf('1894')>=0))})})" +
            ".catch(function(e){console.log('DBGNET '+n+' FAIL '+e)})};" +
            "t('wiki','$NET_URL_WIKI');t('example','$NET_URL_EXAMPLE');t('plain','$NET_URL_PLAIN')})()"
        wv.evaluateJavascript(js, null)
    }

    /** 反射取字段值 */
    private fun field(target: Any, name: String): Any? =
        target.javaClass.getDeclaredField(name).also { it.isAccessible = true }.get(target)

    /** 当前页面对象 */
    private fun page(): Any? = activity?.let { field(it, "page") }

    /** 当前页面的 WebView */
    private fun webView(): WebView? = page()?.let { field(it, "webView") as? WebView }

    /** 当前会话的 Bridge，并确保调试方法已注册 */
    private fun bridge(): ArkliBridge? {
        val b = page()?.let { field(it, "bridge") as? ArkliBridge } ?: return null
        b.register(METHOD_SLEEP, BridgeHandler { ctx, p ->
            val ms = p.optLong("ms", 60_000)
            Log.i(TAG, "sleep 开始 session=${ctx.session} id=${ctx.requestId}")
            try {
                delay(ms)
                JSONObject().put("slept", ms)
            } catch (e: CancellationException) {
                Log.i(TAG, "sleep 被取消 session=${ctx.session} id=${ctx.requestId}")
                throw e
            }
        })
        b.register(METHOD_TICKER, BridgeHandler { ctx, _ ->
            val session = ctx.session
            val task = ctx.launchTask {
                var n = 0
                try {
                    while (true) {
                        delay(500)
                        ctx.emit("dbg.tick", JSONObject().put("n", ++n).put("session", session))
                    }
                } finally {
                    Log.i(TAG, "ticker 结束 session=$session")
                }
            }
            JSONObject().put("taskId", task)
        })
        return b
    }

    /** 执行一条命令 */
    private fun handle(cmd: String, i: Intent) {
        val wv = webView()
        if (wv == null) { Log.w(TAG, "无页面 cmd=$cmd"); return }
        when (cmd) {
            "crash" -> {
                Log.i(TAG, "触发崩溃：加载 chrome://crash，崩溃前 pid=${android.os.Process.myPid()}")
                wv.loadUrl("chrome://crash")
            }
            "hello" -> send(wv, ArkliBridge.METHOD_HELLO, "{}")
            "ping" -> send(wv, "native.ping", "{}")
            "sleep" -> {
                bridge()
                send(wv, METHOD_SLEEP, "{\"ms\":${i.getIntExtra("ms", 60_000)}}", i.getStringExtra("id"))
            }
            "ticker" -> { bridge(); send(wv, METHOD_TICKER, "{}") }
            "cancel" -> send(wv, ArkliBridge.METHOD_CANCEL, "{\"id\":\"${i.getStringExtra("id")}\"}")
            "filepick", "filesave", "writetest", "writeopen", "rangetest", "videotest", "securitytest", "listcache", "previewtest" -> DebugFileCommands.handle(
                cmd, wv.context, wv, i.getStringExtra("mime"), i.getBooleanExtra("multiple", false),
                i.getIntExtra("mb", 6), i.getStringExtra("enc") ?: "latin1",
            ) { method, params -> send(wv, method, params) }
            "imgprep", "imgrun", "exifdump", "imglist", "nav" -> DebugImageCommands.handle(cmd, wv.context, wv, i.getStringExtra("path"))
            "rpc" -> send(wv, i.getStringExtra("method") ?: "native.ping", i.getStringExtra("params") ?: "{}", i.getStringExtra("id"))
            "evaljs" -> wv.evaluateJavascript(i.getStringExtra("js") ?: "0", null)
            "nettest" -> netTest(wv)
            "state" -> Log.i(TAG, "state url=${wv.url} pid=${android.os.Process.myPid()} session=${bridge()?.session}")
        }
    }

    /** 往页面的通道里发一条请求，并把所有回传消息记到 console（logcat 的 chromium tag） */
    private fun send(wv: WebView, method: String, params: String, id: String? = null) {
        val rid = id ?: "dbg-${++seq}"
        val msg = JSONObject().put("v", 2).put("id", rid).put("method", method).put("params", JSONObject(params)).toString()
        val js = "(function(){var o=window.ArkliNative;if(!window.__dbgL){window.__dbgL=1;" +
            "o.addEventListener('message',function(e){console.log('DBGMSG '+e.data)})}" +
            "o.postMessage(${JSONObject.quote(msg)});console.log('DBGSEND '+${JSONObject.quote(msg)})})()"
        wv.evaluateJavascript(js, null)
    }

    override fun query(u: Uri, p: Array<String>?, s: String?, a: Array<String>?, o: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<String>?): Int = 0
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<String>?): Int = 0
}
