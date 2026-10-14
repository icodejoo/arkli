package com.let188.arkli.alarm

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * 发提醒通知：建渠道、点击回到 App。
 *
 * @param context 应用上下文
 */
internal class ReminderNotifier(private val context: Context) {
    /**
     * 当前是否允许发通知（API 33+ 看运行时授权，其余看用户是否在系统里关了通知）。
     *
     * @return 允许返回 true
     */
    fun canNotify(): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()

    /**
     * 立即发一条通知；点击回到 App。调用方应先确认 [canNotify]。
     *
     * @param notificationId 通知 id，同 id 会覆盖
     * @param title 标题
     * @param text 正文，空串则不显示
     */
    @SuppressLint("MissingPermission")
    fun show(notificationId: Int, title: String, text: String) {
        ensureChannel()
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val tap = launch?.let { PendingIntent.getActivity(context, notificationId, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
        if (text.isNotEmpty()) builder.setContentText(text).setStyle(NotificationCompat.BigTextStyle().bigText(text))
        if (tap != null) builder.setContentIntent(tap)
        NotificationManagerCompat.from(context).notify(notificationId, builder.build())
    }

    /** API 26+ 需要渠道，已存在时重复创建无副作用 */
    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH)
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        /** 通知渠道 id */
        const val CHANNEL_ID = "arkli_reminder"

        /** 通知渠道名（系统设置里可见） */
        private const val CHANNEL_NAME = "提醒"
    }
}
