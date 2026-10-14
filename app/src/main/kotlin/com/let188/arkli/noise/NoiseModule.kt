package com.let188.arkli.noise

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.FileEnv

/**
 * 把噪音测量方法注册进一个会话的 Bridge。会话关闭时自动停止录音并释放麦克风。
 * 契约见 docs/design/bridge-protocol.md「噪音测量方法」。
 *
 * 使用示例：`NoiseModule.install(bridge, env)`
 */
object NoiseModule {
    /** 方法名：开始测量 */
    const val METHOD_START = "native.noise.start"

    /** 方法名：停止测量 */
    const val METHOD_STOP = "native.noise.stop"

    /**
     * 注册噪音测量方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取应用上下文与宿主
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        val session = NoiseSession()
        bridge.register(METHOD_START, NoiseStartHandler(env.appContext, env.host, session))
        bridge.register(METHOD_STOP, NoiseStopHandler(session))
        bridge.onClose { session.cancelNow() }
    }
}
