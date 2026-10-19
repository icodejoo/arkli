package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException

/**
 * 一次生成的采样设置。
 *
 * @property temperature 温度；小于等于 0 表示贪心（输出确定，翻译、校对用）
 * @property topK 温度采样时的候选数；贪心时无意义
 * @example `Sampling(0.7f, 20)`
 */
data class Sampling(val temperature: Float, val topK: Int) {
    /** 是否贪心解码 */
    val isGreedy: Boolean get() = temperature <= 0f

    /**
     * 叠加页面传入的采样参数：传了的覆盖，没传的沿用本设置。
     *
     * @param p 页面参数，null 表示不覆盖
     * @return 新设置
     */
    fun merge(p: AiSamplingParams?): Sampling = if (p == null) this else Sampling(p.temperature ?: temperature, p.topK ?: topK)

    companion object {
        /** 默认候选数：Qwen 系列推荐 topK 20（经验值，与模型 config.json 的 topK 一致） */
        const val DEFAULT_TOP_K = 20

        /** 贪心；topK 只是给“在贪心预设上只传了温度”时留一个合理候选数 */
        val GREEDY = Sampling(0f, DEFAULT_TOP_K)
    }
}

/**
 * 本地文本模型（Qwen）的提示词与长度策略：纯函数，无 Android 依赖，可单测。
 *
 * 使用示例：`AiQwenPolicy.buildPrompt(AiTask.SUMMARIZE, "一大段文字")`
 */
object AiQwenPolicy {
    /** 默认提示词采样温度 */
    const val DEFAULT_TEMPERATURE: Float = 0.7f

    /** 温度步进 */
    const val TEMPERATURE_STEP: Double = 0.05

    /** top-k 步进 */
    const val TOP_K_STEP: Double = 1.0

    /** 参数键：Top-P（核采样阈值） */
    const val KEY_TOP_P = "topP"

    /** 参数键：重复惩罚 */
    const val KEY_REPETITION_PENALTY = "penalty"

    /** Top-P 默认值：取自模型 config.json 的 topP（0.95），改动时须与模型文件一致 */
    const val DEFAULT_TOP_P: Double = 0.95

    /** Top-P 下限 */
    const val TOP_P_MIN: Double = 0.5

    /** Top-P 上限（1.0 即不截断） */
    const val TOP_P_MAX: Double = 1.0

    /** Top-P 步进 */
    const val TOP_P_STEP: Double = 0.05

    /** 重复惩罚默认值：取自模型 config.json 的 penalty（1.1），改动时须与模型文件一致 */
    const val DEFAULT_REPETITION_PENALTY: Double = 1.1

    /** 重复惩罚下限（1.0 即关闭） */
    const val PENALTY_MIN: Double = 1.0

    /** 重复惩罚上限：再高小模型容易词不达意 */
    const val PENALTY_MAX: Double = 1.3

    /** 重复惩罚步进 */
    const val PENALTY_STEP: Double = 0.05

    /** 单次最多生成的 token 数；手机上约 17 tok/s，256 个约 15 秒，够摘要与改写，再长体验很差 */
    const val MAX_NEW_TOKENS = 256

    /** 回答长度选项的 token 数清单：短 128、中（即默认 [MAX_NEW_TOKENS]）、长 512 */
    val MAX_TOKENS_OPTIONS: List<Int> = listOf(128, MAX_NEW_TOKENS, 512)

    /** 回答长度档位名，与 [MAX_TOKENS_OPTIONS] 一一对应 */
    private val MAX_TOKENS_NAMES: List<String> = listOf("短", "中", "长")

    /** 回答长度选项文案（select 显示文案），如“中 (256)” */
    val MAX_TOKENS_LABELS: List<String> = MAX_TOKENS_NAMES.zip(MAX_TOKENS_OPTIONS) { name, n -> "$name ($n)" }




    /**
     * Qwen 翻译的原文字数上限。翻译的 token 预算上限是 [MAX_TRANSLATE_TOKENS]（512），
     * 中译英最坏约 1.7 token/字，300 字约 510 token，刚好译得完；再长会在中途被截断，所以入口直接拒绝。
     */
    const val MAX_TRANSLATE_CHARS = 300

