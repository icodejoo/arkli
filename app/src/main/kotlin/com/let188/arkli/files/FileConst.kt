package com.let188.arkli.files

/** 文件相关的共用常量：目录名、上限、保留期。取值依据见 docs/design/platform-infrastructure.md 第六节与 bridge-protocol.md */
object FileConst {
    /** 页面路径前缀：缓存产物，对应 `cacheDir/arkli/` */
    const val PREFIX_CACHE = "cache"

    /** 页面路径前缀：数据包，对应 `filesDir/packs/`，只读 */
    const val PREFIX_PACKS = "packs"

    /** PathHandler 的 URL 路径前缀，其后接 [PREFIX_CACHE] 或 [PREFIX_PACKS] */
    const val URL_PREFIX = "/files/"

    /** 缓存根目录名（位于 cacheDir 下） */
    const val CACHE_ROOT_DIR = "arkli"

    /** 数据包根目录名（位于 filesDir 下） */
    const val PACKS_ROOT_DIR = "packs"

    /** 选图结果目录（缓存根下） */
    const val DIR_PICK = "pick"

    /** 写入完成的产物目录（缓存根下） */
    const val DIR_OUT = "out"

    /** 未关闭写句柄的临时文件目录（缓存根下） */
    const val DIR_TMP = "tmp"

    /** 临时文件后缀 */
    const val PART_SUFFIX = ".part"

    /** 分块写入：单块字节数上限（1MB） */
    const val CHUNK_BYTES = 1 shl 20

    /** 分块写入：单个文件字节数上限（256MB） */
    const val MAX_WRITE_BYTES = 256L shl 20

    /** 同一会话同时打开的写句柄上限 */
    const val MAX_OPEN_WRITES = 8

    /** 写句柄空闲超时：超过则视为被遗弃，清掉（10 分钟） */
    const val WRITE_IDLE_MS = 10 * 60 * 1000L

    /** 缓存保留期：超过则删（24 小时） */
    const val CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000L

    /** 缓存总量上限（500MB），超限从最旧的删 */
    const val CACHE_MAX_TOTAL_BYTES = 500L shl 20

    /** 超限清理时，最近这段时间内写入的文件不动（10 分钟），免得删掉页面刚拿到的产物 */
    const val CACHE_KEEP_RECENT_MS = 10 * 60 * 1000L

    /** 空闲清理时，孤儿临时文件的最短存活时间（1 小时）；启动时清理不设此限 */
    const val PART_ORPHAN_AGE_MS = 60 * 60 * 1000L

    /** 手动清空缓存时的保护期：这段时间内修改过的文件视为正在使用，跳过（1 分钟） */
    const val CLEAR_BUSY_MS = 60 * 1000L

    /** 两次空闲清理的最小间隔（10 分钟） */
    const val CLEANUP_MIN_INTERVAL_MS = 10 * 60 * 1000L

    /** 不透明句柄前缀 */
    const val HANDLE_PREFIX = "uri:"

    /** 不透明句柄表容量，满了淘汰最旧的 */
    const val MAX_OPAQUE_HANDLES = 256

    /** 一次选择最多返回的文件数（页面没传 max 时的默认值） */
    const val DEFAULT_PICK_MAX = 20

    /** 一次选择最多返回的文件数上限 */
    const val PICK_MAX_LIMIT = 50

    /** 非媒体文件（走文档选择器）拷进缓存的大小上限（64MB） */
    const val MAX_PICK_COPY_BYTES = 64L shl 20

    /** 图片拷进缓存的大小上限（128MB）；HEIC 另受解码像素限制 */
    const val MAX_PICK_IMAGE_BYTES = 128L shl 20

    /** 拷贝文件用的缓冲区大小（64KB） */
    const val COPY_BUF_BYTES = 64 * 1024

    /** 随机文件名、句柄 id 用的随机字节数 */
    const val RANDOM_ID_BYTES = 8

    /** 图片通配 mime，选择器默认值与 [PickKind] 判断共用 */
    const val MIME_IMAGE = "image/*"

    /** HEIC 转 JPEG 的 JPEG 质量 */
    const val JPEG_QUALITY = 92

    /** HEIC 解码的像素上限，超过则按采样率缩小，防 OOM（约 2500 万像素） */
    const val HEIC_MAX_DECODE_PIXELS = 25_000_000L

    /** 保存到公共目录时的子目录名 */
    const val SAVE_SUBDIR = "Arkli"

    /** 帧编码：每字符一字节（latin1），默认 */
    const val ENCODING_LATIN1 = "latin1"

    /** 帧编码：base64，兜底 */
    const val ENCODING_BASE64 = "base64"

    /** 拼图成品文件名前缀（位于 out/ 下）；启动清理与 discard 的缩略图联动以此识别本功能产物 */
    const val OUT_STITCH_PREFIX = "stitch_"

    /** 拼图缩略图文件名前缀，同样以 [OUT_STITCH_PREFIX] 开头 */
    const val OUT_STITCH_THUMB_PREFIX = "stitch_thumb_"
}
