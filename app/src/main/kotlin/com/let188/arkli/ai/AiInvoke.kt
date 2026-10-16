package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.image.SourceResolver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * 一次已做结构校验、待分派的 AI 调用。每个子类对应一个任务端口，输入保持强类型，不做万能字典。
 * `native.ai.invoke` 与旧入口（`run` / `translate` / `classify`）都先变成它，再交给 [AiInvoker.dispatch]。
 *
 * @property task 任务
 * @property provider 指定的提供者 id；null 表示按注册顺序取第一个候选
 * @property port 承接的端口
 */
sealed class AiCall(val task: AiTask, val provider: String?, val port: AiPort<*>) {
    /**
     * 经 run 端口的文本任务。
     *
     * @property text 输入文本（已校验）
     * @property preset 预设；null 表示按任务
     * @property system 页面额外传的 system 提示；只有 prompt 预设允许
     * @property sampling 页面传的采样参数；null 表示沿用预设默认
     */
    class Run(
        task: AiTask,
        provider: String?,
        val text: String,
        val preset: AiPreset? = null,
        val system: String? = null,
        val sampling: AiSamplingParams? = null,
    ) : AiCall(task, provider, AiPort.Run) {
        /** 页面传的文本生成可选项（preset、system、sampling）；一项都没传时为空 */
        val gen: AiGenOptions get() = AiGenOptions(preset, system, sampling)
    }

    /**
     * 带语言对的翻译。
     *
     * @property req 结构已校验的请求（语言按选中提供者的约束另查）
     */
    class Translate(val req: AiTranslateRequest) : AiCall(AiTask.TRANSLATE, req.provider, AiPort.Translate)

    /**
     * 识图。
     *
     * @property req 已校验的请求
     */
    class Classify(val req: AiClassifyRequest) : AiCall(AiTask.CLASSIFY_IMAGE, req.provider, AiPort.Classify)

    /**
     * 文字识别。
     *
     * @property req 已校验的请求
     */
    class Ocr(val req: AiOcrRequest) : AiCall(AiTask.OCR, req.provider, AiPort.Ocr)

    /**
     * 对联。
     *
     * @property req 已校验的请求
     */
    class Couplet(val req: AiCoupletRequest) : AiCall(AiTask.COUPLET, req.provider, AiPort.Couplet)
}

/**
 * `native.ai.invoke` 的参数解析：定端口 + 按端口解析输入。端口**不另写表**，一律由 [AiRouter] 推导：
 * - 传了 `entry`：用 [AiPort.byEntry]（相当于直接调那个旧入口，错误与旧入口一致）；
 * - 只传了 `provider`：用 [AiRouter.portOf]（即 offers 里报的 entry）；
 * - 都没传：用 [AiPort.canonicalFor]（有专用端口走专用端口，否则 run）。
 *
 * 纯逻辑，无 Android 依赖，可单测。
 *
 * 使用示例：`AiInvokePolicy.parse(JSONObject("""{"task":"translate","input":{"text":"hi","src":"en","tgt":"fr"}}"""), providers)`
 */
object AiInvokePolicy {
    /** 参数键：任务 */
    private const val KEY_TASK = "task"

    /** 参数键：输入 */
    private const val KEY_INPUT = "input"

    /** 参数键：附加选项 */
    private const val KEY_OPTIONS = "options"

    /** 参数键：钉死入口 */
    private const val KEY_ENTRY = "entry"

    /** run 端口输入里的文本字段 */
    private const val KEY_TEXT = "text"

    /** 文本生成类选项键：只有 run 端口认，其余端口收到要报错而不是静默丢掉 */
    private val GEN_KEYS = listOf(AiGeneratePolicy.KEY_PRESET, AiGeneratePolicy.KEY_SYSTEM, AiGeneratePolicy.KEY_TEMPERATURE)

