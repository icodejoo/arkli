package com.let188.arkli.bridge

import kotlinx.coroutines.CoroutineScope

/**
 * 一次调用的上下文，交给处理器使用。
 *
 * @property session 页面会话号，WebView 重建后递增
 * @property requestId 页面生成的请求 id
 * @property isMainFrame 消息是否来自主 frame；敏感方法应只接受主 frame
 */
class CallContext internal constructor(
    val session: Int,
    val requestId: String,
    val isMainFrame: Boolean,
    private val bridge: ArkliBridge,
) {
    /**
     * 向页面推一个事件。会话已关闭时静默丢弃。
     *
     * @param event 事件名，如 `task.progress`
     * @param data 事件数据，可为 null
     * @param sub 订阅号，订阅类方法返回的 `sub`，页面据此分流
     */
    fun emit(event: String, data: Any? = null, sub: String? = null) = bridge.emit(event, data, sub)

    /**
     * 启动一个随会话存活的后台任务，用于"先回 `{ taskId }` 再推事件"。
     * 页面可用 `native.task.cancel { id: taskId }` 取消；会话关闭时自动取消。
     * 块里抛出的非取消异常会转成 `task.error` 事件。
     *
     * @param block 任务体
     * @return 任务号，应放进响应的 data 里
     */
    fun launchTask(block: suspend CoroutineScope.() -> Unit): String = bridge.launchTask(block)
}
