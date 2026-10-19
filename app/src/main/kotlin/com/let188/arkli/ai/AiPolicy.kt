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

    /** 参数键：提供者 id */
    const val KEY_PROVIDER = "provider"

    /** 参数键：页面缓存路径 */
    const val KEY_PATH = "path"

    /** 路径长度上限 */
    const val MAX_PATH = 1024

    /**
     * 解析并校验 `native.ai.run` 的参数。
     *
     * @param params `{ provider: string, task: string, input: string }`
     * @return 校验通过的请求
     * @throws BridgeException BAD_PARAMS：缺字段、类型不对、任务未知、input 为空或超长、任务需要非文本输入
     */
    fun parseRun(params: JSONObject): AiRunRequest {
        val provider = providerId(params.opt(KEY_PROVIDER), required = true)!!
        val task = parseTask(params)
        return AiRunRequest(provider, task, checkRunText(task, str(params, "input")))
    }

    /**
     * 解析 `task` 字段（`native.ai.run` 与 `native.ai.invoke` 共用）。
     *
     * @param params 含 `task` 的参数
     * @return 任务
     * @throws BridgeException BAD_PARAMS：缺失、不是字符串或不认识
     */
    fun parseTask(params: JSONObject): AiTask {
        val taskName = str(params, "task")
        return AiTask.fromWire(taskName) ?: throw bad("不支持的 task：$taskName")
    }

    /**
     * 校验经 run 端口执行的文本输入（`native.ai.run` 的 `input`、`native.ai.invoke` 的 `input.text` 共用）。
     *
     * @param task 任务
     * @param input 文本
     * @return 原样返回的文本
     * @throws BridgeException BAD_PARAMS：为空、全是空白、超过 [MAX_INPUT]，或任务要非文本输入
     */
    fun checkRunText(task: AiTask, input: String): String {
        if (input.isBlank() || input.length > MAX_INPUT) throw bad("input 需要 1~$MAX_INPUT 字符且不能全是空白")
        if (!task.isText) throw bad("task ${task.wire} 需要非文本输入，当前不支持")
        return input
    }

    /**
     * 校验页面缓存路径字段（识图、文字识别等以图片为输入的入口共用）。
     *
     * @param params 含 `path` 的参数
     * @return 页面缓存路径，如 `cache/pick/a.jpg`（是否真在缓存里由路径解析器另查）
     * @throws BridgeException BAD_PARAMS：不是字符串，或不在 1~[MAX_PATH] 字符
     */
    fun pagePath(params: JSONObject): String {
        val path = params.opt(KEY_PATH) as? String ?: throw bad("path 需要是字符串")
        if (path.isBlank() || path.length > MAX_PATH) throw bad("path 需要 1~$MAX_PATH 字符")
        return path
    }

    /**
     * 校验提供者 id 字段。
     *
     * @param v 原始值（缺省为 null 或 [JSONObject.NULL]）
     * @param required 是否必填
     * @return id；选填且缺省时为 null
     * @throws BridgeException BAD_PARAMS：不是 1~[MAX_ID] 字符的字符串，或必填却缺省
     */
    fun providerId(v: Any?, required: Boolean): String? {
        if (!required && (v == null || v == JSONObject.NULL)) return null
        val s = v as? String
        if (s.isNullOrEmpty() || s.length > MAX_ID) throw bad("provider 需要 1~$MAX_ID 字符")
        return s
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
     * @return `{ id, displayName, layer, available, reason?, session, tasks[], offers[], modelId?, downloaded?, sizeBytes?, downloading? }`，
     *   modelId 等四项只有本地模型类提供者才有；offers 每项 `{ task, entry, constraints? }`；
     *   session 表示持有可预热/卸载的会话（实现了 [AiSessionControl]），前端据此决定要不要预热
     */
    fun providerJson(p: AiProvider): JSONObject {
        val a = p.availability()
        val caps = p.capabilities()
        val tasks = JSONArray()
        AiTask.values().filter { it in caps }.forEach { tasks.put(it.wire) }
        val o = JSONObject().put("id", p.id).put("displayName", p.displayName).put("layer", p.layer.wire).put("available", a.available)
            .put("session", AiPort.Session.bind(p) != null)
        a.reason?.let { o.put("reason", it.wire) }
        p.modelInfo()?.let {
            o.put("modelId", it.modelId).put("downloaded", it.downloaded).put("sizeBytes", it.sizeBytes).put("downloading", it.downloading)
        }
        (p as? AiTunable)?.paramSpecs()?.takeIf { it.isNotEmpty() }?.let { specs ->
            o.put("params", JSONArray(specs.map { it.toJson() }))
        }
        return o.put("tasks", tasks).put("offers", offersJson(p))
    }

    /**
     * 序列化提供者的报价，入口由 [AiRouter.entryOf] 按实现推导。
     *
     * @param p 提供者
     * @return `[{ task, entry, constraints? }]`
     */
    fun offersJson(p: AiProvider): JSONArray {
        val arr = JSONArray()
        p.offers().forEach { offer ->
            val o = JSONObject().put("task", offer.task.wire).put("entry", AiRouter.entryOf(p, offer.task))
            offer.constraints?.let { o.put("constraints", it.toJson()) }
            arr.put(o)
        }
        return arr
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
