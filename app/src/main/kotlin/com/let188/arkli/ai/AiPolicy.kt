package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一次 `native.ai.run` 校验通过的请求。
 *
 * @property provider 提供者 id
 * @property task 任务
 * @property input 输入文本
 */
data class AiRunRequest(val provider: String, val task: AiTask, val input: String)

/**
 * AI 提供者层的纯逻辑：参数校验、可用性汇总、能力合并、结果序列化。无 Android 依赖，可单测。
 *
 * 使用示例：`AiPolicy.parseRun(params)` -> `AiRunRequest("intent-handoff", AiTask.TRANSLATE, "hi")`
 */
object AiPolicy {
    /** 输入文本长度上限，与 `native.intent.processText` 一致 */
    const val MAX_INPUT = 50_000

    /** 提供者 id 长度上限 */
    const val MAX_ID = 64

    /**
     * 解析并校验 `native.ai.run` 的参数。
     *
     * @param params `{ provider: string, task: string, input: string }`
     * @return 校验通过的请求
     * @throws BridgeException BAD_PARAMS：缺字段、类型不对、任务未知、input 为空或超长、任务需要非文本输入
     */
    fun parseRun(params: JSONObject): AiRunRequest {
        val provider = str(params, "provider")
        if (provider.isEmpty() || provider.length > MAX_ID) throw bad("provider 需要 1~$MAX_ID 字符")
        val taskName = str(params, "task")
        val task = AiTask.fromWire(taskName) ?: throw bad("不支持的 task：$taskName")
        val input = str(params, "input")
        if (input.isBlank() || input.length > MAX_INPUT) throw bad("input 需要 1~$MAX_INPUT 字符且不能全是空白")
        if (!task.isText) throw bad("task $taskName 需要非文本输入，当前不支持")
        return AiRunRequest(provider, task, input)
    }

    /**
     * 汇总所有「可用」提供者的任务并集，页面据此决定显示哪些入口。
     *
     * @param providers 提供者列表
     * @return 按枚举顺序排列的任务列表
     */
    fun mergeCapabilities(providers: List<AiProvider>): List<AiTask> {
        val merged = providers.filter { it.availability().available }.flatMap { it.capabilities() }.toSet()
        return AiTask.values().filter { it in merged }
    }

    /**
     * 序列化单个提供者。
     *
     * @param p 提供者
     * @return `{ id, displayName, available, reason?, tasks[], modelId?, downloaded?, sizeBytes?, downloading? }`，
     *   后四项只有本地模型类提供者才有
     */
    fun providerJson(p: AiProvider): JSONObject {
        val a = p.availability()
        val caps = p.capabilities()
        val tasks = JSONArray()
        AiTask.values().filter { it in caps }.forEach { tasks.put(it.wire) }
        val o = JSONObject().put("id", p.id).put("displayName", p.displayName).put("available", a.available)
        a.reason?.let { o.put("reason", it.wire) }
        p.modelInfo()?.let {
            o.put("modelId", it.modelId).put("downloaded", it.downloaded).put("sizeBytes", it.sizeBytes).put("downloading", it.downloading)
        }
        return o.put("tasks", tasks)
    }

    /**
     * 序列化 `native.ai.providers` 的返回值。
     *
     * @param providers 提供者列表（保持注册顺序）
     * @return `{ providers: [...], capabilities: [...] }`
     */
    fun providersJson(providers: List<AiProvider>): JSONObject {
        val arr = JSONArray()
        providers.forEach { arr.put(providerJson(it)) }
        val caps = JSONArray()
        mergeCapabilities(providers).forEach { caps.put(it.wire) }
        return JSONObject().put("providers", arr).put("capabilities", caps)
    }

    /**
     * 序列化执行结果。
     *
     * @param r 提供者返回的结果
     * @return 交接：`{ handoff: true, handled }`；文本：`{ handoff: false, handled: true, text }`
     */
    fun resultJson(r: AiRunResult): JSONObject = when (r) {
        is AiRunResult.Handoff -> JSONObject().put("handoff", true).put("handled", r.handled)
        is AiRunResult.Text -> JSONObject().put("handoff", false).put("handled", true).put("text", r.text)
    }

    /**
     * 检查提供者能否执行任务，不能则抛对应错误。
     *
     * @param provider 提供者，找不到传 null
     * @param req 请求
     * @return 可执行的提供者
     * @throws BridgeException BAD_PARAMS（提供者未知或不支持该任务）、NOT_READY（当前不可用）
     */
    fun requireRunnable(provider: AiProvider?, req: AiRunRequest): AiProvider {
        if (provider == null) throw bad("未知的 provider：${req.provider}")
        if (req.task !in provider.capabilities()) throw bad("${req.provider} 不支持 ${req.task.wire}")
        val a = provider.availability()
        if (!a.available) throw BridgeException(BridgeErrors.NOT_READY, "${req.provider} 当前不可用：${a.reason?.wire}")
        return provider
    }

    /** 取字符串参数，缺失或非字符串返回空串 */
    private fun str(params: JSONObject, key: String): String = (params.opt(key) as? String).orEmpty()

    /** 造 BAD_PARAMS 异常 */
    private fun bad(msg: String) = BridgeException(BridgeErrors.BAD_PARAMS, msg)
}

/**
 * 已注册提供者的登记处，按注册顺序保存。
 *
 * 使用示例：`ProviderRegistry(listOf(IntentHandoffProvider(platform)))`
 *
 * @param initial 初始提供者
 */
class ProviderRegistry(initial: List<AiProvider> = emptyList()) {
    /** 提供者列表 */
    private val items = initial.toMutableList()

    /**
     * 注册一个提供者；id 已存在则替换。
     *
     * @param p 提供者
     */
    @Synchronized
    fun register(p: AiProvider) {
        items.removeAll { it.id == p.id }
        items.add(p)
    }

    /**
     * 取全部提供者的快照。
     *
     * @return 注册顺序的列表
     */
    @Synchronized
    fun all(): List<AiProvider> = items.toList()

    /**
     * 按 id 取提供者。
     *
     * @param id 提供者 id
     * @return 提供者，没有返回 null
     */
    @Synchronized
    fun get(id: String): AiProvider? = items.firstOrNull { it.id == id }
}
