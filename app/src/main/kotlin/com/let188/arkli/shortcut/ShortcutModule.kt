package com.let188.arkli.shortcut

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.FileEnv

/**
 * 把网页转应用（桌面快捷方式）方法注册进一个会话的 Bridge。
 * 契约见 docs/design/bridge-protocol.md「网页转应用」。
 *
 * 使用示例：`ShortcutModule.install(bridge, env)`
 */
object ShortcutModule {
    /** 方法名：固定快捷方式到桌面 */
    const val METHOD_PIN = "native.shortcut.pin"

    /**
     * 注册快捷方式方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取应用上下文
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        bridge.register(METHOD_PIN, ShortcutPinHandler(env.appContext))
    }
}
