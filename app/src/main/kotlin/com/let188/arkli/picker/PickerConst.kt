package com.let188.arkli.picker

/** 自带选图页的常量 */
internal object PickerConst {
    /** 意图参数：最多可选张数 */
    const val EXTRA_MAX = "max"

    /** 意图参数：是否显示悬浮拍照按钮 */
    const val EXTRA_CAMERA = "camera"

    /** 意图参数：要选的媒体种类（[PickerMedia] 的名字） */
    const val EXTRA_MEDIA = "media"

    /** 意图参数：选图页允许的编辑模式列表 */
    const val EXTRA_PICK_EDIT_MODES = "pick_edit_modes"

    /** 结果参数：已选图片 URI 列表 */
    const val EXTRA_URIS = "uris"

    /** 结果码：相册权限被拒（自定义，需 ≥ RESULT_FIRST_USER） */
    const val RESULT_DENIED = 1

    /** 结果码：点击拍照按钮切回拍照 */
    const val RESULT_CAMERA = 2

    /** 没传上限时的默认张数 */
    const val DEFAULT_MAX = 20

    /** 网格列数 */
    const val GRID_COLUMNS = 3

    /** 缩略图目标边长（像素） */
    const val THUMB_PX = 320

    /** 全屏浏览的图片目标短边（像素）：够清晰又不把大图整张解码进内存 */
    const val PREVIEW_PX = 1200

    /** 缩略图缓存占应用堆内存的比例分母（1/8） */
    const val CACHE_HEAP_DIVISOR = 8

    /** 编辑页意图参数：待编辑图片 URI */
    const val EXTRA_EDIT_URI = "edit_uri"

    /** 编辑页意图参数：启用的编辑模式列表 */
    const val EXTRA_EDIT_MODES = "edit_modes"

    /** 编辑页结果参数：导出图片 URI */
    const val EXTRA_EDIT_RESULT = "edit_result"

    /** 编辑模式：裁剪 */
    const val MODE_CROP = "crop"

    /** 编辑模式：旋转与翻转 */
    const val MODE_ROTATE = "rotate"

    /** 编辑模式：预设形状裁剪（圆形、心形等） */
    const val MODE_SHAPE = "shape"

    /** 编辑模式：手绘套索 */
    const val MODE_LASSO = "lasso"

    /** 编辑结果在 pick 缓存目录下的子目录名 */
    const val EDIT_DIR = "edit"

    /** 编辑导出图片的最长边上限（像素），防大图 OOM */
    const val EDIT_EXPORT_MAX_EDGE = 4096

    /** 编辑页相对适配缩放的最小倍数（允许缩小到 0.25 倍） */
    const val EDIT_MIN_ZOOM = 0.25f

    /** 编辑画布左右内边距（dp），让手柄离开系统手势区 */
    const val EDIT_CANVAS_PAD_DP = 24

    /** 系统手势排除带宽度（dp），贴屏幕左右边缘 */
    const val EDIT_GESTURE_BAND_DP = 48

    /** 系统手势排除带高度（dp），系统每侧总上限约 200dp */
    const val EDIT_GESTURE_BAND_HEIGHT_DP = 200

    /** 图片平移时至少留在画布内的长度（dp），防止图被拖丢 */
    const val EDIT_MIN_VISIBLE_DP = 48
}
