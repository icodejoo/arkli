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
