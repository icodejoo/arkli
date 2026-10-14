package com.let188.arkli.tts

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.FileConst
import com.let188.arkli.files.FileEnv
import java.io.File

/**
 * 把文字转语音方法注册进一个会话的 Bridge。引擎按会话创建，会话关闭时释放。
 * 契约见 docs/design/bridge-protocol.md「文字转语音方法」。
 *
 * 使用示例：`TtsModule.install(bridge, env)`
 */
object TtsModule {
    /** 方法名：朗读 */
    const val METHOD_SPEAK = "native.tts.speak"

    /** 方法名：停止朗读 */
    const val METHOD_STOP = "native.tts.stop"

    /** 方法名：引擎状态与可用语言 */
    const val METHOD_STATUS = "native.tts.status"

    /** 方法名：保存为音频 */
    const val METHOD_SAVE = "native.tts.save"

    /**
     * 注册文字转语音方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取应用上下文与缓存根
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        val engine = TtsEngine(env.appContext)
        bridge.register(METHOD_SPEAK, TtsSpeakHandler(engine))
        bridge.register(METHOD_STOP, TtsStopHandler(engine))
        bridge.register(METHOD_STATUS, TtsStatusHandler(engine))
        bridge.register(METHOD_SAVE, TtsSaveHandler(engine, File(env.roots.cacheRoot, FileConst.DIR_OUT), env.roots))
        bridge.onClose { engine.shutdown() }
    }
}
