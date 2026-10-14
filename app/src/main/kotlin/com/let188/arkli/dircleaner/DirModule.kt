package com.let188.arkli.dircleaner

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.FileEnv

/**
 * 把文件夹清理方法注册进一个会话的 Bridge。只走 SAF 授权，不申请任何存储权限。
 * 契约见 docs/design/bridge-protocol.md「文件夹清理方法」。
 *
 * 使用示例：`DirModule.install(bridge, env)`
 */
object DirModule {
    /** 方法名：选择文件夹 */
    const val METHOD_PICK = "native.dir.pick"

    /** 方法名：已授权文件夹 */
    const val METHOD_LIST = "native.dir.list"

    /** 方法名：忘记文件夹 */
    const val METHOD_FORGET = "native.dir.forget"

    /** 方法名：扫描 */
    const val METHOD_SCAN = "native.dir.scan"

    /** 方法名：删除 */
    const val METHOD_DELETE = "native.dir.delete"

    /**
     * 注册文件夹清理方法；扫描登记随会话关闭清空。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取应用上下文与宿主
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        val store = DirStore(env.appContext)
        val registry = ScanRegistry()
        val ctx = env.appContext
        bridge.register(METHOD_PICK, DirPickHandler(ctx, env.host, store))
        bridge.register(METHOD_LIST, DirListHandler(ctx, store))
        bridge.register(METHOD_FORGET, DirForgetHandler(ctx, store, registry))
        bridge.register(METHOD_SCAN, DirScanHandler(ctx, store, registry))
        bridge.register(METHOD_DELETE, DirDeleteHandler(ctx, store, registry))
        bridge.onClose { registry.clear() }
    }
}
