package com.let188.arkli.qrcode

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.FileEnv

/**
 * 把二维码识别方法注册进一个会话的 Bridge：取景扫码与相册图识别，都用 zxing-cpp。
 * 契约见 docs/design/tools/image.md「二维码工具」。
 *
 * 使用示例：`QrModule.install(bridge, env)`
 */
object QrModule {
    /** 方法名：取景扫码 */
    const val METHOD_SCAN = "native.qrcode.scan"

    /** 方法名：识别图片 */
    const val METHOD_DECODE_IMAGE = "native.qrcode.decodeImage"

    /**
     * 注册二维码方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取宿主与目录根
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        bridge.register(METHOD_SCAN, QrScanHandler(env.host))
        bridge.register(METHOD_DECODE_IMAGE, QrDecodeImageHandler(env.roots))
    }
}
