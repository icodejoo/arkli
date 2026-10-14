package com.let188.arkli.dircleaner

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一条已授权文件夹记录。
 *
 * @property token 页面持有的不透明令牌
 * @property uri 目录树 URI 字符串，只留原生侧
 * @property name 显示名
 */
internal data class DirRecord(val token: String, val uri: String, val name: String)

/** 授权记录与 JSON 字符串互转，纯函数，可单测 */
internal object DirRecordCodec {
    /**
     * 编码。
     *
     * @param records 记录列表
     * @return JSON 数组字符串
     */
    fun encode(records: List<DirRecord>): String = JSONArray().also { a ->
        records.forEach { a.put(JSONObject().put("t", it.token).put("u", it.uri).put("n", it.name)) }
    }.toString()

    /**
     * 解码，坏数据与缺字段的项直接丢弃，不抛异常。
     *
     * @param text 存储的字符串，可为空
     * @return 记录列表
     */
    fun decode(text: String?): List<DirRecord> {
        if (text.isNullOrEmpty()) return emptyList()
        val arr = runCatching { JSONArray(text) }.getOrNull() ?: return emptyList()
        val out = ArrayList<DirRecord>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val t = o.optString("t")
            val u = o.optString("u")
            if (t.isEmpty() || u.isEmpty()) continue
            out.add(DirRecord(t, u, o.optString("n")))
        }
        return out
    }
}

/**
 * 授权记录的持久化：token 到目录 URI 与显示名，存在 SharedPreferences。
 *
 * 使用示例：`val store = DirStore(context); val rec = store.add(uri.toString(), "下载")`
 *
 * @param context 应用上下文
 */
internal class DirStore(context: Context) {
    /** 偏好存储 */
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /**
     * 全部记录。
     *
     * @return 按添加顺序的列表
     */
    @Synchronized
    fun all(): List<DirRecord> = DirRecordCodec.decode(prefs.getString(KEY_RECORDS, null))

    /**
     * 按令牌查记录。
     *
     * @param token 令牌
     * @return 记录；不存在返回 null
     */
    @Synchronized
    fun find(token: String): DirRecord? = all().firstOrNull { it.token == token }

    /**
     * 登记一个文件夹；同一 URI 已登记过则复用令牌并更新显示名。
     *
     * @param uri 目录树 URI 字符串
     * @param name 显示名
     * @return 登记后的记录
     */
    @Synchronized
    fun add(uri: String, name: String): DirRecord {
        val list = all().toMutableList()
        val old = list.indexOfFirst { it.uri == uri }
        val rec = DirRecord(if (old >= 0) list[old].token else DirPolicy.newToken(), uri, name)
        if (old >= 0) list[old] = rec else list.add(rec)
        save(list)
        return rec
    }

    /**
     * 删除记录。
     *
     * @param token 令牌
     * @return 被删掉的记录；不存在返回 null
     */
    @Synchronized
    fun remove(token: String): DirRecord? {
        val list = all().toMutableList()
        val i = list.indexOfFirst { it.token == token }
        if (i < 0) return null
        val rec = list.removeAt(i)
        save(list)
        return rec
    }

    /** 写回存储 */
    private fun save(list: List<DirRecord>) {
        prefs.edit().putString(KEY_RECORDS, DirRecordCodec.encode(list)).apply()
    }

    private companion object {
        /** 偏好文件名 */
        const val PREFS_NAME = "arkli_dirs"

        /** 记录键 */
        const val KEY_RECORDS = "records"
    }
}

/**
 * 最近一次扫描结果的登记（每个令牌只保留最新一次），删除前据此核对 id，防止页面伪造。
 * 随会话存活，会话关闭时清空。
 */
internal class ScanRegistry {
    /** 令牌到「id 到节点」 */
    private val byToken = HashMap<String, Map<String, DirNode>>()

    /**
     * 登记一次扫描结果，替换该令牌之前的结果。
     *
     * @param token 令牌
     * @param nodes 命中节点
     * @return 与 nodes 一一对应的句柄
     */
    @Synchronized
    fun replace(token: String, nodes: List<DirNode>): List<String> {
        val ids = nodes.map { DirPolicy.newItemId() }
        byToken[token] = ids.zip(nodes).toMap(LinkedHashMap())
        return ids
    }

    /**
     * 查句柄对应的节点。
     *
     * @param token 令牌
     * @param id 句柄
     * @return 节点；不属于该令牌最近一次扫描返回 null
     */
    @Synchronized
    fun lookup(token: String, id: String): DirNode? = byToken[token]?.get(id)

    /**
     * 删除成功后移除句柄，避免重复删除。
     *
     * @param token 令牌
     * @param id 句柄
     */
    @Synchronized
    fun drop(token: String, id: String) {
        byToken[token]?.let { byToken[token] = it - id }
    }

    /**
     * 清掉某令牌的结果。
     *
     * @param token 令牌
     */
    @Synchronized
    fun forget(token: String) {
        byToken.remove(token)
    }

    /** 清空，会话关闭时调用 */
    @Synchronized
    fun clear() = byToken.clear()
}
