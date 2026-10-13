package com.let188.arkli.files

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred

/**
 * 单槽位的"等结果"登记：同一时刻只允许一个等待者，用于系统选择器、权限弹窗这类一次只能开一个的交互。
 * 不依赖 android，纯 JVM 可测。
 *
 * 使用示例：
 * ```
 * val slot = PendingSlot<Boolean>("已有权限申请在进行")
 * val result = slot.await { launchSomething() }   // 结果由回调里的 slot.complete(true) 送达
 * ```
 *
 * @param busyMessage 槽位被占用时 NOT_READY 的提示
 */
class PendingSlot<T>(private val busyMessage: String) {
    /** 当前等待者，空表示空闲 */
    private var current: CompletableDeferred<T>? = null

    /**
     * 占住槽位、执行 [launch]、等结果。launch 抛异常时槽位一定释放；协程被取消时是否释放由
     * [releaseOnCancel] 决定。
     *
     * @param releaseOnCancel 取消等待时是否立刻释放槽位。界面仍在屏幕上、结果还会到达的交互（如选择器）
     *   传 false，由 [complete] 释放，免得旧结果被下一个等待者误收
     * @param launch 拉起交互的动作，通常要切到主线程
     * @return 交互结果
     * @throws BridgeException 槽位已被占用（NOT_READY）
     */
    suspend fun await(releaseOnCancel: Boolean = true, launch: suspend () -> Unit): T {
        val wait = CompletableDeferred<T>()
        synchronized(this) {
            if (current != null) throw BridgeException(BridgeErrors.NOT_READY, busyMessage)
            current = wait
        }
        try {
            launch()
            return wait.await()
        } catch (e: CancellationException) {
            if (releaseOnCancel) release(wait)
            throw e
        } catch (e: Throwable) {
            release(wait)
            throw e
        }
    }

    /** 只清自己占的槽，避免误删后来者 */
    private fun release(wait: CompletableDeferred<T>) {
        synchronized(this) { if (current === wait) current = null }
    }

    /**
     * 送达结果并释放槽位；没人在等（协程已取消）就丢弃。
     *
     * @param value 交互结果
     */
    fun complete(value: T) {
        val wait = synchronized(this) { current.also { current = null } }
        wait?.complete(value)
    }

    /**
     * 当前是否有等待者。
     *
     * @return 有则 true
     */
    fun isBusy(): Boolean = synchronized(this) { current != null }
}
