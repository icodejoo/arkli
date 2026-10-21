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

    /** 非 [AiProvider] 的额外可回收项（如语音识别器）：id 到卸载函数，卸载函数返回是否真的卸掉了 */
    private val extras = java.util.concurrent.ConcurrentHashMap<String, suspend () -> Boolean>()

    /**
     * 登记一个不属于提供者的可回收项；同 id 重复登记以最后一次为准。
     *
     * @param id 回收日志里显示的名字
     * @param unload 卸载函数，真的卸掉了返回 true
     */
    fun attachExtra(id: String, unload: suspend () -> Boolean) {
        extras[id] = unload
    }

    /**
     * 取消登记一个额外可回收项（单测清理用；没登记过则什么都不做）。
     *
     * @param id [attachExtra] 用过的名字
     */
    fun detachExtra(id: String) {
        extras.remove(id)
    }

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
    suspend fun releaseNow(): List<String> {
        val done = AiLifecyclePolicy.unloadAll(sessions).toMutableList()
        for ((id, unload) in extras) if (runCatching { unload() }.getOrDefault(false)) done.add(id)
        return done
    }

    /**
     * 卸载除 [keepId] 以外的全部已登记会话：大模型加载前先让位（如 logo 生成前卸掉常驻的 Qwen）。
     * 额外可回收项（语音识别器等）不动。
     *
     * @param keepId 要保留的提供者 id
     * @return 实际卸掉的提供者 id
     */
    suspend fun releaseExcept(keepId: String): List<String> =
        AiLifecyclePolicy.unloadAll(sessions.filter { it.first != keepId })

    /**
     * 异步卸载全部已加载的 AI 会话，立刻返回。
     *
     * @param reason 触发原因，只写日志
     */
    fun releaseAll(reason: String) {
        if (sessions.isEmpty() && extras.isEmpty()) return
        scope.launch {
            val done = releaseNow()
            Log.i(AI_LOG_TAG, "回收 AI 会话（$reason）：已卸载 $done")
        }
    }
}
