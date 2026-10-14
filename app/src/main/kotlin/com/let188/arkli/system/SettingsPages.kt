package com.let188.arkli.system

import android.provider.Settings

/**
 * `native.settings.open` 的页面白名单：页面名 -> 系统设置 Action。纯数据，可单测。
 *
 * 使用示例：`SettingsPages.actionOf("wifi", sdk = 34)`
 */
internal object SettingsPages {
    /** 本应用详情页，需要附带 `package:` URI */
    const val PAGE_APP = "app"

    /** 通知设置页，API 26+ 才有专属 Action */
    const val PAGE_NOTIFICATION = "notification"

    /** 通知设置页专属 Action 的最低 API */
    private const val NOTIFICATION_MIN_SDK = 26

    /** 白名单：页面名 -> Action 字符串 */
    val ACTIONS: Map<String, String> = mapOf(
        "wifi" to Settings.ACTION_WIFI_SETTINGS,
        "display" to Settings.ACTION_DISPLAY_SETTINGS,
        "battery" to Settings.ACTION_BATTERY_SAVER_SETTINGS,
        "developer" to Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS,
        PAGE_APP to Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        PAGE_NOTIFICATION to "android.settings.APP_NOTIFICATION_SETTINGS",
        "date" to Settings.ACTION_DATE_SETTINGS,
        "locale" to Settings.ACTION_LOCALE_SETTINGS,
        "accessibility" to Settings.ACTION_ACCESSIBILITY_SETTINGS,
        "bluetooth" to Settings.ACTION_BLUETOOTH_SETTINGS,
        "storage" to Settings.ACTION_INTERNAL_STORAGE_SETTINGS,
    )

    /**
     * 查页面对应的 Action。
     *
     * @param page 页面名
     * @param sdk 当前 API 级别；通知页在 26 以下退回应用详情页
     * @return Action 字符串；不在白名单返回 null
     */
    fun actionOf(page: String, sdk: Int): String? {
        if (page == PAGE_NOTIFICATION && sdk < NOTIFICATION_MIN_SDK) return ACTIONS[PAGE_APP]
        return ACTIONS[page]
    }

    /**
     * 这个 Action 是否需要附带本应用包名（`package:` URI）。
     *
     * @param action 已解析的 Action
     * @return 应用详情页为 true
     */
    fun needsPackageUri(action: String): Boolean = action == ACTIONS[PAGE_APP]
}
