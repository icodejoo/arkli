package com.let188.arkli.splash

/**
 * 启动动画的一段时间区间。
 *
 * @property delayMs 开始时刻（毫秒，相对动画起点）
 * @property durationMs 持续时长（毫秒）
 */
internal data class Span(val delayMs: Long, val durationMs: Long)

/**
 * 启动动画的时间轴与退出判定，纯逻辑，可单测。
 *
 * 使用示例：`SplashTimeline.progress(elapsedMs, SplashTimeline.GRADIENT)`
 */
internal object SplashTimeline {
    /** 渐变背景从纯色淡入 */
    val GRADIENT = Span(0, 400)

    /** 爆出的图标个数，要与 SplashActivity 里的 ITEMS 一致 */
    const val ITEM_COUNT = 13

    /** 每个图标比前一个晚出手的间隔（毫秒），由内圈到外圈 */
    private const val ITEM_STAGGER_MS = 25L

    /** 图标爆出时长 */
    private const val ITEM_BURST_MS = 600L

    /** 第一个图标出手时刻：渐变刚开始淡入就炸 */
    private const val ITEM_FIRST_MS = 120L

    /** 所有图标依次爆出 */
    val ITEMS: List<Span> = List(ITEM_COUNT) { Span(ITEM_FIRST_MS + it * ITEM_STAGGER_MS, ITEM_BURST_MS) }

    /** 字标淡入 */
    val TITLE = Span(300, 400)

    /** 副标题淡入 */
    val SUB = Span(400, 400)

    /** 最短展示时长，够播完图标爆发与字标 */
    const val MIN_SHOW_MS = 1100L

    /** 兜底：页面迟迟没就绪也最多展示这么久 */
    const val MAX_SHOW_MS = 4000L

    /** 退出淡出时长 */
    const val FADE_OUT_MS = 300

    /**
     * 某段动画在 [elapsedMs] 时的进度。
     *
     * @param elapsedMs 已播放毫秒数
     * @param span 动画区间
     * @return 0（未开始）到 1（已结束）
     */
    fun progress(elapsedMs: Long, span: Span): Float =
        ((elapsedMs - span.delayMs).toFloat() / span.durationMs).coerceIn(0f, 1f)

    /**
     * 是否该开始退出：页面就绪且播够最短时长，或者超过兜底时长。
     *
     * @param elapsedMs 已播放毫秒数
     * @param pageReady 页面是否已就绪
     * @return 该退出返回 true
     */
    fun canExit(elapsedMs: Long, pageReady: Boolean): Boolean =
        elapsedMs >= MAX_SHOW_MS || (pageReady && elapsedMs >= MIN_SHOW_MS)
}
