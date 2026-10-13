package com.let188.arkli.files

import java.security.SecureRandom

/** 文件名清洗与 mime 推断，纯函数 */
object FileNames {
    /** 文件名长度上限（含扩展名） */
    private const val MAX_NAME = 120

    /** 清洗后名字为空时的兜底 */
    private const val FALLBACK = "file"

    /** 文件名里不允许的字符，统一换成下划线 */
    private val ILLEGAL = Regex("[\\u0000-\\u001f<>:\"|?*]")

    /** 常见 mime 与扩展名对照 */
    private val MIME_EXT = mapOf(
        "image/jpeg" to "jpg", "image/png" to "png", "image/webp" to "webp", "image/gif" to "gif",
        "image/bmp" to "bmp", "image/avif" to "avif", "image/heic" to "heic", "image/heif" to "heif",
        "video/mp4" to "mp4", "video/webm" to "webm", "video/quicktime" to "mov", "video/3gpp" to "3gp",
        "audio/mpeg" to "mp3", "audio/mp4" to "m4a", "audio/wav" to "wav", "audio/ogg" to "ogg",
        "text/plain" to "txt", "text/csv" to "csv", "application/json" to "json", "application/zip" to "zip",
    )

    /**
     * 清洗文件名：去掉路径部分、控制字符与非法字符，限长并保留扩展名。
     *
     * @param name 原始名字，可为 null
     * @return 可安全落盘的文件名，不会为空、不含路径分隔符
     */
    fun sanitize(name: String?): String {
        var s = (name ?: "").substringAfterLast('/').substringAfterLast('\\')
        s = ILLEGAL.replace(s, "_").trim().trim('.')
        if (s.isEmpty()) return FALLBACK
        if (s.length > MAX_NAME) {
            val dot = s.lastIndexOf('.')
            val ext = if (dot > 0 && s.length - dot <= 10) s.substring(dot) else ""
            s = s.substring(0, MAX_NAME - ext.length) + ext
        }
        return s
    }

    /**
     * mime 对应的常用扩展名。
     *
     * @param mime mime 类型，可为 null
     * @return 不带点的扩展名；不认识返回 null
     */
    fun extForMime(mime: String?): String? = mime?.lowercase()?.substringBefore(';')?.trim()?.let { MIME_EXT[it] }

    /**
     * 名字缺扩展名时按 mime 补上。
     *
     * @param name 已清洗的名字
     * @param mime mime 类型，可为 null
     * @return 带扩展名的名字（mime 不认识则原样返回）
     */
    fun withExt(name: String, mime: String?): String {
        if (name.substringAfterLast('.', "").isNotEmpty() && name.contains('.')) return name
        val ext = extForMime(mime) ?: return name
        return "$name.$ext"
    }

    /**
     * 把名字的扩展名换成指定的。
     *
     * @param name 原名
     * @param ext 新扩展名，不带点
     * @return 新名字，如 `IMG_1.HEIC` -> `IMG_1.jpg`
     */
    fun replaceExt(name: String, ext: String): String {
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        return "$base.$ext"
    }

    /**
     * 在目录里挑一个不冲突的文件名，冲突时在扩展名前加 ` (1)`、` (2)`。
     *
     * @param dir 目标目录
     * @param name 已清洗的文件名
     * @return 目录里尚不存在的文件（不创建）
     */
    fun unique(dir: java.io.File, name: String): java.io.File {
        var f = java.io.File(dir, name)
        if (!f.exists()) return f
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var i = 1
        while (f.exists()) f = java.io.File(dir, "$base ($i)$ext").also { i++ }
        return f
    }

    /**
     * 是否 HEIC/HEIF 系列。
     *
     * @param mime mime 类型，可为 null
     * @return 是返回 true
     */
    fun isHeif(mime: String?): Boolean {
        val m = mime?.lowercase() ?: return false
        return m.startsWith("image/heic") || m.startsWith("image/heif")
    }
}

