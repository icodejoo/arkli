package com.let188.arkli.system

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.ActivityHost
import com.let188.arkli.files.requireMainFrame
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * `native.haptic.vibrate`：`{ pattern: number[], repeat?: number }` 或 `{ cancel: true }` -> `{ vibrated: boolean }`。
 * 参数校验见 [VibratePolicy]；设备没有马达时 `vibrated` 为 false。API 31+ 走 VibratorManager，26+ 用 waveform，24~25 用旧接口。
 *
 * @param context 应用上下文
 */
internal class HapticHandler(private val context: Context) : BridgeHandler {
    /** 取系统震动器 */
    @Suppress("DEPRECATION")
    private fun vibrator(): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }

    /** 校验后震动或取消 */
    @Suppress("DEPRECATION")
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val cancel = SystemParams.boolOrNull(params, "cancel") ?: false
        val v = vibrator()
        if (cancel) {
            v?.cancel()
            return JSONObject().put("vibrated", false)
        }
        val arr = params.optJSONArray("pattern") ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "pattern 必须是数组")
        val repeat = if (params.has("repeat") && !params.isNull("repeat")) (params.opt("repeat") as? Number)?.toInt()
            ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "repeat 必须是数字") else null
        val spec = SystemParams.validated { VibratePolicy.parse(arr.toList(), repeat) }
        if (v == null || !v.hasVibrator()) return JSONObject().put("vibrated", false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            v.vibrate(VibrationEffect.createWaveform(spec.timings, spec.repeat))
        } else {
            v.vibrate(spec.timings, spec.repeat)
        }
        return JSONObject().put("vibrated", true)
    }

    /** JSONArray 转 List，元素保持原样交给校验 */
    private fun JSONArray.toList(): List<Any?> = (0 until length()).map { opt(it) }
}

/**
 * `native.screen.keepAwake`：`{ on: boolean }` -> `{ on }`，开关屏幕常亮（仅本应用窗口）。
 *
 * @param host 操作窗口的宿主
 */
internal class KeepAwakeHandler(private val host: ActivityHost) : BridgeHandler {
    /** 设置常亮 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val on = SystemParams.bool(params, "on")
        host.setScreen(keepAwake = on, brightness = null, immersive = null)
        return JSONObject().put("on", on)
    }
}

/**
 * `native.screen.brightness`：`{ value: number }`（0~1，-1 跟随系统）-> `{ value }`，只影响本应用窗口。
 *
 * @param host 操作窗口的宿主
 */
internal class BrightnessHandler(private val host: ActivityHost) : BridgeHandler {
    /** 设置窗口亮度 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val value = SystemParams.number(params, "value")
        val b = SystemParams.validated { ScreenParams.brightness(value) }
        host.setScreen(keepAwake = null, brightness = b, immersive = null)
        return JSONObject().put("value", b.toDouble())
    }
}

/**
 * `native.screen.immersive`：`{ on: boolean }` -> `{ on }`，隐藏/恢复状态栏与导航栏。
 *
 * @param host 操作窗口的宿主
 */
internal class ImmersiveHandler(private val host: ActivityHost) : BridgeHandler {
    /** 设置沉浸模式 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val on = SystemParams.bool(params, "on")
        host.setScreen(keepAwake = null, brightness = null, immersive = on)
        return JSONObject().put("on", on)
    }
}

/**
 * `native.screen.orientation`：`{ mode: 'landscape' | 'portrait' }` -> `{ mode }`。
 * landscape 为传感器横屏（翻转手机自动正过来），portrait 还原竖屏。
 *
 * @param host 操作窗口的宿主
 */
internal class OrientationHandler(private val host: ActivityHost) : BridgeHandler {
    /** 切换方向 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val mode = SystemParams.string(params, "mode")
        host.setOrientation(SystemParams.validated { ScreenParams.landscape(mode) })
        return JSONObject().put("mode", mode)
    }
}

/**
 * `native.device.info` / `status` / `display`：设备静态信息、动态状态、屏幕参数，字段见 [DeviceCollector]，取不到为 null。
 *
 * @param collector 采集器
 * @param pick 取哪一块数据
 */
internal class DeviceHandler(
    private val collector: DeviceCollector,
    private val pick: (DeviceCollector) -> JSONObject,
) : BridgeHandler {
    /** 在 IO 线程采集（StatFs 等可能阻塞） */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return withContext(Dispatchers.IO) { pick(collector) }
    }
}
