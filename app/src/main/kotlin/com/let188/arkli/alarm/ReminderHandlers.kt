package com.let188.arkli.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.content.ContextCompat
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.requireMainFrame
import com.let188.arkli.system.SystemParams
import org.json.JSONObject

/**
 * `native.notify.show`：`{ id?: number, title: string, text?: string }` -> `{ shown: true, id: number }`。
 * 没有通知授权（API 33+ 未授予，或用户在系统里关了通知）抛 PERMISSION_DENIED。
 *
 * @param context 应用上下文
 * @param notifier 通知发送器
 */
internal class NotifyShowHandler(private val context: Context, private val notifier: ReminderNotifier) : BridgeHandler {
    /** 校验后立即发通知 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val idValue = params.opt("id")
        val id = if (idValue == null || idValue == JSONObject.NULL) null else SystemParams.number(params, "id")
        val spec = SystemParams.validated {
            ReminderPolicy.parseNotify(id, SystemParams.string(params, "title"), SystemParams.stringOrNull(params, "text"), System.currentTimeMillis())
        }
        requireNotifyPermission(context, notifier)
        notifier.show(spec.notificationId, spec.title, spec.text)
        return JSONObject().put("shown", true).put("id", spec.notificationId)
    }
}

/** 没有通知授权就抛 PERMISSION_DENIED，提示去授权 */
internal fun requireNotifyPermission(context: Context, notifier: ReminderNotifier) {
    val runtimeDenied = ReminderPolicy.needsRuntimePermission(Build.VERSION.SDK_INT) &&
        ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    if (runtimeDenied || !notifier.canNotify()) {
        throw BridgeException(BridgeErrors.PERMISSION_DENIED, "没有通知权限，请先授权或在系统设置里打开通知")
    }
}

/**
 * 闹钟调度：封装 AlarmManager 的设置与取消，PendingIntent 按 id 区分。
 *
 * @param context 应用上下文
 * @param store 待触发记录
 */
internal class AlarmScheduler(private val context: Context, private val store: AlarmStore) {
    /** 系统闹钟服务 */
    private val manager: AlarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    /** 用 setAlarmClock 设闹钟（无需精确闹钟权限，状态栏会显示闹钟图标）并记录 */
    fun set(entry: AlarmEntry) {
        val showIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?.let { PendingIntent.getActivity(context, 0, it, FLAGS) }
        store.put(entry)
        try {
            manager.setAlarmClock(AlarmManager.AlarmClockInfo(entry.atEpochMs, showIntent), pendingOf(entry.id))
        } catch (e: SecurityException) {
            // 精确闹钟权限被收回时降级为非精确闹钟，仍在 Doze 下触发
            try {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, entry.atEpochMs, pendingOf(entry.id))
            } catch (e2: SecurityException) {
                store.remove(entry.id)
                throw BridgeException(BridgeErrors.PERMISSION_DENIED, "系统拒绝设置闹钟：${e2.message}")
            }
        }
    }

    /** 取消闹钟并删记录；返回记录原先是否存在 */
    fun cancel(id: String): Boolean {
        manager.cancel(pendingOf(id))
        return store.remove(id)
    }

    /** 同 id 总是得到等价的 PendingIntent（靠 data URI 区分） */
    private fun pendingOf(id: String): PendingIntent {
        val intent = Intent(context, AlarmReceiver::class.java)
            .setData(Uri.fromParts(AlarmReceiver.SCHEME, id, null))
            .putExtra(AlarmReceiver.EXTRA_ID, id)
        return PendingIntent.getBroadcast(context, 0, intent, FLAGS)
    }

    private companion object {
        /** PendingIntent 标志：不可变、同一个就更新 */
        const val FLAGS = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    }
}

/**
 * `native.alarm.set`：`{ id, atEpochMs, title, text? }` -> `{ set: true }`。
 * 时刻必须在未来且不超过一年；同 id 再设会覆盖。设备重启后闹钟失效（不做开机恢复）。
 *
 * @param scheduler 闹钟调度器
 */
internal class AlarmSetHandler(private val scheduler: AlarmScheduler) : BridgeHandler {
    /** 校验后设闹钟 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val entry = SystemParams.validated {
            ReminderPolicy.parseAlarm(
                SystemParams.string(params, "id"), SystemParams.number(params, "atEpochMs"),
                SystemParams.string(params, "title"), SystemParams.stringOrNull(params, "text"), System.currentTimeMillis(),
            )
        }
        scheduler.set(entry)
        return JSONObject().put("set", true)
    }
}

/**
 * `native.alarm.cancel`：`{ id }` -> `{ cancelled: boolean }`，记录不存在时为 false，不报错。
 *
 * @param scheduler 闹钟调度器
 */
internal class AlarmCancelHandler(private val scheduler: AlarmScheduler) : BridgeHandler {
    /** 取消闹钟 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val id = SystemParams.validated { ReminderPolicy.cleanAlarmId(SystemParams.string(params, "id")) }
        return JSONObject().put("cancelled", scheduler.cancel(id))
    }
}

/**
 * `native.alarm.list`：无参 -> `{ items: [{ id, atEpochMs, title, text }] }`，按触发时间升序，已失效的不列出。
 *
 * @param store 待触发记录
 */
internal class AlarmListHandler(private val store: AlarmStore) : BridgeHandler {
    /** 列出待触发提醒 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val items = ReminderPolicy.active(store.all(), System.currentTimeMillis())
        return JSONObject().put("items", ReminderPolicy.toJson(items))
    }
}
