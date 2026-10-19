package com.let188.arkli.model

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.net.HOST_GITHUB
import com.let188.arkli.net.NetPolicy
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.net.URI

/** 重定向最多跟随几跳 */
const val MAX_REDIRECTS = 5

/** 下载前要求的剩余空间倍数，分子 */
private const val FREE_SPACE_NUM = 12L

/** 下载前要求的剩余空间倍数，分母（1.2 倍） */
private const val FREE_SPACE_DEN = 10L

/** 退避基数（毫秒）：第 n 次失败后等 `基数 * 2^n` */
const val BACKOFF_BASE_MS = 1_000L

/** 退避上限（毫秒） */
const val BACKOFF_MAX_MS = 8_000L

/** 校验标记文件名，放在模型目录里，记录“这些文件已通过 sha256”及其长度与修改时间 */
internal const val MARKER_NAME = ".arkli-model.json"

/** release 下载地址的路径形态：`/<owner>/<repo>/releases/download/<tag>/<文件>` */
private val RELEASE_DOWNLOAD_PATH = Regex("^/([^/]+)/([^/]+)/releases/download/([^/]+)/[^/]+$")

/** release 页面地址前缀（github.com 的 https 根） */
private const val RELEASE_PAGE_ROOT = "https://github.com"

/** 桥参数里的模型 id 字段名 */
private const val KEY_ID = "id"

/** HTTP 200 */
private const val HTTP_OK = 200

/** HTTP 206 */
private const val HTTP_PARTIAL = 206

/** HTTP 416 */
private const val HTTP_RANGE_NOT_SATISFIABLE = 416

/** HTTP 408 */
private const val HTTP_REQUEST_TIMEOUT = 408

/** HTTP 429 */
private const val HTTP_TOO_MANY = 429

/** 从这个状态码起算服务器错误 */
private const val HTTP_SERVER_ERROR = 500

/** Content-Range 的格式 */
private val CONTENT_RANGE = Regex("^bytes (\\d+)-(\\d+)/(\\d+|\\*)$")

/** 模型状态，wire 即桥协议里的字符串 */
enum class ModelState(val wire: String) {
    /** 未安装（可能留有 .part 可续传） */
    ABSENT("absent"),

    /** 下载或校验中 */
    DOWNLOADING("downloading"),

    /** 已安装且校验标记有效 */
    INSTALLED("installed"),

    /** 文件齐全但没有有效校验标记（如手动放进去的），需 verify 或 ensure */
    UNVERIFIED("unverified"),

    /** 有文件长度不对，ensure 会清掉重下 */
    CORRUPT("corrupt"),
}

/** 下载失败的原因，wire 即桥协议里 `error.code` */
enum class ModelErrorCode(val wire: String) {
    /** 剩余空间不足 */
    NO_SPACE("NO_SPACE"),

    /** 网络错误或所有下载源都失败 */
    NETWORK("NETWORK"),

    /** sha256 不一致 */
    HASH_MISMATCH("HASH_MISMATCH"),

    /** 服务器给的长度与清单不符 */
    SIZE_MISMATCH("SIZE_MISMATCH"),

    /** 下载地址（含重定向）被白名单拒绝 */
    SOURCE_REJECTED("SOURCE_REJECTED"),

    /** 数据包解压失败（条目缺失、多余、长度不符、压缩包损坏） */
    UNPACK_FAILED("UNPACK_FAILED"),

    /** 本地 I/O 等内部错误 */
    INTERNAL("INTERNAL"),
}

/**
 * 下载过程中的失败。
 *
 * @property code 原因
 * @property retriable 同一下载源上是否值得重试
 */
class ModelDownloadException(val code: ModelErrorCode, message: String, val retriable: Boolean = false) : Exception(message)

/**
 * 一个文件在磁盘上的情况。
 *
 * @property name 文件名
 * @property finalBytes 目标文件长度，不存在为 null
 * @property finalMtime 目标文件修改时间，不存在为 null
 * @property partBytes `.part` 长度，不存在为 0
 */
data class FileFacts(val name: String, val finalBytes: Long?, val finalMtime: Long?, val partBytes: Long)

