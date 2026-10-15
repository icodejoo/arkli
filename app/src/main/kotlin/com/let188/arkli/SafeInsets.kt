package com.let188.arkli

import java.util.Locale

/**
 * 页面安全区：被系统栏（状态栏、导航栏）和刘海挡住的四边尺寸，单位是 CSS px（等于 dp）。
 *
 * 窗口是边到边的，WebView 铺满整个屏幕，原生把这四个值推给页面，由页面（Vue）自己留白。
 * 页面用 `var(--safe-top)` 等读取，没有宿主时回退到 `env(safe-area-inset-*)`。
 *
 * 使用示例：`page.setSafeInsets(SafeInsets(top = 24f, bottom = 0f, left = 0f, right = 0f))`
 *
 * @property top 顶部（状态栏 / 刘海）
 * @property bottom 底部（导航栏 / 手势条）；输入法弹出时为 0，WebView 自己避开键盘
 * @property left 左侧
 * @property right 右侧
 * @property imeOpen 输入法是否弹出（动画一开始就为 true，完全收起才为 false）
 */
data class SafeInsets(val top: Float, val bottom: Float, val left: Float, val right: Float, val imeOpen: Boolean = false) {
    /**
     * 生成写进页面 `<html>` 内联样式的脚本：设置 `--safe-top` 等四个 CSS 变量。
     * 内联样式的优先级高于样式表里的默认值，所以页面不用做任何判断。
     *
     * 同时把输入法状态写成 `<html>` 的 `kb-open` 类，并派发 `arkli-keyboard` 事件（detail.open）。
     *
     * @return 可直接交给 `evaluateJavascript` 的脚本；负值按 0 处理
     */
    fun toScript(): String {
        val sb = StringBuilder("(function(){var s=document.documentElement.style;")
        for ((name, value) in listOf("top" to top, "bottom" to bottom, "left" to left, "right" to right)) {
            sb.append("s.setProperty('").append(VAR_PREFIX).append(name).append("','").append(px(value)).append("');")
        }
        sb.append("document.documentElement.classList.toggle('").append(KB_CLASS).append("',").append(imeOpen).append(");")
        sb.append("window.dispatchEvent(new CustomEvent('").append(KB_EVENT).append("',{detail:{open:").append(imeOpen).append("}}));")
        return sb.append("})()").toString()
    }

    /** 数值转 CSS px 字符串，保留两位小数，负数按 0，与系统区域设置无关 */
    private fun px(v: Float): String = String.format(Locale.ROOT, "%.2fpx", v.coerceAtLeast(0f))

    companion object {
        /** CSS 变量名前缀，与 web/src/styles/index.scss 里的 --safe-* 对应 */
        const val VAR_PREFIX = "--safe-"

        /** 输入法弹出时加在 `<html>` 上的类名，与 web 的 useKeyboardOpen 对应 */
        const val KB_CLASS = "kb-open"

        /** 输入法状态变化时派发的 window 事件名，与 web 的 useKeyboardOpen 对应 */
        const val KB_EVENT = "arkli-keyboard"

        /** 四边都为 0 */
        val ZERO = SafeInsets(0f, 0f, 0f, 0f)
    }
}
