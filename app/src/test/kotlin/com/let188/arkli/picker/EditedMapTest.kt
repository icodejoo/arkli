package com.let188.arkli.picker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/** [PickState] 的替换、顺序、还原、上限逻辑 */
class EditedMapTest {
    /** 已选图编辑后保持原位置，最终列表用编辑后地址 */
    @Test
    fun editKeepsOrder() {
        val s = PickState<Long, String>(listOf(1L, 2L, 3L)).applyEdit(2L, "e2", 5)
        assertEquals(listOf(1L, 2L, 3L), s.selected)
        assertEquals(listOf("o1", "e2", "o3"), s.resolve { "o$it" })
    }

    /** 未选的图编辑后自动选中，排在末尾 */
    @Test
    fun editAutoSelects() {
        val s = PickState<Long, String>(listOf(1L)).applyEdit(7L, "e7", 5)
        assertEquals(listOf(1L, 7L), s.selected)
    }

    /** 重复编辑取最新 */
    @Test
    fun repeatEditTakesLatest() {
        val s = PickState<Long, String>().applyEdit(1L, "a", 3).applyEdit(1L, "b", 3)
        assertEquals("b", s.current(1L, "orig"))
        assertEquals(listOf(1L), s.selected)
    }

    /** 还原后回到原图，仍保持选中 */
    @Test
    fun restoreBringsBackOriginal() {
        val s = PickState<Long, String>().applyEdit(1L, "a", 3).restore(1L)
        assertEquals("orig", s.current(1L, "orig"))
        assertEquals(listOf(1L), s.selected)
        assertSame(s, s.restore(1L))
    }

    /** 已满时未选的图只记映射，不自动选中 */
    @Test
    fun fullSelectionNotExceeded() {
        val s = PickState<Long, String>(listOf(1L, 2L)).applyEdit(9L, "e9", 2)
        assertEquals(listOf(1L, 2L), s.selected)
        assertEquals("e9", s.current(9L, "o"))
    }

    /** 取消（null）不改变任何状态 */
    @Test
    fun cancelKeepsState() {
        val s = PickState<Long, String>(listOf(1L), mapOf(1L to "a"))
        assertSame(s, s.applyEdit(1L, null, 3))
        assertSame(s, s.applyEdit(5L, null, 3))
    }

    /** resolve 跳过取不到原图的项 */
    @Test
    fun resolveSkipsMissing() {
        val s = PickState<Long, String>(listOf(1L, 2L))
        assertEquals(listOf("o2"), s.resolve { if (it == 2L) "o2" else null })
    }
}
