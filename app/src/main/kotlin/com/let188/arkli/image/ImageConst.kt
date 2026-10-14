package com.let188.arkli.image

/** 原生图片压缩用到的常量：参数范围、上限、事件名。与 docs/design/tools/image.md 对齐 */
object ImageConst {
    /** 一次调用最多处理的图片数 */
    const val MAX_ITEMS = 50

    /** 默认质量（jpeg/webp） */
    const val DEFAULT_QUALITY = 80

    /** 质量下限 */
    const val MIN_QUALITY = 1

    /** 质量上限 */
    const val MAX_QUALITY = 100

    /** maxEdge 下限 */
    const val MIN_EDGE = 64

    /** maxEdge 上限 */
    const val MAX_EDGE = 16384

    /** 调色板颜色数下限 */
    const val MIN_COLORS = 2

    /** 调色板颜色数上限（也是默认值） */
    const val MAX_COLORS = 256

    /** 显示名最大长度（字符） */
    const val MAX_NAME_LEN = 120

    /** 解码后像素数上限，与 web 侧 MAX_CANVAS_PIXELS 一致 */
    const val MAX_DECODE_PIXELS = 64_000_000L

    /** PNG 路径（要把像素读成 IntArray）的像素数上限，约 64MB 的 IntArray */
    const val MAX_PNG_PIXELS = 16_000_000L

    /** 目标体积二分的最多编码次数（含上下界探测） */
    const val MAX_SEARCH_STEPS = 9

    /** 缩放时单步最大缩小倍率，超过则分步缩，避免锯齿 */
    const val SCALE_STEP_RATIO = 2

    /** 进度事件名，数据 `{ done, total, name }` */
    const val EVENT_PROGRESS = "image.progress"

    /** 成品的页面路径前缀（缓存根下的 out 目录） */
    const val OUT_PAGE_PREFIX = "cache/out"

    /** 半成品后缀 */
    const val PART_SUFFIX = ".part"

    /** JPEG 铺底色（不透明白） */
    const val JPEG_BACKGROUND = -1

    /** 输出文件名的随机后缀字节数 */
    const val ID_BYTES = 4

    /** 默认输出主名 */
    const val DEFAULT_STEM = "image"

    /** mime：jpeg */
    const val MIME_JPEG = "image/jpeg"

    /** mime：webp */
    const val MIME_WEBP = "image/webp"

    /** mime：png */
    const val MIME_PNG = "image/png"

    /** 拼接：最少张数 */
    const val STITCH_MIN_ITEMS = 2

    /** 拼接：最多张数 */
    const val STITCH_MAX_ITEMS = 20

    /** 拼接：图间距上限（像素） */
    const val STITCH_MAX_GAP = 200

    /** 拼接：JPEG 默认质量（0..1） */
    const val STITCH_DEFAULT_QUALITY = 0.92

    /** 拼接：默认背景色 */
    const val STITCH_DEFAULT_BG = "#ffffff"

    /** 拼接：画布像素数上限（约 160MB 位图），超出报 BAD_PARAMS */
    const val STITCH_MAX_PIXELS = 40_000_000L

    /** 拼接：画布单边上限（像素） */
    const val STITCH_MAX_EDGE = 30_000

    /** 进度阶段：绘制 */
    const val PHASE_DRAW = "draw"

    /** 进度阶段：编码 */
    const val PHASE_ENCODE = "encode"

    /** 进度阶段：全部完成 */
    const val PHASE_DONE = "done"

    /** 编码进度节流：最小百分比步长 */
    const val PROGRESS_MIN_STEP = 2

    /** 编码进度节流：最小上报间隔（毫秒） */
    const val PROGRESS_MIN_INTERVAL_MS = 250L

    /** 缩略图最长边（像素） */
    const val THUMB_EDGE = 256

    /** 缩略图 JPEG 质量 */
    const val THUMB_QUALITY = 80
}
