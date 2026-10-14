package com.let188.arkli.bridge

import org.json.JSONObject

/**
 * Bridge 方法处理器：一个实现对应一个方法名，挂起函数，可被取消。
 *
 * 取消信号就是协程取消：被 `native.task.cancel` 取消或会话关闭时，挂起点会抛
 * `CancellationException`，处理器别吞掉它。契约见 docs/design/bridge-protocol.md。
 *
 * 使用示例：
 * ```
 * bridge.register("native.ping", BridgeHandler { _, _ -> JSONObject().put("pong", true) })
 * ```
 */
fun interface BridgeHandler {
    /**
     * 处理一次调用。
     *
     * @param ctx 调用上下文（会话号、请求 id、事件推送、后台任务）
     * @param params 页面传来的参数对象
     * @return 成功时的 data；失败请抛出 [BridgeException]
     */
    suspend fun handle(ctx: CallContext, params: JSONObject): Any?
}

/**
 * 处理器主动报告的业务错误，会被转换成协议里的 error 响应。
 *
 * @property code 协议错误码，见 [BridgeErrors]
 */
class BridgeException(val code: String, message: String) : Exception(message)

/** 协议错误码，与 web/src/native/protocol.ts 保持一致 */
object BridgeErrors {
    /** 方法不存在 */
    const val UNKNOWN_METHOD = "UNKNOWN_METHOD"

    /** 参数缺失或类型不对 */
    const val BAD_PARAMS = "BAD_PARAMS"

    /** 用户拒绝了所需权限 */
    const val PERMISSION_DENIED = "PERMISSION_DENIED"

    /** 依赖未就绪 */
    const val NOT_READY = "NOT_READY"

    /** 原生或 Rust 内部错误 */
    const val INTERNAL = "INTERNAL"

    /** 超时 */
    const val TIMEOUT = "TIMEOUT"

    /** 调用已被取消 */
    const val CANCELLED = "CANCELLED"

    /** 网络错误 */
    const val NETWORK = "NETWORK"

    /** 输出格式与要覆盖的原图格式不一致（`native.file.overwrite`） */
    const val FORMAT_MISMATCH = "FORMAT_MISMATCH"
}
