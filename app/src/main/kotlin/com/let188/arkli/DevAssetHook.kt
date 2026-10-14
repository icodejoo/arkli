package com.let188.arkli

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse

/**
 * 开发期页面资源钩子：release 里永远是空的，只有 debug 源集的 `DevServerProxy` 会往里填。
 * 让 debug 包能把页面资源转给电脑上的 Vite（热更新），页面来源仍是 appassets，通道与 CSP 都不用改。
 */
object DevAssetHook {

    /** 资源代理：返回 null 表示不接管，交给包内 assets；release 里为 null */
    @Volatile
    var proxy: ((WebResourceRequest) -> WebResourceResponse?)? = null

    /** 开发期额外放行的 connect-src 来源（热更新的 WebSocket），release 里为空 */
    @Volatile
    var extraConnectSrc: List<String> = emptyList()
}
