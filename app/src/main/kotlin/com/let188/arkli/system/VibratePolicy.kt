package com.let188.arkli.system

/**
 * 校验通过的震动请求。
 *
 * @property timings `[停, 震, 停, 震…]` 毫秒数组
 * @property repeat 从哪个下标开始循环，-1 表示只震一遍
 */
internal class VibrateSpec(val timings: LongArray, val repeat: Int)

/**
 * `native.haptic.vibrate` 的参数校验，纯函数，可单测。
 *
 * 使用示例：`VibratePolicy.parse(listOf(0, 100, 50, 100), null)`
 */
internal object VibratePolicy {
    /** 数组最多元素个数 */
    const val MAX_COUNT = 100

    /** 单个元素的最大毫秒数 */
    const val MAX_ITEM_MS = 10_000L

    /** 整个 pattern 的总时长上限（毫秒） */
    const val MAX_TOTAL_MS = 30_000L

    /** 不循环 */
    const val NO_REPEAT = -1

    /**
     * 校验并转换震动参数。
     *
     * @param pattern 毫秒数组，元素须是 0~10000 的整数，个数 1~100，总长不超过 30 秒且大于 0
     * @param repeat 循环起点下标，缺省或 -1 表示不循环；须在 pattern 范围内
     * @return 规范化后的请求
     * @throws IllegalArgumentException 参数不合法
     */
    fun parse(pattern: List<Any?>, repeat: Int?): VibrateSpec {
        require(pattern.isNotEmpty()) { "pattern 不能为空" }
        require(pattern.size <= MAX_COUNT) { "pattern 最多 $MAX_COUNT 项" }
        var total = 0L
        val timings = LongArray(pattern.size) { i ->
            val d = (pattern[i] as? Number)?.toDouble() ?: throw IllegalArgumentException("pattern[$i] 必须是数字")
            require(d == Math.floor(d) && d >= 0 && d <= MAX_ITEM_MS) { "pattern[$i] 需要是 0~$MAX_ITEM_MS 的整数" }
            d.toLong().also { total += it }
        }
        require(total <= MAX_TOTAL_MS) { "pattern 总时长不能超过 ${MAX_TOTAL_MS / 1000} 秒" }
        require(total > 0) { "pattern 不能全是 0" }
        val r = repeat ?: NO_REPEAT
        require(r == NO_REPEAT || r in timings.indices) { "repeat 需要是 -1 或有效下标" }
        return VibrateSpec(timings, r)
    }
}
