package com.let188.arkli.model

import java.io.File
import java.io.IOException
import kotlin.coroutines.cancellation.CancellationException

/** 复制中的临时文件后缀，复制完才改成正式名，保证原子 */
internal const val IMPORT_TMP_SUFFIX = ".imp"

/** 外部导入目录名，位于 `getExternalFilesDir(null)` 之下 */
const val IMPORT_DIR_NAME = "import"

/** 复制缓冲区大小 */
private const val COPY_BUFFER = 256 * 1024

/**
 * 外部目录导入的纯文件逻辑：扫描、过滤、复制（先写临时文件再原子改名）。校验仍走下载器，不在这里。
 *
 * 使用示例：`ModelImporter.scan(importRoot, manifest).found.forEach { (entry, src) -> ... }`
 */
internal object ModelImporter {
    /**
     * 一次扫描的结果。
     *
     * @property found 待导入的（清单项，源目录）
     * @property ignored 不在清单里、被忽略的目录名
     */
    data class ScanResult(val found: List<Pair<ModelEntry, File>>, val ignored: List<String>)

    /**
     * 扫描导入根目录：只认清单里的模型 id 且目录非空；其它目录记入 ignored。
     *
     * @param importRoot 导入根目录，不存在返回空结果
     * @param manifest 随包清单
     * @return 扫描结果
     */
    fun scan(importRoot: File, manifest: ModelManifest): ScanResult {
        val dirs = importRoot.listFiles { f -> f.isDirectory } ?: return ScanResult(emptyList(), emptyList())
        val found = ArrayList<Pair<ModelEntry, File>>()
        val ignored = ArrayList<String>()
        for (d in dirs.sortedBy { it.name }) {
            val entry = manifest.find(d.name)
            if (entry == null) ignored += d.name
            else if (!d.listFiles().isNullOrEmpty()) found += entry to d
        }
        return ScanResult(found, ignored)
    }

    /** 该模型接受的文件名：解压后的文件与压缩包，其余一律不复制 */
    fun acceptedNames(entry: ModelEntry): Set<String> = entry.files.map { it.name }.toSet() + listOfNotNull(entry.archive?.name)

    /**
     * 把源目录里被接受的文件复制进模型目录：先写 `.imp` 再改名；任何失败都清掉本次已复制的文件与临时文件。
     *
     * @param entry 清单项
     * @param src 导入源目录
     * @param dir 模型私有目录（不存在会创建）
     * @param freeSpace 取分区可用字节，单测可替换
     * @param active 返回 false 表示被取消，抛 [CancellationException]
     * @param onBytes 已复制字节累计回调
     * @return 复制成功的目标文件
     * @throws ModelDownloadException NO_SPACE：空间不足；INTERNAL：没有可导入文件或读写失败
     */
    fun copyInto(
        entry: ModelEntry,
        src: File,
        dir: File,
        freeSpace: (File) -> Long,
        active: () -> Boolean = { true },
        onBytes: (Long) -> Unit = {},
    ): List<File> {
        val names = acceptedNames(entry)
        val files = src.listFiles { f -> f.isFile && f.name in names }?.toList().orEmpty()
        if (files.isEmpty()) throw ModelDownloadException(ModelErrorCode.INTERNAL, "导入目录里没有这个模型的文件")
        if (!dir.isDirectory && !dir.mkdirs()) throw ModelDownloadException(ModelErrorCode.INTERNAL, "无法创建模型目录")
        val need = ModelPolicy.requiredFreeBytes(files.sumOf { it.length() })
        val free = freeSpace(dir)
        if (free < need) throw ModelDownloadException(ModelErrorCode.NO_SPACE, "剩余空间不足：需要 $need 字节，只有 $free 字节")
        val done = ArrayList<File>()
        var total = 0L
        try {
            for (f in files) {
                val tmp = File(dir, f.name + IMPORT_TMP_SUFFIX)
                f.inputStream().use { i ->
                    tmp.outputStream().use { o ->
                        val buf = ByteArray(COPY_BUFFER)
                        while (true) {
                            if (!active()) throw CancellationException("导入已取消")
                            val n = i.read(buf)
                            if (n < 0) break
                            o.write(buf, 0, n)
                            total += n
                            onBytes(total)
                        }
                    }
                }
                val target = File(dir, f.name)
                if ((target.exists() && !target.delete()) || !tmp.renameTo(target)) {
                    throw ModelDownloadException(ModelErrorCode.INTERNAL, "无法落盘 ${f.name}")
                }
                done += target
            }
        } catch (e: Throwable) {
            rollback(done, dir, files.map { it.name })
            throw if (e is IOException) ModelDownloadException(ModelErrorCode.INTERNAL, "复制失败：${e.message}") else e
        }
        return done
    }

    /**
     * 删除已复制的目标文件与对应临时文件，失败吞掉。
     *
     * @param copied 已复制成功的目标文件
     * @param dir 模型私有目录
     * @param names 本次涉及的文件名（用于清临时文件）
     */
    fun rollback(copied: List<File>, dir: File, names: Collection<String>) {
        copied.forEach { runCatching { it.delete() } }
        names.forEach { runCatching { File(dir, it + IMPORT_TMP_SUFFIX).delete() } }
    }
}
