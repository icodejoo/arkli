package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一次预热的结果。
 *
 * @property provider 提供者 id
 * @property elapsedMs 耗时（毫秒）；此前已加载则接近 0
 */
data class WarmupResult(val provider: String, val elapsedMs: Long)

/**
 * 持有本地模型会话、可以预热与卸载的提供者（`local-nllb`、`local-clip`）。
 * 两个操作都排在 [AiHeavyGate] 后执行，不会打断正在进行的推理。
 *
 * 使用示例：`(provider as AiSessionControl).warmup()`
 */
interface AiSessionControl {
    /**
     * 只加载模型会话，不做推理。已加载则立刻返回；被取消时不会留下半加载状态（加载中被取消会在加载完后卸掉）。
     *
     * @return 预热结果
     * @throws BridgeException NOT_READY（模型未安装）、INTERNAL（加载失败）
     */
    suspend fun warmup(): WarmupResult

    /**
     * 卸载已加载的会话，幂等。
     *
     * @return 此前确实加载过返回 true，本来就没加载返回 false
     */
    suspend fun unloadSession(): Boolean
}

/**
 * 预热/卸载的纯逻辑：参数校验、提供者判定、响应组装、批量卸载、系统内存回收判定。无 Android 依赖，可单测。
 *
 * 使用示例：`AiLifecyclePolicy.parseWarmup(JSONObject("""{"provider":"local-nllb"}"""))`
 */
object AiLifecyclePolicy {
    /** 参数键：提供者 id */
    private const val KEY_PROVIDER = "provider"

    /** 系统内存回收级别：前台但内存非常紧张（`TRIM_MEMORY_RUNNING_CRITICAL`） */
    const val TRIM_RUNNING_CRITICAL = 15

    /** 系统内存回收级别：后台进程排在最易被杀的位置（`TRIM_MEMORY_COMPLETE`） */
    const val TRIM_COMPLETE = 80

    /**
     * 解析 `native.ai.warmup` 的参数。
     *
     * @param params `{ provider: string }`
     * @return 提供者 id
     * @throws BridgeException BAD_PARAMS：provider 缺失或不是字符串
     */
    fun parseWarmup(params: JSONObject): String =
        params.opt(KEY_PROVIDER) as? String ?: throw bad("provider 需要是字符串")

    /**
     * 解析 `native.ai.unload` 的参数。
     *
     * @param params `{ provider?: string }`
     * @return 提供者 id；缺省或 null 表示卸载全部
     * @throws BridgeException BAD_PARAMS：provider 不是字符串
     */
    fun parseUnload(params: JSONObject): String? = when (val v = params.opt(KEY_PROVIDER)) {
        null, JSONObject.NULL -> null
        is String -> v
        else -> throw bad("provider 需要是字符串")
    }

    /**
     * 选出要预热的提供者并检查可用性。
     *
     * @param providers 全部提供者
     * @param id 请求的提供者 id
     * @return 可预热的提供者及其会话控制
     * @throws BridgeException BAD_PARAMS（不认识或不支持预热）、NOT_READY（模型未安装，message 带 not_installed）
     */
    fun requireWarmable(providers: List<AiProvider>, id: String): Pair<AiProvider, AiSessionControl> {
        val provider = providers.firstOrNull { it.id == id } ?: throw bad("不认识的 provider：$id")
        val control = provider as? AiSessionControl ?: throw bad("$id 不支持预热")
        val a = provider.availability()
        if (!a.available) throw BridgeException(BridgeErrors.NOT_READY, "$id 当前不可用：${a.reason?.wire}")
        return provider to control
    }

    /**
     * 选出要卸载的会话。
     *
     * @param providers 全部提供者
     * @param id 提供者 id；null 表示全部持有会话的提供者
     * @return （提供者 id，会话控制）列表，按注册顺序
     * @throws BridgeException BAD_PARAMS：指定的 id 不认识或不持有会话
     */
    fun selectSessions(providers: List<AiProvider>, id: String?): List<Pair<String, AiSessionControl>> {
        if (id == null) return providers.filterIsInstance<AiSessionControl>().map { (it as AiProvider).id to it }
        val provider = providers.firstOrNull { it.id == id } ?: throw bad("不认识的 provider：$id")
        val control = provider as? AiSessionControl ?: throw bad("$id 没有可卸载的会话")
        return listOf(id to control)
    }

    /**
     * 依次卸载一批会话；某一个失败不影响其余，失败的不计入结果。
     *
     * @param sessions （提供者 id，会话控制）列表
     * @return 实际卸掉的提供者 id（此前没加载的、卸载失败的不在内）
     */
    suspend fun unloadAll(sessions: List<Pair<String, AiSessionControl>>): List<String> {
        val done = ArrayList<String>()
        for ((id, control) in sessions) {
            val was = try {
                control.unloadSession()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                false
            }
            if (was) done += id
        }
        return done
    }

    /**
     * 序列化预热结果。
     *
     * @param r 预热结果
     * @return `{ provider, loaded: true, elapsedMs }`
     */
    fun warmupJson(r: WarmupResult): JSONObject =
        JSONObject().put(KEY_PROVIDER, r.provider).put("loaded", true).put("elapsedMs", r.elapsedMs)

    /**
     * 序列化卸载结果。
     *
     * @param unloaded 实际卸掉的提供者 id
     * @return `{ unloaded: string[] }`
     */
    fun unloadJson(unloaded: List<String>): JSONObject = JSONObject().put("unloaded", JSONArray(unloaded))

    /**
     * 系统内存回收回调该不该卸载 AI 会话：前台极度紧张或后台最易被杀时卸载，普通的 UI 隐藏不卸载。
     *
     * @param level `onTrimMemory` 的级别
     * @return 该卸载返回 true
     */
    fun shouldReleaseOnTrim(level: Int): Boolean = level == TRIM_RUNNING_CRITICAL || level >= TRIM_COMPLETE

    /** 造 BAD_PARAMS 异常 */
    private fun bad(msg: String) = BridgeException(BridgeErrors.BAD_PARAMS, msg)
}
