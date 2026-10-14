package com.let188.arkli

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SafeInsetsTest {
    @Test
    fun scriptSetsFourVariablesOnDocumentElement() {
        val js = SafeInsets(top = 24.5f, bottom = 16f, left = 0f, right = 8.25f).toScript()
        assertTrue(js.startsWith("(function(){var s=document.documentElement.style;"))
        assertTrue(js.contains("s.setProperty('--safe-top','24.50px');"))
        assertTrue(js.contains("s.setProperty('--safe-bottom','16.00px');"))
        assertTrue(js.contains("s.setProperty('--safe-left','0.00px');"))
        assertTrue(js.contains("s.setProperty('--safe-right','8.25px');"))
        assertTrue(js.endsWith("})()"))
    }

    @Test
    fun negativeValuesBecomeZero() {
        val js = SafeInsets(top = -3f, bottom = -0.1f, left = 0f, right = 0f).toScript()
        assertTrue(js.contains("'--safe-top','0.00px'"))
        assertTrue(js.contains("'--safe-bottom','0.00px'"))
    }

    @Test
    fun zeroConstantHasAllSidesZero() {
        assertEquals(SafeInsets(0f, 0f, 0f, 0f), SafeInsets.ZERO)
    }
}
