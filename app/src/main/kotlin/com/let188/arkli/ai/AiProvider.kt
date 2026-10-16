package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject

/**
 * AI 任务种类。页面只认任务，不认厂商；各提供者各自声明支持哪些。
 *
 * @property wire 桥协议里的字符串名
 * @property isText 是否是纯文本输入类任务
 */
enum class AiTask(val wire: String, val isText: Boolean) {
    /** 摘要 */
    SUMMARIZE("summarize", true),

    /** 校对 / 纠错 */
    PROOFREAD("proofread", true),

    /** 改写 */
    REWRITE("rewrite", true),

    /** 看图说话（输入是图片，契约预留，当前没有提供者支持） */
    DESCRIBE_IMAGE("describeImage", false),

    /** 自由提示词问答 */
    PROMPT("prompt", true),

    /** 翻译 */
    TRANSLATE("translate", true),

    /** 图像分类识物（输入是图片，走 `native.ai.classify`，不走 `native.ai.run`） */
    CLASSIFY_IMAGE("classifyImage", false),

    /** 文字识别（输入是图片，走 `native.ai.ocr`，不走 `native.ai.run`） */
    OCR("ocr", false),

    /** 对联（文本生成类，但参数与结果强类型，走专用端口 `native.ai.couplet`，不走 `native.ai.run`） */
    COUPLET("couplet", false);

