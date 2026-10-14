package com.let188.arkli.splash

import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * 启动动画与主页面之间的进程级协调：谁来播、页面是否就绪。
 *
 * 使用示例：冷启动时 `if (SplashGate.claim()) startActivity(...)`；页面挂载后调 `SplashGate.markReady()`。
 */
internal object SplashGate {
    /** 本进程是否已经播过（或决定要播） */
    private val claimed = AtomicBoolean(false)

    /** 页面是否已就绪 */
    private val readyFlow = MutableStateFlow(false)

    /** 页面就绪状态，启动动画据此决定何时退出 */
    val ready: StateFlow<Boolean> get() = readyFlow

    /**
     * 认领播放权，每个进程只有第一次返回 true，热启动、重建都不再播。
     *
     * @return 本次应当播放返回 true
     */
    fun claim(): Boolean = claimed.compareAndSet(false, true)

    /** 页面已挂载，可以揭开启动动画 */
    fun markReady() {
        readyFlow.value = true
    }

    /** 仅测试用：复位状态 */
    internal fun resetForTest() {
        claimed.set(false)
        readyFlow.value = false
    }
}
