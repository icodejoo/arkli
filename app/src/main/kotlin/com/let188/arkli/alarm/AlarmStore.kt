package com.let188.arkli.alarm

import android.content.Context
import android.content.SharedPreferences

/**
 * 待触发闹钟的本地记录，存 SharedPreferences（一条 JSON 数组）。读改写加锁，接收器与页面调用可并发。
 *
 * @param context 应用上下文
 */
internal class AlarmStore(context: Context) {
    /** 存储文件 */
    private val prefs: SharedPreferences = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** 读全部记录 */
    @Synchronized
    fun all(): List<AlarmEntry> = ReminderPolicy.decode(prefs.getString(KEY_ITEMS, null))

    /** 取一条，没有返回 null */
    @Synchronized
    fun get(id: String): AlarmEntry? = all().firstOrNull { it.id == id }

    /** 新增或覆盖同 id 的记录 */
    @Synchronized
    fun put(entry: AlarmEntry) = save(all().filter { it.id != entry.id } + entry)

    /** 删除一条；返回原先是否存在 */
    @Synchronized
    fun remove(id: String): Boolean {
        val old = all()
        val left = old.filter { it.id != id }
        if (left.size != old.size) save(left)
        return left.size != old.size
    }

    /** 写回全部记录 */
    private fun save(items: List<AlarmEntry>) {
        prefs.edit().putString(KEY_ITEMS, ReminderPolicy.encode(items)).apply()
    }

    private companion object {
        /** SharedPreferences 文件名 */
        const val PREFS_NAME = "arkli_alarms"

        /** 记录键 */
        const val KEY_ITEMS = "items"
    }
}
