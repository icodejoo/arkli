package com.let188.arkli.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 闹钟到点后的接收器（清单里 exported=false）：取出记录、发通知、删掉记录。
 * 设备重启后系统会丢掉闹钟，这里不做开机恢复。
 */
class AlarmReceiver : BroadcastReceiver() {
    /** 收到闹钟广播；记录不存在（已取消）则忽略 */
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val store = AlarmStore(context)
        val entry = store.get(id) ?: return
        store.remove(id)
        val notifier = ReminderNotifier(context)
        if (notifier.canNotify()) notifier.show(ReminderPolicy.notificationIdOf(id), entry.title, entry.text)
    }

    companion object {
        /** Intent 里携带闹钟标识的键 */
        const val EXTRA_ID = "alarm_id"

        /** 闹钟 Intent 的 data scheme，让不同 id 的 PendingIntent 互不相同 */
        const val SCHEME = "arkli-alarm"
    }
}