/**
 * 校验标记：某版本的各文件在通过 sha256 时的长度与修改时间。文件被替换或改动后指纹对不上，标记即失效。
 *
 * @property version 清单版本
 * @property files 文件名到（长度，修改时间）
 */
data class VerifiedMarker(val version: String, val files: Map<String, Pair<Long, Long>>)

/** 一次响应对断点续传的判定 */
sealed class RangeDecision {
    /** 把响应体写到 .part 的 [startAt] 处；0 表示从头写（需截断） */
    data class Write(val startAt: Long) : RangeDecision()

    /** .part 已经是完整长度，直接校验 */
    object Complete : RangeDecision()

    /** .part 与服务器对不上，删掉后从头来 */
    object Restart : RangeDecision()

    /** 失败 */
    data class Fail(val error: ModelDownloadException) : RangeDecision()
}

/**
 * 对外展示的模型状态快照。
 *
 * @property id 模型 id
 * @property displayName 展示名
 * @property version 清单版本
 * @property state 状态
 * @property totalBytes 总字节数
 * @property downloadedBytes 已落地字节数
 * @property diskBytes 磁盘占用（含 .part）
 * @property phase 下载中时的阶段（download / verify），否则 null
 * @property speedBps 下载中的平均速度（字节/秒），未知为 null
 * @property errorCode 最近一次下载失败的错误码，没有为 null
 * @property errorMessage 错误描述
 */
data class ModelSnapshot(
    val id: String,
    val displayName: String,
    val version: String,
    val state: ModelState,
    val totalBytes: Long,
    val downloadedBytes: Long,
    val diskBytes: Long,
    val phase: String? = null,
    val speedBps: Long? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null,
)

/**
 * 模型下载管理的纯逻辑：参数校验、磁盘状态推断、Range 判定、重定向校验、退避、序列化。无 Android 依赖，可单测。
 *
 * 使用示例：`ModelPolicy.requiredFreeBytes(54_662_805)` 为 65_595_366
 */
object ModelPolicy {
    /**
     * 算出应当回收的退役模型目录。
     * 规则：路径必须是 `models/<单段名>`（拒绝含 `..`、绝对路径、多段、空、反斜杠）；
     * 与现行条目的 dir 重名则跳过；只返回设备上实际存在的目录；结果去重并保持清单顺序。
     *
     * @param manifest 随包清单
     * @param existingDirs 设备上实际存在的模型目录，形如 `models/<单段名>`
     * @return 应删除的目录列表；`retired` 为空时返回空列表
     *
     * 使用示例：`retiredDirsToDelete(manifest, setOf("models/old"))`
     */
    fun retiredDirsToDelete(manifest: ModelManifest, existingDirs: Set<String>): List<String> {
        if (manifest.retired.isEmpty()) return emptyList()
        val live = manifest.models.map { it.dir }.toSet()
        return manifest.retired.map { it.dir }
            .filter { isSingleSegmentModelDir(it) && it !in live && it in existingDirs }
            .distinct()
    }

    /** 是否形如 `models/<单段名>`：单段、不以点开头、无分隔符、非 `.`/`..` */
    internal fun isSingleSegmentModelDir(dir: String): Boolean {
        if (!dir.startsWith(MODEL_DIR_PREFIX)) return false
        val seg = dir.substring(MODEL_DIR_PREFIX.length)
        return SEGMENT_REGEX.matches(seg) && seg != "." && seg != ".."
    }

    /** 下载阶段名 */
    const val PHASE_DOWNLOAD = "download"

    /** 校验阶段名 */
    const val PHASE_VERIFY = "verify"

    /** 数据包解压阶段名 */
    const val PHASE_UNPACK = "unpack"

    /** 压缩包格式名，目前只有 zip */
    const val ARCHIVE_FORMAT = "zip"

