package com.let188.arkli.bridge

import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * Bridge 的原生侧入口：接收页面消息，按方法名分发，再把结果回传给页面。
 *
 * 通道目前用 `@JavascriptInterface`，协议与通道解耦，后续可换成 WebMessageListener。
 *
 * 使用示例：
 * ```
 * val bridge = ArkliBridge(reply = { json -> webView.post { webView.evaluateJavascript("__arkliDispatch(${JSONObject.quote(json)})", null) } })
 * bridge.register("native.ping", BridgeHandler { JSONObject().put("pong", true) })
 * webView.addJavascriptInterface(bridge, ArkliBridge.JS_OBJECT_NAME)
 * ```
 *
 * @property reply 把响应或事件的 JSON 回传给页面，由宿主决定如何切到主线程
 */
class ArkliBridge(private val reply: (String) -> Unit) {

    /** 方法名 → 处理器的白名单注册表，没注册的方法一律拒绝 */
    private val handlers = mutableMapOf<String, BridgeHandler>()

    /**
     * 注册一个方法处理器。
     *
     * @param method 方法名，格式 `域.模块.动作`
     * @param handler 对应的处理器
     */
    fun register(method: String, handler: BridgeHandler) {
        handlers[method] = handler
    }

    /**
     * 页面调用入口，页面侧对应 `window.ArkliNative.postMessage(json)`。
     *
     * @param json 请求 JSON，格式见 bridge-protocol.md
     */
    @JavascriptInterface
    fun postMessage(json: String) {
        val request = runCatching { JSONObject(json) }.getOrNull() ?: return
        val id = request.optString(KEY_ID)
        val method = request.optString(KEY_METHOD)
        val handler = handlers[method]
        if (handler == null) {
            reply(errorResponse(id, ERR_UNKNOWN_METHOD, "未注册的方法：$method"))
            return
        }
        val response = try {
            okResponse(id, handler.handle(request.optJSONObject(KEY_PARAMS) ?: JSONObject()))
        } catch (e: BridgeException) {
            errorResponse(id, e.code, e.message ?: "")
        } catch (e: Exception) {
            errorResponse(id, ERR_INTERNAL, e.message ?: e.javaClass.simpleName)
        }
        reply(response)
    }

    /** 拼装成功响应 */
    private fun okResponse(id: String, data: Any?): String =
        JSONObject().put("v", PROTOCOL_VERSION).put(KEY_ID, id).put("ok", true)
            .put("data", data ?: JSONObject.NULL).toString()

    /** 拼装失败响应 */
    private fun errorResponse(id: String, code: String, message: String): String =
        JSONObject().put("v", PROTOCOL_VERSION).put(KEY_ID, id).put("ok", false)
            .put("error", JSONObject().put("code", code).put("message", message)).toString()

    companion object {
        /** 注入页面的对象名，需与 web/src/native/bridge.ts 一致 */
        const val JS_OBJECT_NAME = "ArkliNative"

        /** 当前协议版本 */
        const val PROTOCOL_VERSION = 1

        private const val KEY_ID = "id"
        private const val KEY_METHOD = "method"
        private const val KEY_PARAMS = "params"
        private const val ERR_UNKNOWN_METHOD = "UNKNOWN_METHOD"
        private const val ERR_INTERNAL = "INTERNAL"
    }
}
