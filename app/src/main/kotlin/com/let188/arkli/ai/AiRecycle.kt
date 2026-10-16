package com.let188.arkli.ai

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** AI 回收日志 tag（真机用 logcat 过滤它确认卸载被调用） */
private const val AI_LOG_TAG = "ArkliAi"

/**
 * 进程级的 AI 会话回收入口：退出 App、系统内存告急时尽力卸载全部模型会话。
 *
 * **回收谁不在这里写**：`AiModule.install` 把登记的提供者交给 [attach]，回收时取其中实现了 [AiSessionControl] 的
 * （经 [AiLifecyclePolicy.selectSessions]，与 `native.ai.unload` 缺省卸全部是同一个选择）。新增会话类提供者只要登记进
 * `AiModule.providers`，不用改这里。
 *
 * 在进程级协程里排在 [AiHeavyGate] 后执行：不阻塞主线程，也不打断正在跑的推理；
 * 页面（WebView 会话）销毁不会调用这里，所以不会误伤别的会话。还没装过 AI 模块（没有提供者）则什么都不做。
 *
 * 使用示例：`AiRecycle.releaseAll("activity-finish")`
 */
object AiRecycle {
    /** 进程级协程域，不随 Activity 取消 */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * 最近一次登记的会话（只留会话控制，不留整个提供者列表，免得长期攥着交接平台里的 Activity 宿主）。
     * 会话背后的服务是进程单例，任一会话装出来的都能卸到同一份模型。
     */
    @Volatile
    private var sessions: List<Pair<String, AiSessionControl>> = emptyList()

    /**
     * 登记当前的提供者；重复调用以最后一次为准。
     *
     * @param providers `AiModule.providers(...)` 的结果
     */
    fun attach(providers: List<AiProvider>) {
        sessions = AiLifecyclePolicy.selectSessions(providers, null)
    }

    /**
     * 立刻（在当前协程里）卸载全部已登记的会话。
     *
     * @return 实际卸掉的提供者 id
     */
    suspend fun releaseNow(): List<String> = AiLifecyclePolicy.unloadAll(sessions)

    /**
     * 异步卸载全部已加载的 AI 会话，立刻返回。
     *
     * @param reason 触发原因，只写日志
     */
    fun releaseAll(reason: String) {
        if (sessions.isEmpty()) return
        scope.launch {
            val done = releaseNow()
            Log.i(AI_LOG_TAG, "回收 AI 会话（$reason）：已卸载 $done")
        }
    }
}