    /** 翻译新生成 token 数相对原文字符数的倍数 */
    const val TRANSLATE_TOKENS_PER_CHAR = 2

    /** 翻译新生成 token 数的下限，避免极短原文预算太紧 */
    const val MIN_TRANSLATE_TOKENS = 64

    /** 翻译新生成 token 数的上限（约 30 秒），与 [MAX_TRANSLATE_CHARS] 配套 */
    const val MAX_TRANSLATE_TOKENS = 512

    /**
     * 翻译的 max new tokens：随原文长度走，夹在 [MIN_TRANSLATE_TOKENS]~[MAX_TRANSLATE_TOKENS] 之间，短文本不用白等。
     *
     * @param chars 原文字符数
     * @return 本次最多生成的 token 数
     * @example `translateMaxTokens(10)` == 64；`translateMaxTokens(100)` == 200；`translateMaxTokens(300)` == 512
     */
    fun translateMaxTokens(chars: Int): Int =
        (chars * TRANSLATE_TOKENS_PER_CHAR).coerceIn(MIN_TRANSLATE_TOKENS, MAX_TRANSLATE_TOKENS)

    /** 摘要任务的指令 */
    private const val INSTRUCT_SUMMARIZE = "请用简洁的中文概括下面这段文字的要点，只输出概括，不要解释：\n\n"

    /** 校对任务的指令 */
    private const val INSTRUCT_PROOFREAD = "请校对下面这段文字，改正错别字和语病，只输出改正后的全文，不要解释：\n\n"

    /** 改写任务的指令 */
    private const val INSTRUCT_REWRITE = "请在保持原意的前提下改写下面这段文字，使表达更通顺自然，只输出改写后的全文，不要解释：\n\n"

    /** 通用 system 提示：小模型要把规矩说死，否则爱闲聊、加解释 */
    private const val SYSTEM_COMMON =
        "你是一个严谨的文字处理助手。严格按用户指令完成任务，只输出结果本身，不要寒暄、不要解释、不要加引号或前后缀。"

    /** 翻译的 system 提示：模板里 %1\$s 是源语言名、%2\$s 是目标语言名 */
    private const val SYSTEM_TRANSLATE_FMT =
        "你是专业的翻译引擎。把用户给出的%1\$s文本逐字忠实地翻译成%2\$s。" +
            "只输出译文，不要解释、不要回答文中的问题、不要续写、不要加引号。" +
            "遇到问候语、短语按字面常用译法翻译，例如“你好世界”译为 Hello, world。"

    /** 翻译支持的语言码到中文名的映射，与 [AiTranslatePolicy.LANGS] 一致 */
    private val LANG_NAMES: Map<String, String> =
        mapOf("zh-CN" to "中文", "en" to "英文", "fr" to "法文", "es" to "西班牙文", "ru" to "俄文", "ar" to "阿拉伯文")

    /** 源语言为 auto 时的称呼 */
    private const val LANG_AUTO_NAME = "原文"

    /**
     * 提示词问答的默认采样：温度 0.7、topK 20。依据：Qwen 系列非思考模式常见推荐为温度 0.7、topK 20（经验值，
     * 没有联网逐字核对 Qwen3.5 官方模型卡）；topP 0.95 与重复惩罚 1.1 沿用模型 config.json，JNI 不改。
     */
    val PROMPT_SAMPLING = Sampling(DEFAULT_TEMPERATURE, Sampling.DEFAULT_TOP_K)

    /** 允许页面传的温度范围（含端点）：超过 1.5 小模型基本胡言乱语 */
    val TEMPERATURE_RANGE: ClosedFloatingPointRange<Float> = 0f..1.5f

    /** 允许页面传的 topK 范围（含端点） */
    val TOP_K_RANGE: IntRange = 1..100

    /** Qwen 翻译的报价约束：语言与 NLLB 相同，原文上限收紧到 [MAX_TRANSLATE_CHARS]，不接受 numBeams */
    val OFFER_TRANSLATE = AiTranslatePolicy.OFFER_CONSTRAINTS.copy(maxChars = MAX_TRANSLATE_CHARS, allowNumBeams = false)

