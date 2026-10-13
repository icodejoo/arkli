package com.let188.arkli.files

import java.io.File

/**
 * 路径归一化与防目录穿越。页面传来的路径一律不可信，这里是唯一的把关点。
 *
 * 使用示例：
 * ```
 * SafePath.resolve(root, "pick/a.jpg")      // 落在 root 内 -> File
 * SafePath.resolve(root, "../etc/passwd")   // -> null
 * ```
 */
object SafePath {
    /**
     * 把相对路径解析成 [root] 内的文件。
     * 拒绝：空串、绝对路径、反斜杠、NUL、含 `.` / `..` / 空段、符号链接逃出 root。
     *
     * @param root 允许的根目录
     * @param rel 以 `/` 分隔的相对路径
     * @return 规范化后的文件（不要求存在）；不合法返回 null
     */
    fun resolve(root: File, rel: String): File? {
        if (rel.isEmpty() || rel.startsWith("/") || rel.indexOf('\\') >= 0 || rel.indexOf('\u0000') >= 0) return null
        if (rel.split('/').any { it.isEmpty() || it == "." || it == ".." }) return null
        val rootCanon = root.canonicalFile
        val target = File(rootCanon, rel).canonicalFile
        return if (target.path.startsWith(rootCanon.path + File.separator)) target else null
    }
}

/**
 * 页面可见的目录根：`cache/…` 对应缓存目录，`packs/…` 对应数据包目录（只读）。
 *
 * 使用示例：`roots.resolve("cache/out/a.png")`，`roots.pagePathOf(file)`。
 *
 * @param cacheRoot 缓存根目录（`cacheDir/arkli`）
 * @param packsRoot 数据包根目录（`filesDir/packs`）
 */
class FileRoots(val cacheRoot: File, val packsRoot: File) {
    /**
     * 解析页面路径（可读，缓存与数据包都行）。
     *
     * @param pagePath 形如 `cache/pick/a.jpg`、`packs/x/y.bin`
     * @return 文件；前缀不认识或路径不合法返回 null
     */
    fun resolve(pagePath: String): File? {
        val slash = pagePath.indexOf('/')
        if (slash <= 0) return null
        val rest = pagePath.substring(slash + 1)
        return when (pagePath.substring(0, slash)) {
            FileConst.PREFIX_CACHE -> SafePath.resolve(cacheRoot, rest)
            FileConst.PREFIX_PACKS -> SafePath.resolve(packsRoot, rest)
            else -> null
        }
    }

    /**
     * 解析页面路径，只认缓存目录（保存等方法用，数据包只读不可碰）。
     *
     * @param pagePath 形如 `cache/out/a.png`
     * @return 文件；不是缓存路径或不合法返回 null
     */
    fun resolveCache(pagePath: String): File? =
        if (pagePath.startsWith(FileConst.PREFIX_CACHE + "/")) resolve(pagePath) else null

    /**
     * 缓存文件转页面路径。
     *
     * @param file 缓存目录内的文件
     * @return 形如 `cache/out/h1/a.png`；不在缓存目录内返回 null
     */
    fun pagePathOf(file: File): String? {
        val rootCanon = cacheRoot.canonicalFile
        val canon = file.canonicalFile
        val prefix = rootCanon.path + File.separator
        if (!canon.path.startsWith(prefix)) return null
        return FileConst.PREFIX_CACHE + "/" + canon.path.substring(prefix.length).replace(File.separatorChar, '/')
    }
}
