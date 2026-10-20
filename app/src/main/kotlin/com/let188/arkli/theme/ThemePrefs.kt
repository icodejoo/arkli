package com.let188.arkli.theme

import android.content.Context
import android.content.res.Configuration

/**
 * 主题模式：亮色、暗色、跟随系统。取值与前端 web/src/shared/theme.ts 的 THEME_MODES 一致。
 *
 * 使用示例：`ThemeMode.isDark(ThemeMode.SYSTEM, systemDark = true)`
 */
object ThemeMode {
    /** 亮色 */
    const val LIGHT = "light"

    /** 暗色 */
    const val DARK = "dark"

    /** 跟随系统（默认） */
    const val SYSTEM = "system"

    /** 全部合法取值 */
    val ALL = listOf(LIGHT, DARK, SYSTEM)

    /**
     * 把存储或页面传来的原始值规范成合法模式。
     *
     * @param raw 原始字符串，可为 null
     * @return 合法模式；不认识的值回落到 [SYSTEM]
     */
    fun parse(raw: String?): String = if (raw != null && raw in ALL) raw else SYSTEM

    /**
     * 解析实际是否暗色。
     *
     * @param mode 主题模式（非法值按跟随系统处理）
     * @param systemDark 系统当前是否深色
     * @return true 为暗色
     */
    fun isDark(mode: String?, systemDark: Boolean): Boolean = when (parse(mode)) {
        LIGHT -> false
        DARK -> true
        else -> systemDark
    }
}

/**
 * 主题偏好：用 SharedPreferences 记住页面选的模式，原生各页面据此判断深浅，不依赖系统 API 级别。
 *
 * 使用示例：`val dark = ThemePrefs.isDark(context)`
 */
object ThemePrefs {
    /** SharedPreferences 文件名 */
    private const val PREFS_NAME = "arkli_theme"

    /** 模式的键 */
    private const val KEY_MODE = "mode"

    /**
     * 读当前保存的模式。
     *
     * @param context 上下文
     * @return 合法模式，没存过为 [ThemeMode.SYSTEM]
     */
    fun mode(context: Context): String =
        ThemeMode.parse(context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(KEY_MODE, null))

    /**
     * 保存模式（异步落盘）。
     *
     * @param context 上下文
     * @param mode 要保存的模式，非法值按跟随系统存
     */
    fun save(context: Context, mode: String) {
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(KEY_MODE, ThemeMode.parse(mode)).apply()
    }

    /**
     * 系统当前是否深色。
     *
     * @param context 上下文（用其配置里的 uiMode）
     */
    fun systemDark(context: Context): Boolean =
        (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    /**
     * 当前实际是否暗色：显式亮/暗按偏好，跟随系统按系统。
     *
     * @param context 上下文
     * @return true 为暗色
     */
    fun isDark(context: Context): Boolean = ThemeMode.isDark(mode(context), systemDark(context))
}
