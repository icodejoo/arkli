package com.let188.arkli.apps

import com.let188.arkli.files.FileNames
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一个已安装应用的信息。
 *
 * @property pkg 包名
 * @property label 应用名
 * @property versionName 版本名，取不到为空串
 * @property versionCode 版本号
 * @property firstInstallMs 首次安装时间（毫秒时间戳）
 * @property lastUpdateMs 最近更新时间（毫秒时间戳）
 * @property isSystem 是否系统应用（含被更新过的系统应用）
 * @property apkBytes base APK 大小（字节），取不到为 0
 */
internal data class AppItem(
    val pkg: String,
    val label: String,
    val versionName: String,
    val versionCode: Long,
    val firstInstallMs: Long,
    val lastUpdateMs: Long,
    val isSystem: Boolean,
    val apkBytes: Long,
)

/**
 * 应用管理的参数校验、排序、文件名清洗，纯函数，可单测。
 *
 * 使用示例：`AppsPolicy.requirePackage("com.tencent.mm")`
 */
internal object AppsPolicy {
    /** 导出安装包大小上限（300MB） */
    const val MAX_APK_BYTES = 300L shl 20

    /** 图标边长下限（像素） */
    const val MIN_ICON_SIZE = 48

    /** 图标边长上限（像素） */
    const val MAX_ICON_SIZE = 192

    /** 图标边长缺省值（像素） */
    const val DEFAULT_ICON_SIZE = 96

    /** 包名长度上限 */
    private const val MAX_PKG_LENGTH = 255

    /** 包名格式：至少两段，段以字母开头 */
    private val PKG_REGEX = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")

    /**
     * 校验包名格式。
     *
     * @param pkg 页面传来的包名
     * @return 原样返回的包名
     * @throws IllegalArgumentException 格式不对
     */
    fun requirePackage(pkg: String): String {
        require(pkg.length <= MAX_PKG_LENGTH && PKG_REGEX.matches(pkg)) { "pkg 不是合法包名：$pkg" }
        return pkg
    }

    /**
     * 校验并取图标边长。
     *
     * @param size 页面传来的边长，可空；空则用缺省
     * @return 整数边长
     * @throws IllegalArgumentException 不是整数或不在 48~192
     */
    fun iconSize(size: Double?): Int {
        if (size == null) return DEFAULT_ICON_SIZE
        require(size == Math.floor(size) && size >= MIN_ICON_SIZE && size <= MAX_ICON_SIZE) { "size 需要是 $MIN_ICON_SIZE~$MAX_ICON_SIZE 的整数" }
        return size.toInt()
    }

    /**
     * 按应用名排序，名字相同按包名，保证结果稳定。
     *
     * @param items 应用列表
     * @param comparator 应用名比较器；线上用中文 Collator，测试可传简单比较器
     * @return 排好序的新列表
     */
    fun sortByLabel(items: List<AppItem>, comparator: Comparator<String>): List<AppItem> =
        items.sortedWith(Comparator<AppItem> { a, b -> comparator.compare(a.label, b.label) }.thenBy { it.pkg })

    /**
     * 导出安装包的文件名：`<应用名>_<版本名>.apk`，非法字符被替换，应用名为空用包名代替。
     *
     * @param label 应用名
     * @param versionName 版本名，可为空
     * @param pkg 包名
     * @return 可安全落盘的文件名
     */
    fun apkFileName(label: String, versionName: String, pkg: String): String {
        val base = label.trim().ifEmpty { pkg }.replace('/', '_').replace('\\', '_')
        val ver = versionName.trim()
        return FileNames.sanitize(if (ver.isEmpty()) "$base.apk" else "${base}_$ver.apk")
    }

    /**
     * 导出前的大小检查。
     *
     * @param bytes 安装包字节数
     * @throws IllegalArgumentException 为空或超过上限
     */
    fun requireApkSize(bytes: Long) {
        require(bytes > 0) { "找不到安装包文件" }
        require(bytes <= MAX_APK_BYTES) { "安装包超过 ${MAX_APK_BYTES shr 20}MB，不支持导出" }
    }

    /**
     * 应用列表转 JSON 数组，字段与 `native.apps.list` 的返回一致。
     *
     * @param items 应用列表
     * @return JSON 数组
     */
    fun toJson(items: List<AppItem>): JSONArray = JSONArray().also { arr ->
        for (a in items) {
            arr.put(
                JSONObject().put("pkg", a.pkg).put("label", a.label).put("versionName", a.versionName)
                    .put("versionCode", a.versionCode).put("firstInstallMs", a.firstInstallMs)
                    .put("lastUpdateMs", a.lastUpdateMs).put("isSystem", a.isSystem).put("apkBytes", a.apkBytes),
            )
        }
    }
}
