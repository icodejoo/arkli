package com.let188.arkli.files

/**
 * 覆盖原图的纯判断：格式是否一致、从选图 URI 里认出 MediaStore 图片 id。无 Android 依赖，可在 JVM 单测。
 *
 * 使用示例：
 * ```
 * OverwritePolicy.sameFormat("image/jpeg", "out.jpg")   // true
 * OverwritePolicy.mediaId("content://com.android.providers.media.documents/document/image%3A47")   // 47
 * ```
 */
object OverwritePolicy {
    /** 相册文档提供者 URI：`.../document/image:<id>`（冒号可能被编码成 %3A） */
    private val DOCUMENT_RE = Regex("^content://com\\.android\\.providers\\.media\\.documents/(?:tree/[^/]+/)?document/image(?:%3A|%3a|:)(\\d+)$")

    /** Photo Picker URI：`content://media/picker/<user>/<authority>/media/<id>` */
    private val PICKER_RE = Regex("^content://media/picker/\\d+/[^/]+/media/(\\d+)$")

    /** MediaStore 图片 URI：`content://media/<volume>/images/media/<id>` */
    private val MEDIA_RE = Regex("^content://media/[^/]+/images/media/(\\d+)$")

    /**
     * 把 mime 归一成小写主类型，并合并常见别名。
     *
     * @param mime 原始 mime，可含参数
     * @return 归一后的 mime；空返回 null
     */
    fun normalize(mime: String?): String? {
        val m = mime?.substringBefore(';')?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        return when (m) {
            "image/jpg", "image/pjpeg" -> "image/jpeg"
            "image/x-png" -> "image/png"
            else -> m
        }
    }

    /**
     * 按文件名扩展名给出图片 mime。
     *
     * @param name 文件名
     * @return mime；扩展名不认识返回 null
     */
    fun mimeOfName(name: String): String? = when (name.substringAfterLast('.', "").lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "bmp" -> "image/bmp"
        else -> null
    }

    /**
     * 要写入的文件与原图格式是否一致。任一方认不出都算不一致。
     *
     * @param srcMime 原图 mime（来自内容解析器）
     * @param fileName 要写入的缓存文件名
     * @return 一致返回 true
     */
    fun sameFormat(srcMime: String?, fileName: String): Boolean {
        val a = normalize(srcMime) ?: return false
        val b = mimeOfName(fileName) ?: return false
        return a == b
    }

    /**
     * 从选图 URI 字符串里认出 MediaStore 图片 id，认不出返回 null。
     * 支持相册文档 URI、Photo Picker URI（取末段 id，真机未验证，写入前由调用方核对文件名兜底）与 MediaStore 原生 URI。
     *
     * @param uri URI 字符串
     * @return MediaStore `_id`
     */
    fun mediaId(uri: String): Long? =
        (DOCUMENT_RE.find(uri) ?: PICKER_RE.find(uri) ?: MEDIA_RE.find(uri))?.groupValues?.get(1)?.toLongOrNull()
}