    /**
     * 解析 `native.ai.invoke` 的参数并定端口。
     *
     * @param params `{ task: string, input: object, provider?: string, entry?: string, options?: object }`；文本生成类任务的 options 可带 `preset`、`system`、`temperature`、`topK`
     * @param providers 全部提供者（只用来按 id 推导端口，不查可用性）
     * @return 待分派的调用
     * @throws BridgeException BAD_PARAMS：字段缺失或类型不对、task 未知、entry 不是任务入口或与 task 不配、input/options 里有重复键或写了 provider、按端口解析输入失败
     * @example `parse(JSONObject("""{"task":"summarize","provider":"local-qwen","input":{"text":"…"}}"""), all)` 得到 `AiCall.Run`
     */
    fun parse(params: JSONObject, providers: List<AiProvider>): AiCall {
        val task = AiPolicy.parseTask(params)
        val provider = AiPolicy.providerId(params.opt(AiPolicy.KEY_PROVIDER), required = false)
        val input = obj(params, KEY_INPUT, required = true)!!
        val options = obj(params, KEY_OPTIONS, required = false)
        val port = portFor(task, provider, entry(params), providers)
        return toCall(port, task, provider, flatten(input, options, provider))
    }

    /**
     * 定一次调用的端口（不查可用性）。
     *
     * @param task 任务
     * @param provider 指定的提供者 id，可为 null
     * @param entry 钉死的入口方法名，可为 null
     * @param providers 全部提供者
     * @return 端口；provider 不认识或没声明该任务时退回缺省端口，由路由报“未知的 provider”“不支持”（与旧入口同文案）
     * @throws BridgeException BAD_PARAMS：entry 不是任务入口
     */
    fun portFor(task: AiTask, provider: String?, entry: String?, providers: List<AiProvider>): AiPort<*> {
        if (entry != null) return AiPort.byEntry(entry) ?: throw bad("entry 不是任务入口：$entry")
        val p = provider?.let { id -> providers.firstOrNull { it.id == id } }?.takeIf { task in it.capabilities() }
        return if (p != null) AiRouter.portOf(p, task) else AiPort.canonicalFor(task)
    }

    /**
     * 按端口把扁平参数解析成强类型调用：专用端口复用各自旧入口的 parse，保证校验完全一致。
     *
     * @param port 端口
     * @param task 任务
     * @param provider 提供者 id
     * @param flat 扁平参数（input + options + provider）
     * @return 调用
     * @throws BridgeException BAD_PARAMS：任务与专用端口不配、输入不合法
     */
    private fun toCall(port: AiPort<*>, task: AiTask, provider: String?, flat: JSONObject): AiCall {
        if (port.task != null && port.task != task) throw bad("${task.wire} 不走 ${port.entry}")
        rejectGenOptions(port, flat)
        return when (port) {
            AiPort.Run -> {
                val gen = AiGeneratePolicy.parse(flat)
                AiCall.Run(task, provider, AiPolicy.checkRunText(task, flat.opt(KEY_TEXT) as? String ?: ""), gen.preset, gen.system, gen.sampling)
            }
            AiPort.Translate -> AiCall.Translate(AiTranslatePolicy.parse(flat))
            AiPort.Classify -> AiCall.Classify(AiClassifyPolicy.parse(flat))
            AiPort.Ocr -> AiCall.Ocr(AiOcrPolicy.parse(flat))
            AiPort.Couplet -> AiCall.Couplet(AiCoupletPolicy.parse(flat))
            AiPort.Session -> throw bad("${port.entry} 不是任务入口")
        }
    }

    /**
     * 非 run 端口不认文本生成选项：preset / system / temperature 任何端口都不认，topK 只有识图认（前 K 个类别）。
     * 与 [AiGeneratePolicy] “不静默忽略”一致。
     */
    private fun rejectGenOptions(port: AiPort<*>, flat: JSONObject) {
        if (port == AiPort.Run) return
        val keys = when (port) {
            AiPort.Classify -> GEN_KEYS
            // 对联认 temperature 与 topK（自己的范围校验），不认 preset / system
            AiPort.Couplet -> GEN_KEYS - AiGeneratePolicy.KEY_TEMPERATURE
            else -> GEN_KEYS + AiGeneratePolicy.KEY_TOP_K
        }
        val hit = keys.firstOrNull { flat.has(it) && flat.opt(it) != JSONObject.NULL } ?: return
        throw bad("${port.entry} 不支持 $hit，这是文本生成的选项")
    }

