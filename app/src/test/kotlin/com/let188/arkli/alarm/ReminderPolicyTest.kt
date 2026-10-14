package com.let188.arkli.alarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** 提醒的参数校验与存储编解码 */
class ReminderPolicyTest {
    /** 固定的"现在" */
    private val now = 1_700_000_000_000L

    @Test
    fun notifyTrimsAndDefaultsId() {
        val spec = ReminderPolicy.parseNotify(null, "  喝水 ", null, now)
        assertEquals("喝水", spec.title)
        assertEquals("", spec.text)
        assertEquals((now % Int.MAX_VALUE).toInt(), spec.notificationId)
        assertEquals(7, ReminderPolicy.parseNotify(7.0, "a", "b", now).notificationId)
    }

    @Test
    fun notifyRejectsBadInput() {
        assertThrows(IllegalArgumentException::class.java) { ReminderPolicy.parseNotify(null, "  ", null, now) }
        assertThrows(IllegalArgumentException::class.java) { ReminderPolicy.parseNotify(1.5, "a", null, now) }
        assertThrows(IllegalArgumentException::class.java) { ReminderPolicy.parseNotify(-1.0, "a", null, now) }
        assertThrows(IllegalArgumentException::class.java) { ReminderPolicy.parseNotify(null, "a".repeat(101), null, now) }
        assertThrows(IllegalArgumentException::class.java) { ReminderPolicy.parseNotify(null, "a", "b".repeat(501), now) }
    }

    @Test
    fun alarmMustBeFutureAndWithinOneYear() {
        val ok = ReminderPolicy.parseAlarm("a1", (now + 1000).toDouble(), "t", "x", now)
        assertEquals(AlarmEntry("a1", now + 1000, "t", "x"), ok)
        assertThrows(IllegalArgumentException::class.java) { ReminderPolicy.parseAlarm("a1", now.toDouble(), "t", null, now) }
        assertThrows(IllegalArgumentException::class.java) { ReminderPolicy.parseAlarm("a1", (now - 5).toDouble(), "t", null, now) }
        assertThrows(IllegalArgumentException::class.java) {
            ReminderPolicy.parseAlarm("a1", (now + ReminderPolicy.MAX_AHEAD_MS + 1).toDouble(), "t", null, now)
        }
        ReminderPolicy.parseAlarm("a1", (now + ReminderPolicy.MAX_AHEAD_MS).toDouble(), "t", null, now)
        assertThrows(IllegalArgumentException::class.java) { ReminderPolicy.parseAlarm("a1", Double.NaN, "t", null, now) }
        assertThrows(IllegalArgumentException::class.java) { ReminderPolicy.parseAlarm("a1", now + 1000.5, "t", null, now) }
    }

    @Test
    fun alarmIdRules() {
        assertEquals("x", ReminderPolicy.cleanAlarmId(" x "))
        assertThrows(IllegalArgumentException::class.java) { ReminderPolicy.cleanAlarmId("") }
        assertThrows(IllegalArgumentException::class.java) { ReminderPolicy.cleanAlarmId("a".repeat(65)) }
        assertThrows(IllegalArgumentException::class.java) { ReminderPolicy.cleanAlarmId("a\nb") }
    }

    @Test
    fun notificationIdIsStableAndNonNegative() {
        assertEquals(ReminderPolicy.notificationIdOf("abc"), ReminderPolicy.notificationIdOf("abc"))
        assertTrue(ReminderPolicy.notificationIdOf("polygenelubricants") >= 0)
        assertTrue(ReminderPolicy.notificationIdOf("") >= 0)
    }

    @Test
    fun activeDropsExpiredAndSorts() {
        val items = listOf(
            AlarmEntry("late", now + 5000, "t", ""),
            AlarmEntry("old", now - ReminderPolicy.EXPIRE_GRACE_MS - 1, "t", ""),
            AlarmEntry("soon", now + 10, "t", ""),
            AlarmEntry("justPassed", now - 1000, "t", ""),
        )
        assertEquals(listOf("justPassed", "soon", "late"), ReminderPolicy.active(items, now).map { it.id })
    }

    @Test
    fun encodeDecodeRoundTrip() {
        val items = listOf(AlarmEntry("a", 123, "标题", "正文 \"引号\""), AlarmEntry("b", 456, "t", ""))
        assertEquals(items, ReminderPolicy.decode(ReminderPolicy.encode(items)))
    }

    @Test
    fun decodeToleratesGarbage() {
        assertTrue(ReminderPolicy.decode(null).isEmpty())
        assertTrue(ReminderPolicy.decode("").isEmpty())
        assertTrue(ReminderPolicy.decode("{not json").isEmpty())
        val mixed = ReminderPolicy.decode("""[1, {"id":"","atEpochMs":1}, {"id":"ok","atEpochMs":9}, {"id":"noTime"}]""")
        assertEquals(listOf("ok"), mixed.map { it.id })
    }

    @Test
    fun runtimePermissionStartsAt33() {
        assertFalse(ReminderPolicy.needsRuntimePermission(32))
        assertTrue(ReminderPolicy.needsRuntimePermission(33))
    }

    @Test
    fun toJsonUsesContractFields() {
        val arr = ReminderPolicy.toJson(listOf(AlarmEntry("a", 5, "t", "x")))
        val o = arr.getJSONObject(0)
        assertEquals("a", o.getString("id"))
        assertEquals(5L, o.getLong("atEpochMs"))
        assertEquals("x", o.getString("text"))
    }
}
