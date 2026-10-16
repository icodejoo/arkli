package com.let188.arkli.ai

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Test

/** 进程级回收：额外可回收项（语音识别器）登记后随 releaseNow 一起卸载，只报真正卸掉的 */
class AiRecycleTest {
    /** 登记项是进程级单例，用完清掉，免得串到别的测试 */
    @After
    fun cleanup() {
        listOf("test-extra-on", "test-extra-off", "test-extra-boom").forEach { AiRecycle.detachExtra(it) }
    }

    /** 登记的额外项会被调用，返回 true 的计入已卸载 */
    @Test
    fun extra_unloaded_and_reported() = runBlocking {
        var called = 0
        AiRecycle.attachExtra("test-extra-on") { called++; true }
        val done = AiRecycle.releaseNow()
        assertTrue(done.contains("test-extra-on"))
        assertEquals(1, called)
    }

    /** 返回 false（没加载或有会话在用）的不计入，抛异常的也不影响其他项 */
    @Test
    fun extra_false_or_throwing_not_reported() = runBlocking {
        AiRecycle.attachExtra("test-extra-off") { false }
        AiRecycle.attachExtra("test-extra-boom") { error("boom") }
        val done = AiRecycle.releaseNow()
        assertTrue(!done.contains("test-extra-off"))
        assertTrue(!done.contains("test-extra-boom"))
    }
}
