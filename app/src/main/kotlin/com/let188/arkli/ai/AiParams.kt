package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject

/**
 * 参数控件形态。
 *
 * @property wire 桥协议里的字符串名
 */
enum class AiParamKind(val wire: String) {
    /** 连续量滑块（如温度） */
    SLIDER("slider"),

    /** 整数微调器（如 topK） */
    STEPPER("stepper"),

    /** 开关（0/1） */
    SWITCH("switch"),

    /** 单选档位（如回答长度、束宽分段） */
    SELECT("select");

    companion object {
        /**
         * 按桥协议名查控件形态。
         *
         * @param wire 协议名
         * @return 控件形态，不认识返回 null
         */
        fun fromWire(wire: String): AiParamKind? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * 参数生效作用域。
 *
 * @property wire 桥协议里的字符串名
 */
enum class AiParamScope(val wire: String) {
    /** 调用级参数：每次调用传入，改了下次调用直接生效，不重建会话 */
    CALL("call"),

    /** 会话级参数：加载模型时定死，改了需要重建会话 */
    SESSION("session");

    companion object {
        /**
         * 按协议名查作用域。
         *
         * @param wire 协议名
         * @return 作用域，不认识返回 null
         */
        fun fromWire(wire: String): AiParamScope? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * 一个可调推理参数的规格定义（范围、默认值、控件形态、生效作用域）。
 *
 * @property key 稳定标识键，如 "temperature"、"numBeams"
 * @property label 显示标题
 * @property desc 一句话人情味说明文案
 * @property kind 控件形态
 * @property default 默认数值；SWITCH 为 0/1，SELECT 有 [optionValues] 时为真实值，否则为选项下标
 * @property min 最小值（有 [optionValues] 的 SELECT 取其最小值）
 * @property max 最大值（有 [optionValues] 的 SELECT 取其最大值）
 * @property step 步进
 * @property options SELECT 档位的显示文本列表；其它形态为空
 * @property optionValues SELECT 各档位对应的真实值，与 [options] 等长；为空时 SELECT 存选项下标
 * @property advanced 是否折叠在“高级设置”中
 * @property scope 生效作用域：CALL 下次调用生效 / SESSION 需重建会话
 * @property applyTo 仅作用于哪些任务；空表示作用于该提供者支持的全部任务
 */
data class AiParamSpec(
    val key: String,
    val label: String,
    val desc: String,
    val kind: AiParamKind,
    val default: Double,
    val min: Double,
    val max: Double,
    val step: Double,
    val options: List<String> = emptyList(),
    val optionValues: List<Double> = emptyList(),
    val advanced: Boolean = false,
    val scope: AiParamScope = AiParamScope.CALL,
    val applyTo: List<AiTask> = emptyList(),
) {
    /**
     * 校验给定数值是否在当前 spec 允许的合法范围内且步进对齐。
     *
     * @param value 待检查数值
     * @return 合法返回 true
     * @example `spec.isValidValue(0.7)`
     */
    fun isValidValue(value: Double): Boolean {
        if (!value.isFinite()) return false
        if (kind == AiParamKind.SELECT) {
            // 有真实值表：值必须是其中之一；否则按下标，范围与步进校验之外再要求是选项下标
            if (optionValues.isNotEmpty()) return optionValues.any { Math.abs(it - value) <= EPSILON }
            return Math.abs(value - Math.rint(value)) <= EPSILON && Math.rint(value).toInt() in options.indices
        }
        if (value < min - EPSILON || value > max + EPSILON) return false
        val steps = (value - min) / step
        val roundSteps = Math.round(steps)
        return Math.abs(value - (min + roundSteps * step)) <= EPSILON
    }

    /**
     * 序列化为符合桥协议契约的 JSON 对象。
     *
     * @return 规格 JSON
     */
    fun toJson(): JSONObject {
        val o = JSONObject()
            .put(KEY_KEY, key)
            .put(KEY_LABEL, label)
            .put(KEY_DESC, desc)
            .put(KEY_KIND, kind.wire)
            .put(KEY_DEFAULT, default)
            .put(KEY_MIN, min)
            .put(KEY_MAX, max)
            .put(KEY_STEP, step)
            .put(KEY_ADVANCED, advanced)
            .put(KEY_SCOPE, scope.wire)
        if (options.isNotEmpty()) {
            o.put(KEY_OPTIONS, JSONArray(options))
        }
        if (optionValues.isNotEmpty()) {
            o.put(KEY_OPTION_VALUES, JSONArray(optionValues))
        }
        if (applyTo.isNotEmpty()) {
            o.put(KEY_APPLY_TO, JSONArray(applyTo.map { it.wire }))
        }
        return o
    }

    companion object {
        /** 浮点误差容差 */
        const val EPSILON = 1e-4

        /** 参数键：key */
        const val KEY_KEY = "key"

        /** 参数键：label */
        const val KEY_LABEL = "label"

        /** 参数键：desc */
        const val KEY_DESC = "desc"

        /** 参数键：kind */
        const val KEY_KIND = "kind"

        /** 参数键：default */
        const val KEY_DEFAULT = "default"

        /** 参数键：min */
        const val KEY_MIN = "min"

        /** 参数键：max */
        const val KEY_MAX = "max"

        /** 参数键：step */
        const val KEY_STEP = "step"

        /** 参数键：options */
        const val KEY_OPTIONS = "options"

        /** 参数键：optionValues */
        const val KEY_OPTION_VALUES = "optionValues"

        /** 参数键：advanced */
        const val KEY_ADVANCED = "advanced"

        /** 参数键：scope */
        const val KEY_SCOPE = "scope"

        /** 参数键：applyTo */
        const val KEY_APPLY_TO = "applyTo"
    }
}

/**
 * 声明了可调推理参数的提供者（可选端口，与 [TextGenerator] 同类）。
 */
interface AiTunable {
    /**
     * 参数规格列表（只读常量）。
     *
     * @return 该提供者支持的参数规格
     * @example `override fun paramSpecs(): List<AiParamSpec> = ...`
     */
    fun paramSpecs(): List<AiParamSpec>
}

/**
 * AI 参数纯逻辑处理：读写校验、会话指纹计算与响应封装。无 Android 依赖，可单测。
 *
 * 使用示例：`AiParams.handleGet(params, providers, store)`
 */
object AiParams {
    /** 桥参数键：提供者 */
    const val KEY_PROVIDER = "provider"

    /** 响应键：参数规格列表 */
    const val KEY_SPECS = "specs"

    /** 响应键：当前生效值映射表 */
    const val KEY_VALUES = "values"

    /** 重置键：要重置的 key 列表 */
    const val KEY_KEYS = "keys"

    /**
     * 处理 `native.ai.params.get` 请求。
     *
     * @param params 请求参数 `{ provider }`
     * @param providers 全部提供者
     * @param store 参数持久化存储
     * @return `{ provider, specs, values }`
     * @throws BridgeException BAD_PARAMS：提供者不存在或不支持调整参数
     * @example `AiParams.handleGet(params, providers, store)`
     */
    fun handleGet(params: JSONObject, providers: List<AiProvider>, store: AiParamStore): JSONObject {
        val (providerId, specs) = resolveTunable(params, providers)
        return resultJson(providerId, specs, store)
    }

    /**
     * 处理 `native.ai.params.set` 请求。整批原子校验：任一非法整批拒绝。
     *
     * @param params 请求参数 `{ provider, values }`
     * @param providers 全部提供者
     * @param store 参数持久化存储
     * @return `{ provider, specs, values }`
     * @throws BridgeException BAD_PARAMS：未知 key、越界、步进不对齐、SELECT 取值非法
     * @example `AiParams.handleSet(params, providers, store)`
     */
    fun handleSet(params: JSONObject, providers: List<AiProvider>, store: AiParamStore): JSONObject {
        val (providerId, specs) = resolveTunable(params, providers)
        val valuesObj = params.optJSONObject(KEY_VALUES)
            ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "$KEY_VALUES 需要是对象")
        if (valuesObj.length() == 0) throw BridgeException(BridgeErrors.BAD_PARAMS, "$KEY_VALUES 不能为空")

        val validated = mutableMapOf<String, Double>()
        val iter = valuesObj.keys()
        while (iter.hasNext()) {
            val k = iter.next()
            val spec = specs.firstOrNull { it.key == k }
                ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "未知的参数 key: $k")
            val num = valuesObj.opt(k) as? Number
                ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "参数 $k 的值需要是数字")
            val d = num.toDouble()
            if (!spec.isValidValue(d)) {
                throw BridgeException(BridgeErrors.BAD_PARAMS, "参数 $k 的值 $d 超出范围或未按步进对齐")
            }
            validated[k] = d
        }

        // 全部校验通过后再落盘：与默认相同的键删掉，只存不同值
        validated.forEach { (k, v) ->
            val spec = specs.first { it.key == k }
            if (Math.abs(v - spec.default) < AiParamSpec.EPSILON) {
                store.remove(providerId, k)
            } else {
                store.set(providerId, k, v)
            }
        }
        return resultJson(providerId, specs, store)
    }

    /**
     * 处理 `native.ai.params.reset` 请求。
     *
     * @param params 请求参数 `{ provider, keys? }`
     * @param providers 全部提供者
     * @param store 参数持久化存储
     * @return `{ provider, specs, values }`
     * @throws BridgeException BAD_PARAMS：提供者不合法或指定了未知的 key
     * @example `AiParams.handleReset(params, providers, store)`
     */
    fun handleReset(params: JSONObject, providers: List<AiProvider>, store: AiParamStore): JSONObject {
        val (providerId, specs) = resolveTunable(params, providers)
        val keysArr = params.optJSONArray(KEY_KEYS)
        if (keysArr != null) {
            val toReset = mutableListOf<String>()
            for (i in 0 until keysArr.length()) {
                val k = keysArr.optString(i)
                if (specs.none { it.key == k }) throw BridgeException(BridgeErrors.BAD_PARAMS, "未知的参数 key: $k")
                toReset.add(k)
            }
            toReset.forEach { store.remove(providerId, it) }
        } else {
            store.clearProvider(providerId)
        }
        return resultJson(providerId, specs, store)
    }

    /**
     * 计算提供者的会话指纹（对 scope == SESSION 的参数算指纹）。
     *
     * @param provider 提供者 id
     * @param specs 参数规格列表
     * @param store 参数持久化存储
     * @param mnnSpecs 公用 MNN 基础参数规格（预留）
     * @return 会话指纹字符串；无 SESSION 参数时为空串
     * @example `AiParams.sessionFingerprint("local-qwen", specs, store)`
     */
    fun sessionFingerprint(
        provider: String,
        specs: List<AiParamSpec>,
        store: AiParamStore,
        mnnSpecs: List<AiParamSpec> = emptyList(),
    ): String {
        val sessionSpecs = specs.filter { it.scope == AiParamScope.SESSION }
        val mnnSessionSpecs = mnnSpecs.filter { it.scope == AiParamScope.SESSION }
        if (sessionSpecs.isEmpty() && mnnSessionSpecs.isEmpty()) return ""
        val parts = mutableListOf<String>()
        sessionSpecs.sortedBy { it.key }.forEach { spec ->
            val v = store.effectiveValue(provider, spec)
            parts += "${spec.key}=$v"
        }
        mnnSessionSpecs.sortedBy { it.key }.forEach { spec ->
            val v = store.effectiveValue(AiMnnParams.PROVIDER_ID, spec)
            parts += "${AiMnnParams.PROVIDER_ID}.${spec.key}=$v"
        }
        return parts.joinToString("|")
    }

    /**
     * 生成规范的响应 JSON：包含 provider、specs 列表与全部 key 的当前生效值。
     *
     * @param provider 提供者 id
     * @param specs 参数规格列表
     * @param store 参数持久化存储
     * @return 响应 JSON
     */
    fun resultJson(provider: String, specs: List<AiParamSpec>, store: AiParamStore): JSONObject {
        val values = JSONObject()
        specs.forEach { spec ->
            values.put(spec.key, store.effectiveValue(provider, spec))
        }
        return JSONObject()
            .put(KEY_PROVIDER, provider)
            .put(KEY_SPECS, JSONArray(specs.map { it.toJson() }))
            .put(KEY_VALUES, values)
    }

    /** 从参数中解析并校验出提供者及其参数规格 */
    private fun resolveTunable(params: JSONObject, providers: List<AiProvider>): Pair<String, List<AiParamSpec>> {
        val providerId = params.optString(KEY_PROVIDER).takeIf { it.isNotEmpty() }
            ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "$KEY_PROVIDER 不能为空")
        if (providerId == AiMnnParams.PROVIDER_ID) {
            return providerId to AiMnnParams.SPECS
        }
        val p = providers.firstOrNull { it.id == providerId }
            ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "未知的提供者: $providerId")
        val tunable = p as? AiTunable
            ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "提供者 $providerId 不支持调整参数")
        val specs = tunable.paramSpecs()
        if (specs.isEmpty()) throw BridgeException(BridgeErrors.BAD_PARAMS, "提供者 $providerId 没有可调参数")
        return providerId to specs
    }
}

/**
 * Float 按十进制字面量转 Double，给参数 spec 用：直接 `toDouble()` 会把 0.7f 变成 0.699999988…，
 * 页面拿它和滑块值比较时永远“不等于默认”。
 *
 * @return 与 Float 十进制写法一致的 Double
 * @example `0.7f.toSpecDouble() // 0.7`
 */
fun Float.toSpecDouble(): Double = toString().toDouble()
