package com.let188.arkli.system

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorManager
import android.hardware.display.DisplayManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.util.DisplayMetrics
import android.view.Display
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.TimeZone

/**
 * 采集设备静态信息、动态状态与屏幕参数，组装成 JSON。每个字段单独兜底，取不到给 null，不抛。
 *
 * 使用示例：`DeviceCollector(context).status()`
 *
 * @param context 应用上下文
 */
internal class DeviceCollector(private val context: Context) {
    /** 常见系统特性：页面键 -> PackageManager 特性名 */
    private val features = listOf(
        "nfc" to PackageManager.FEATURE_NFC,
        "bluetooth" to PackageManager.FEATURE_BLUETOOTH,
        "bluetoothLe" to PackageManager.FEATURE_BLUETOOTH_LE,
        "wifi" to PackageManager.FEATURE_WIFI,
        "telephony" to PackageManager.FEATURE_TELEPHONY,
        "fingerprint" to PackageManager.FEATURE_FINGERPRINT,
        "camera" to PackageManager.FEATURE_CAMERA_ANY,
        "cameraFront" to PackageManager.FEATURE_CAMERA_FRONT,
        "cameraFlash" to PackageManager.FEATURE_CAMERA_FLASH,
        "gps" to PackageManager.FEATURE_LOCATION_GPS,
        "microphone" to PackageManager.FEATURE_MICROPHONE,
        "gyroscope" to PackageManager.FEATURE_SENSOR_GYROSCOPE,
        "accelerometer" to PackageManager.FEATURE_SENSOR_ACCELEROMETER,
        "compass" to PackageManager.FEATURE_SENSOR_COMPASS,
        "barometer" to PackageManager.FEATURE_SENSOR_BAROMETER,
        "lightSensor" to PackageManager.FEATURE_SENSOR_LIGHT,
        "proximity" to PackageManager.FEATURE_SENSOR_PROXIMITY,
        "usbHost" to PackageManager.FEATURE_USB_HOST,
        "infrared" to PackageManager.FEATURE_CONSUMER_IR,
    )

    /** 取值失败给 null 的包装 */
    private inline fun <T> orNull(block: () -> T?): Any = try {
        block() ?: JSONObject.NULL
    } catch (e: Exception) {
        JSONObject.NULL
    }

    /**
     * 静态信息：品牌型号、系统版本、ABI、总内存、屏幕、传感器、语言时区、系统特性。
     *
     * @return `native.device.info` 的返回数据
     */
    fun info(): JSONObject = JSONObject()
        .put("brand", Build.BRAND)
        .put("model", Build.MODEL)
        .put("device", Build.DEVICE)
        .put("manufacturer", Build.MANUFACTURER)
        .put("androidVersion", Build.VERSION.RELEASE)
        .put("sdkInt", Build.VERSION.SDK_INT)
        .put("securityPatch", orNull { Build.VERSION.SECURITY_PATCH })
        .put("abis", JSONArray(Build.SUPPORTED_ABIS.toList()))
        .put("harmonyOs", orNull { harmonyBrand() != null })
        .put("osBrand", orNull { harmonyBrand() })
        .put("totalMemBytes", orNull { memoryInfo().totalMem })
        .put("display", display())
        .put("sensors", orNull { sensors() })
        .put("locale", orNull { Locale.getDefault().toLanguageTag() })
        .put("timeZone", orNull { TimeZone.getDefault().id })
        .put("features", featureMap())