    /** 读可选的 entry 字段 */
    private fun entry(params: JSONObject): String? = when (val v = params.opt(KEY_ENTRY)) {
        null, JSONObject.NULL -> null
        is String -> v
        else -> throw bad("entry 需要是字符串")
    }

    /** 读对象字段；必填缺省或类型不对报 BAD_PARAMS */
    private fun obj(params: JSONObject, key: String, required: Boolean): JSONObject? = when (val v = params.opt(key)) {
        is JSONObject -> v
        null, JSONObject.NULL -> if (required) throw bad("$key 需要是对象") else null
        else -> throw bad("$key 需要是对象")
    }

    /** 把 input 与 options 拼成旧入口的扁平参数，provider 只认顶层的 */
    private fun flatten(input: JSONObject, options: JSONObject?, provider: String?): JSONObject {
        val flat = JSONObject()
        for (src in listOfNotNull(input, options)) {
            for (k in src.keys()) {
                if (k == AiPolicy.KEY_PROVIDER) throw bad("provider 只能写在顶层")
                if (flat.has(k)) throw bad("input 与 options 有重复的键：$k")
                flat.put(k, src.get(k))
            }
        }
        if (provider != null) flat.put(AiPolicy.KEY_PROVIDER, provider)
        return flat
    }

    /** 造 BAD_PARAMS 异常 */
    private fun bad(msg: String) = BridgeException(BridgeErrors.BAD_PARAMS, msg)
}

/**
 * 一次调用的去向（[AiInvoker.plan] 的结果）。
 *
 * @property provider 选中的提供者
 * @property port 承接的端口
 */
data class AiPlan(val provider: AiProvider, val port: AiPort<*>)

/**
 * AI 调用的分派器：`native.ai.invoke` 与旧入口共用。固定流程——选提供者（[AiRouter.select]）→ 按它报价里的约束校验输入
 * （[AiConstraints.check]）→ 查可用性（NOT_READY）→ 调强类型端口 → 按端口序列化。重活排 [AiHeavyGate]（在各服务里），
 * 跑在 IO 线程；取消沿用桥的 `native.task.cancel`（取消本协程）。
 *
 * 使用示例：`AiInvoker({ registry.all() }, resolver).invoke(params)`
 *
 * @param providers 取当前全部提供者（注册顺序）
 * @param resolver 页面缓存路径解析器（识图用），必须拒绝路径穿越
 */
class AiInvoker(private val providers: () -> List<AiProvider>, private val resolver: SourceResolver) {
    private companion object {
        /** 页面传的路径解析不到缓存图片时的提示 */
        const val BAD_IMAGE_PATH = "path 不是有效的缓存图片路径"
    }

    /**
     * 处理 `native.ai.invoke`。
     *
     * @param params `{ task, input, provider?, entry?, options? }`
     * @return 该端口的结果 JSON（与对应旧入口完全相同）
     * @throws BridgeException BAD_PARAMS / NOT_READY / INTERNAL，语义同旧入口
     */
    suspend fun invoke(params: JSONObject): JSONObject = dispatch(AiInvokePolicy.parse(params, providers()))

    /**
     * 只定路由不执行：invoke 会把这次调用交给哪个提供者的哪个端口（不查可用性、不校验约束）。
     * 供契约测试与调试用，与 [dispatch] 同一套解析与选择。
     *
     * @param params `native.ai.invoke` 的参数
     * @return 去向
     * @throws BridgeException BAD_PARAMS
     */
    fun plan(params: JSONObject): AiPlan {
        val all = providers()
        val call = AiInvokePolicy.parse(params, all)
        return AiPlan(AiRouter.select(all, call.task, call.port, call.provider, generative = isGenerative(call)).provider, call.port)
    }

