package com.let188.arkli.dircleaner

/** 目录项 mime：文件夹 */
internal const val DIR_MIME = "vnd.android.document/directory"

/** 安装包 mime */
internal const val APK_MIME = "application/vnd.android.package-archive"

/**
 * 目录里的一个直接子项（SAF 查询的一行）。
 *
 * @property docId 文档 id（SAF 的 COLUMN_DOCUMENT_ID）
 * @property name 显示名
 * @property mime mime 类型，文件夹为 [DIR_MIME]
 * @property size 字节数，未知为 -1
 * @property lastModifiedMs 最后修改时间（毫秒），未知为 0
 */
internal data class DirEntry(
    val docId: String,
    val name: String,
    val mime: String,
    val size: Long,
    val lastModifiedMs: Long,
) {
    /** 是否文件夹 */
    val isDir: Boolean get() = mime == DIR_MIME
}

/** 目录读取失败（权限失效、provider 异常等） */
internal class DirReadException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** 子项来源，真实实现走 SAF，测试里用内存假实现 */
internal fun interface DirSource {
    /**
     * 列出一个文件夹的直接子项。
     *
     * @param docId 文件夹的文档 id
     * @return 子项列表
     * @throws DirReadException 读取失败
     */
    fun children(docId: String): List<DirEntry>
}

/**
 * 扫描结果里的一项。
 *
 * @property docId 文档 id，仅原生侧使用
 * @property name 显示名
 * @property relPath 相对所选文件夹的路径，以 / 分隔
 * @property bytes 字节数，文件夹与未知为 0
 * @property lastModifiedMs 最后修改时间（毫秒）
 * @property isDir 是否文件夹
 * @property depth 层级，所选文件夹的直接子项为 1
 */
internal data class DirNode(
    val docId: String,
    val name: String,
    val relPath: String,
    val bytes: Long,
    val lastModifiedMs: Long,
    val isDir: Boolean,
    val depth: Int,
)

/**
 * 一次扫描的输出。
 *
 * @property items 命中项（已排序、已按 maxItems 截断）
 * @property scanned 遍历过的节点数
 * @property truncated 是否不完整（命中数被截断、节点超上限或层级超限）
 */
internal data class ScanOutcome(val items: List<DirNode>, val scanned: Int, val truncated: Boolean)

/**
 * 扫描模式。
 *
 * @property wire 协议里的字符串
 */
internal enum class ScanMode(val wire: String) {
    /** 大文件 */
    LARGE("large"),

    /** 空文件与空文件夹 */
    EMPTY("empty"),

    /** 安装包 */
    APK("apk"),

    /** 全部列出 */
    ALL("all"),
}

/**
 * 扫描参数，已校验。
 *
 * @property mode 模式
 * @property minBytes 大文件阈值
 * @property maxItems 命中数上限
 * @property maxDepth 最大下探层数
 */
internal data class ScanOptions(val mode: ScanMode, val minBytes: Long, val maxItems: Int, val maxDepth: Int)

/** 文件夹遍历时的记录，用于自底向上判断是否为空 */
private class FolderRec(val node: DirNode, val parent: Int) {
    /** 是否直接含有文件 */
    var hasFile = false

    /** 是否已列出过子项；没列出的无法断定为空 */
    var explored = false
}

/** 遍历栈帧：文档 id、相对路径、层级、在文件夹表里的下标（所选根为 -1） */
private class Frame(val docId: String, val relPath: String, val depth: Int, val index: Int)

/**
 * 目录扫描：显式栈的迭代遍历，不递归，不依赖 Android，可单测。
 *
 * 使用示例：`DirScanner.scan(source, "root", opts, onProgress = {}, checkCancel = {})`
 */
internal object DirScanner {
    /** 遍历节点总数上限，超过即停并标记截断 */
    const val MAX_NODES = 50_000

    /** 每遍历多少个节点汇报一次进度 */
    const val PROGRESS_STEP = 500

    /**
     * 判断是否安装包：mime 为安装包类型，或扩展名是 apk/apks/xapk。
     *
     * @param name 文件名
     * @param mime mime 类型
     * @return 是则 true
     */
    fun isApk(name: String, mime: String): Boolean {
        if (mime.equals(APK_MIME, ignoreCase = true)) return true
        val ext = name.substringAfterLast('.', "").lowercase()
        return ext == "apk" || ext == "apks" || ext == "xapk"
    }

