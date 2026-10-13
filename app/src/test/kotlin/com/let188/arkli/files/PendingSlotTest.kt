package com.let188.arkli.files

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** PendingSlot：占用、送达、launch 失败与取消后的清理 */
class PendingSlotTest {
    @Test
    fun deliversResultAndFreesSlot() = runBlocking {
        val slot = PendingSlot<Boolean>("忙")
        val r = slot.await { slot.complete(true) }
        assertTrue(r)
        assertFalse(slot.isBusy())
    }

    @Test
    fun secondWaiterRejectedWhileBusy() = runBlocking {
        val slot = PendingSlot<Int>("忙")
        val first = async(start = CoroutineStart.UNDISPATCHED) { slot.await { } }
        assertTrue(slot.isBusy())
        try {
            slot.await { }
            fail("应抛 NOT_READY")
        } catch (e: BridgeException) {
            assertEquals(BridgeErrors.NOT_READY, e.code)
        }
        slot.complete(7)
        assertEquals(7, first.await())
    }

    @Test
    fun launchFailureReleasesSlot() = runBlocking {
        val slot = PendingSlot<Boolean>("忙")
        try {
            slot.await { error("拉起失败") }
            fail("应抛异常")
        } catch (_: IllegalStateException) {
        }
        assertFalse(slot.isBusy())
        assertTrue(slot.await { slot.complete(true) })
    }

    @Test
    fun cancellationReleasesSlot() = runBlocking {
        val slot = PendingSlot<Boolean>("忙")
        val job = async(start = CoroutineStart.UNDISPATCHED) { slot.await { } }
        assertTrue(slot.isBusy())
        job.cancelAndJoin()
        assertFalse(slot.isBusy())
        assertTrue(slot.await { slot.complete(true) })
    }

    @Test
    fun cancellationKeepsSlotUntilResultWhenNotReleasing() = runBlocking {
        val slot = PendingSlot<Boolean>("忙")
        val job = async(start = CoroutineStart.UNDISPATCHED) { slot.await(releaseOnCancel = false) { } }
        job.cancelAndJoin()
        assertTrue(slot.isBusy())
        slot.complete(true)
        assertFalse(slot.isBusy())
    }

    @Test
    fun completeWithoutWaiterIsIgnored() {
        val slot = PendingSlot<Int>("忙")
        slot.complete(1)
        assertFalse(slot.isBusy())
    }
}
