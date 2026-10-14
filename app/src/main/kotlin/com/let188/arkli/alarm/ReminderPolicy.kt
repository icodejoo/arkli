package com.let188.arkli.alarm

import org.json.JSONArray
import org.json.JSONObject

/**
 * 一条待触发的闹钟提醒。
 *
 * @property id 页面给的闹钟标识
 * @property atEpochMs 触发时刻（毫秒时间戳）
 * @property title 通知标题
 * @property text 通知正文，可为空串
 */
internal data class AlarmEntry(val id: String, val atEpochMs: Long, val title: String, val text: String)

/**
 * 校验通过的立即通知请求。
 *
 * @property notificationId 通知 id
 * @property title 标题
 * @property text 正文，可为空串
 */
internal data class NotifySpec(val notificationId: Int, val title: String, val text: String)

/**
 * 提醒相关的参数校验与存储编解码，纯函数，可单测。
 *
 * 使用示例：`ReminderPolicy.parseAlarm("a1", 1.7e12, "喝水", null, now)`
 */
internal object ReminderPolicy {
    /** 标识长度上限 */
    const val MAX_ID_LENGTH = 64

    /** 标题长度上限 */
    const val MAX_TITLE_LENGTH = 100

    /** 正文长度上限 */
    const val MAX_TEXT_LENGTH = 500

    /** 闹钟最远能设多久之后（366 天，毫秒） */
    const val MAX_AHEAD_MS = 366L * 24 * 60 * 60 * 1000

    /** 列表里容忍已过点多久仍显示（1 分钟，毫秒），再久视为已失效 */
    const val EXPIRE_GRACE_MS = 60_000L

    /** API 33 起通知需要运行时授权 */
    private const val SDK_NOTIFICATION_PERMISSION = 33

    /** 当前系统通知是否需要运行时权限 */
    fun needsRuntimePermission(sdk: Int): Boolean = sdk >= SDK_NOTIFICATION_PERMISSION

    /**
     * 校验标题与正文并规范化。
     *
     * @param title 标题，必填
     * @param text 正文，可空
     * @return 去首尾空白后的标题与正文
     * @throws IllegalArgumentException 标题为空或长度超限
     */
    fun cleanContent(title: String, text: String?): Pair<String, String> {
        val t = title.trim()
        require(t.isNotEmpty()) { "title 不能为空" }
        require(t.length <= MAX_TITLE_LENGTH) { "title 超过 $MAX_TITLE_LENGTH 字符" }
        val body = text?.trim().orEmpty()
        require(body.length <= MAX_TEXT_LENGTH) { "text 超过 $MAX_TEXT_LENGTH 字符" }
        return t to body
    }

    /**
     * 校验立即通知参数。
     *
     * @param id 通知 id，可空；空则按当前时间生成
     * @param title 标题
     * @param text 正文，可空
     * @param now 当前毫秒时间，用来生成缺省 id
     * @return 规范化后的请求
     * @throws IllegalArgumentException id 不是非负整数，或标题正文不合法
     */
    fun parseNotify(id: Double?, title: String, text: String?, now: Long): NotifySpec {
        val (t, body) = cleanContent(title, text)
        val nid = if (id == null) {
            (now % Int.MAX_VALUE).toInt()
        } else {
            require(id == Math.floor(id) && id >= 0 && id <= Int.MAX_VALUE) { "id 必须是 0~${Int.MAX_VALUE} 的整数" }
            id.toInt()
        }
        return NotifySpec(nid, t, body)
    }

    /**
     * 校验闹钟标识。
     *
     * @param id 标识
     * @return 去首尾空白后的标识
     * @throws IllegalArgumentException 为空、过长或含控制字符
     */
    fun cleanAlarmId(id: String): String {
        val v = id.trim()
        require(v.isNotEmpty()) { "id 不能为空" }
        require(v.length <= MAX_ID_LENGTH) { "id 超过 $MAX_ID_LENGTH 字符" }
        require(v.none { it.code < 0x20 || it.code == 0x7f }) { "id 含控制字符" }
        return v
    }

    /**
     * 校验闹钟参数：触发时刻必须在未来，且不超过一年。
     *
     * @param id 标识
     * @param atEpochMs 触发时刻（毫秒时间戳，页面传来的数字）
     * @param title 标题
     * @param text 正文，可空
     * @param now 当前毫秒时间
     * @return 规范化后的闹钟条目
     * @throws IllegalArgumentException 时刻不合法或其它字段不合法
     */
    fun parseAlarm(id: String, atEpochMs: Double, title: String, text: String?, now: Long): AlarmEntry {
        val cleanId = cleanAlarmId(id)
        val (t, body) = cleanContent(title, text)
        require(!atEpochMs.isNaN() && atEpochMs == Math.floor(atEpochMs)) { "atEpochMs 必须是整数毫秒" }
        require(atEpochMs > now) { "atEpochMs 必须在未来" }
        require(atEpochMs <= now + MAX_AHEAD_MS.toDouble()) { "atEpochMs 不能超过一年后" }
        return AlarmEntry(cleanId, atEpochMs.toLong(), t, body)
    }

    /**
     * 闹钟对应的通知 id：由闹钟标识哈希而来，同一闹钟总是同一个通知。
     *
     * @param alarmId 闹钟标识
     * @return 非负整数
     */
    fun notificationIdOf(alarmId: String): Int = alarmId.hashCode() and Int.MAX_VALUE

    /**
     * 去掉已失效（过点太久）的条目，并按触发时间升序。
     *
     * @param items 全部条目
     * @param now 当前毫秒时间
     * @return 仍有效的条目
     */
    fun active(items: List<AlarmEntry>, now: Long): List<AlarmEntry> =
        items.filter { it.atEpochMs >= now - EXPIRE_GRACE_MS }.sortedBy { it.atEpochMs }

    /**
     * 条目列表编码成 JSON 字符串，存 SharedPreferences。
     *
     * @param items 条目
     * @return JSON 数组字符串
     */
    fun encode(items: List<AlarmEntry>): String = toJson(items).toString()

    /**
     * 条目列表转 JSON 数组，字段 id / atEpochMs / title / text，同时是 `native.alarm.list` 的返回格式。
     *
     * @param items 条目
     * @return JSON 数组
     */
    fun toJson(items: List<AlarmEntry>): JSONArray = JSONArray().also { arr ->
        for (e in items) {
            arr.put(JSONObject().put("id", e.id).put("atEpochMs", e.atEpochMs).put("title", e.title).put("text", e.text))
        }
    }

    /**
     * 解码存储的 JSON；数据损坏时返回空列表，坏条目被跳过。
     *
     * @param raw 存储的字符串，可空
     * @return 条目列表
     */
    fun decode(raw: String?): List<AlarmEntry> {
        if (raw.isNullOrEmpty()) return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val id = o.optString("id", "")
                if (id.isEmpty() || !o.has("atEpochMs")) return@mapNotNull null
                AlarmEntry(id, o.optLong("atEpochMs"), o.optString("title", ""), o.optString("text", ""))
            }
        } catch (e: Exception) {
            emptyList()
        }
    }
}
