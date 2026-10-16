package com.let188.arkli.speech

import com.let188.arkli.ai.AiRecycle
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

    /** 登记进 AI 回收时的名字（回收日志里显示） */
    const val RECYCLE_ID = "speech"

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
        // 返回键退出、系统内存告急时与其他 AI 会话一起卸载（空闲 60 秒的自动释放仍然保留）
        AiRecycle.attachExtra(RECYCLE_ID) { service.unload() }
        bridge.onClose { session.cancelNow() }
    }
}