    /**
     * 解析 `{ id }` 参数，id 必须在清单里。
     *
     * @param params 桥参数
     * @param manifest 随包清单
     * @return 清单里的模型
     * @throws BridgeException BAD_PARAMS：缺 id、类型不对或不在清单
     */
    fun requireEntry(params: JSONObject, manifest: ModelManifest): ModelEntry {
        val id = params.opt(KEY_ID) as? String ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "id 需要是字符串")
        return manifest.find(id) ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "未知的模型 id")
    }

    /**
     * 下载前要求的剩余空间：待下载字节的 1.2 倍（向上取整）。
     *
     * @param remainingBytes 还需要下载的字节数（已有 .part 不算）
     * @return 要求的可用字节数
     */
    fun requiredFreeBytes(remainingBytes: Long): Long = (remainingBytes * FREE_SPACE_NUM + FREE_SPACE_DEN - 1) / FREE_SPACE_DEN

    /**
     * 第 n 次失败（从 0 起）后的退避时长，指数增长并封顶。
     *
     * @param failures 0 表示第一次失败后
     * @return 毫秒
     */
    fun backoffMs(failures: Int): Long = (BACKOFF_BASE_MS shl failures.coerceIn(0, 20)).coerceAtMost(BACKOFF_MAX_MS)

    /**
     * 由磁盘情况与校验标记推断状态（不含“下载中”，那由管理器按任务判定）。
     *
     * @param entry 清单模型
     * @param facts 与 entry.files 同序的磁盘情况
     * @param marker 校验标记，没有为 null
     * @return 文件长度不对为 CORRUPT；齐全且标记吻合为 INSTALLED，标记缺失或失效为 UNVERIFIED；其余为 ABSENT
     */
    fun diskState(entry: ModelEntry, facts: List<FileFacts>, marker: VerifiedMarker?): ModelState {
        val pairs = entry.files.zip(facts)
        if (pairs.any { (f, d) -> d.finalBytes != null && d.finalBytes != f.bytes }) return ModelState.CORRUPT
        if (pairs.any { (_, d) -> d.finalBytes == null }) return ModelState.ABSENT
        val ok = marker != null && marker.version == entry.version && pairs.all { (f, d) ->
            marker.files[f.name] == Pair(f.bytes, d.finalMtime)
        }
        return if (ok) ModelState.INSTALLED else ModelState.UNVERIFIED
    }

    /**
     * 已落地的字节数：完整文件算全长，否则取 .part 长度（不超过全长）。
     *
     * @param entry 清单模型
     * @param facts 与 entry.files 同序的磁盘情况
     * @return 已下载字节
     */
    fun downloadedBytes(entry: ModelEntry, facts: List<FileFacts>): Long = entry.files.zip(facts).sumOf { (f, d) ->
        if (d.finalBytes == f.bytes) f.bytes else d.partBytes.coerceAtMost(f.bytes)
    }

    /**
     * 占用的磁盘字节：目标文件加 .part 的实际长度之和。
     *
     * @param facts 磁盘情况
     * @return 字节数
     */
    fun diskBytes(facts: List<FileFacts>): Long = facts.sumOf { (it.finalBytes ?: 0L) + it.partBytes }

    /**
     * 判定一次（非重定向）响应怎么处理。
     *
     * @param status HTTP 状态码
     * @param requestedFrom 请求的起始偏移，0 表示没带 Range
     * @param contentRange 响应的 Content-Range 头，没有为 null
     * @param contentLength 响应的 Content-Length，未知为 null
     * @param expectedBytes 清单里该文件的字节数
     * @return 写入位置、已完成、重来或失败
     */
    fun decideRange(status: Int, requestedFrom: Long, contentRange: String?, contentLength: Long?, expectedBytes: Long): RangeDecision = when {
        status == HTTP_OK ->
            // 200：服务器没做 Range（或本来就没带），整个文件从头来
            if (contentLength != null && contentLength != expectedBytes) sizeMismatch("服务器给的长度 $contentLength 与清单 $expectedBytes 不符")
            else RangeDecision.Write(0)
        status == HTTP_PARTIAL -> decidePartial(requestedFrom, contentRange, expectedBytes)
        status == HTTP_RANGE_NOT_SATISFIABLE -> when {
            requestedFrom == expectedBytes -> RangeDecision.Complete
            requestedFrom > 0 -> RangeDecision.Restart
            else -> RangeDecision.Fail(ModelDownloadException(ModelErrorCode.NETWORK, "服务器返回 416", false))
        }
        status == HTTP_REQUEST_TIMEOUT || status == HTTP_TOO_MANY || status >= HTTP_SERVER_ERROR ->
            RangeDecision.Fail(ModelDownloadException(ModelErrorCode.NETWORK, "服务器返回 $status", true))
        else -> RangeDecision.Fail(ModelDownloadException(ModelErrorCode.NETWORK, "服务器返回 $status", false))
    }

    /** 206 的判定：起点必须等于请求偏移，终点必须是文件末尾，总长（若给了）必须等于清单 */
    private fun decidePartial(requestedFrom: Long, contentRange: String?, expectedBytes: Long): RangeDecision {
        val r = parseContentRange(contentRange)
        return when {
            requestedFrom <= 0 -> RangeDecision.Fail(ModelDownloadException(ModelErrorCode.NETWORK, "没带 Range 却收到 206", true))
            r == null -> RangeDecision.Fail(ModelDownloadException(ModelErrorCode.NETWORK, "206 缺少有效的 Content-Range", true))
            r.first != requestedFrom || r.second != expectedBytes - 1 || (r.third != null && r.third != expectedBytes) ->
                sizeMismatch("Content-Range 与清单不符")
            else -> RangeDecision.Write(requestedFrom)
        }
    }

    /** 造一个长度不符的失败（不重试，换下载源） */
    private fun sizeMismatch(msg: String) = RangeDecision.Fail(ModelDownloadException(ModelErrorCode.SIZE_MISMATCH, msg, false))

    /**
     * 解析 `bytes 100-199/200`。
     *
     * @param header Content-Range 头值
     * @return （起、止、总长或 null），格式不对返回 null
     */
    fun parseContentRange(header: String?): Triple<Long, Long, Long?>? {
        val m = CONTENT_RANGE.matchEntire(header?.trim().orEmpty()) ?: return null
        val a = m.groupValues[1].toLongOrNull() ?: return null
        val b = m.groupValues[2].toLongOrNull() ?: return null
        val totalText = m.groupValues[3]
        val total = if (totalText == "*") null else (totalText.toLongOrNull() ?: return null)
        return if (b < a) null else Triple(a, b, total)
    }

    /**
     * 校验一跳重定向并算出下一个 URL。
     *
     * @param current 当前 URL
     * @param location Location 头（可为相对地址）
     * @param hops 已经跟随的跳数（不含这一跳）
     * @param allowLoopbackHttp 是否放行回环明文，仅 debug 为 true
     * @return 下一跳的绝对 URL
     * @throws ModelDownloadException SOURCE_REJECTED：缺 Location、超过 [MAX_REDIRECTS] 跳、目标不是白名单 https
     */
    fun nextHop(current: String, location: String?, hops: Int, allowLoopbackHttp: Boolean): String {
        if (hops >= MAX_REDIRECTS) throw rejected("重定向超过 $MAX_REDIRECTS 跳")
        if (location.isNullOrBlank()) throw rejected("重定向缺少 Location")
        val next = try {
            URI(current).resolve(location.trim()).toString()
        } catch (e: Exception) {
            throw rejected("重定向地址非法")
        }
        if (!NetPolicy.isAllowedDownload(next, allowLoopbackHttp)) throw rejected("重定向目标不在白名单：${NetPolicy.redact(next)}")
        return next
    }

    /** 造“地址被拒”异常（不重试，换下载源） */
    private fun rejected(msg: String) = ModelDownloadException(ModelErrorCode.SOURCE_REJECTED, msg, false)

    /**
     * 序列化校验标记。
     *
     * @param m 标记
     * @return JSON 文本
     */
    fun markerToJson(m: VerifiedMarker): String {
        val files = JSONObject()
        m.files.forEach { (name, p) -> files.put(name, JSONObject().put("bytes", p.first).put("mtime", p.second)) }
        return JSONObject().put("version", m.version).put("files", files).toString()
    }

    /**
     * 解析校验标记，损坏的标记当作没有。
     *
     * @param text 文件内容
     * @return 标记，解析失败返回 null
     */
    fun markerFromJson(text: String?): VerifiedMarker? {
        if (text == null) return null
        return try {
            val o = JSONObject(text)
            val f = o.getJSONObject("files")
            val files = f.keys().asSequence().associateWith { k -> f.getJSONObject(k).let { Pair(it.getLong("bytes"), it.getLong("mtime")) } }
            VerifiedMarker(o.getString("version"), files)
        } catch (e: JSONException) {
            null
        }
    }

    /**
     * 序列化状态快照。不含任何路径，页面只看到相对描述。
     *
     * @param s 快照
     * @return `{ id, displayName, version, state, totalBytes, downloadedBytes, diskBytes, phase?, speedBps?, error? }`
     */
    fun snapshotJson(s: ModelSnapshot): JSONObject {
        val o = JSONObject().put("id", s.id).put("displayName", s.displayName).put("version", s.version)
            .put("state", s.state.wire).put("totalBytes", s.totalBytes)
            .put("downloadedBytes", s.downloadedBytes).put("diskBytes", s.diskBytes)
        s.phase?.let { o.put("phase", it) }
        s.speedBps?.let { o.put("speedBps", it) }
        if (s.errorCode != null) o.put("error", JSONObject().put("code", s.errorCode).put("message", s.errorMessage.orEmpty()))
        return o
    }

    /**
     * 由一条下载地址推出所属 GitHub release 页面地址。
     *
     * @param url 清单里的下载地址
     * @return 形如 `https://github.com/o/r/releases/tag/<tag>`；不是 github.com release 下载地址返回 null
     *
     * 使用示例：`releasePageOf("https://github.com/o/r/releases/download/v1/a.bin")` 为 `https://github.com/o/r/releases/tag/v1`
     */
    fun releasePageOf(url: String): String? {
        val u = try {
            URI(url)
        } catch (e: Exception) {
            return null
        }
        if (u.scheme?.lowercase() != "https" || u.host?.lowercase() != HOST_GITHUB) return null
        val m = RELEASE_DOWNLOAD_PATH.matchEntire(u.rawPath.orEmpty()) ?: return null
        return "$RELEASE_PAGE_ROOT/${m.groupValues[1]}/${m.groupValues[2]}/releases/tag/${m.groupValues[3]}"
    }

    /**
     * 序列化一个模型的下载来源（只读，供界面展示与手动下载）。
     * 地址只取随包清单：先过 [NetPolicy.isAllowedDownload]（不放行回环明文）再经 [NetPolicy.redact] 去掉查询串与片段，
     * 因此不会回显带 token 的地址；debug 的 URL 覆盖不在这里，永远不会出现。不含磁盘绝对路径，`dir` 是相对 filesDir 的目录。
     *
     * @param entry 清单里的模型
     * @return `{ id, dir, files: [{ name, bytes, sha256, urls }], releasePages: [string] }`；单包安装的模型 `files` 只含压缩包一项，
     *   另有 `format`（`zip`）、`unpackedBytes`（解压后总字节）、`entryCount`（包内文件数）、`license`（可空）
     *
     * 使用示例：`sourcesJson(entry).getJSONArray("releasePages")`
     */
    fun sourcesJson(entry: ModelEntry): JSONObject {
        val pages = LinkedHashSet<String>()
        val files = JSONArray()
        // 数据包用户要下载的是压缩包；解压后的文件没有下载地址
        (entry.archive?.let { listOf(it) } ?: entry.files).forEach { f ->
            val urls = JSONArray()
            f.urls.filter { NetPolicy.isAllowedDownload(it) }.map { NetPolicy.redact(it) }.forEach {
                urls.put(it)
                releasePageOf(it)?.let(pages::add)
            }
            files.put(JSONObject().put("name", f.name).put("bytes", f.bytes).put("sha256", f.sha256).put("urls", urls))
        }
        val out = JSONObject().put("id", entry.id).put("dir", entry.dir).put("files", files).put("releasePages", JSONArray(pages.toList()))
        // 单包安装：补解压后总字节、条目数、格式、许可证，供“一个包”的详情展示；旧格式清单不带这些字段
        if (entry.archive != null) {
            out.put("format", ARCHIVE_FORMAT).put("unpackedBytes", entry.totalBytes).put("entryCount", entry.files.size)
            entry.license?.let { out.put("license", it) }
        }
        return out
    }
}
