package com.let188.arkli.picker

/**
 * 选图页的“选中 + 已编辑”状态，纯 JVM、不依赖 android；key 是图片唯一键，U 是图片地址。
 * 不可变：每次操作返回新状态，调用方整体替换。
 *
 * @property selected 已选 key，按点选顺序
 * @property edited 原图 key 到编辑后地址的映射
 * @example
 * val s = PickState<Long, String>().applyEdit(1L, "file://a.jpg", max = 3)
 * s.selected // [1]
 */
data class PickState<K, U>(val selected: List<K> = emptyList(), val edited: Map<K, U> = emptyMap()) {
    /**
     * 应用一次编辑结果：记录映射；已选的保持原位置，未选且没满则自动选中。
     *
     * @param key 被编辑的图
     * @param uri 编辑后的地址；null 表示用户取消，状态不变
     * @param max 最多可选个数
     * @return 新状态；已满时未选的图只记映射、不自动选中
     */
    fun applyEdit(key: K, uri: U?, max: Int): PickState<K, U> {
        if (uri == null) return this
        val sel = if (key in selected || selected.size >= max) selected else selected + key
        return PickState(sel, edited + (key to uri))
    }

    /**
     * 还原某张图为原图，选中状态不变。
     *
     * @param key 要还原的图
     * @return 新状态；没编辑过则原样返回
     */
    fun restore(key: K): PickState<K, U> = if (key in edited) copy(edited = edited - key) else this

    /**
     * 某张图当前该用的地址：编辑过取编辑后的，否则取原图。
     *
     * @param key 图片 key
     * @param original 原图地址
     * @return 当前地址
     */
    fun current(key: K, original: U): U = edited[key] ?: original

    /**
     * 按选中顺序算出最终返回的地址列表。
     *
     * @param originalOf 由 key 取原图地址，取不到的项跳过
     * @return 已编辑的用编辑后地址，其余用原图
     */
    fun resolve(originalOf: (K) -> U?): List<U> = selected.mapNotNull { edited[it] ?: originalOf(it) }
}