    /**
     * 自底向上判定哪些文件夹「不含任何文件」：子项全是空文件夹也算空；未列出子项的文件夹一律视为非空。
     *
     * @param parents 每个文件夹的父下标，-1 表示父级是所选根；父下标必须小于自身下标
     * @param hasFile 每个文件夹是否直接含文件
     * @param explored 每个文件夹是否已列出过子项
     * @return 与入参等长，true 表示该文件夹为空
     */
    fun emptyFolders(parents: IntArray, hasFile: BooleanArray, explored: BooleanArray): BooleanArray {
        val content = BooleanArray(parents.size) { hasFile[it] || !explored[it] }
        for (i in parents.indices.reversed()) {
            val p = parents[i]
            if (content[i] && p >= 0) content[p] = true
        }
        return BooleanArray(parents.size) { !content[it] }
    }

    /**
     * 遍历并筛选。
     *
     * @param source 子项来源
     * @param rootDocId 所选文件夹的文档 id
     * @param opts 扫描参数
     * @param onProgress 每 [PROGRESS_STEP] 个节点回调一次已遍历数
     * @param checkCancel 取消检查点，被取消时应抛出异常
     * @return 扫描结果
     * @throws DirReadException 所选文件夹本身读不了；子文件夹读不了只会当作未探索
     */
    fun scan(
        source: DirSource,
        rootDocId: String,
        opts: ScanOptions,
        onProgress: (Int) -> Unit,
        checkCancel: () -> Unit,
    ): ScanOutcome {
        val folders = ArrayList<FolderRec>()
        val files = ArrayList<DirNode>()
        val stack = ArrayDeque<Frame>()
        stack.addLast(Frame(rootDocId, "", 0, -1))
        var scanned = 0
        var truncated = false
        // 文件夹下标在创建时分配，子必大于父，满足 emptyFolders 的前提
        while (stack.isNotEmpty() && scanned < MAX_NODES) {
            checkCancel()
            val frame = stack.removeLast()
            if (frame.depth >= opts.maxDepth) {
                truncated = true
                continue
            }
            val kids = try {
                source.children(frame.docId)
            } catch (e: DirReadException) {
                if (frame.index < 0) throw e
                truncated = true
                continue
            }
            if (frame.index >= 0) folders[frame.index].explored = true
            for (k in kids) {
                if (scanned >= MAX_NODES) {
                    truncated = true
                    break
                }
                scanned++
                if (scanned % PROGRESS_STEP == 0) {
                    checkCancel()
                    onProgress(scanned)
                }
                val rel = if (frame.relPath.isEmpty()) k.name else frame.relPath + "/" + k.name
                // 文件夹的 size 是文件系统的目录项大小（如 3440），不是内容体积，按约定记 0，免得抬高“可释放空间”
                val node = DirNode(k.docId, k.name, rel, if (k.isDir) 0 else k.size.coerceAtLeast(0), k.lastModifiedMs, k.isDir, frame.depth + 1)
                if (k.isDir) {
                    folders.add(FolderRec(node, frame.index))
                    stack.addLast(Frame(k.docId, rel, frame.depth + 1, folders.size - 1))
                } else {
                    if (frame.index >= 0) folders[frame.index].hasFile = true
                    if (matchesFile(node, k.size, k.mime, opts)) files.add(node)
                }
            }
        }
        // 栈没清空就退出（节点超限）：剩下的文件夹保持 explored=false，自然被视为非空
        if (stack.isNotEmpty()) truncated = true
        val hits = ArrayList<DirNode>(files)
        when (opts.mode) {
            ScanMode.EMPTY -> {
                val empty = emptyFolders(
                    IntArray(folders.size) { folders[it].parent },
                    BooleanArray(folders.size) { folders[it].hasFile },
                    BooleanArray(folders.size) { folders[it].explored },
                )
                folders.forEachIndexed { i, f -> if (empty[i]) hits.add(f.node) }
            }
            ScanMode.ALL -> folders.forEach { hits.add(it.node) }
            else -> Unit
        }
        val sorted = when (opts.mode) {
            ScanMode.LARGE, ScanMode.APK -> hits.sortedWith(compareByDescending<DirNode> { it.bytes }.thenBy { it.relPath })
            else -> hits.sortedBy { it.relPath }
        }
        val cut = sorted.size > opts.maxItems
        return ScanOutcome(if (cut) sorted.subList(0, opts.maxItems) else sorted, scanned, truncated || cut)
    }

    /** 文件是否命中当前模式；文件夹由调用处另行处理 */
    private fun matchesFile(node: DirNode, rawSize: Long, mime: String, opts: ScanOptions): Boolean = when (opts.mode) {
        ScanMode.LARGE -> rawSize >= opts.minBytes
        ScanMode.EMPTY -> rawSize == 0L
        ScanMode.APK -> isApk(node.name, mime)
        ScanMode.ALL -> true
    }
}
