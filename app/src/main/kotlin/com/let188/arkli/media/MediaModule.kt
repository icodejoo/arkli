package com.let188.arkli.media

import android.net.Uri
import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.FileEnv
import com.let188.arkli.files.HandleTable

/**
 * 把视频与音频方法注册进一个会话的 Bridge：info / extractAudio / frames / compress。
 * 只用平台自带的 MediaExtractor / MediaMuxer / MediaCodec / MediaMetadataRetriever，不引入第三方依赖；
 * 以后 Media3 Transformer 获批后可替换内部实现，协议不变。契约见 docs/design/bridge-protocol.md「视频与音频方法」。
 *
 * 使用示例：`MediaModule.install(bridge, env, FileModule.install(bridge, env))`
 */
object MediaModule {
    /**
     * 注册媒体方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取应用上下文与缓存根
     * @param handles 本会话的视频句柄表，必须与 `native.file.pick` 用同一张（取自 `FileModule.install` 的返回值）
     */
    fun install(bridge: ArkliBridge, env: FileEnv, handles: HandleTable<Uri>) {
        bridge.register(MediaConst.METHOD_INFO, MediaInfoHandler(env, handles))
        bridge.register(MediaConst.METHOD_EXTRACT_AUDIO, ExtractAudioHandler(env, handles))
        bridge.register(MediaConst.METHOD_FRAMES, FramesHandler(env, handles))
        bridge.register(MediaConst.METHOD_COMPRESS, CompressHandler(env, handles))
    }
}
