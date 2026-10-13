package com.let188.arkli.files

import android.content.Context
import android.net.Uri
import android.util.Log
import com.let188.arkli.ASSET_HOST
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/** 日志 tag */
internal const val FILE_LOG_TAG = "ArkliFiles"

/**
 * 需要借助 Activity 才能完成的交互：系统选择器与运行时权限申请。
 * 由 MainActivity 实现，文件处理器只依赖这个接口，不直接碰 Activity。
 */
interface ActivityHost {
    /**
     * 打开系统选择器让用户选文件。用户直接关掉选择器返回空列表。
     *
     * @param mime mime 过滤，见 [PickKind.of]
     * @param multiple 是否多选
     * @param max 多选时的数量上限（系统选择器不一定遵守，调用方会再截断）
     * @return 选中的 URI 列表，可能为空
     */
    suspend fun pickMedia(mime: String, multiple: Boolean, max: Int): List<Uri>

    /**
     * 申请一个运行时权限。
     *
     * @param permission 权限名
     * @return 用户是否授予
     */
    suspend fun requestPermission(permission: String): Boolean
}

/**
 * 文件能力的运行环境：目录根、PathHandler、写句柄登记、缓存清理，进程内一份。
 *
 * 使用示例：`val env = FileEnv(context, host); env.cleanup(startup = true)`
 *
 * @param context 上下文，取缓存目录与内容解析器
 * @param host 选择器与权限申请的宿主
 */
class FileEnv(context: Context, val host: ActivityHost) {
    /** 应用上下文 */
    val appContext: Context = context.applicationContext

    /** 页面可见的目录根 */
    val roots = FileRoots(
        File(appContext.cacheDir, FileConst.CACHE_ROOT_DIR).apply { mkdirs() },
        File(appContext.filesDir, FileConst.PACKS_ROOT_DIR),
    )

    /** `/files/` 路径的响应器，支持 Range */
    val server = FilesPathServer(roots)

    /** 各会话的写句柄登记，清理器据此跳过活跃的临时文件 */
    internal val registries: MutableSet<WriteRegistry> = ConcurrentHashMap.newKeySet()

    /** 缓存清理器 */
    private val janitor = CacheJanitor(roots.cacheRoot, { registries.flatMapTo(HashSet()) { it.activeParts() } })

    /** 上次空闲清理的时间 */
    private val lastCleanup = AtomicLong(0)

    /** 单线程执行清理，不占主线程 */
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "arkli-cleanup").apply { isDaemon = true } }

    /**
     * 异步清理缓存：删过期文件、孤儿临时文件，超总量上限时删最旧的，并清掉空闲超时的写句柄。
     * 空闲清理有最小间隔，频繁调用会被合并。
     *
     * @param startup 是否启动时清理；是则不受间隔限制，且所有非活跃临时文件立即算孤儿
     */
    fun cleanup(startup: Boolean) {
        val now = System.currentTimeMillis()
        if (!startup) {
            val last = lastCleanup.get()
            if (now - last < FileConst.CLEANUP_MIN_INTERVAL_MS || !lastCleanup.compareAndSet(last, now)) return
        } else {
            lastCleanup.set(now)
        }
        io.execute {
            runCatching {
                val idle = registries.sumOf { it.sweepIdle() }
                val n = janitor.run(startup)
                Log.i(FILE_LOG_TAG, "缓存清理 startup=$startup 删文件=$n 清空闲句柄=$idle")
            }.onFailure { Log.w(FILE_LOG_TAG, "缓存清理失败", it) }
        }
    }

    /**
     * 页面路径转 PathHandler 可读 URL。
     *
     * @param pagePath 形如 `cache/out/h/a.png`
     * @return 完整 https URL
     */
    fun urlOf(pagePath: String): String = "https://$ASSET_HOST${FileConst.URL_PREFIX}$pagePath"
}
