package com.let188.arkli.bridge

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Test

/** ArkliBridge.onClose 钩子测试 */
@OptIn(ExperimentalCoroutinesApi::class)
class BridgeCloseHookTest {
    /** 造一个丢弃回传的 Bridge */
    private fun bridge() = ArkliBridge(1, ReplyIo { }, false, UnconfinedTestDispatcher())

    @Test
    fun listenersRunOnceEvenIfClosedTwice() {
        val b = bridge()
        var n = 0
        b.onClose { n++ }
        b.close()
        b.close()
        assertEquals(1, n)
    }

    @Test
    fun throwingListenerDoesNotBlockOthers() {
        val b = bridge()
        var ran = false
        b.onClose { error("boom") }
        b.onClose { ran = true }
        b.close()
        assertEquals(true, ran)
    }
}
