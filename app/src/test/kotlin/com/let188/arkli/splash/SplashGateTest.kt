package com.let188.arkli.splash

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SplashGateTest {
    @Before
    fun reset() = SplashGate.resetForTest()

    @Test
    fun claimOnlySucceedsOncePerProcess() {
        assertTrue(SplashGate.claim())
        assertFalse(SplashGate.claim())
        assertFalse(SplashGate.claim())
    }

    @Test
    fun markReadyFlipsFlow() {
        assertFalse(SplashGate.ready.value)
        SplashGate.markReady()
        assertTrue(SplashGate.ready.value)
    }
}
