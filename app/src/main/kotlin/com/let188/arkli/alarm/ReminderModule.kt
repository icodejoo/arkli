package com.let188.arkli.alarm

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.FileEnv

/**
 * 把提醒方法注册进一个会话的 Bridge：立即通知、闹钟设置 / 取消 / 列表。
 * 契约见 docs/design/bridge-protocol.md「提醒方法」。
 *
 * 使用示例：`ReminderModule.install(bridge, env)`
 */
object ReminderModule {
    /** 方法名：立即发通知 */
    const val METHOD_NOTIFY_SHOW = "native.notify.show"

    /** 方法名：设闹钟 */
    const val METHOD_ALARM_SET = "native.alarm.set"

    /** 方法名：取消闹钟 */
    const val METHOD_ALARM_CANCEL = "native.alarm.cancel"

    /** 方法名：列出待触发闹钟 */
    const val METHOD_ALARM_LIST = "native.alarm.list"

    /**
     * 注册提醒方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取应用上下文
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        val context = env.appContext
        val notifier = ReminderNotifier(context)
        val store = AlarmStore(context)
        val scheduler = AlarmScheduler(context, store)
        bridge.register(METHOD_NOTIFY_SHOW, NotifyShowHandler(context, notifier))
        bridge.register(METHOD_ALARM_SET, AlarmSetHandler(scheduler))
        bridge.register(METHOD_ALARM_CANCEL, AlarmCancelHandler(scheduler))
        bridge.register(METHOD_ALARM_LIST, AlarmListHandler(store))
    }
}
