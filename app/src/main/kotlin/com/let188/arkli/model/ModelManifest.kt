package com.let188.arkli.model

import com.let188.arkli.net.NetPolicy
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** 清单资源在 assets 里的路径 */
const val MODEL_MANIFEST_ASSET = "ai/models.json"

/** 模型目录必须落在 filesDir 的这个子目录下 */
internal const val MODEL_DIR_PREFIX = "models/"

/** 单个文件允许的下载源数量上限 */
private const val MAX_URLS = 8

/** 每个模型的文件数上限 */
private const val MAX_FILES = 16

/** 清单里模型数量上限 */
private const val MAX_MODELS = 64

/** 模型 id：小写字母数字开头，可含点、下划线、连字符 */
private val ID_REGEX = Regex("^[a-z0-9][a-z0-9._-]{0,63}$")

/** 目录名与文件名：单段，不以点开头，不含路径分隔符 */
internal val SEGMENT_REGEX = Regex("^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$")

/** sha256 十六进制，小写 64 位 */
private val SHA256_REGEX = Regex("^[0-9a-f]{64}$")

/** 清单 kind：普通模型（逐文件下载） */
internal const val KIND_MODEL = "model"

/** 清单 kind：数据包（下载一个 zip，解压后逐文件校验） */
internal const val KIND_PACK = "pack"

/** 数据包压缩包的后缀 */
internal const val ARCHIVE_SUFFIX = ".zip"

/** 下载中的临时文件后缀，清单里的文件名不得以它结尾，避免与 .part 撞名 */
internal const val PART_SUFFIX = ".part"

/**
 * 清单里的一个文件。
 *
 * @property name 文件名（单段，落在模型目录下）
 * @property bytes 字节数
 * @property sha256 小写十六进制摘要
 * @property role 用途标记，如 `model`，可空
 * @property urls 下载源，按序回退，镜像互为备份
 */
data class ModelFile(val name: String, val bytes: Long, val sha256: String, val role: String?, val urls: List<String>)

/**
 * 清单里的一个模型。
 *
 * @property id 稳定 id，也是桥方法的参数
 * @property displayName 给人看的名字
 * @property version 清单版本号，换版本会让旧的校验标记失效
 * @property dir 目标目录，相对 filesDir，如 `models/siglip2-mnn-w8`
 * @property totalBytes 全部文件字节数之和
 * @property license 许可证标识，可空
 * @property files 文件列表；数据包（[archive] 非空）里是**解压后**的文件，不带下载源，由解压校验
 * @property archive 压缩包（zip）：下载的是它，解压出 [files]（逐文件的 bytes/sha256 仍用于解压核对与就绪判断）；
 *   数据包必有，普通模型可选（旧格式逐文件下载时为 null）
 */
data class ModelEntry(
    val id: String,
    val displayName: String,
    val version: String,
    val dir: String,
    val totalBytes: Long,
    val license: String?,
    val files: List<ModelFile>,
    val archive: ModelFile? = null,
) {
    /** 是否数据包（下载压缩包再解压） */
    val isPack: Boolean get() = archive != null

    /** 需要下载的字节数：数据包是压缩包大小，普通模型是全部文件之和 */
    val downloadBytes: Long get() = archive?.bytes ?: totalBytes
}

/**
 * 已退役、设备上应当回收的旧模型。
 *
 * @property id 旧模型 id（仅作记录与日志）
 * @property dir 旧目录，相对 filesDir，形如 `models/<单段名>`；是否安全由 [ModelPolicy.retiredDirsToDelete] 再把关
 */
data class RetiredModel(val id: String, val dir: String)

/**
 * 随包清单：下载地址的唯一来源。页面只能传 id，不能传 URL。
 *
 * @property models 全部模型
 * @property retired 已退役的旧模型，启动后台回收其目录；缺省为空
 */
class ModelManifest(val models: List<ModelEntry>, val retired: List<RetiredModel> = emptyList()) {
    /**
     * 按 id 找模型。
     *
     * @param id 模型 id
     * @return 命中的模型，没有返回 null
     */
    fun find(id: String): ModelEntry? = models.firstOrNull { it.id == id }

    companion object {
        /** 空清单：清单解析失败时的兜底，所有 id 都会被拒绝 */
        val EMPTY = ModelManifest(emptyList())
    }
}

/**
 * 清单解析与校验，纯函数。任何一项不合法都整份拒绝（信任锚宁可不用也不能半信半疑）。
 *
 * 使用示例：`ModelManifestParser.parse(assetText).find("siglip2-mnn-w8")`
 */
object ModelManifestParser {
    /**
     * 解析清单 JSON。
     *
     * @param text 清单文本，结构见 docs/design/bridge-protocol.md 的「模型下载管理」
     * @return 校验通过的清单
     * @throws IllegalArgumentException 格式错误、id/目录/文件名不合法、摘要或字节数不对、总字节不等于文件之和、
     *   下载源不在 [NetPolicy.DOWNLOAD_HOSTS] 白名单内、id 或文件名重复
     */
    fun parse(text: String): ModelManifest {
        try {
            val root = JSONObject(text)
            require(root.optInt("schema") == 1) { "不支持的 schema" }
            val arr = root.optJSONArray("models") ?: throw IllegalArgumentException("缺 models")
            require(arr.length() in 1..MAX_MODELS) { "models 数量不合法" }
            val models = (0 until arr.length()).map { entry(arr.optJSONObject(it) ?: throw IllegalArgumentException("models[$it] 不是对象")) }
            require(models.map { it.id }.toSet().size == models.size) { "模型 id 重复" }
            require(models.map { it.dir }.toSet().size == models.size) { "模型目录重复" }
            return ModelManifest(models, retired(root.opt("retired")))
        } catch (e: JSONException) {
            throw IllegalArgumentException("清单不是合法 JSON：${e.message}")
        }
    }

