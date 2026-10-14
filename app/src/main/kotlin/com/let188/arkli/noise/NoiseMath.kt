package com.let188.arkli.noise

import com.let188.arkli.system.SystemParams
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * 一个窗口的噪音统计。
 *
 * @property db 近似声压级（未校准），0~140
 * @property peakDb 窗口峰值对应的近似声压级，0~140
 * @property rmsDbfs 窗口 RMS 的 dBFS，满量程为 0，静音取下限 [NoiseMath.MIN_DBFS]
 */
internal data class NoiseStats(val db: Double, val peakDb: Double, val rmsDbfs: Double)

/**
 * 噪音换算与窗口分块，纯函数，可单测。
 * 声压级是未校准的近似值：`db = dBFS + 90`，不同机型麦克风灵敏度差异很大，仅供参考。
 *
 * 使用示例：`NoiseMath.stats(samples, samples.size)`
 */
internal object NoiseMath {
    /** 采样率（Hz） */
    const val SAMPLE_RATE = 16_000

    /** 汇报间隔缺省值（毫秒） */
    const val DEFAULT_INTERVAL_MS = 100

    /** 汇报间隔下限（毫秒） */
    const val MIN_INTERVAL_MS = 50

    /** 汇报间隔上限（毫秒） */
    const val MAX_INTERVAL_MS = 1000

    /** dBFS 到近似声压级的偏移 */
    const val DB_OFFSET = 90.0

    /** 近似声压级上限 */
    const val MAX_DB = 140.0

    /** 静音时 dBFS 的下限，避免 -Infinity 进不了 JSON */
    const val MIN_DBFS = -120.0

    /** 16bit 满量程幅值 */
    private const val FULL_SCALE = 32768.0

    /** 一个采样占的字节数 */
    private const val BYTES_PER_SAMPLE = 2

    /**
     * 解析并校验汇报间隔。
     *
     * @param params 页面参数，`intervalMs` 缺省取 [DEFAULT_INTERVAL_MS]
     * @return 毫秒数
     * @throws com.let188.arkli.bridge.BridgeException BAD_PARAMS，不在 50~1000
     */
    fun parseInterval(params: org.json.JSONObject): Int {
        val v = params.opt("intervalMs")
        if (v == null || v == org.json.JSONObject.NULL) return DEFAULT_INTERVAL_MS
        val n = SystemParams.number(params, "intervalMs")
        return SystemParams.validated {
            require(n.isFinite() && n >= MIN_INTERVAL_MS && n <= MAX_INTERVAL_MS) { "intervalMs 须在 $MIN_INTERVAL_MS~$MAX_INTERVAL_MS 之间" }
            n.toInt()
        }
    }

    /**
     * 一个窗口的采样数。
     *
     * @param intervalMs 窗口时长（毫秒）
     * @return 采样数，至少 1
     */
    fun windowSamples(intervalMs: Int): Int = (SAMPLE_RATE.toLong() * intervalMs / 1000).toInt().coerceAtLeast(1)

    /**
     * 录音缓冲区字节数：不小于系统最小值，并留出几个窗口的余量防溢出。
     *
     * @param minBufferBytes 系统给的最小缓冲区字节数
     * @param windowSamples 窗口采样数
     * @return 缓冲区字节数
     */
    fun bufferBytes(minBufferBytes: Int, windowSamples: Int): Int = maxOf(minBufferBytes, windowSamples * BYTES_PER_SAMPLE * 4)

    /**
     * 幅值比转 dBFS，夹到 [MIN_DBFS, 0]。
     *
     * @param amplitude 幅值，满量程为 32768
     * @return dBFS
     */
    fun toDbfs(amplitude: Double): Double {
        if (amplitude <= 0.0) return MIN_DBFS
        return (20 * log10(amplitude / FULL_SCALE)).coerceIn(MIN_DBFS, 0.0)
    }

    /**
     * dBFS 转近似声压级，夹到 0~140。
     *
     * @param dbfs dBFS 值
     * @return 近似声压级
     */
    fun toDb(dbfs: Double): Double = (dbfs + DB_OFFSET).coerceIn(0.0, MAX_DB)

    /**
     * 计算一段采样的统计值。
     *
     * @param samples 16bit 采样
     * @param len 有效采样数，不超过 samples 长度
     * @return 统计值；len 为 0 时按静音处理
     */
    fun stats(samples: ShortArray, len: Int): NoiseStats {
        var sumSq = 0.0
        var peak = 0
        for (i in 0 until len) {
            val v = samples[i].toInt()
            sumSq += v.toDouble() * v
            val a = if (v < 0) -v else v
            if (a > peak) peak = a
        }
        val rms = if (len > 0) sqrt(sumSq / len) else 0.0
        val rmsDbfs = toDbfs(rms)
        return NoiseStats(toDb(rmsDbfs), toDb(toDbfs(peak.toDouble())), rmsDbfs)
    }
}

/**
 * 把任意大小的读取块攒成定长窗口，每满一个窗口回调一次统计值。
 *
 * 使用示例：`WindowAccumulator(1600).feed(buf, n) { stats -> ... }`
 *
 * @param windowSize 窗口采样数
 */
internal class WindowAccumulator(private val windowSize: Int) {
    /** 当前窗口已攒的采样 */
    private val window = ShortArray(windowSize)

    /** 已攒数量 */
    private var filled = 0

    /**
     * 喂入一块采样。
     *
     * @param buf 采样缓冲
     * @param len 有效采样数
     * @param onWindow 每攒满一个窗口回调一次
     */
    fun feed(buf: ShortArray, len: Int, onWindow: (NoiseStats) -> Unit) {
        var pos = 0
        while (pos < len) {
            val n = minOf(windowSize - filled, len - pos)
            System.arraycopy(buf, pos, window, filled, n)
            filled += n
            pos += n
            if (filled == windowSize) {
                onWindow(NoiseMath.stats(window, windowSize))
                filled = 0
            }
        }
    }
}
