package com.let188.arkli.apps

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.FileConst
import com.let188.arkli.files.FileEnv
import java.io.File

/**
 * 把应用管理方法注册进一个会话的 Bridge。只能列出可启动应用（见清单 `<queries>`），不申请 QUERY_ALL_PACKAGES。
 * 契约见 docs/design/bridge-protocol.md「应用管理方法」。
 *
 * 使用示例：`AppsModule.install(bridge, env)`
 */
object AppsModule {
    /** 方法名：列出应用 */
    const val METHOD_LIST = "native.apps.list"

    /** 方法名：打开应用 */
    const val METHOD_OPEN = "native.apps.open"

    /** 方法名：应用详情页（卸载入口） */
    const val METHOD_SETTINGS = "native.apps.settings"

    /** 方法名：导出安装包 */
    const val METHOD_EXPORT_APK = "native.apps.exportApk"

    /** 方法名：应用图标 */
    const val METHOD_ICON = "native.apps.icon"

    /** 图标缓存子目录名（缓存 `out/` 下） */
    private const val ICON_DIR = "app-icons"

    /**
     * 注册应用管理方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取应用上下文、宿主与缓存根
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        val repo = AppRepository(env.appContext)
        val outDir = File(env.roots.cacheRoot, FileConst.DIR_OUT)
        bridge.register(METHOD_LIST, AppsListHandler(repo))
        bridge.register(METHOD_OPEN, AppsOpenHandler(repo, env.host))
        bridge.register(METHOD_SETTINGS, AppsSettingsHandler(env.host))
        bridge.register(METHOD_EXPORT_APK, AppsExportHandler(repo, outDir, env.roots))
        bridge.register(METHOD_ICON, AppsIconHandler(repo, File(outDir, ICON_DIR), env.roots))
    }
}
