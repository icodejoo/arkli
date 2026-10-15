package com.let188.arkli.ai

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** AI 回收日志 tag（真机用 logcat 过滤它确认卸载被调用） */
private const val AI_LOG_TAG = "ArkliAi"

/**
 * 进程级的 AI 会话回收入口：退出 App、系统内存告急时尽力卸载翻译、识物与文本模型会话。
 *
 * 在进程级协程里排在 [AiHeavyGate] 后执行：不阻塞主线程，也不打断正在跑的推理；
 * 页面（WebView 会话）销毁不会调用这里，所以不会误伤别的会话。从没加载过（没创建过服务）则什么都不做。
 *
 * 使用示例：`AiRecycle.releaseAll("activity-finish")`
 */
object AiRecycle {
    /** 进程级协程域，不随 Activity 取消 */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * 异步卸载全部已加载的 AI 会话，立刻返回。
     *
     * @param reason 触发原因，只写日志
     */
    fun releaseAll(reason: String) {
        val sessions = listOfNotNull(
            TranslateRuntime.peek()?.let { LocalNllbProvider.ID to AiServiceControl { it.unload() } },
            ClipRuntime.peek()?.let { LocalClipProvider.ID to AiServiceControl { it.unload() } },
            QwenRuntime.peek()?.let { LocalQwenProvider.ID to AiServiceControl { it.unload() } },
        )
        if (sessions.isEmpty()) return
        scope.launch {
            val done = AiLifecyclePolicy.unloadAll(sessions)
            Log.i(AI_LOG_TAG, "回收 AI 会话（$reason）：已卸载 $done")
        }
    }
}

/**
 * 只带卸载动作的会话控制，供 [AiRecycle] 直接包装服务（不经提供者）。
 *
 * @param unload 卸载动作，返回此前是否加载过
 */
private class AiServiceControl(private val unload: suspend () -> Boolean) : AiSessionControl {
    /** 回收入口不会预热 */
    override suspend fun warmup(): WarmupResult = throw UnsupportedOperationException("回收入口不预热")

    /** 转交卸载动作 */
    override suspend fun unloadSession(): Boolean = unload()
}
