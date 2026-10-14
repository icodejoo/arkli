package com.let188.arkli.splash

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SplashTimelineTest {
    @Test
    fun progressClampsBeforeAndAfter() {
        val s = Span(100, 200)
        assertEquals(0f, SplashTimeline.progress(0, s), 0f)
        assertEquals(0f, SplashTimeline.progress(100, s), 0f)
        assertEquals(0.5f, SplashTimeline.progress(200, s), 1e-6f)
        assertEquals(1f, SplashTimeline.progress(300, s), 0f)
        assertEquals(1f, SplashTimeline.progress(9999, s), 0f)
    }

    @Test
    fun canExitNeedsReadyAndMinimum() {
        assertFalse(SplashTimeline.canExit(SplashTimeline.MIN_SHOW_MS - 1, true))
        assertTrue(SplashTimeline.canExit(SplashTimeline.MIN_SHOW_MS, true))
        assertFalse(SplashTimeline.canExit(SplashTimeline.MIN_SHOW_MS + 500, false))
    }

    @Test
    fun canExitFallsBackAtMax() {
        assertFalse(SplashTimeline.canExit(SplashTimeline.MAX_SHOW_MS - 1, false))
        assertTrue(SplashTimeline.canExit(SplashTimeline.MAX_SHOW_MS, false))
    }

    @Test
    fun allSegmentsFinishBeforeMinimumShow() {
        val ends = SplashTimeline.ITEMS + listOf(SplashTimeline.TITLE, SplashTimeline.SUB)
        // 最后一段在最短展示时长（容许 300ms 尾巴）内播完，退出时不会切到半截
        assertTrue(ends.all { it.delayMs + it.durationMs <= SplashTimeline.MIN_SHOW_MS + 300 })
    }

    @Test
    fun itemsCountMatchesAndStaggerIncreases() {
        assertEquals(SplashTimeline.ITEM_COUNT, SplashTimeline.ITEMS.size)
        val starts = SplashTimeline.ITEMS.map { it.delayMs }
        assertEquals(starts.sorted(), starts)
        assertEquals(starts.toSet().size, starts.size)
    }
}
