package com.let188.arkli.files

import java.io.File

/**
 * 缓存里的一个文件。
 *
 * @property path 相对缓存根的路径，`/` 分隔，如 `out/w1/a.bin`
 * @property size 字节数
 * @property lastModified 最近修改时间（毫秒）
 * @property isPart 是否未关闭写句柄的临时文件（tmp 目录下的 part 文件）
 */
data class CacheEntry(val path: String, val size: Long, val lastModified: Long, val isPart: Boolean)

/** 缓存清理策略：只做决策，不碰文件系统，便于单测 */
object CachePolicy {
    /**
     * 算出该删哪些文件。规则依次为：
     * 1. 临时文件：属于活跃句柄的保留；否则存活超过 [partOrphanAgeMs] 就删（启动时传 0，全是孤儿）。
     * 2. 其余文件：超过 [maxAgeMs] 就删。
     * 3. 剩下的总量（含活跃临时文件）仍超过 [maxTotal]，从最旧的开始删，
     *    但 [keepRecentMs] 内写入的不动。
     *
     * @param entries 当前缓存里的所有文件
     * @param now 当前时间（毫秒）
     * @param activeParts 活跃写句柄的临时文件路径
     * @param maxAgeMs 保留期
     * @param maxTotal 总量上限
     * @param keepRecentMs 超限清理时的保护期
     * @param partOrphanAgeMs 孤儿临时文件的最短存活时间
     * @return 应删除的文件
     */
    fun plan(
        entries: List<CacheEntry>,
        now: Long,
        activeParts: Set<String>,
        maxAgeMs: Long = FileConst.CACHE_MAX_AGE_MS,
        maxTotal: Long = FileConst.CACHE_MAX_TOTAL_BYTES,
        keepRecentMs: Long = FileConst.CACHE_KEEP_RECENT_MS,
        partOrphanAgeMs: Long = FileConst.PART_ORPHAN_AGE_MS,
    ): List<CacheEntry> {
        val delete = ArrayList<CacheEntry>()
        val survivors = ArrayList<CacheEntry>()
        var total = 0L
        for (e in entries) {
            val age = now - e.lastModified
            val drop = when {
                e.isPart && e.path in activeParts -> false
                e.isPart -> age >= partOrphanAgeMs
                else -> age > maxAgeMs
            }
            if (drop) {
                delete += e
            } else {
                total += e.size
                if (!e.isPart) survivors += e
            }
        }
        if (total > maxTotal) {
            for (e in survivors.sortedBy { it.lastModified }) {
                if (total <= maxTotal) break
                if (now - e.lastModified < keepRecentMs) continue
                delete += e
                total -= e.size
            }
        }
        return delete
    }
}

/**
 * 缓存清理执行器：扫描缓存根，按 [CachePolicy] 删文件，再清掉空目录。
 *
 * 使用示例：`CacheJanitor(root, { reg.activeParts() }).run(startup = true)`
 *
 * @param root 缓存根目录
 * @param activeParts 返回当前活跃写句柄的临时文件路径
 * @param clock 时钟，测试可替换
 */
class CacheJanitor(
    private val root: File,
    private val activeParts: () -> Set<String>,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /**
     * 扫描缓存根下所有文件。
     *
     * @return 文件列表；根目录不存在返回空
     */
    fun scan(): List<CacheEntry> {
        if (!root.isDirectory) return emptyList()
        val base = root.path + File.separator
        return root.walkTopDown().filter { it.isFile }.map {
            val rel = it.path.removePrefix(base).replace(File.separatorChar, '/')
            val part = rel.startsWith(FileConst.DIR_TMP + "/") && rel.endsWith(FileConst.PART_SUFFIX)
            CacheEntry(rel, it.length(), it.lastModified(), part)
        }.toList()
    }

    /**
     * 执行一次清理。
     *
     * @param startup 是否启动时清理；是则所有非活跃临时文件立即视为孤儿
     * @return 实际删除的文件数
     */
    fun run(startup: Boolean): Int {
        val victims = CachePolicy.plan(
            scan(), clock(), activeParts(),
            partOrphanAgeMs = if (startup) 0L else FileConst.PART_ORPHAN_AGE_MS,
        )
        var n = 0
        for (v in victims) if (File(root, v.path).delete()) n++
        pruneEmptyDirs()
        return n
    }

    /** 删掉空的子目录（保留根目录本身），由深到浅 */
    private fun pruneEmptyDirs() {
        if (!root.isDirectory) return
        root.walkBottomUp().filter { it.isDirectory && it != root }.forEach { d ->
            if (d.list()?.isEmpty() == true) d.delete()
        }
    }
}
