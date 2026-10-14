package com.let188.arkli.picker

/** 自带选图页的常量 */
internal object PickerConst {
    /** 意图参数：最多可选张数 */
    const val EXTRA_MAX = "max"

    /** 结果参数：已选图片 URI 列表 */
    const val EXTRA_URIS = "uris"

    /** 结果码：相册权限被拒（自定义，需 ≥ RESULT_FIRST_USER） */
    const val RESULT_DENIED = 1

    /** 没传上限时的默认张数 */
    const val DEFAULT_MAX = 20

    /** 网格列数 */
    const val GRID_COLUMNS = 3

    /** 缩略图目标边长（像素） */
    const val THUMB_PX = 320

    /** 缩略图缓存占应用堆内存的比例分母（1/8） */
    const val CACHE_HEAP_DIVISOR = 8
}
