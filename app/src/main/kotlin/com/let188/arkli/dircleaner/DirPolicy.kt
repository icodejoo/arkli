package com.let188.arkli.dircleaner

import com.let188.arkli.system.SystemParams
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/** 参数名：授权令牌 */
internal const val KEY_TOKEN = "token"

/**
 * 文件夹清理的参数解析与校验，纯函数，可单测。
 *
 * 使用示例：`DirPolicy.parseScan(params)`
 */
internal object DirPolicy {
    /** 大文件阈值缺省值（50MB） */
    const val DEFAULT_MIN_BYTES = 50L shl 20

    /** 命中数缺省上限 */
    const val DEFAULT_MAX_ITEMS = 2000

    /** 命中数硬上限 */
    const val MAX_ITEMS_LIMIT = 5000

    /** 下探层数缺省值 */
    const val DEFAULT_MAX_DEPTH = 12

    /** 下探层数硬上限 */
    const val MAX_DEPTH_LIMIT = 20

    /** 单次删除的条目数上限 */
    const val MAX_DELETE_IDS = 500

    /** 随机串字节数 */
    private const val RANDOM_BYTES = 16

    /** 令牌前缀 */
    private const val TOKEN_PREFIX = "dir:"

    /** 扫描项句柄前缀 */
    private const val ITEM_PREFIX = "it:"

    /** 安全随机源 */
    private val random = SecureRandom()

    /**
     * 生成随机不透明令牌。
     *
     * @return 形如 `dir:3fa9…` 的字符串
     */
    fun newToken(): String = TOKEN_PREFIX + randomHex()

    /**
     * 生成扫描项句柄。
     *
     * @return 形如 `it:3fa9…` 的字符串
     */
    fun newItemId(): String = ITEM_PREFIX + randomHex()

    /** 随机十六进制串 */
    private fun randomHex(): String {
        val b = ByteArray(RANDOM_BYTES)
        random.nextBytes(b)
        return b.joinToString("") { "%02x".format(it) }
    }

    /**
     * 解析模式名。
     *
     * @param wire 页面传来的字符串
     * @return 对应模式
     * @throws IllegalArgumentException 不是 large/empty/apk/all
     */
    fun parseMode(wire: String): ScanMode =
        ScanMode.values().firstOrNull { it.wire == wire } ?: throw IllegalArgumentException("mode 只能是 large / empty / apk / all")

    /**
     * 解析 `native.dir.scan` 的参数（不含 token）。
     *
     * @param params 页面参数
     * @return 校验后的扫描参数
     * @throws com.let188.arkli.bridge.BridgeException BAD_PARAMS
     */
    fun parseScan(params: JSONObject): ScanOptions {
        val mode = SystemParams.validated { parseMode(SystemParams.string(params, "mode")) }
        val minBytes = optNumber(params, "minBytes")?.let { SystemParams.validated { nonNegative(it) } } ?: DEFAULT_MIN_BYTES
        val maxItems = optNumber(params, "maxItems")?.let { SystemParams.validated { boundedInt("maxItems", it, MAX_ITEMS_LIMIT) } }
            ?: DEFAULT_MAX_ITEMS
        val maxDepth = optNumber(params, "maxDepth")?.let { SystemParams.validated { boundedInt("maxDepth", it, MAX_DEPTH_LIMIT) } }
            ?: DEFAULT_MAX_DEPTH
        return ScanOptions(mode, minBytes, maxItems, maxDepth)
    }

    /**
     * 解析删除的 id 列表：去重、保持顺序、限制数量。
     *
     * @param params 页面参数
     * @return 去重后的 id
     * @throws com.let188.arkli.bridge.BridgeException BAD_PARAMS
     */
    fun parseIds(params: JSONObject): List<String> = SystemParams.validated {
        val arr = params.optJSONArray("ids") ?: throw IllegalArgumentException("缺少 ids")
        val ids = LinkedHashSet<String>()
        for (i in 0 until arr.length()) {
            ids.add(arr.opt(i) as? String ?: throw IllegalArgumentException("ids 必须是字符串数组"))
        }
        require(ids.size in 1..MAX_DELETE_IDS) { "ids 数量须在 1~$MAX_DELETE_IDS 之间" }
        ids.toList()
    }

    /**
     * 删除顺序：层级深的先删，免得先删了父文件夹，子项再删时已不存在。
     *
     * @param nodes 待删除节点
     * @return 排好序的节点
     */
    fun deleteOrder(nodes: List<DirNode>): List<DirNode> = nodes.sortedByDescending { it.depth }

    /**
     * 扫描项转 JSON。
     *
     * @param id 本次扫描内的句柄
     * @param n 节点
     * @return `{ id, name, relPath, bytes, lastModifiedMs, isDir }`
     */
    fun itemJson(id: String, n: DirNode): JSONObject = JSONObject().put("id", id).put("name", n.name).put("relPath", n.relPath)
        .put("bytes", n.bytes).put("lastModifiedMs", n.lastModifiedMs).put("isDir", n.isDir)

    /**
     * 授权列表转 JSON。
     *
     * @param records 已授权的文件夹
     * @return `[{ token, name }]`
     */
    fun recordsJson(records: List<DirRecord>): JSONArray =
        JSONArray().also { a -> records.forEach { a.put(JSONObject().put(KEY_TOKEN, it.token).put("name", it.name)) } }

    /** 读可选数字，缺省或 null 返回 null */
    private fun optNumber(p: JSONObject, key: String): Double? {
        val v = p.opt(key)
        if (v == null || v == JSONObject.NULL) return null
        return SystemParams.number(p, key)
    }

    /** 校验非负 */
    private fun nonNegative(v: Double): Long {
        require(v.isFinite() && v >= 0) { "minBytes 不能为负" }
        return v.toLong()
    }

    /** 校验 1..limit 的整数 */
    private fun boundedInt(name: String, v: Double, limit: Int): Int {
        require(v.isFinite() && v >= 1 && v <= limit) { "$name 须在 1~$limit 之间" }
        return v.toInt()
    }
}
