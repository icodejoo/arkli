package com.let188.arkli.bridge

import java.util.concurrent.atomic.AtomicInteger

/**
 * 页面会话号发生器：进程内单调递增，每建一个 WebView（首次、重载、崩溃重建）取一个新号。
 *
 * 使用示例：`val session = BridgeSessions.next()`
 */
object BridgeSessions {
    /** 当前已发出的最大会话号 */
    private val counter = AtomicInteger(0)

    /**
     * 取下一个会话号。
     *
     * @return 从 1 开始递增的会话号
     */
    fun next(): Int = counter.incrementAndGet()
}
