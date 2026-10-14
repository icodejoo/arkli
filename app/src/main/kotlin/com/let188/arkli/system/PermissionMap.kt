package com.let188.arkli.system

import android.Manifest

/**
 * 页面可查询/申请的权限名映射，纯函数，可单测。
 *
 * 使用示例：`PermissionMap.permissionOf("camera", sdk = 34)` -> `"android.permission.CAMERA"`
 */
internal object PermissionMap {
    /** 页面权限名：相机 */
    const val CAMERA = "camera"

    /** 页面权限名：麦克风 */
    const val MICROPHONE = "microphone"

    /** 页面权限名：通知 */
    const val NOTIFICATIONS = "notifications"

    /** 页面权限名：读取图片 */
    const val MEDIA_IMAGES = "media_images"

    /** 通知权限与细分图片权限都出现在 API 33 */
    private const val SDK_TIRAMISU = 33

    /** 通知权限的系统名 */
    private const val POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"

    /** 细分图片权限的系统名 */
    private const val READ_MEDIA_IMAGES = "android.permission.READ_MEDIA_IMAGES"

    /** 该 API 级别无需权限（视为已授予）时返回的标记 */
    const val NOT_REQUIRED = ""

    /** 白名单里的全部页面权限名 */
    val NAMES: Set<String> = setOf(CAMERA, MICROPHONE, NOTIFICATIONS, MEDIA_IMAGES)

    /**
     * 页面权限名转系统权限名。
     *
     * @param name 页面权限名
     * @param sdk 当前 API 级别
     * @return 系统权限名；该 API 级别无需权限（通知在 33 以下）返回 [NOT_REQUIRED]；名字不在白名单返回 null
     */
    fun permissionOf(name: String, sdk: Int): String? = when (name) {
        CAMERA -> Manifest.permission.CAMERA
        MICROPHONE -> Manifest.permission.RECORD_AUDIO
        NOTIFICATIONS -> if (sdk >= SDK_TIRAMISU) POST_NOTIFICATIONS else NOT_REQUIRED
        MEDIA_IMAGES -> if (sdk >= SDK_TIRAMISU) READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
        else -> null
    }
}