    /**
     * 分派一次已解析的调用。
     *
     * @param call 调用
     * @return 结果 JSON：run 为 [AiPolicy.resultJson]，翻译为 [AiTranslatePolicy.resultJson]，识图为 [AiClassifyPolicy.resultJson]，文字识别为 [AiOcrPolicy.resultJson]，对联为 [AiCoupletPolicy.resultJson]
     * @throws BridgeException BAD_PARAMS（路由失败、超出约束、路径无效）、NOT_READY、INTERNAL
     */
    suspend fun dispatch(call: AiCall): JSONObject = when (call) {
        is AiCall.Run -> {
            val p = route(call, AiPort.Run).port
            AiPolicy.resultJson(runOnIo(p, call))
        }
        is AiCall.Translate -> {
            val t = route(call, AiPort.Translate).port
            AiTranslatePolicy.resultJson(withContext(Dispatchers.IO) { t.translate(call.req) })
        }
        is AiCall.Classify -> {
            val c = route(call, AiPort.Classify).port
            val file = resolver.resolve(call.req.path)?.takeIf { it.isFile }
                ?: throw BridgeException(BridgeErrors.BAD_PARAMS, BAD_IMAGE_PATH)
            AiClassifyPolicy.resultJson(withContext(Dispatchers.IO) { c.classify(file, call.req.topK) })
        }
        is AiCall.Ocr -> {
            val o = route(call, AiPort.Ocr).port
            val file = resolver.resolve(call.req.path)?.takeIf { it.isFile }
                ?: throw BridgeException(BridgeErrors.BAD_PARAMS, BAD_IMAGE_PATH)
            AiOcrPolicy.resultJson(withContext(Dispatchers.IO) { o.recognize(file) })
        }
        is AiCall.Couplet -> {
            val c = route(call, AiPort.Couplet).port
            AiCoupletPolicy.resultJson(withContext(Dispatchers.IO) { c.generate(call.req) })
        }
    }

    /**
     * run 端口在 IO 线程上跑（其余端口也一样）。Qwen 生成可被取消：服务内部用 [runCancellable] 在协程被取消时
     * 通知引擎在下一个 token 处中止（预填充阶段不可打断），闸门随之释放。
     */
    private suspend fun runOnIo(p: AiProvider, call: AiCall.Run): AiRunResult = withContext(Dispatchers.IO) { runText(p, call) }

    /** 没带可选项走旧的 run；带了就必须由 [TextGenerator] 承接（路由阶段已保证，这里再兜底一次） */
    private suspend fun runText(p: AiProvider, call: AiCall.Run): AiRunResult {
        if (call.gen.isEmpty) return p.run(call.task, call.text)
        val g = p as? TextGenerator ?: throw notGenerative(p.id)
        return g.generate(call.task, call.text, call.gen)
    }

    /** 是不是带了生成类可选项的 run 调用（缺省选提供者时要选能生成的） */
    private fun isGenerative(call: AiCall): Boolean = call is AiCall.Run && !call.gen.isEmpty

    /** 提供者不支持预设、system、采样参数时的错误 */
    private fun notGenerative(id: String) =
        BridgeException(BridgeErrors.BAD_PARAMS, "$id 不支持 preset / system / temperature / topK，请去掉这些选项")

    /** 选提供者 → 约束校验 → 查可用性 */
    private fun <T : Any> route(call: AiCall, port: AiPort<T>): AiRoute<T> {
        val r = AiRouter.select(providers(), call.task, port, call.provider, generative = isGenerative(call))
        val constraints = AiRouter.offerOf(r.provider, call.task)?.constraints
        constraints?.check(call)
        // 非生成式提供者（报价没带 Generate 约束）不能静默吞掉预设 / system / 采样参数
        if (call is AiCall.Run && !call.gen.isEmpty && constraints !is AiConstraints.Generate) throw notGenerative(r.provider.id)
        AiRouter.requireAvailable(r.provider)
        return r
    }
}
