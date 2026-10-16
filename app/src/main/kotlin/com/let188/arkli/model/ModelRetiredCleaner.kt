package com.let188.arkli.model

import android.util.Log
import java.io.File
import java.io.IOException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes

/** 日志 tag */
private const val RETIRED_LOG_TAG = "ArkliModel"

/** 模型根目录名（filesDir 下） */
private const val MODELS_ROOT = "models"

/** 退役清理用的文件系统接口，便于单测替身 */
interface RetiredFs {
    /** @return 设备上实际存在的模型目录，形如 `models/<单段名>` */
    fun existingDirs(): Set<String>

    /**
     * 删除一个模型目录。
     *
     * @param dir 形如 `models/<单段名>`
     * @return 是否已删除；目标不在 models 目录之下等安全检查不过时返回 false
     */
    fun delete(dir: String): Boolean
}

/**
 * 基于 filesDir 的真实实现。删除前先看目标是不是符号链接（是就只删链接本身，不碰它指向的东西），
 * 再规范化路径确认目标恰为 models 目录的直接子目录、且不在任何现行模型目录之内；递归删除不跟随链接。
 *
 * @param filesDir 应用 filesDir
 * @param liveDirs 现行清单的模型目录（形如 `models/<单段名>`），目标落在它们之内一律拒绝
 */
class FileRetiredFs(private val filesDir: File, private val liveDirs: Set<String> = emptySet()) : RetiredFs {
    /** 列出 models 下实际存在的子目录（含指向目录的链接，是否删除由 [delete] 再把关） */
    override fun existingDirs(): Set<String> =
        File(filesDir, MODELS_ROOT).listFiles { f -> f.isDirectory }?.map { "$MODELS_ROOT/${it.name}" }?.toSet().orEmpty()

    /** 安全删除一个退役目录：链接只删链接本身；真实目录须是 models 的直接子目录且不在现行模型目录内，递归时不跟随链接 */
    override fun delete(dir: String): Boolean {
        val root = File(filesDir, MODELS_ROOT).canonicalFile
        val entry = File(filesDir, dir)
        // 父目录（规范化后）必须恰为 models 根，挡住 ../ 与多段路径
        if (entry.parentFile?.canonicalFile != root) return false
        val path = entry.toPath()
        // 先判链接再规范化：规范化会把链接解析成目标，退役项若是指向现行模型的链接就会误删现行模型
        if (Files.isSymbolicLink(path)) {
            Files.delete(path)
            return true
        }
        val target = entry.canonicalFile
        if (target.parentFile != root) return false
        if (liveDirs.any { target.toPath().startsWith(File(filesDir, it).canonicalFile.toPath()) }) return false
        deleteTree(target.toPath())
        return !target.exists()
    }

    /** 递归删除目录树：用不跟随链接的遍历，遇到链接只删链接本身 */
    private fun deleteTree(start: Path) {
        Files.walkFileTree(start, object : SimpleFileVisitor<Path>() {
            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                Files.delete(file)
                return FileVisitResult.CONTINUE
            }

            override fun postVisitDirectory(dir: Path, exc: IOException?): FileVisitResult {
                Files.delete(dir)
                return FileVisitResult.CONTINUE
            }
        })
    }
}

/**
 * 退役模型回收：算出要删的目录并逐个删除。失败只记日志，不抛。
 *
 * 保守说明：退役条目不在现行清单里，没有下载入口，也没有模型会话在用，
 * 所以这里不需要判断下载/使用状态；与现行条目重名的目录已由 [ModelPolicy.retiredDirsToDelete] 排除。
 * 若将来允许退役 id 复用同一目录，必须沿用“重名跳过”。
 *
 * 使用示例：`ModelRetiredCleaner.run(manifest, FileRetiredFs(filesDir))`
 */
object ModelRetiredCleaner {
    /**
     * 执行一次回收。
     *
     * @param manifest 随包清单
     * @param fs 文件系统
     * @return 实际删除成功的目录
     */
    fun run(manifest: ModelManifest, fs: RetiredFs): List<String> {
        if (manifest.retired.isEmpty()) return emptyList()
        val deleted = ArrayList<String>()
        try {
            for (dir in ModelPolicy.retiredDirsToDelete(manifest, fs.existingDirs())) {
                try {
                    if (fs.delete(dir)) deleted += dir else logW("拒绝删除（不在 models 之下或删除失败）：$dir")
                } catch (e: Exception) {
                    logW("删除退役目录失败：$dir ${e.message}")
                }
            }
        } catch (e: Exception) {
            logW("退役清理失败：${e.message}")
        }
        return deleted
    }

    /** 记警告日志；单测（无 Android）下 Log 不可用时静默 */
    private fun logW(msg: String) {
        runCatching { Log.w(RETIRED_LOG_TAG, msg) }
    }
}