/** 页面帧数据解码：latin1（每字符一字节）与 base64 */
object FrameCodec {
    /**
     * 解码一块数据。
     *
     * @param encoding `latin1` 或 `base64`
     * @param data 页面发来的字符串
     * @param base64 base64 解码函数；Android 上用 android.util.Base64，测试可换 java.util.Base64
     * @return 原始字节
     * @throws IllegalArgumentException 编码名不认识、latin1 里含大于 0xFF 的字符、base64 非法
     */
    fun decode(encoding: String, data: String, base64: (String) -> ByteArray): ByteArray = when (encoding) {
        FileConst.ENCODING_LATIN1 -> {
            val out = ByteArray(data.length)
            for (i in data.indices) {
                val c = data[i].code
                require(c <= 0xFF) { "latin1 帧含大于 0xFF 的字符，位置 $i" }
                out[i] = c.toByte()
            }
            out
        }
        FileConst.ENCODING_BASE64 -> base64(data)
        else -> throw IllegalArgumentException("不支持的 encoding：$encoding")
    }
}

/**
 * 不透明句柄表：页面只拿到 `uri:<随机 id>`，真实对象（如 content URI）只留在原生侧。
 * 满容量时淘汰最旧的。线程安全。
 *
 * 使用示例：`val h = table.put(uri)`，之后 `table.get(h)`。
 *
 * @param T 句柄背后的对象类型
 * @param capacity 容量上限
 */
class HandleTable<T : Any>(private val capacity: Int = FileConst.MAX_OPAQUE_HANDLES) {
    /** 按插入顺序保存，便于淘汰最旧项 */
    private val map = LinkedHashMap<String, T>()

    /** 安全随机源 */
    private val random = SecureRandom()

    /**
     * 登记一个对象。
     *
     * @param value 要隐藏的对象
     * @return 不透明句柄，形如 `uri:3fa9…`
     */
    @Synchronized
    fun put(value: T): String {
        val b = ByteArray(ID_BYTES)
        random.nextBytes(b)
        val id = FileConst.HANDLE_PREFIX + b.joinToString("") { "%02x".format(it) }
        map[id] = value
        while (map.size > capacity) map.remove(map.keys.first())
        return id
    }

    /**
     * 查对象。
     *
     * @param handle 句柄
     * @return 对象；句柄不存在返回 null
     */
    @Synchronized
    fun get(handle: String): T? = map[handle]

    /**
     * 登记数。
     *
     * @return 当前句柄数
     */
    @Synchronized
    fun size(): Int = map.size

    /** 清空，会话关闭时调用 */
    @Synchronized
    fun clear() = map.clear()

    private companion object {
        /** 句柄随机字节数 */
        const val ID_BYTES = 12
    }
}

/** 选择器种类：决定走 Photo Picker 还是系统文档选择器 */
enum class PickKind {
    /** 只选图片（Photo Picker） */
    IMAGE,

    /** 只选视频（Photo Picker） */
    VIDEO,

    /** 图片和视频都可（Photo Picker） */
    IMAGE_VIDEO,

    /** 指定的单个媒体 mime，如 `image/png`（Photo Picker） */
    SINGLE_MEDIA,

    /** 其他文件，走系统文档选择器（SAF） */
    DOCUMENT;

    companion object {
        /** 图片与视频并列的写法：image 通配加逗号加 video 通配 */
        const val MIME_IMAGE_VIDEO = "image/*,video/*"

        /** mime 的基本格式，防止乱传 */
        private val MIME_RE = Regex("""^(\*|[\w.+-]+)/(\*|[\w.+*-]+)$""")

        /**
         * 校验 mime 参数是否合法。
         *
         * @param mime 页面传来的 mime 过滤
         * @return 合法返回 true
         */
        fun isValid(mime: String): Boolean = mime == MIME_IMAGE_VIDEO || MIME_RE.matches(mime)

        /**
         * 由 mime 过滤决定选择器种类。
         *
         * @param mime 如 image 通配、video 通配、两者逗号并列（见 [MIME_IMAGE_VIDEO]）、`image/png`、`text/plain`、全通配
         * @return 选择器种类
         */
        fun of(mime: String): PickKind = when {
            mime == FileConst.MIME_IMAGE -> IMAGE
            mime == "video/*" -> VIDEO
            mime == MIME_IMAGE_VIDEO -> IMAGE_VIDEO
            mime.startsWith("image/") || mime.startsWith("video/") -> SINGLE_MEDIA
            else -> DOCUMENT
        }
    }
}