    /**
     * 动态状态：电量、充电、温度、电压、可用内存、存储、网络、省电模式。
     *
     * @return `native.device.status` 的返回数据
     */
    fun status(): JSONObject {
        val battery = orNull { context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) }
        val b = battery as? Intent
        val statusCode = b?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)?.takeIf { it >= 0 }
        val plugged = b?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
        val charge = DeviceFormat.chargeStatus(statusCode)
        val plug = DeviceFormat.plugType(plugged)
        val net = networkType()
        return JSONObject()
            .put("batteryPercent", DeviceFormat.batteryPercent(b?.intExtraOrNull(BatteryManager.EXTRA_LEVEL), b?.intExtraOrNull(BatteryManager.EXTRA_SCALE)) ?: JSONObject.NULL)
            .put("charging", if (b == null) JSONObject.NULL else charge == "charging" || charge == "full" && plug != DeviceFormat.PLUG_NONE)
            .put("chargeStatus", charge)
            .put("chargeStatusText", DeviceFormat.textOf(charge))
            .put("plugType", plug)
            .put("plugText", DeviceFormat.textOf(plug))
            .put("batteryTempC", DeviceFormat.celsius(b?.intExtraOrNull(BatteryManager.EXTRA_TEMPERATURE)) ?: JSONObject.NULL)
            .put("batteryVoltageMv", DeviceFormat.voltage(b?.intExtraOrNull(BatteryManager.EXTRA_VOLTAGE)) ?: JSONObject.NULL)
            .put("availMemBytes", orNull { memoryInfo().availMem })
            .put("lowMemory", orNull { memoryInfo().lowMemory })
            .put("storageTotalBytes", orNull { StatFs(Environment.getDataDirectory().path).totalBytes })
            .put("storageFreeBytes", orNull { StatFs(Environment.getDataDirectory().path).availableBytes })
            .put("networkType", net ?: JSONObject.NULL)
            .put("networkText", net?.let { DeviceFormat.textOf(it) } ?: JSONObject.NULL)
            .put("powerSave", orNull { (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isPowerSaveMode })
    }

    /**
     * 屏幕参数：真实分辨率、dpi、密度、刷新率。
     *
     * @return `native.device.display` 的返回数据，字段取不到为 null
     */
    @Suppress("DEPRECATION")
    fun display(): JSONObject {
        val dm = try {
            val d = (context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).getDisplay(Display.DEFAULT_DISPLAY)
            DisplayMetrics().also { d.getRealMetrics(it) } to d.refreshRate
        } catch (e: Exception) {
            null
        }
        val m = dm?.first ?: context.resources.displayMetrics
        return JSONObject()
            .put("widthPx", m.widthPixels)
            .put("heightPx", m.heightPixels)
            .put("xdpi", m.xdpi.toDouble())
            .put("ydpi", m.ydpi.toDouble())
            .put("densityDpi", m.densityDpi)
            .put("density", m.density.toDouble())
            .put("refreshRate", dm?.second?.toDouble() ?: JSONObject.NULL)
    }

    /** 读 Intent 里的整数，缺失返回 null */
    private fun Intent.intExtraOrNull(key: String): Int? = if (hasExtra(key)) getIntExtra(key, 0) else null

    /** 系统内存信息 */
    private fun memoryInfo(): ActivityManager.MemoryInfo =
        ActivityManager.MemoryInfo().also { (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(it) }

    /** 当前网络类型枚举；取不到（无权限、系统异常）返回 null */
    private fun networkType(): String? = try {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
        val all = listOf(
            NetworkCapabilities.TRANSPORT_WIFI, NetworkCapabilities.TRANSPORT_CELLULAR, NetworkCapabilities.TRANSPORT_ETHERNET,
            NetworkCapabilities.TRANSPORT_BLUETOOTH, NetworkCapabilities.TRANSPORT_VPN,
        )
        DeviceFormat.networkType(if (caps == null) emptySet() else all.filterTo(HashSet()) { caps.hasTransport(it) }.ifEmpty { setOf(-1) })
    } catch (e: Exception) {
        null
    }

    /** 传感器列表（上限 100 个），每项含名称、类型数值与类型字符串 */
    private fun sensors(): JSONArray {
        val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val arr = JSONArray()
        sm.getSensorList(Sensor.TYPE_ALL).take(MAX_SENSORS).forEach {
            arr.put(JSONObject().put("name", it.name).put("type", it.type).put("typeName", it.stringType ?: JSONObject.NULL))
        }
        return arr
    }

    /** 系统特性开关表 */
    private fun featureMap(): JSONObject {
        val pm = context.packageManager
        val o = JSONObject()
        features.forEach { (key, name) -> o.put(key, orNull { pm.hasSystemFeature(name) }) }
        return o
    }

    /** 鸿蒙检测：反射 `com.huawei.system.BuildEx.getOsBrand()`，非鸿蒙或失败返回 null；只在 harmony 时返回品牌名 */
    private fun harmonyBrand(): String? = try {
        val brand = Class.forName(HARMONY_CLASS).getMethod("getOsBrand").invoke(null) as? String
        brand?.takeIf { it.equals("harmony", ignoreCase = true) }
    } catch (e: Throwable) {
        null
    }

    private companion object {
        /** 鸿蒙系统提供的 Build 扩展类 */
        const val HARMONY_CLASS = "com.huawei.system.BuildEx"

        /** 传感器列表条数上限，防止个别机型返回极长列表 */
        const val MAX_SENSORS = 100
    }
}
