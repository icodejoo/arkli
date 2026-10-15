package com.let188.arkli.speech

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.FileEnv

/**
 * 把本地流式语音转文字方法注册进一个会话的 Bridge。会话关闭时自动停止采集并释放麦克风与识别流。
 * 契约见 docs/design/bridge-protocol.md「语音转文字方法」。
 *
 * 使用示例：`SpeechModule.install(bridge, env)`
 */
object SpeechModule {
    /** 方法名：状态 */
    const val METHOD_STATUS = "native.speech.status"

    /** 方法名：开始听写 */
    const val METHOD_START = "native.speech.start"

    /** 方法名：停止听写 */
    const val METHOD_STOP = "native.speech.stop"

    /**
     * 注册语音转文字方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取应用上下文与宿主
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        val service = SpeechRuntime.get(env.appContext)
        val session = SpeechSession()
        bridge.register(METHOD_STATUS, SpeechStatusHandler(service))
        bridge.register(METHOD_START, SpeechStartHandler(env.appContext, env.host, service, session))
        bridge.register(METHOD_STOP, SpeechStopHandler(session))
        bridge.onClose { session.cancelNow() }
    }
}
