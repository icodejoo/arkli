package com.let188.arkli.ai

/**
 * AI 参数默认值填充器：分派前把“用户设置”补进调用里没带的字段。
 * 优先级：显式传参 > 用户设置 > 内置默认。只补用户**真的改过**的值（存储里只留与默认不同的值），
 * 没改过的什么都不补，调用与改前完全一样。纯逻辑，可单测。
 *
 * 使用示例：`AiParamDefaults.fill(call, provider, store)`
 */
object AiParamDefaults {
    /** 参数键：回答长度（Qwen，select，值即 token 数，见 [AiQwenPolicy.MAX_TOKENS_OPTIONS]） */
    const val KEY_MAX_TOKENS = "maxTokens"

    /** 参数键：束宽档位（NLLB，select，值即束宽，见 [AiTranslatePolicy.NUM_BEAMS_OPTIONS]） */
    const val KEY_NUM_BEAMS = "numBeams"

    /**
     * 把用户设置补进一次调用，返回补完的快照（原调用不变）。不是可调提供者、或没有可补的值时原样返回。
     *
     * @param call 原始调用
     * @param provider 选中的提供者
     * @param store 用户参数存储
     * @return 补完后的调用，类型与入参相同
     * @example `AiParamDefaults.fill(call, provider, store)`
     */
    @Suppress("UNCHECKED_CAST")
    fun <C : AiCall> fill(call: C, provider: AiProvider, store: AiParamStore): C {
        val specs = (provider as? AiTunable)?.paramSpecs() ?: return call
        val filled: AiCall = when (call) {
            is AiCall.Run -> fillRun(call, provider.id, specs, store)
            is AiCall.Translate -> fillTranslate(call, provider.id, specs, store)
            is AiCall.Couplet -> fillCouplet(call, provider.id, specs, store)
            is AiCall.Classify -> fillClassify(call, provider.id, specs, store)
            is AiCall.Ocr -> fillOcr(call, provider.id, specs, store)
            else -> call
        }
        return filled as C
    }

    /** 取某个 key 的用户设置值；没有声明该 key 或用户没改过返回 null */
    private fun user(specs: List<AiParamSpec>, key: String, provider: String, store: AiParamStore): Double? =
        specs.firstOrNull { it.key == key }?.let { store.userValue(provider, it) }

    /** 文本生成：温度/topK 只补 prompt 预设（其余预设保持贪心）；回答长度补全部文本预设 */
    private fun fillRun(call: AiCall.Run, id: String, specs: List<AiParamSpec>, store: AiParamStore): AiCall.Run {
        val preset = call.preset ?: AiPreset.ofTask(call.task)
        var sampling = call.sampling
        if (preset == AiPreset.PROMPT) {
            val t = call.sampling?.temperature ?: user(specs, AiGeneratePolicy.KEY_TEMPERATURE, id, store)?.toFloat()
            val k = call.sampling?.topK ?: user(specs, AiGeneratePolicy.KEY_TOP_K, id, store)?.toInt()
            if (t != null || k != null) sampling = AiSamplingParams(t, k)
        }
        val maxTokens = call.maxTokens ?: user(specs, KEY_MAX_TOKENS, id, store)?.toInt()
        if (sampling === call.sampling && maxTokens == call.maxTokens) return call
        return AiCall.Run(call.task, call.provider, call.text, call.preset, call.system, sampling, maxTokens)
    }

    /** 翻译：页面没传 numBeams 时按用户档位映射成束宽 */
    private fun fillTranslate(call: AiCall.Translate, id: String, specs: List<AiParamSpec>, store: AiParamStore): AiCall.Translate {
        if (call.req.numBeams != null) return call
        val beams = user(specs, KEY_NUM_BEAMS, id, store)?.toInt() ?: return call
        return AiCall.Translate(call.req.copy(numBeams = beams))
    }

    /** 对联：页面没传的温度、topK 用用户设置补 */
    private fun fillCouplet(call: AiCall.Couplet, id: String, specs: List<AiParamSpec>, store: AiParamStore): AiCall.Couplet {
        val t = call.req.temperature ?: user(specs, AiGeneratePolicy.KEY_TEMPERATURE, id, store)?.toFloat()
        val k = call.req.topK ?: user(specs, AiGeneratePolicy.KEY_TOP_K, id, store)?.toInt()
        if (t == call.req.temperature && k == call.req.topK) return call
        return AiCall.Couplet(call.req.copy(temperature = t, topK = k))
    }

    /** 识物：页面没传 topK、strictness 时用用户设置补，没有则保持 null（由分派处兜底） */
    private fun fillClassify(call: AiCall.Classify, id: String, specs: List<AiParamSpec>, store: AiParamStore): AiCall.Classify {
        val k = call.req.topK ?: user(specs, AiGeneratePolicy.KEY_TOP_K, id, store)?.toInt()
        val s = call.req.strictness ?: user(specs, AiClassifyPolicy.KEY_CLIP_STRICTNESS, id, store)?.toInt()
        if (k == call.req.topK && s == call.req.strictness) return call
        return AiCall.Classify(call.req.copy(topK = k, strictness = s))
    }

    /** 文字识别：页面没传的灵敏度、过滤分、最长边用用户设置补 */
    private fun fillOcr(call: AiCall.Ocr, id: String, specs: List<AiParamSpec>, store: AiParamStore): AiCall.Ocr {
        val sensitivity = call.req.sensitivity ?: user(specs, AiOcrPolicy.KEY_OCR_SENSITIVITY, id, store)?.toInt()
        val dropScore = call.req.dropScore ?: user(specs, AiOcrPolicy.KEY_OCR_DROP_SCORE, id, store)?.toFloat()
        val maxSide = call.req.maxSide ?: user(specs, AiOcrPolicy.KEY_OCR_MAX_SIDE, id, store)?.toInt()
        if (sensitivity == call.req.sensitivity && dropScore == call.req.dropScore && maxSide == call.req.maxSide) return call
        return AiCall.Ocr(call.req.copy(sensitivity = sensitivity, dropScore = dropScore, maxSide = maxSide))
    }
}
