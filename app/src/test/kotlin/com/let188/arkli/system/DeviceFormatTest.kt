package com.let188.arkli.system

import android.net.NetworkCapabilities
import android.os.BatteryManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 设备信息的格式化与状态码映射 */
class DeviceFormatTest {
    @Test
    fun chargeStatusMapping() {
        assertEquals("charging", DeviceFormat.chargeStatus(BatteryManager.BATTERY_STATUS_CHARGING))
        assertEquals("discharging", DeviceFormat.chargeStatus(BatteryManager.BATTERY_STATUS_DISCHARGING))
        assertEquals("not_charging", DeviceFormat.chargeStatus(BatteryManager.BATTERY_STATUS_NOT_CHARGING))
        assertEquals("full", DeviceFormat.chargeStatus(BatteryManager.BATTERY_STATUS_FULL))
        assertEquals("unknown", DeviceFormat.chargeStatus(BatteryManager.BATTERY_STATUS_UNKNOWN))
        assertEquals("unknown", DeviceFormat.chargeStatus(null))
        assertEquals("unknown", DeviceFormat.chargeStatus(99))
    }

    @Test
    fun plugTypeMaskPriority() {
        assertEquals("none", DeviceFormat.plugType(0))
        assertEquals("none", DeviceFormat.plugType(null))
        assertEquals("ac", DeviceFormat.plugType(BatteryManager.BATTERY_PLUGGED_AC))
        assertEquals("usb", DeviceFormat.plugType(BatteryManager.BATTERY_PLUGGED_USB))
        assertEquals("wireless", DeviceFormat.plugType(BatteryManager.BATTERY_PLUGGED_WIRELESS))
        assertEquals("dock", DeviceFormat.plugType(8))
        assertEquals("ac", DeviceFormat.plugType(BatteryManager.BATTERY_PLUGGED_AC or BatteryManager.BATTERY_PLUGGED_USB))
    }

    @Test
    fun networkTypeMapping() {
        assertEquals("none", DeviceFormat.networkType(emptySet()))
        assertEquals("wifi", DeviceFormat.networkType(setOf(NetworkCapabilities.TRANSPORT_WIFI)))
        assertEquals("cellular", DeviceFormat.networkType(setOf(NetworkCapabilities.TRANSPORT_CELLULAR)))
        assertEquals("ethernet", DeviceFormat.networkType(setOf(NetworkCapabilities.TRANSPORT_ETHERNET)))
        assertEquals("bluetooth", DeviceFormat.networkType(setOf(NetworkCapabilities.TRANSPORT_BLUETOOTH)))
        // VPN 叠在真实链路上时报真实链路
        assertEquals("wifi", DeviceFormat.networkType(setOf(NetworkCapabilities.TRANSPORT_VPN, NetworkCapabilities.TRANSPORT_WIFI)))
        assertEquals("vpn", DeviceFormat.networkType(setOf(NetworkCapabilities.TRANSPORT_VPN)))
        assertEquals("other", DeviceFormat.networkType(setOf(-1)))
    }

    @Test
    fun textMapping() {
        assertEquals("充电中", DeviceFormat.textOf("charging"))
        assertEquals("Wi-Fi", DeviceFormat.textOf("wifi"))
        assertEquals("未连接电源", DeviceFormat.textOf("none"))
        assertEquals("未知", DeviceFormat.textOf("whatever"))
    }

    @Test
    fun batteryNumbers() {
        assertEquals(50, DeviceFormat.batteryPercent(50, 100))
        assertEquals(33, DeviceFormat.batteryPercent(1, 3))
        assertEquals(100, DeviceFormat.batteryPercent(120, 100))
        assertNull(DeviceFormat.batteryPercent(null, 100))
        assertNull(DeviceFormat.batteryPercent(50, 0))
        assertNull(DeviceFormat.batteryPercent(-1, 100))
        assertEquals(31.5, DeviceFormat.celsius(315)!!, 0.0)
        assertNull(DeviceFormat.celsius(null))
        assertEquals(4200, DeviceFormat.voltage(4200))
        assertNull(DeviceFormat.voltage(0))
        assertNull(DeviceFormat.voltage(null))
    }
}
