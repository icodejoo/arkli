package com.let188.arkli.noise

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** 噪音换算与窗口分块测试 */
class NoiseMathTest {
    @Test
    fun fullScaleIsZeroDbfs() {
        assertEquals(0.0, NoiseMath.toDbfs(32768.0), 1e-9)
        assertEquals(-6.02, NoiseMath.toDbfs(16384.0), 0.01)
    }

    @Test
    fun silenceClampsToFloor() {
        assertEquals(NoiseMath.MIN_DBFS, NoiseMath.toDbfs(0.0), 0.0)
        val s = NoiseMath.stats(ShortArray(100), 100)
        assertEquals(NoiseMath.MIN_DBFS, s.rmsDbfs, 0.0)
        assertEquals(0.0, s.db, 0.0)
    }

    @Test
    fun dbOffsetAndClamp() {
        assertEquals(60.0, NoiseMath.toDb(-30.0), 1e-9)
        assertEquals(0.0, NoiseMath.toDb(-120.0), 0.0)
        assertEquals(NoiseMath.MAX_DB, NoiseMath.toDb(80.0), 0.0)
    }

    @Test
    fun statsOfConstantSignal() {
        val buf = ShortArray(50) { 16384 }
        val s = NoiseMath.stats(buf, 50)
        assertEquals(-6.02, s.rmsDbfs, 0.01)
        assertEquals(s.db, s.peakDb, 1e-9)
    }

    @Test
    fun peakExceedsRmsWhenSpiky() {
        val buf = ShortArray(100)
        buf[10] = -32768
        val s = NoiseMath.stats(buf, 100)
        assertEquals(90.0, s.peakDb, 1e-9)
        assertTrue(s.db < s.peakDb)
    }

    @Test
    fun statsRespectsLen() {
        val buf = ShortArray(10) { 1000 }
        buf[9] = 32767
        assertEquals(NoiseMath.stats(ShortArray(9) { 1000 }, 9), NoiseMath.stats(buf, 9))
    }

    @Test
    fun windowSizes() {
        assertEquals(1600, NoiseMath.windowSamples(100))
        assertEquals(800, NoiseMath.windowSamples(50))
        assertEquals(16000, NoiseMath.windowSamples(1000))
        assertEquals(12800, NoiseMath.bufferBytes(100, 1600))
        assertEquals(50000, NoiseMath.bufferBytes(50000, 1600))
    }

    @Test
    fun accumulatorSplitsIntoWindows() {
        val acc = WindowAccumulator(4)
        val seen = ArrayList<NoiseStats>()
        acc.feed(ShortArray(3) { 100 }, 3) { seen.add(it) }
        assertEquals(0, seen.size)
        acc.feed(ShortArray(6) { 100 }, 6) { seen.add(it) }
        // 3 + 6 = 9 个采样，凑出 2 个窗口，余 1
        assertEquals(2, seen.size)
        acc.feed(ShortArray(3) { 100 }, 3) { seen.add(it) }
        assertEquals(3, seen.size)
    }

    @Test
    fun accumulatorMixesChunksInOneWindow() {
        val acc = WindowAccumulator(4)
        var out: NoiseStats? = null
        acc.feed(shortArrayOf(0, 0), 2) { out = it }
        acc.feed(shortArrayOf(-32768, 0), 2) { out = it }
        assertEquals(90.0, out!!.peakDb, 1e-9)
    }

    @Test
    fun intervalParsing() {
        assertEquals(100, NoiseMath.parseInterval(JSONObject()))
        assertEquals(50, NoiseMath.parseInterval(JSONObject().put("intervalMs", 50)))
        assertEquals(1000, NoiseMath.parseInterval(JSONObject().put("intervalMs", 1000)))
        for (bad in listOf<Any>(49, 1001, "x")) {
            try {
                NoiseMath.parseInterval(JSONObject().put("intervalMs", bad))
                fail("应当抛出")
            } catch (e: BridgeException) {
                assertEquals(BridgeErrors.BAD_PARAMS, e.code)
            }
        }
    }
}
