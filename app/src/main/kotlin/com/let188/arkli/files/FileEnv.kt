package com.let188.arkli.files

import android.content.Context
import android.content.Intent
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
     * 打开系统文件夹选择器（SAF 目录树授权）。用户直接关掉返回 null。
     *
     * @return 选中的目录树 URI；取消返回 null
     */
    suspend fun pickDirectory(): Uri?

    /**
     * 申请一个运行时权限。
     *
     * @param permission 权限名
     * @return 用户是否授予
     */
    suspend fun requestPermission(permission: String): Boolean

    /**
     * 打开原生全屏图片预览（立即返回，不等用户关闭）。
     *
     * @param files 要预览的图片文件
     * @param index 起始下标
     */
    fun previewImages(files: List<File>, index: Int)

    /**
     * 拉起一个外部 Intent（系统设置、分享面板、外部应用）。
     *
     * @param intent 要启动的 Intent
     * @return 成功拉起返回 true；没有能处理的应用或被系统拒绝返回 false
     */
    fun startIntent(intent: Intent): Boolean

    /**
     * 调整本应用窗口的屏幕行为，为 null 的项保持不变。
     *
     * @param keepAwake 是否保持屏幕常亮
     * @param brightness 窗口亮度 0~1，-1 表示跟随系统
     * @param immersive 是否隐藏系统栏进入沉浸模式
     */
    fun setScreen(keepAwake: Boolean?, brightness: Float?, immersive: Boolean?)

    /**
     * 请求系统授权修改一张 MediaStore 图片（API 30+ 的 `createWriteRequest` 确认框）。
     * 默认实现返回 false（不支持），由 Activity 覆盖。
     *
     * @param uri MediaStore 图片 URI（`content://media/external/images/media/<id>`）
     * @return 用户是否允许
     */
    suspend fun requestWriteAccess(uri: Uri): Boolean = false
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
                // 进程重启后没有页面会话，out/ 里的拼图成品都是孤儿
                val stitched = if (startup) OutFiles.purgeStitch(outDir) else 0
                Log.i(FILE_LOG_TAG, "缓存清理 startup=$startup 删文件=$n 清空闲句柄=$idle 清拼图遗留=$stitched")
            }.onFailure { Log.w(FILE_LOG_TAG, "缓存清理失败", it) }
        }
    }

    /** 缓存根下的 out 目录（页面产物） */
    val outDir: File get() = File(roots.cacheRoot, FileConst.DIR_OUT)

    /**
     * 统计缓存占用，见 [CacheJanitor.stats]。会遍历文件，请在 IO 线程调用。
     *
     * @return 总量与按一级目录分组的量
     */
    fun cacheStats(): CacheStats = janitor.stats()

    /**
     * 手动清空缓存，见 [CacheJanitor.clear]。会遍历并删除文件，请在 IO 线程调用。
     *
     * @return 释放字节、删除数、跳过数
     */
    fun clearCache(): ClearResult = janitor.clear()

    /** 异步清掉 out/ 里的拼图遗留，Activity 销毁时尽力调用 */
    fun purgeStitchOutputs() {
        io.execute { runCatching { OutFiles.purgeStitch(outDir) } }
    }

    /**
     * 页面路径转 PathHandler 可读 URL。
     *
     * @param pagePath 形如 `cache/out/h/a.png`
     * @return 完整 https URL
     */
    fun urlOf(pagePath: String): String = "https://$ASSET_HOST${FileConst.URL_PREFIX}$pagePath"
}