    companion object {
        /**
         * 按桥协议名查任务。
         *
         * @param wire 协议名，如 `summarize`
         * @return 对应任务，不认识返回 null
         */
        fun fromWire(wire: String): AiTask? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * 提供者不可用的原因。
 *
 * @property wire 桥协议里的字符串名
 */
enum class AiUnavailableReason(val wire: String) {
    /** 系统里没有能接手文本的应用（交接类提供者） */
    NO_HANDLER("no_handler"),

    /** 设备或系统版本不支持（端侧模型类提供者，如 ML Kit GenAI 要白名单机型） */
    UNSUPPORTED_DEVICE("unsupported_device"),

    /** 模型或运行时还没下载 / 安装 */
    NOT_INSTALLED("not_installed"),

    /** 需要用户配置（如在线服务的 Key） */
    NOT_CONFIGURED("not_configured"),
}

/**
 * 提供者当前是否可用。
 *
 * @property available 是否可用
 * @property reason 不可用时的原因；可用时为 null
 */
data class AiAvailability(val available: Boolean, val reason: AiUnavailableReason? = null) {
    companion object {
        /** 可用 */
        val AVAILABLE = AiAvailability(true)

        /**
         * 构造不可用结果。
         *
         * @param reason 不可用原因
         */
        fun unavailable(reason: AiUnavailableReason) = AiAvailability(false, reason)
    }
}

/**
 * 本地模型类提供者的下载状态，序列化进 `native.ai.providers` 的提供者条目。
 *
 * @property modelId 清单里的模型 id，对应 `native.model.*`
 * @property downloaded 模型已安装且校验通过
 * @property sizeBytes 磁盘占用（含未完成的 .part）
 * @property downloading 是否正在下载或校验
 */
data class AiModelInfo(val modelId: String, val downloaded: Boolean, val sizeBytes: Long, val downloading: Boolean)

/**
 * 提供者所属的 AI 层（决策 0005 的四层），前端选择器按层排序与分组。
 *
 * @property wire 桥协议里的字符串名
 */
enum class AiLayer(val wire: String) {
    /** 本地小模型：专用任务的小模型（识物、NLLB 翻译、OCR……），按需下载 */
    L1("L1"),

    /** 本地大模型：通用生成式 LLM（Qwen），按需下载 */
    L2("L2"),

    /** 本机 AI：系统提供的能力，含交接型 */
    L3("L3"),

    /** 远端 API：在线大模型（未接入） */
    L4("L4"),
}

/**
 * 一项任务的附加约束，随 offer 序列化给前端，前端不再自己写一份；分派时也按它校验输入（同一份数据，两头一致）。
 */
sealed class AiConstraints {
    /**
     * 序列化成 JSON。
     *
     * @return 约束对象
     */
    abstract fun toJson(): JSONObject

    /**
     * 按本约束校验一次调用的输入。分派时在选中提供者之后、查可用性之前调用；与本约束无关的调用直接放行。
     *
     * @param call 已做结构校验的调用
     * @throws com.let188.arkli.bridge.BridgeException BAD_PARAMS：输入超出约束
     */
    abstract fun check(call: AiCall)

    /**
     * 翻译约束：语言对从哪些语言里选、源语言能否写 auto。
     *
     * @property languages 支持的应用语言码（非空）
     * @property sourceAuto 源语言可否为 `auto`
     * @property maxChars 该提供者能译的原文字数上限，缺省与入口上限 [AiTranslatePolicy.MAX_TEXT] 相同
     * @property allowNumBeams 是否接受束宽 `numBeams`（束搜索是 NLLB 的参数，Qwen 没有，传了就报错而不是静默忽略）
     * @example `AiConstraints.Translate(AiTranslatePolicy.LANGS, sourceAuto = true, maxChars = 300, allowNumBeams = false)`
     */
    data class Translate(
        val languages: List<String>,
        val sourceAuto: Boolean,
        val maxChars: Int = AiTranslatePolicy.MAX_TEXT,
        val allowNumBeams: Boolean = true,
    ) : AiConstraints() {
        /** `{ languages: [...], sourceAuto, maxChars, allowNumBeams }` */
        override fun toJson(): JSONObject = JSONObject().put("languages", JSONArray(languages)).put("sourceAuto", sourceAuto)
            .put("maxChars", maxChars).put("allowNumBeams", allowNumBeams)

        /** 只查带语言对的翻译调用：原文不超过 [maxChars]、numBeams 要 [allowNumBeams]，src/tgt 必须在 [languages] 里，src 为 auto 要 [sourceAuto] 为真 */
        override fun check(call: AiCall) {
            if (call !is AiCall.Translate) return
            if (call.req.text.length > maxChars) {
                throw BridgeException(BridgeErrors.BAD_PARAMS, "该模型最多翻译 $maxChars 字，请改用本地翻译模型")
            }
            if (call.req.numBeams != null && !allowNumBeams) {
                throw BridgeException(BridgeErrors.BAD_PARAMS, "该模型不支持 numBeams，请去掉这个选项")
            }
            AiTranslatePolicy.checkLanguages(call.req, languages, sourceAuto)
        }
    }

    /**
     * 文本生成约束：允许的预设、采样参数范围、是否允许页面额外传 system。只挂在文本生成类任务上。
     *
     * @property presets 允许的预设
     * @property temperature 温度范围（含端点），0 表示贪心
     * @property topK topK 范围（含端点）
     * @property allowSystem 是否允许页面额外传 system（即便允许，也只有 [AiPreset.PROMPT] 可传）
     * @example `AiConstraints.Generate(AiPreset.values().toList(), 0f..1.5f, 1..100, allowSystem = true)`
     */
    data class Generate(
        val presets: List<AiPreset>,
        val temperature: ClosedFloatingPointRange<Float>,
        val topK: IntRange,
        val allowSystem: Boolean,
    ) : AiConstraints() {
        /** `{ presets, temperature: {min,max}, topK: {min,max}, allowSystem }` */
        override fun toJson(): JSONObject = JSONObject()
            .put("presets", AiGeneratePolicy.presetsJson(presets))
            .put("temperature", AiGeneratePolicy.rangeJson(temperature.start, temperature.endInclusive))
            .put("topK", AiGeneratePolicy.rangeJson(topK.first, topK.last))
            .put("allowSystem", allowSystem)

        /**
         * 只查经 run 端口的文本生成调用：预设在清单里；system 要 [allowSystem] 且有效预设是 prompt；温度与 topK 在范围内。
         *
         * @throws com.let188.arkli.bridge.BridgeException BAD_PARAMS
         */
        override fun check(call: AiCall) {
            if (call !is AiCall.Run) return
            call.preset?.let { if (it !in presets) throw bad("本提供者不支持预设 ${it.wire}") }
            if (call.system != null) {
                if (!allowSystem) throw bad("本提供者不允许传 system")
                val effective = call.preset ?: AiPreset.ofTask(call.task)
                if (effective != AiPreset.PROMPT) throw bad("只有 prompt 预设可以传 system")
            }
            call.sampling?.temperature?.let {
                if (it !in temperature) throw bad("temperature 需要在 ${temperature.start}~${temperature.endInclusive} 之间")
            }
            call.sampling?.topK?.let { if (it !in topK) throw bad("topK 需要在 ${topK.first}~${topK.last} 之间") }
        }

        /** 造 BAD_PARAMS 异常 */
        private fun bad(msg: String) = BridgeException(BridgeErrors.BAD_PARAMS, msg)
    }

    /**
     * 对联约束：上联最多几个字、温度与 topK 的范围。只挂在 `couplet` 任务上。
     *
     * @property maxChars 上联最多字数（含标点）
     * @property temperature 温度范围（含端点），0 表示贪心
     * @property topK topK 范围（含端点）
     * @example `AiConstraints.Couplet(14, 0f..2f, 1..200)`
     */
    data class Couplet(
        val maxChars: Int,
        val temperature: ClosedFloatingPointRange<Float>,
        val topK: IntRange,
    ) : AiConstraints() {
        /** `{ maxChars, temperature: {min,max}, topK: {min,max} }` */
        override fun toJson(): JSONObject = JSONObject().put("maxChars", maxChars)
            .put("temperature", AiGeneratePolicy.rangeJson(temperature.start, temperature.endInclusive))
            .put("topK", AiGeneratePolicy.rangeJson(topK.first, topK.last))

        /** 只查对联调用：字数、温度、topK 在范围内 */
        override fun check(call: AiCall) {
            if (call is AiCall.Couplet) AiCoupletPolicy.checkConstraints(call.req, this)
        }
    }
}

/**
 * 提供者对一项任务的“报价”：能做什么任务、带什么约束。走哪个桥方法（entry）不由提供者填，
 * 而由 [AiRouter.entryOf] 按它实际实现的端口推导，避免声明与实现对不上。
 *
 * @property task 任务
 * @property constraints 约束；没有为 null
 * @example `AiOffer(AiTask.TRANSLATE, AiTranslatePolicy.OFFER_CONSTRAINTS)`
 */
data class AiOffer(val task: AiTask, val constraints: AiConstraints? = null)

/** 提供者执行任务的结果 */
sealed class AiRunResult {
    /**
     * 已把输入交给系统里的其他应用，拿不回结果。
     *
     * @property handled 是否真的有应用接手
     */
    data class Handoff(val handled: Boolean) : AiRunResult()

    /**
     * 直接拿到文本结果（端侧模型、在线服务类提供者将来使用）。
     *
     * @property text 结果文本
     */
    data class Text(val text: String) : AiRunResult()
}

/**
 * AI 提供者：一层抽象，将来与本地 MNN 模型、在线 OpenAI、ML Kit GenAI 并列。
 * 页面（Web）只看 [capabilities] 与 [availability]，不认厂商。
 *
 * 规划中的实现（当前代码里只有 [IntentHandoffProvider]）：
 * - `MlKitGenAiProvider`：谷歌 ML Kit GenAI，依赖 AICore 与白名单机型，要 minSdk 26 以上，未接入；
 * - 在线 OpenAI 兼容接口：见 docs/decisions/0004-ai-provider-abstraction.md。
 *
 * 使用示例：`registry.get("intent-handoff")?.run(AiTask.TRANSLATE, "hello")`
 */
interface AiProvider {
    /** 稳定标识，如 `intent-handoff` */
    val id: String

    /** 给人看的名字（中文） */
    val displayName: String

    /** 所属层（决策 0005）：L1 本地小模型 / L2 本地大模型 / L3 本机 AI / L4 远端 API */
    val layer: AiLayer

    /**
     * 声明支持的任务，静态不变。**声明必须与实现一致**（单测 `AiProviderContractTest` 逐个检查）：
     * - 有专用端口的任务（[AiPort.DEDICATED]，如 translate ↔ [TextTranslator]、classifyImage ↔ [ImageClassifier]）：
     *   实现了端口就必须声明；声明了却没实现端口时，就由 [run] 承接（如交接类提供者的 translate）；
     * - 其余任务一律由 [run] 承接。
     *
     * @return 支持的任务集合
     */
    fun capabilities(): Set<AiTask>

    /**
     * 每项任务的报价（带约束）。默认由 [capabilities] 逐项推导、不带约束；需要约束的提供者（如翻译的语言清单）重写它。
     * **任务集合必须与 [capabilities] 完全一致**，带语言对端口的 translate 必须给出非空语言清单（`AiProviderContractTest` 检查）。
     *
     * @return 按 [AiTask] 枚举顺序排列的报价
     * @example `override fun offers() = listOf(AiOffer(AiTask.TRANSLATE, AiTranslatePolicy.OFFER_CONSTRAINTS))`
     */
    fun offers(): List<AiOffer> = AiTask.values().filter { it in capabilities() }.map { AiOffer(it) }

    /**
     * 运行时探测当前是否可用，应当快速返回。
     *
     * @return 可用性
     */
    fun availability(): AiAvailability

    /**
     * 本地模型类提供者的下载状态；不依赖本地模型的提供者保持默认的 null，序列化时不输出相关字段。
     *
     * @return 模型状态，或 null
     */
    fun modelInfo(): AiModelInfo? = null

    /**
     * 经 `native.ai.run` 执行一次任务。路由（[AiRouter]）只会派来 [AiRouter.runTasks] 里的任务，且输入已校验、提供者可用；
     * 收到不归 run 的任务时应抛 [AiRouter.notRunnable]（BAD_PARAMS）。
     *
     * @param task 任务
     * @param input 输入文本
     * @return 直接结果或交接标记
     */
    suspend fun run(task: AiTask, input: String): AiRunResult
}
