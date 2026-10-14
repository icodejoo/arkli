package com.let188.arkli.image

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 编码进度节流测试：时钟注入，不依赖真实时间 */
class ProgressThrottleTest {
    /** 假时钟（毫秒） */
    private var now = 0L

    /** 被测对象 */
    private val t = ProgressThrottle(minStep = 2, minIntervalMs = 250) { now }

    @Test
    fun firstAlwaysPasses() {
        assertTrue(t.accept(0))
    }

    @Test
    fun passesOnlyAfterStepOrInterval() {
        assertTrue(t.accept(0))
        assertFalse(t.accept(1))
        assertTrue(t.accept(2))
        assertFalse(t.accept(3))
        now += 249
        assertFalse(t.accept(3))
        now += 1
        assertTrue(t.accept(3))
    }

    @Test
    fun repeatedOrBackwardNeverPasses() {
        assertTrue(t.accept(10))
        now += 10_000
        assertFalse(t.accept(10))
        assertFalse(t.accept(9))
    }

    @Test
    fun hundredAlwaysPassesOnceAndAtMostFiftyOneEventsForFullRun() {
        var passed = 0
        for (p in 0..100) if (t.accept(p)) passed++
        // 0 起每 2 个点放行一次：0,2,...,98 共 50 条，再加 100
        assertEquals(51, passed)
        assertFalse(t.accept(100))
    }
}
