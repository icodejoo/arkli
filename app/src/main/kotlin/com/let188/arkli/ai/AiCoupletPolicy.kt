package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject

/**
 * 一次 `native.ai.couplet` 校验通过的请求。上联的字符合法性（汉字与允许标点、不含字母数字括号）由 Rust 引擎校验，这里只管形状与范围。
 *
 * @property provider 指定的提供者 id；null 表示用第一个支持对联的
 * @property text 上联
 * @property temperature 温度，null 取引擎默认 0.8，0 为贪心
 * @property topK top-k，null 取引擎默认 40
 * @property seed 随机种子，null 表示随机；给定则结果可复现
 */
data class AiCoupletRequest(
    val provider: String?,
    val text: String,
    val temperature: Float? = null,
    val topK: Int? = null,
    val seed: Long? = null,
)

/**
 * 对联的纯逻辑：参数解析与范围校验、结果序列化。无 Android 依赖，可单测。
 *
 * 使用示例：`AiCoupletPolicy.parse(JSONObject("""{"text":"春风送暖入屠苏","temperature":0}"""))`
 */
object AiCoupletPolicy {
    /** 参数键：上联 */
    const val KEY_TEXT = "text"

    /** 参数键：温度 */
    const val KEY_TEMPERATURE = AiGeneratePolicy.KEY_TEMPERATURE

    /** 参数键：top-k */
    const val KEY_TOP_K = AiGeneratePolicy.KEY_TOP_K

    /** 参数键：随机种子 */
    const val KEY_SEED = "seed"

    /** 上联最多字数（含标点），与 Rust 的 `MAX_UPPER_CHARS` 一致 */
    const val MAX_CHARS = 14

    /** 温度范围，与 Rust 的 `MAX_TEMPERATURE` 一致 */
    val TEMPERATURE_RANGE: ClosedFloatingPointRange<Float> = 0f..2f

    /** top-k 范围，与 Rust 的 `MAX_TOP_K` 一致 */
    val TOP_K_RANGE: IntRange = 1..200

    /** 引擎缺省温度，与 Rust `couplet.rs` 的缺省一致 */
    const val DEFAULT_TEMPERATURE = 0.8f

    /** 引擎缺省 top-k，与 Rust `couplet.rs` 的缺省一致 */
    const val DEFAULT_TOP_K = 40

    /** AI 中心滑块的温度上限：UI 收窄到 1.5（再高常出不通顺），原生上限仍是 [TEMPERATURE_RANGE] */
    const val UI_MAX_TEMPERATURE = 1.5f

    /** 温度滑块步进 */
    const val TEMPERATURE_STEP = 0.05

    /** JS 安全整数上限：种子经 JSON 数字传入，超过它会丢精度 */
    private const val MAX_SEED = 9_007_199_254_740_991L

    /** 本地对联提供者的报价约束 */
    val OFFER_CONSTRAINTS = AiConstraints.Couplet(MAX_CHARS, TEMPERATURE_RANGE, TOP_K_RANGE)

    /**
     * 对联模型的可调参数：温度（UI 收窄到 0~[UI_MAX_TEMPERATURE]）与 top-k（高级）。范围引用本对象常量，不另抄数字。
     */
    val PARAM_SPECS: List<AiParamSpec> = listOf(
        AiParamSpec(
            key = KEY_TEMPERATURE,
            label = "稳妥与新奇",
            desc = "往左更工整稳妥，往右更敢出新意，但太右容易不通顺。页面里自己指定了的，以页面为准",
            kind = AiParamKind.SLIDER,
            default = DEFAULT_TEMPERATURE.toSpecDouble(),
            min = TEMPERATURE_RANGE.start.toSpecDouble(),
            max = UI_MAX_TEMPERATURE.toSpecDouble(),
            step = TEMPERATURE_STEP,
            applyTo = listOf(AiTask.COUPLET),
        ),
        AiParamSpec(
            key = KEY_TOP_K,
            label = "候选字范围",
            desc = "每一步从多少个候选字里挑，越小越保守，改完下一副对联就生效",
            kind = AiParamKind.STEPPER,
            default = DEFAULT_TOP_K.toDouble(),
            min = TOP_K_RANGE.first.toDouble(),
            max = TOP_K_RANGE.last.toDouble(),
            step = 1.0,
            advanced = true,
            applyTo = listOf(AiTask.COUPLET),
        ),
    )

    /**
     * 解析并校验对联参数（invoke 的 input + options 已被拍平成同一层）。
     *
     * @param params `{ provider?, text, temperature?, topK?, seed? }`
     * @return 校验通过的请求
     * @throws BridgeException BAD_PARAMS：text 不是非空字符串或超过 [MAX_CHARS] 字；temperature、topK、seed 类型或范围不对
     */
    fun parse(params: JSONObject): AiCoupletRequest {
        val text = params.opt(KEY_TEXT) as? String ?: throw bad("$KEY_TEXT 需要是字符串")
        if (text.isEmpty() || text.codePointCount(0, text.length) > MAX_CHARS) throw bad("上联需要 1~$MAX_CHARS 个字")
        val temperature = optional(params, KEY_TEMPERATURE)?.let {
            val d = (it as? Number)?.toDouble() ?: throw bad("$KEY_TEMPERATURE 需要是数字")
            if (!d.isFinite()) throw bad("$KEY_TEMPERATURE 需要是有限数字")
            d.toFloat()
        }
        val topK = optional(params, KEY_TOP_K)?.let { intOf(it, KEY_TOP_K).toInt() }
        val seed = optional(params, KEY_SEED)?.let {
            val n = intOf(it, KEY_SEED)
            if (n < 0 || n > MAX_SEED) throw bad("$KEY_SEED 需要在 0~$MAX_SEED 之间")
            n
        }
        return AiCoupletRequest(AiPolicy.providerId(params.opt(AiPolicy.KEY_PROVIDER), required = false), text, temperature, topK, seed)
    }

    /**
     * 按提供者的约束检查范围：字数、温度、topK。
     *
     * @param req 已解析的请求
     * @param c 提供者报价里的约束
     * @throws BridgeException BAD_PARAMS：超出范围
     */
    fun checkConstraints(req: AiCoupletRequest, c: AiConstraints.Couplet) {
        if (req.text.codePointCount(0, req.text.length) > c.maxChars) throw bad("上联最多 ${c.maxChars} 个字")
        req.temperature?.let {
            if (it !in c.temperature) throw bad("temperature 需要在 ${c.temperature.start}~${c.temperature.endInclusive} 之间")
        }
        req.topK?.let { if (it !in c.topK) throw bad("topK 需要在 ${c.topK.first}~${c.topK.last} 之间") }
    }

    /**
     * 序列化结果。
     *
     * @param r 生成结果
     * @return `{ text, elapsedMs, modelId }`，text 是与上联等长的下联
     */
    fun resultJson(r: CoupletResult): JSONObject =
        JSONObject().put("text", r.text).put("elapsedMs", r.elapsedMs).put("modelId", r.modelId)

    /** 取整数字段：必须是整数值的数字 */
    private fun intOf(v: Any, key: String): Long {
        val n = v as? Number ?: throw bad("$key 需要是整数")
        if (n.toDouble() != n.toLong().toDouble()) throw bad("$key 需要是整数")
        return n.toLong()
    }

    /** 读可选字段：缺省或 null 都当没传 */
    private fun optional(params: JSONObject, key: String): Any? = params.opt(key)?.takeIf { it != JSONObject.NULL }

    /** 造 BAD_PARAMS 异常 */
    private fun bad(msg: String) = BridgeException(BridgeErrors.BAD_PARAMS, msg)
}
