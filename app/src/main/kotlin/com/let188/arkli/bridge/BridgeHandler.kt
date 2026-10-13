package com.let188.arkli.bridge

import org.json.JSONObject

/**
 * Bridge 方法处理器：一个实现对应一个方法名。
 *
 * 契约见 docs/design/bridge-protocol.md。
 *
 * 使用示例：
 * ```
 * bridge.register("native.ping", BridgeHandler { JSONObject().put("pong", true) })
 * ```
 */
fun interface BridgeHandler {
    /**
     * 处理一次调用。
     *
     * @param params 页面传来的参数对象
     * @return 成功时的 data；失败请抛出 [BridgeException]
     */
    fun handle(params: JSONObject): Any?
}

/**
 * 处理器主动报告的业务错误，会被转换成协议里的 error 响应。
 *
 * @property code 协议错误码，如 BAD_PARAMS
 */
class BridgeException(val code: String, message: String) : Exception(message)
