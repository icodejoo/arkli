package com.let188.arkli.files

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import java.io.File

/**
 * 一个子目录的占用。
 *
 * @property bytes 总字节数
 * @property files 文件数
 */
data class DirStat(val bytes: Long, val files: Int)

/**
 * 缓存占用统计。
 *
 * @property bytes 缓存根下全部文件的总字节数
 * @property files 文件总数
 * @property byDir 按缓存根下第一级目录分组（如 pick / out / tmp），根目录直属文件归入 [CacheMaintenance.ROOT_KEY]
 */
data class CacheStats(val bytes: Long, val files: Int, val byDir: Map<String, DirStat>)

/**
 * 一次手动清空的结果。
 *
 * @property freedBytes 释放的字节数
 * @property deleted 删除的文件数
 * @property skipped 因活跃或刚写入而保留的文件数
 */
data class ClearResult(val freedBytes: Long, val deleted: Int, val skipped: Int)

/**
 * 一次手动清空的决策。
 *
 * @property victims 将删除的文件
 * @property skipped 因活跃或刚写入而保留的文件数
 */
class ClearPlan(val victims: List<CacheEntry>, val skipped: Int)

/**
 * 缓存统计、手动清空与 out/ 清理的策略，只做决策不碰文件系统（除 [OutFiles] 外），便于单测。
 *
 * 使用示例：`CacheMaintenance.stats(janitor.scan())`
 */
object CacheMaintenance {
    /** 根目录直属文件在 byDir 里的键 */
    const val ROOT_KEY = "_root"

    /**
     * 统计占用。
     *
     * @param entries 缓存里的所有文件
     * @return 总量与按目录分组的量
     */
    fun stats(entries: List<CacheEntry>): CacheStats {
        val dirs = LinkedHashMap<String, DirStat>()
        var bytes = 0L
        for (e in entries) {
            bytes += e.size
            val key = if (e.path.contains('/')) e.path.substringBefore('/') else ROOT_KEY
            val old = dirs[key]
            dirs[key] = DirStat((old?.bytes ?: 0L) + e.size, (old?.files ?: 0) + 1)
        }
        return CacheStats(bytes, entries.size, dirs)
    }

    /**
     * 决定手动清空时删哪些：全部删除，除了
     * 1. 活跃写句柄的临时文件；
     * 2. [busyMs] 内修改过的文件（可能正被写入、或页面刚拿到产物还在用）。
     *
     * @param entries 缓存里的所有文件
     * @param now 当前时间（毫秒）
     * @param activeParts 活跃写句柄的临时文件路径
     * @param busyMs 保护期，默认 [FileConst.CLEAR_BUSY_MS]
     * @return 清空计划
     */
    fun planClear(
        entries: List<CacheEntry>,
        now: Long,
        activeParts: Set<String>,
        busyMs: Long = FileConst.CLEAR_BUSY_MS,
    ): ClearPlan {
        val victims = ArrayList<CacheEntry>()
        var skipped = 0
        for (e in entries) {
            val busy = (e.isPart && e.path in activeParts) || now - e.lastModified < busyMs
            if (busy) skipped++ else victims += e
        }
        return ClearPlan(victims, skipped)
    }
}

/**
 * `out/` 目录里的文件操作：页面主动丢弃、启动清理拼图遗留。
 * 路径判断走 [FileRoots] 的防穿越解析，只允许落在 out/ 内。
 *
 * 使用示例：`OutFiles.discard(outDir, roots::resolveCache, listOf("cache/out/stitch_1.png"))`
 */
object OutFiles {
    /** 一次最多丢弃的路径数 */
    const val MAX_DISCARD = 200

    /**
     * 丢弃 out/ 内的文件。任一路径非法（穿越、不在 out/、是目录）整体拒绝，一个都不删；不存在的忽略。
     * 拼图成品（`stitch_<id>.ext`）会连带删同 id 的缩略图（`stitch_thumb_<id>.jpg`）。
     *
     * @param outDir 缓存根下的 out 目录
     * @param resolve 页面路径解析器（须防穿越，非法返回 null）
     * @param paths 页面路径列表，1..[MAX_DISCARD] 项
     * @return 实际删除的文件数
     * @throws BridgeException 参数不合法（BAD_PARAMS）
     */
    fun discard(outDir: File, resolve: (String) -> File?, paths: List<String>): Int {
        if (paths.isEmpty() || paths.size > MAX_DISCARD) throw BridgeException(BridgeErrors.BAD_PARAMS, "paths 需要 1~$MAX_DISCARD 项")
        val outCanon = outDir.canonicalFile
        val prefix = outCanon.path + File.separator
        val targets = LinkedHashSet<File>()
        for ((i, p) in paths.withIndex()) {
            val f = resolve(p)?.takeIf { it.canonicalPath.startsWith(prefix) }
                ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "paths[$i] 不在 cache/out/ 内")
            if (f.isDirectory) throw BridgeException(BridgeErrors.BAD_PARAMS, "paths[$i] 是目录")
            targets += f
            thumbOf(f)?.let { targets += it }
        }
        return targets.count { it.isFile && it.delete() }
    }

    /**
     * 删除 out/ 顶层里所有拼图遗留（`stitch_` 前缀，含缩略图与 .part）。
     * 只动这个前缀，别的工具的产物（压缩、视频、TTS、壁纸）一概不碰。
     *
     * @param outDir 缓存根下的 out 目录
     * @return 删除的文件数
     */
    fun purgeStitch(outDir: File): Int =
        outDir.listFiles { f -> f.isFile && f.name.startsWith(FileConst.OUT_STITCH_PREFIX) }?.count { it.delete() } ?: 0

    /** 拼图成品对应的缩略图文件；不是拼图成品返回 null */
    private fun thumbOf(f: File): File? {
        val n = f.name
        if (!n.startsWith(FileConst.OUT_STITCH_PREFIX) || n.startsWith(FileConst.OUT_STITCH_THUMB_PREFIX)) return null
        val id = n.removePrefix(FileConst.OUT_STITCH_PREFIX).substringBeforeLast('.')
        return File(f.parentFile, "${FileConst.OUT_STITCH_THUMB_PREFIX}$id.jpg")
    }
}
