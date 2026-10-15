package com.let188.arkli.system

/**
 * `native.screen.*` 的参数换算，纯函数，可单测。
 *
 * 使用示例：`ScreenParams.brightness(0.5)` -> `0.5f`
 */
internal object ScreenParams {
    /** 跟随系统亮度的取值（与 WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE 相同） */
    const val FOLLOW_SYSTEM = -1.0f

    /** 最低亮度：0 在部分机型上会直接熄屏，夹到 1% */
    const val MIN_BRIGHTNESS = 0.01f

    /** 方向模式：传感器横屏（两个横向都跟随重力） */
    const val ORIENTATION_LANDSCAPE = "landscape"

    /** 方向模式：还原竖屏 */
    const val ORIENTATION_PORTRAIT = "portrait"

    /**
     * 校验方向模式。
     *
     * @param mode `landscape` 或 `portrait`
     * @return 是否横屏
     * @throws IllegalArgumentException 不是这两个值
     */
    fun landscape(mode: String): Boolean {
        require(mode == ORIENTATION_LANDSCAPE || mode == ORIENTATION_PORTRAIT) { "mode 只能是 landscape 或 portrait" }
        return mode == ORIENTATION_LANDSCAPE
    }

    /**
     * 校验并换算亮度。
     *
     * @param value 0~1，或 -1 表示跟随系统
     * @return 窗口亮度值；0 会被夹到 [MIN_BRIGHTNESS]
     * @throws IllegalArgumentException 超出范围或不是有限数
     */
    fun brightness(value: Double): Float {
        require(value.isFinite()) { "value 必须是有限数字" }
        if (value == -1.0) return FOLLOW_SYSTEM
        require(value in 0.0..1.0) { "value 需要在 0~1，或为 -1" }
        return value.toFloat().coerceAtLeast(MIN_BRIGHTNESS)
    }
}
