package com.let188.arkli.theme

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.FileEnv
import com.let188.arkli.files.requireMainFrame
import org.json.JSONObject

/**
 * 主题方法：`native.theme.set`，契约见 docs/design/bridge-protocol.md「native.theme.set」。
 *
 * 使用示例：`ThemeModule.install(bridge, env)`
 */
object ThemeModule {
    /** 方法名：设置主题模式 */
    const val METHOD_THEME_SET = "native.theme.set"

    /**
     * 注册主题方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取上下文与宿主
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        val context = env.appContext
        bridge.register(METHOD_THEME_SET, ThemeSetHandler({ ThemePrefs.save(context, it) }) { env.host.onThemeChanged() })
    }
}

/**
 * `native.theme.set`：`{ mode: 'light' | 'dark' | 'system' }` -> `{ mode }`，记住模式并让宿主重设系统栏。
 *
 * @param save 保存模式
 * @param onChanged 保存后通知宿主刷新系统栏
 */
internal class ThemeSetHandler(private val save: (String) -> Unit, private val onChanged: () -> Unit) : BridgeHandler {
    /** 校验并保存 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val mode = params.opt("mode") as? String
        if (mode == null || mode !in ThemeMode.ALL) throw BridgeException(BridgeErrors.BAD_PARAMS, "mode 必须是 light / dark / system")
        save(mode)
        onChanged()
        return JSONObject().put("mode", mode)
    }
}
