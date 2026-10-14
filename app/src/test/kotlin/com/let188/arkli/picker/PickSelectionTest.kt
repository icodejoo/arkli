package com.let188.arkli.picker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 选中顺序逻辑的单测 */
class PickSelectionTest {
    /** 新增追加到末尾 */
    @Test
    fun toggleAppends() {
        assertEquals(listOf(1L, 2L, 3L), PickSelection.toggle(listOf(1L, 2L), 3L, 3))
    }

    /** 再点一次取消，其余保持顺序 */
    @Test
    fun toggleRemoves() {
        assertEquals(listOf(1L, 3L), PickSelection.toggle(listOf(1L, 2L, 3L), 2L, 3))
    }

    /** 已满时新增返回 null，但已选的仍可取消 */
    @Test
    fun fullRejectsNewButAllowsRemove() {
        assertNull(PickSelection.toggle(listOf(1L, 2L), 3L, 2))
        assertEquals(listOf(1L), PickSelection.toggle(listOf(1L, 2L), 2L, 2))
    }

    /** 序号从 1 起，未选为 0 */
    @Test
    fun orderOfIsOneBased() {
        assertEquals(2, PickSelection.orderOf(listOf(5L, 7L), 7L))
        assertEquals(0, PickSelection.orderOf(listOf(5L, 7L), 9L))
    }

    /** 缩略图采样倍数至少为 1 */
    @Test
    fun sampleSizeAtLeastOne() {
        assertEquals(1, MediaImages.sampleSize(100, 320))
        assertEquals(4, MediaImages.sampleSize(1280, 320))
    }
}
