package com.let188.arkli.system

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.FileEnv

/**
 * 把系统能力方法注册进一个会话的 Bridge：剪贴板、分享、系统设置、外部跳转、震动、屏幕、设备信息、权限。
 * 全部只接受主 frame，契约见 docs/design/bridge-protocol.md「系统能力方法」。
 *
 * 使用示例：`SystemModule.install(bridge, env)`
 */
object SystemModule {
    /** 方法名：写剪贴板 */
    const val METHOD_CLIPBOARD_WRITE = "native.clipboard.write"

    /** 方法名：读剪贴板 */
    const val METHOD_CLIPBOARD_READ = "native.clipboard.read"

    /** 方法名：系统分享 */
    const val METHOD_SHARE = "native.share"

    /** 方法名：打开系统设置页 */
    const val METHOD_SETTINGS_OPEN = "native.settings.open"

    /** 方法名：打开外部链接 / 拨号 / 短信等 */
    const val METHOD_INTENT_OPEN = "native.intent.open"

    /** 方法名：交给其他应用处理文本（翻译等） */
    const val METHOD_INTENT_PROCESS_TEXT = "native.intent.processText"

    /** 方法名：震动 */
    const val METHOD_HAPTIC_VIBRATE = "native.haptic.vibrate"

    /** 方法名：屏幕常亮 */
    const val METHOD_SCREEN_KEEP_AWAKE = "native.screen.keepAwake"

    /** 方法名：窗口亮度 */
    const val METHOD_SCREEN_BRIGHTNESS = "native.screen.brightness"

    /** 方法名：沉浸模式 */
    const val METHOD_SCREEN_IMMERSIVE = "native.screen.immersive"

    /** 方法名：设备静态信息 */
    const val METHOD_DEVICE_INFO = "native.device.info"

    /** 方法名：设备动态状态 */
    const val METHOD_DEVICE_STATUS = "native.device.status"

    /** 方法名：屏幕参数 */
    const val METHOD_DEVICE_DISPLAY = "native.device.display"

    /** 方法名：查权限 */
    const val METHOD_PERMISSION_CHECK = "native.permission.check"

    /** 方法名：申请权限 */
    const val METHOD_PERMISSION_REQUEST = "native.permission.request"

    /**
     * 注册系统能力方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取上下文、宿主与缓存路径解析
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        val context = env.appContext
        val host = env.host
        val collector = DeviceCollector(context)
        val checker = PermissionChecker(context)
        bridge.register(METHOD_CLIPBOARD_WRITE, ClipboardWriteHandler(context))
        bridge.register(METHOD_CLIPBOARD_READ, ClipboardReadHandler(context))
        bridge.register(METHOD_SHARE, ShareHandler(context, host) { env.roots.resolveCache(it) })
        bridge.register(METHOD_SETTINGS_OPEN, SettingsOpenHandler(context, host))
        bridge.register(METHOD_INTENT_OPEN, IntentOpenHandler(host))
        bridge.register(METHOD_INTENT_PROCESS_TEXT, ProcessTextHandler(host))
        bridge.register(METHOD_HAPTIC_VIBRATE, HapticHandler(context))
        bridge.register(METHOD_SCREEN_KEEP_AWAKE, KeepAwakeHandler(host))
        bridge.register(METHOD_SCREEN_BRIGHTNESS, BrightnessHandler(host))
        bridge.register(METHOD_SCREEN_IMMERSIVE, ImmersiveHandler(host))
        bridge.register(METHOD_DEVICE_INFO, DeviceHandler(collector) { it.info() })
        bridge.register(METHOD_DEVICE_STATUS, DeviceHandler(collector) { it.status() })
        bridge.register(METHOD_DEVICE_DISPLAY, DeviceHandler(collector) { it.display() })
        bridge.register(METHOD_PERMISSION_CHECK, PermissionCheckHandler(checker))
        bridge.register(METHOD_PERMISSION_REQUEST, PermissionRequestHandler(checker, host))
    }
}