    /**
     * 解析可选的 `retired`。退役回收只是尽力而为，所以这里宽松：不是数组视为空，
     * 不合法的条目（非对象、id 或目录不合规）直接丢弃，不拖垮整份清单；超出 [MAX_MODELS] 的部分也丢弃。
     */
    private fun retired(raw: Any?): List<RetiredModel> {
        val arr = raw as? JSONArray ?: return emptyList()
        return (0 until minOf(arr.length(), MAX_MODELS)).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val id = o.optString("id")
            val dir = o.optString("dir")
            if (ID_REGEX.matches(id) && isSafeDir(dir)) RetiredModel(id, dir) else null
        }
    }

    /** 解析一个模型 */
    private fun entry(o: JSONObject): ModelEntry {
        val id = o.optString("id")
        require(ID_REGEX.matches(id)) { "非法的模型 id：$id" }
        val dir = o.optString("dir")
        require(isSafeDir(dir)) { "非法的模型目录：$dir" }
        val version = o.optString("version")
        require(version.isNotEmpty() && version.length <= 32) { "$id 缺 version" }
        val displayName = o.optString("displayName")
        require(displayName.isNotEmpty()) { "$id 缺 displayName" }
        val kind = o.optString("kind", KIND_MODEL)
        require(kind == KIND_MODEL || kind == KIND_PACK) { "$id 的 kind 不认识：$kind" }
        // 压缩包：数据包必须有；普通模型可选（带了就是“单个 zip 包”安装，解压结果与逐文件安装完全一致）
        val rawArchive = o.optJSONObject("archive")
        require(kind != KIND_PACK || rawArchive != null) { "$id 是数据包却缺 archive" }
        require(!o.has("archive") || rawArchive != null) { "$id 的 archive 不是对象" }
        val archive = rawArchive?.let {
            file(id, it).also { a -> require(a.name.endsWith(ARCHIVE_SUFFIX)) { "$id 的压缩包必须是 $ARCHIVE_SUFFIX" } }
        }
        val arr = o.optJSONArray("files") ?: throw IllegalArgumentException("$id 缺 files")
        require(arr.length() in 1..MAX_FILES) { "$id 的文件数不合法" }
        val files = (0 until arr.length()).map {
            file(id, arr.optJSONObject(it) ?: throw IllegalArgumentException("$id.files[$it] 不是对象"), needUrls = archive == null)
        }
        require(files.map { it.name }.toSet().size == files.size) { "$id 的文件名重复" }
        require(archive == null || archive.name !in files.map { it.name }) { "$id 的压缩包与解压文件重名" }
        val total = o.optLong("totalBytes", -1)
        require(total == files.sumOf { it.bytes }) { "$id 的 totalBytes 与文件之和不一致" }
        return ModelEntry(id, displayName, version, dir, total, o.optString("license").ifEmpty { null }, files, archive)
    }

    /** 解析一个文件；[needUrls] 为 false 时（数据包解压后的文件）不得带下载源 */
    private fun file(modelId: String, o: JSONObject, needUrls: Boolean = true): ModelFile {
        val name = o.optString("name")
        require(SEGMENT_REGEX.matches(name) && !name.endsWith(PART_SUFFIX)) { "$modelId 的文件名非法：$name" }
        val bytes = o.optLong("bytes", -1)
        require(bytes > 0) { "$modelId/$name 的 bytes 必须为正" }
        val sha = o.optString("sha256")
        require(SHA256_REGEX.matches(sha)) { "$modelId/$name 的 sha256 不是 64 位小写十六进制" }
        val urls = strings(o.optJSONArray("urls"))
        if (needUrls) require(urls.size in 1..MAX_URLS) { "$modelId/$name 的 urls 数量不合法" }
        else require(urls.isEmpty()) { "$modelId/$name 是解压文件，不应带 urls" }
        urls.forEach { require(NetPolicy.isAllowedDownload(it)) { "$modelId/$name 的下载源不在白名单：${NetPolicy.redact(it)}" } }
        return ModelFile(name, bytes, sha, o.optString("role").ifEmpty { null }, urls)
    }

    /** 取字符串数组，非字符串元素视为非法 */
    private fun strings(a: JSONArray?): List<String> =
        if (a == null) emptyList() else (0 until a.length()).map { a.opt(it) as? String ?: throw IllegalArgumentException("urls 含非字符串") }

    /** 目录必须是 `models/<单段>`，不能含 `..`、反斜杠或绝对路径 */
    private fun isSafeDir(dir: String): Boolean = ModelPolicy.isSingleSegmentModelDir(dir)
}
