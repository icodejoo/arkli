package com.let188.arkli.picker

/**
 * 多选图片的选中顺序逻辑，纯 JVM、不依赖 android。
 * 顺序即用户点选顺序，会原样交给页面（拼接这类顺序敏感的工具直接用）。
 */
object PickSelection {
    /**
     * 点一下某张图：已选则取消，未选则追加到末尾。
     *
     * @param current 当前已选 id，按点选顺序
     * @param id 被点的图片 id
     * @param max 最多可选张数
     * @return 新的已选列表；已满且是新增时返回 null，调用方提示"最多 N 张"
     * @example
     * PickSelection.toggle(listOf(1L, 2L), 3L, 3) // [1, 2, 3]
     * PickSelection.toggle(listOf(1L, 2L, 3L), 4L, 3) // null
     */
    fun toggle(current: List<Long>, id: Long, max: Int): List<Long>? = when {
        id in current -> current - id
        current.size >= max -> null
        else -> current + id
    }

    /**
     * 某张图的选中序号。
     *
     * @param current 当前已选 id
     * @param id 图片 id
     * @return 从 1 开始的序号，未选返回 0
     */
    fun orderOf(current: List<Long>, id: Long): Int = current.indexOf(id) + 1
}