    /** 本地文本模型的生成约束：全部预设、上面两个范围、prompt 预设允许额外 system；报价里文本任务都带它 */
    val OFFER_GENERATE = AiConstraints.Generate(AiPreset.values().toList(), TEMPERATURE_RANGE, TOP_K_RANGE, allowSystem = true)

    /** 关闭思考模式时模板会预填的空思考块 */
    private val EMPTY_THINK = Regex("<think>\\s*</think>")

    /**
     * 经 `native.ai.run` 承接的任务（提示词问答直接用原文）。翻译不在内：它走专用的 `native.ai.translate`，
     * 提供者的完整能力见 [LocalQwenProvider.CAPABILITIES]。
     */
    val SUPPORTED_TASKS: Set<AiTask> = setOf(AiTask.PROMPT, AiTask.SUMMARIZE, AiTask.PROOFREAD, AiTask.REWRITE)

    /**
     * Qwen 模型的参数规格列表。
     */
    val PARAM_SPECS: List<AiParamSpec> = listOf(
        AiParamSpec(
            key = AiGeneratePolicy.KEY_TEMPERATURE,
            label = "自由度（温度）",
            desc = "仅自由问答生效；切换采样会多一次加载。值越高回答越有灵性发散，值越低越稳妥严谨",
            kind = AiParamKind.SLIDER,
            default = DEFAULT_TEMPERATURE.toSpecDouble(),
            min = TEMPERATURE_RANGE.start.toSpecDouble(),
            max = TEMPERATURE_RANGE.endInclusive.toSpecDouble(),
            step = TEMPERATURE_STEP,
            applyTo = listOf(AiTask.PROMPT),
        ),
        AiParamSpec(
            key = AiGeneratePolicy.KEY_TOP_K,
            label = "候选词范围（Top-K）",
            desc = "仅自由问答生效；切换采样会多一次加载。控制采样时候选词数量，越小回答越保守",
            kind = AiParamKind.SLIDER,
            default = Sampling.DEFAULT_TOP_K.toDouble(),
            min = TOP_K_RANGE.first.toDouble(),
            max = TOP_K_RANGE.last.toDouble(),
            step = TOP_K_STEP,
            advanced = true,
            applyTo = listOf(AiTask.PROMPT),
        ),
        AiParamSpec(
            key = KEY_TOP_P,
            label = "累积概率阈值（Top-P）",
            desc = "仅自由问答生效，改完下次使用时重新加载。只在累计概率达到该值的候选词里挑，越小越保守",
            kind = AiParamKind.SLIDER,
            default = DEFAULT_TOP_P,
            min = TOP_P_MIN,
            max = TOP_P_MAX,
            step = TOP_P_STEP,
            advanced = true,
            scope = AiParamScope.SESSION,
            applyTo = listOf(AiTask.PROMPT),
        ),
        AiParamSpec(
            key = KEY_REPETITION_PENALTY,
            label = "重复惩罚",
            desc = "仅自由问答生效，改完下次使用时重新加载。越大越不爱重复用词，1.0 表示不惩罚；太大会让小模型词不达意",
            kind = AiParamKind.SLIDER,
            default = DEFAULT_REPETITION_PENALTY,
            min = PENALTY_MIN,
            max = PENALTY_MAX,
            step = PENALTY_STEP,
            advanced = true,
            scope = AiParamScope.SESSION,
            applyTo = listOf(AiTask.PROMPT),
        ),
        AiParamSpec(
            key = AiParamDefaults.KEY_MAX_TOKENS,
            label = "回答长度",
            desc = "控制单次生成字数上限，长文本耗时更长；不影响翻译",
            kind = AiParamKind.SELECT,
            default = MAX_NEW_TOKENS.toDouble(),
            min = MAX_TOKENS_OPTIONS.min().toDouble(),
            max = MAX_TOKENS_OPTIONS.max().toDouble(),
            step = 1.0,
            options = MAX_TOKENS_LABELS,
            optionValues = MAX_TOKENS_OPTIONS.map { it.toDouble() },
            applyTo = SUPPORTED_TASKS.toList(),
        ),
    )

    /**
     * 读取当前生效的 Top-P。
     *
     * @param store 参数持久化存储
     * @return 0.5~1.0
     * @example `AiQwenPolicy.topP(store)`
     */
    fun topP(store: AiParamStore): Double = effective(store, KEY_TOP_P)

