package com.let188.arkli.ai

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
    TRANSLATE("translate", true);

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
 * AI 提供者：一层抽象，将来与本地 ONNX、在线 OpenAI、ML Kit GenAI 并列。
 * 页面（Web）只看 [capabilities] 与 [availability]，不认厂商。
 *
 * 规划中的实现（当前代码里只有 [IntentHandoffProvider]）：
 * - `MlKitGenAiProvider`：谷歌 ML Kit GenAI，依赖 AICore 与白名单机型，要 minSdk 26 以上，未接入；
 * - 本地 ONNX、在线 OpenAI 兼容接口：见 docs/decisions/0004-ai-provider-abstraction.md。
 *
 * 使用示例：`registry.get("intent-handoff")?.run(AiTask.TRANSLATE, "hello")`
 */
interface AiProvider {
    /** 稳定标识，如 `intent-handoff` */
    val id: String

    /** 给人看的名字（中文） */
    val displayName: String

    /**
     * 声明支持的任务，静态不变。
     *
     * @return 支持的任务集合
     */
    fun capabilities(): Set<AiTask>

    /**
     * 运行时探测当前是否可用，应当快速返回。
     *
     * @return 可用性
     */
    fun availability(): AiAvailability

    /**
     * 执行一次任务。调用前由上层保证任务受支持、输入已校验、提供者可用。
     *
     * @param task 任务
     * @param input 输入文本
     * @return 直接结果或交接标记
     */
    suspend fun run(task: AiTask, input: String): AiRunResult
}
