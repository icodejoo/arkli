package com.let188.arkli.model

import android.content.Context
import android.net.ConnectivityManager
import android.util.Log
import com.let188.arkli.ai.AiHeavyGate
import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.net.JdkHttpTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/** 日志 tag */
private const val MODEL_LOG_TAG = "ArkliModel"

/**
 * 仅供 debug 构建使用的钩子：覆盖下载源，便于用本机 Range 服务做端到端验证。
 * release 里没有任何代码会设置它（只有 `app/src/debug` 的调试广播会写），所以恒为 null。
 * 覆盖只换 URL，清单里的 sha256 与字节数照常校验。
 */
internal object ModelDebugHooks {
    /** 非 null 时替换所有文件的下载源，并放行 `http://127.0.0.1` */
    @Volatile
    var urlOverride: List<String>? = null
}

/**
 * 进程内唯一的模型管理器（下载任务要跨页面会话存活）。
 */
internal object ModelRuntime {
    /** 单例，首次使用时创建 */
    @Volatile
    private var manager: ModelManager? = null

    /**
     * 取管理器；清单解析失败时用空清单（所有 id 都被拒绝）并记日志，不让应用崩溃。
     *
     * @param context 应用上下文
     * @return 进程内唯一的管理器
     */
    fun get(context: Context): ModelManager = manager ?: synchronized(this) {
        manager ?: create(context.applicationContext).also { manager = it }
    }

    /** 创建管理器 */
    private fun create(ctx: Context): ModelManager {
        val manifest = try {
            ModelManifestParser.parse(ctx.assets.open(MODEL_MANIFEST_ASSET).use { it.readBytes().toString(Charsets.UTF_8) })
        } catch (e: Exception) {
            Log.e(MODEL_LOG_TAG, "模型清单不可用", e)
            ModelManifest.EMPTY
        }
        val downloader = ModelDownloader(
            JdkHttpTransport,
            freeSpace = { it.usableSpace },
            allowLoopbackHttp = { ModelDebugHooks.urlOverride != null },
        )
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        return ModelManager(
            manifest,
            ctx.filesDir,
            downloader,
            CoroutineScope(SupervisorJob() + Dispatchers.IO),
            metered = { runCatching { cm?.isActiveNetworkMetered == true }.getOrDefault(false) },
            urlOverride = { ModelDebugHooks.urlOverride },
        )
    }
}

/**
 * 模型下载管理的桥方法：`native.model.list/status/ensure/cancel/remove/verify/sources`，
 * 并在状态或下载进度变化时推送 `model.changed` 事件。
 * 下载地址只来自随包清单（页面只能传 id），全部只接受主 frame，契约见 docs/design/bridge-protocol.md「模型下载管理」。
 *
 * 使用示例：`ModelModule.install(bridge, context)`
 */
object ModelModule {
    /** 方法名：列出全部模型 */
    const val METHOD_LIST = "native.model.list"

    /** 方法名：单个模型状态 */
    const val METHOD_STATUS = "native.model.status"

    /** 方法名：确保就绪（启动下载） */
    const val METHOD_ENSURE = "native.model.ensure"

    /** 方法名：取消下载 */
    const val METHOD_CANCEL = "native.model.cancel"

    /** 方法名：删除 */
    const val METHOD_REMOVE = "native.model.remove"

    /** 方法名：重新校验 */
    const val METHOD_VERIFY = "native.model.verify"

    /** 方法名：下载来源（只读） */
    const val METHOD_SOURCES = "native.model.sources"

    /** 退役清理每个进程只排一次 */
    private val retiredScheduled = AtomicBoolean(false)

    /** 事件名：某模型状态或下载进度变化，data 同 `native.model.status` 的返回 */
    const val EVENT_CHANGED = "model.changed"

    /**
     * 注册模型方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param context 应用上下文
     * @return 进程内唯一的模型管理器，供其他模块登记释放钩子或查询状态
     */
    fun install(bridge: ArkliBridge, context: Context): ModelManager {
        val manager = ModelRuntime.get(context)
        bridge.register(METHOD_LIST, ModelListHandler(manager))
        bridge.register(METHOD_STATUS, ModelStatusHandler(manager))
        bridge.register(METHOD_ENSURE, ModelEnsureHandler(manager))
        bridge.register(METHOD_CANCEL, ModelCancelHandler(manager))
        bridge.register(METHOD_REMOVE, ModelRemoveHandler(manager))
        bridge.register(METHOD_VERIFY, ModelVerifyHandler(manager))
        bridge.register(METHOD_SOURCES, ModelSourcesHandler(manager))
        // 管理器是进程单例、桥是每会话一个：后装的桥接管推送，旧会话的事件本来就会被丢弃
        manager.setListener { bridge.emit(EVENT_CHANGED, ModelPolicy.snapshotJson(it)) }
        scheduleRetiredCleanup(manager.manifest, context.applicationContext.filesDir)
        return manager
    }

    /** 后台排在 [AiHeavyGate] 之后回收退役模型目录；每进程一次，失败只记日志，不阻塞启动 */
    private fun scheduleRetiredCleanup(manifest: ModelManifest, filesDir: java.io.File) {
        if (manifest.retired.isEmpty() || !retiredScheduled.compareAndSet(false, true)) return
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                val deleted = AiHeavyGate.run { ModelRetiredCleaner.run(manifest, FileRetiredFs(filesDir, manifest.models.map { it.dir }.toSet())) }
                if (deleted.isNotEmpty()) Log.i(MODEL_LOG_TAG, "已回收退役模型：$deleted")
            } catch (e: Exception) {
                Log.w(MODEL_LOG_TAG, "退役清理异常", e)
            }
        }
    }
}
