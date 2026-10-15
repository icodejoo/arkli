package com.let188.arkli.camera

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.FileEnv

/**
 * 把通用原生相机方法注册进一个会话的 Bridge：拍照、录像、相册入口与临时产物清理。
 * 契约见 docs/design/bridge-protocol.md。
 *
 * 使用示例：`CameraModule.install(bridge, env)`
 */
object CameraModule {
    /** 方法名：拉起原生相机 */
    const val METHOD_CAPTURE = "native.camera.capture"

    /** 方法名：清理相机临时产物 */
    const val METHOD_CLEAR = "native.camera.clear"

    /**
     * 注册相机方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取宿主与目录根
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        bridge.register(METHOD_CAPTURE, CameraCaptureHandler(env.host, env.roots))
        bridge.register(METHOD_CLEAR, CameraClearHandler(env.roots))
    }
}
