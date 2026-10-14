package com.let188.arkli.system

import android.net.NetworkCapabilities
import android.os.BatteryManager

/**
 * 设备信息里的数值格式化与状态码映射，纯函数，可单测。
 *
 * 使用示例：`DeviceFormat.chargeStatus(BatteryManager.BATTERY_STATUS_CHARGING)` -> `"charging"`
 */
internal object DeviceFormat {
    /** 未知 */
    const val UNKNOWN = "unknown"

    /** 无连接 */
    const val NET_NONE = "none"

    /** 无外接电源 */
    const val PLUG_NONE = "none"

    /** 底座充电（BatteryManager.BATTERY_PLUGGED_DOCK，API 33 才有常量） */
    private const val PLUGGED_DOCK = 8

    /** 充电状态码 -> 英文枚举 */
    private val CHARGE_CODES = mapOf(
        BatteryManager.BATTERY_STATUS_CHARGING to "charging",
        BatteryManager.BATTERY_STATUS_DISCHARGING to "discharging",
        BatteryManager.BATTERY_STATUS_NOT_CHARGING to "not_charging",
        BatteryManager.BATTERY_STATUS_FULL to "full",
    )

    /** 英文枚举 -> 中文文案（充电状态、供电方式、网络类型共用） */
    private val TEXTS = mapOf(
        "charging" to "充电中",
        "discharging" to "放电中",
        "not_charging" to "未在充电",
        "full" to "已充满",
        "ac" to "交流电",
        "usb" to "USB",
        "wireless" to "无线充电",
        "dock" to "底座",
        PLUG_NONE to "未连接电源",
        "wifi" to "Wi-Fi",
        "cellular" to "移动数据",
        "ethernet" to "以太网",
        "bluetooth" to "蓝牙网络",
        "vpn" to "VPN",
        "other" to "其他网络",
        UNKNOWN to "未知",
    )

    /** 网络传输类型 -> 英文枚举，按优先级排列（VPN 下层通常还有真实链路，优先报真实链路） */
    private val TRANSPORTS = listOf(
        NetworkCapabilities.TRANSPORT_WIFI to "wifi",
        NetworkCapabilities.TRANSPORT_CELLULAR to "cellular",
        NetworkCapabilities.TRANSPORT_ETHERNET to "ethernet",
        NetworkCapabilities.TRANSPORT_BLUETOOTH to "bluetooth",
        NetworkCapabilities.TRANSPORT_VPN to "vpn",
    )

    /**
     * 充电状态码转英文枚举。
     *
     * @param status `BatteryManager.EXTRA_STATUS` 的值
     * @return charging / discharging / not_charging / full / unknown
     */
    fun chargeStatus(status: Int?): String = CHARGE_CODES[status] ?: UNKNOWN

    /**
     * 供电方式位掩码转英文枚举，多种同时存在时按 交流 > USB > 无线 > 底座 取一个。
     *
     * @param plugged `BatteryManager.EXTRA_PLUGGED` 的值
     * @return ac / usb / wireless / dock / none
     */
    fun plugType(plugged: Int?): String {
        val p = plugged ?: 0
        return when {
            p and BatteryManager.BATTERY_PLUGGED_AC != 0 -> "ac"
            p and BatteryManager.BATTERY_PLUGGED_USB != 0 -> "usb"
            p and BatteryManager.BATTERY_PLUGGED_WIRELESS != 0 -> "wireless"
            p and PLUGGED_DOCK != 0 -> "dock"
            else -> PLUG_NONE
        }
    }

    /**
     * 当前网络的传输类型转英文枚举。
     *
     * @param transports 当前网络具备的 `NetworkCapabilities.TRANSPORT_*`；空集表示无网络
     * @return wifi / cellular / ethernet / bluetooth / vpn / other / none
     */
    fun networkType(transports: Set<Int>): String {
        if (transports.isEmpty()) return NET_NONE
        return TRANSPORTS.firstOrNull { it.first in transports }?.second ?: "other"
    }

    /**
     * 枚举转中文文案。
     *
     * @param code 本对象产出的英文枚举
     * @return 中文文案；不认识的枚举返回「未知」
     */
    fun textOf(code: String): String = TEXTS[code] ?: TEXTS.getValue(UNKNOWN)

    /**
     * 电量百分比。
     *
     * @param level 当前电量
     * @param scale 满电刻度
     * @return 0~100 的整数；任一值缺失或不合法返回 null
     */
    fun batteryPercent(level: Int?, scale: Int?): Int? {
        if (level == null || scale == null || level < 0 || scale <= 0) return null
        return (level * 100L / scale).toInt().coerceIn(0, 100)
    }

    /**
     * 电池温度换算：系统给的是十分之一摄氏度。
     *
     * @param tenths `BatteryManager.EXTRA_TEMPERATURE` 的值
     * @return 摄氏度（保留一位小数）；缺失返回 null
     */
    fun celsius(tenths: Int?): Double? = tenths?.let { it / 10.0 }

    /**
     * 电压有效性：系统取不到时给 0 或负数。
     *
     * @param millivolts `BatteryManager.EXTRA_VOLTAGE` 的值
     * @return 毫伏；不合法返回 null
     */
    fun voltage(millivolts: Int?): Int? = millivolts?.takeIf { it > 0 }
}
