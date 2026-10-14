package com.let188.arkli.wallpaper

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.FileEnv

/**
 * 把获取壁纸方法注册进一个会话的 Bridge。受 Android 版本限制，不申请新权限。
 * 契约见 docs/design/bridge-protocol.md「获取壁纸方法」。
 *
 * 使用示例：`WallpaperModule.install(bridge, env)`
 */
object WallpaperModule {
    /** 方法名：获取当前壁纸 */
    const val METHOD_GET = "native.wallpaper.get"

    /**
     * 注册获取壁纸方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取应用上下文与缓存根
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        bridge.register(METHOD_GET, WallpaperGetHandler(env.appContext, env.roots))
    }
}
