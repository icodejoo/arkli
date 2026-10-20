package com.let188.arkli.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

/**
 * Compose 里判断当前是否暗色，替代 `isSystemInDarkTheme()`：显式亮/暗按用户偏好，跟随系统时随系统配置重组。
 *
 * @return true 为暗色
 */
@Composable
fun isAppDarkTheme(): Boolean {
    val systemDark = isSystemInDarkTheme()
    return ThemeMode.isDark(ThemePrefs.mode(LocalContext.current), systemDark)
}