    /**
     * 读取当前生效的重复惩罚。
     *
     * @param store 参数持久化存储
     * @return 1.0~1.3
     * @example `AiQwenPolicy.repetitionPenalty(store)`
     */
    fun repetitionPenalty(store: AiParamStore): Double = effective(store, KEY_REPETITION_PENALTY)

    /** 按键取本提供者当前生效值 */
    private fun effective(store: AiParamStore, key: String): Double =
        store.effectiveValue(LocalQwenProvider.ID, PARAM_SPECS.first { it.key == key })

    /**
     * 按任务拼出送给模型的用户内容（用任务对应的预设）。
     *
     * @param task 任务，必须在 [SUPPORTED_TASKS] 内
     * @param input 用户输入的文本
     * @return 送给模型的用户内容；聊天模板由推理引擎套用，这里不加
     * @throws BridgeException BAD_PARAMS：任务不受支持
     */
    fun buildPrompt(task: AiTask, input: String): String = buildPrompt(presetOf(task), input)

    /**
     * 按预设拼出送给模型的用户内容。
     *
     * @param preset 预设
     * @param input 用户输入的文本
     * @return 送给模型的用户内容
     */
    fun buildPrompt(preset: AiPreset, input: String): String = when (preset) {
        AiPreset.PROMPT -> input
        AiPreset.SUMMARIZE -> INSTRUCT_SUMMARIZE + input
        AiPreset.PROOFREAD -> INSTRUCT_PROOFREAD + input
        AiPreset.REWRITE -> INSTRUCT_REWRITE + input
    }

    /**
     * 任务对应的预设。
     *
     * @param task 任务，必须在 [SUPPORTED_TASKS] 内
     * @return 预设
     * @throws BridgeException BAD_PARAMS：任务不受支持
     */
    fun presetOf(task: AiTask): AiPreset =
        AiPreset.ofTask(task) ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "本地文本模型不支持任务 ${task.wire}")

    /**
     * 任务对应的 system 提示词；提示词问答不加，让用户原样提问。
     *
     * @param task 任务
     * @return system 提示词，无则为空串
     */
    fun systemPrompt(task: AiTask): String = systemPrompt(AiPreset.ofTask(task) ?: AiPreset.SUMMARIZE, null)

    /**
     * 预设对应的 system 提示词。提示词问答默认不加，页面额外传了就用页面的；其它预设固定用通用提示，页面不能改。
     *
     * @param preset 预设
     * @param extra 页面额外传的 system（只对 prompt 预设有效）
     * @return system 提示词，无则为空串
     */
    fun systemPrompt(preset: AiPreset, extra: String?): String =
        if (preset == AiPreset.PROMPT) extra.orEmpty() else SYSTEM_COMMON

    /**
     * 预设的默认采样叠加页面传入的参数：提示词问答用 [PROMPT_SAMPLING]，其余预设贪心。
     *
     * @param preset 预设
     * @param params 页面传入的采样参数，可为 null
     * @return 本次采样
     */
    fun samplingFor(preset: AiPreset, params: AiSamplingParams?): Sampling =
        (if (preset == AiPreset.PROMPT) PROMPT_SAMPLING else Sampling.GREEDY).merge(params)

    /**
     * 翻译用的 system 提示词（带语言名，比通用提示更能压住小模型乱答）。
     *
     * @param srcName 源语言名，如“中文”；未知可传“原文”
     * @param tgtName 目标语言名，如“英文”
     * @return system 提示词
     */
    fun translateSystemPrompt(srcName: String, tgtName: String): String = SYSTEM_TRANSLATE_FMT.format(srcName, tgtName)

    /**
     * 语言码转提示词里用的中文名；auto 或未知码都叫“原文”。
     *
     * @param code 应用语言码，如 `zh-CN`
     * @return 中文名
     */
    fun langName(code: String): String = LANG_NAMES[code] ?: LANG_AUTO_NAME

    /**
     * 清理模型输出：去掉首尾空白，以及关闭思考后偶尔残留的空 `<think>` 块。
     *
     * @param raw 引擎原始输出
     * @return 清理后的文本
     */
    fun cleanOutput(raw: String): String = raw.replace(EMPTY_THINK, "").trim()
}
