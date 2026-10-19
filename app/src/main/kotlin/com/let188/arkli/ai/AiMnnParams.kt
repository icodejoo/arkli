package com.let188.arkli.ai

/**
 * MNN 共享推理参数与会话指纹辅助工具。
 *
 * 管理所有本地 MNN 模型的共用参数（如算子线程数），提供线程数读取与并入各模型会话指纹的纯逻辑。
 *
 * 使用示例：`val t = AiMnnParams.threads(store)`
 */
object AiMnnParams {
    /** 提供者标识（公用参数专用命名空间） */
    const val PROVIDER_ID = "mnn"

    /** 参数键：推理线程数 */
    const val KEY_NUM_THREAD = "numThread"

    /** 参数键：性能模式 */
    const val KEY_POWER = "power"

    /** 性能模式取值：均衡（MNN 的 Power_Normal） */
    const val POWER_NORMAL = 0

    /** 性能模式取值：性能（Power_High） */
    const val POWER_HIGH = 1

    /** 默认线程数 */
    const val DEFAULT_THREADS = 4

    /** 最小线程数 */
    const val MIN = 1

    /** 最大线程数 */
    const val MAX = 6

    /** 线程数步进 */
    private const val STEP_THREADS = 1.0

    /**
     * MNN 共享参数规格列表。
     */
    val SPECS: List<AiParamSpec> = listOf(
        AiParamSpec(
            key = KEY_NUM_THREAD,
            label = "推理线程数",
            desc = "一般设成手机大核数最快；调太高反而变慢，调到 1 会慢好几倍",
            kind = AiParamKind.STEPPER,
            default = DEFAULT_THREADS.toDouble(),
            min = MIN.toDouble(),
            max = MAX.toDouble(),
            step = STEP_THREADS,
            scope = AiParamScope.SESSION,
        ),
        AiParamSpec(
            key = KEY_POWER,
            label = "性能模式",
            desc = "性能档固定用大核计算，在大小核调度不好的手机上可能更快，代价是更耗电；改完下次使用时重新加载",
            kind = AiParamKind.SELECT,
            default = POWER_NORMAL.toDouble(),
            min = POWER_NORMAL.toDouble(),
            max = POWER_HIGH.toDouble(),
            step = 1.0,
            options = listOf("均衡", "性能"),
            optionValues = listOf(POWER_NORMAL, POWER_HIGH).map { it.toDouble() },
            scope = AiParamScope.SESSION,
        ),
    )

    /**
     * 读取当前生效的推理线程数。
     *
     * @param store 参数持久化存储
     * @return 线程数（1~6）
     * @example `AiMnnParams.threads(store)`
     */
    fun threads(store: AiParamStore): UInt {
        val spec = SPECS.first { it.key == KEY_NUM_THREAD }
        return store.effectiveValue(PROVIDER_ID, spec).toUInt()
    }

    /**
     * 读取当前生效的性能模式。
     *
     * @param store 参数持久化存储
     * @return 0 均衡 / 1 性能
     * @example `AiMnnParams.power(store)`
     */
    fun power(store: AiParamStore): Int = intValue(store, KEY_POWER)

    /** 按键取当前生效值并取整 */
    private fun intValue(store: AiParamStore, key: String): Int =
        store.effectiveValue(PROVIDER_ID, SPECS.first { it.key == key }).toInt()

    /**
     * 计算并入 MNN 公用会话参数后的提供者会话指纹。
     *
     * @param providerId 提供者 id
     * @param specs 提供者自身的参数规格列表
     * @param store 参数持久化存储
     * @return 会话指纹字符串
     * @example `AiMnnParams.fingerprint("local-qwen", specs, store)`
     */
    fun fingerprint(providerId: String, specs: List<AiParamSpec>, store: AiParamStore): String =
        AiParams.sessionFingerprint(providerId, specs, store, SPECS)
}
