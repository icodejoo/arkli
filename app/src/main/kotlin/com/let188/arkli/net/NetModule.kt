package com.let188.arkli.net

import android.util.Base64
import com.let188.arkli.bridge.ArkliBridge

/**
 * 把联网方法注册进一个会话的 Bridge。页面自己的出站网络被 CSP 与 [NetPolicy] 封死，联网工具都走这里。
 * 全部只接受主 frame，契约见 docs/design/bridge-protocol.md「联网方法」。
 *
 * 使用示例：`NetModule.install(bridge)`
 */
object NetModule {
    /** 方法名：HTTP 请求 */
    const val METHOD_HTTP = "native.net.http"

    /** 方法名：DNS 解析 */
    const val METHOD_RESOLVE = "native.net.resolve"

    /** 方法名：TCP 连通 */
    const val METHOD_TCP = "native.net.tcp"

    /** 方法名：Whois */
    const val METHOD_WHOIS = "native.net.whois"

    /** 方法名：下行测速 */
    const val METHOD_SPEED = "native.net.speed"

    /**
     * 注册联网方法。
     *
     * @param bridge 当前会话的 Bridge
     */
    fun install(bridge: ArkliBridge) {
        val engine = NetEngine(SystemResolver, JdkHttpTransport, JdkTcpDialer, { Base64.encodeToString(it, Base64.NO_WRAP) })
        bridge.register(METHOD_HTTP, NetHttpHandler(engine))
        bridge.register(METHOD_RESOLVE, NetResolveHandler(engine))
        bridge.register(METHOD_TCP, NetTcpHandler(engine))
        bridge.register(METHOD_WHOIS, NetWhoisHandler(engine))
        bridge.register(METHOD_SPEED, NetSpeedHandler(engine))
    }
}
