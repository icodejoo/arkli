package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject

/**
 * 文本生成的预设：决定指令模板、system 提示与默认采样。与 [AiTask] 里的文本生成类任务一一对应。
 *
 * @property wire 桥协议里的字符串名，与对应任务的 wire 相同
 * @property task 对应的任务
 */
enum class AiPreset(val wire: String, val task: AiTask) {
    /** 摘要 */
    SUMMARIZE("summarize", AiTask.SUMMARIZE),

    /** 校对 */
    PROOFREAD("proofread", AiTask.PROOFREAD),

    /** 改写 */
    REWRITE("rewrite", AiTask.REWRITE),

    /** 提示词问答：原样提问，允许页面额外传 system */
    PROMPT("prompt", AiTask.PROMPT);

    companion object {
        /**
         * 按协议名查预设。
         *
         * @param wire 协议名
         * @return 预设，不认识返回 null
         */
        fun fromWire(wire: String): AiPreset? = values().firstOrNull { it.wire == wire }

        /**
         * 任务对应的预设。
         *
         * @param task 任务
         * @return 预设，非文本生成类任务返回 null
         */
        fun ofTask(task: AiTask): AiPreset? = values().firstOrNull { it.task == task }
    }
}

/**
 * 页面按次传入的采样参数，字段缺省表示沿用预设默认。
 *
 * @property temperature 温度；0 表示贪心
 * @property topK 温度采样的候选数
 */
data class AiSamplingParams(val temperature: Float? = null, val topK: Int? = null)

/**
 * 一次文本生成任务带的可选项（`native.ai.invoke` 的 `options`），不传的都是 null。
 *
 * @property preset 预设；null 表示按任务
 * @property system 页面额外传的 system 提示；只有 [AiPreset.PROMPT] 允许
 * @property sampling 采样参数；null 表示沿用预设默认
 * @property maxTokens 本次最多生成的 token 数；null 表示沿用 [AiQwenPolicy.MAX_NEW_TOKENS]（只由用户设置补入，桥上不收）
 */
data class AiGenOptions(
    val preset: AiPreset? = null,
    val system: String? = null,
    val sampling: AiSamplingParams? = null,
    val maxTokens: Int? = null,
) {
    /** 是否一项都没传 */
    val isEmpty: Boolean get() = preset == null && system == null && sampling == null && maxTokens == null

    companion object {
        /** 什么都没传 */
        val NONE = AiGenOptions()
    }
}

/**
 * 能按预设与采样生成文本的提供者（可选端口）。实现了它的提供者，文本任务的报价必须带 [AiConstraints.Generate]，
 * 反之亦然（`AiProviderContractTest` 检查）。没实现它的提供者收到预设、system、采样参数时由分派器报 BAD_PARAMS，不静默忽略。
 */
interface TextGenerator {
    /**
     * 带可选项执行一次文本生成任务。输入与可选项已通过结构与约束校验。
     *
     * @param task 任务
     * @param input 输入文本
     * @param opts 可选项
     * @return 文本结果
     * @example `generator.generate(AiTask.PROMPT, "你好", AiGenOptions(sampling = AiSamplingParams(temperature = 0.3f)))`
     */
    suspend fun generate(task: AiTask, input: String, opts: AiGenOptions): AiRunResult
}

/**
 * 文本生成可选项的解析（结构校验），范围与权限由 [AiConstraints.Generate.check] 按提供者报价另查。纯逻辑，可单测。
 *
 * 使用示例：`AiGeneratePolicy.parse(JSONObject("""{"preset":"prompt","temperature":0.5}"""))`
 */
object AiGeneratePolicy {
    /** 选项键：预设 */
    const val KEY_PRESET = "preset"

    /** 选项键：额外 system */
    const val KEY_SYSTEM = "system"

    /** 选项键：温度 */
    const val KEY_TEMPERATURE = "temperature"

    /** 选项键：topK */
    const val KEY_TOP_K = "topK"

    /** 额外 system 的长度上限 */
    const val MAX_SYSTEM = 2_000

    /**
     * 从扁平参数里取出文本生成可选项；没有相关键时返回 [AiGenOptions.NONE]。
     *
     * @param flat input 与 options 拼成的扁平参数
     * @return 可选项
     * @throws BridgeException BAD_PARAMS：preset 不认识、system 为空或过长、temperature 不是有限数字、topK 不是整数
     * @example `parse(JSONObject("""{"preset":"rewrite"}"""))` 得到 `AiGenOptions(AiPreset.REWRITE)`
     */
    fun parse(flat: JSONObject): AiGenOptions {
        val preset = optional(flat, KEY_PRESET)?.let {
            val name = it as? String ?: throw bad("$KEY_PRESET 需要是字符串")
            AiPreset.fromWire(name) ?: throw bad("不认识的预设：$name")
        }
        val system = optional(flat, KEY_SYSTEM)?.let {
            val s = it as? String ?: throw bad("$KEY_SYSTEM 需要是字符串")
            if (s.isBlank() || s.length > MAX_SYSTEM) throw bad("$KEY_SYSTEM 需要 1~$MAX_SYSTEM 字符且不能全是空白")
            s
        }
        val temperature = optional(flat, KEY_TEMPERATURE)?.let {
            val d = (it as? Number)?.toDouble() ?: throw bad("$KEY_TEMPERATURE 需要是数字")
            if (!d.isFinite()) throw bad("$KEY_TEMPERATURE 需要是有限数字")
            d.toFloat()
        }
        val topK = optional(flat, KEY_TOP_K)?.let {
            val n = it as? Number ?: throw bad("$KEY_TOP_K 需要是整数")
            if (n.toDouble() != n.toInt().toDouble()) throw bad("$KEY_TOP_K 需要是整数")
            n.toInt()
        }
        val sampling = if (temperature == null && topK == null) null else AiSamplingParams(temperature, topK)
        return AiGenOptions(preset, system, sampling)
    }

    /** 读可选键，缺省或 null 返回 null */
    private fun optional(flat: JSONObject, key: String): Any? = flat.opt(key)?.takeIf { it != JSONObject.NULL }

    /**
     * 序列化约束里的范围。
     *
     * @param min 下限
     * @param max 上限
     * @return `{ min, max }`
     */
    internal fun rangeJson(min: Number, max: Number): JSONObject = JSONObject().put("min", min).put("max", max)

    /**
     * 序列化预设清单。
     *
     * @param presets 预设
     * @return 协议名数组
     */
    internal fun presetsJson(presets: Collection<AiPreset>): JSONArray = JSONArray().also { a -> presets.forEach { a.put(it.wire) } }

    /** 造 BAD_PARAMS 异常 */
    private fun bad(msg: String) = BridgeException(BridgeErrors.BAD_PARAMS, msg)
}
