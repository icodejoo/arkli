package com.let188.arkli

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/**
 * 唯一的 Activity：用 Compose 承载一个全屏 WebView。
 */
class MainActivity : ComponentActivity() {

    /** 当前 WebView，供返回键与销毁使用 */
    private var webView: WebView? = null

    /** 重建计数，渲染进程崩溃后加一，触发 Compose 重新创建 WebView */
    private var generation by mutableIntStateOf(0)

    /** 创建界面并接管返回键 */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            // 返回键：能后退就后退，否则交给系统
            BackHandler(enabled = true) {
                val wv = webView
                if (wv != null && wv.canGoBack()) wv.goBack() else finish()
            }
            // generation 变化即换 key，旧 AndroidView 释放、新的重建
            key(generation) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        createArkliWebView(ctx) { onRenderGone() }.also { webView = it }
                    },
                    onRelease = { it.destroySafely() },
                )
            }
        }
    }

    /** 渲染进程崩溃：递增 generation 让 AndroidView 重建 */
    private fun onRenderGone() {
        generation++
    }

    /** 销毁时释放 WebView */
    override fun onDestroy() {
        webView?.destroySafely()
        webView = null
        super.onDestroy()
    }
}
