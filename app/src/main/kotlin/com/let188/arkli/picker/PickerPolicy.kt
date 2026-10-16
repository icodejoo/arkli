package com.let188.arkli.picker

import com.let188.arkli.files.PickKind
import org.json.JSONArray
import org.json.JSONObject

/**
 * 选图路由判定与响应组装的纯逻辑策略。
 */
object PickerPolicy {
    /**
     * 解析 camera 参数是否生效：仅图片场景有效。
     *
     * @param requested 页面传入的 camera
     * @param kind 选择媒体种类
     * @return 是否启用拍照按钮
     */
    fun wantsCamera(requested: Boolean, kind: PickKind): Boolean = requested && kind == PickKind.IMAGE

    /**
     * 把选择种类映射成自带选择页的媒体种类；相册、拍照一律走自带页，不再用系统选择器。
     * 只有指定单个 mime（如 image/png）和普通文件仍走系统选择器。
     *
     * @param kind 选择媒体种类
     * @return 自带页的媒体种类；不走自带页返回 null
     * @example
     * PickerPolicy.mediaOf(PickKind.VIDEO) // PickerMedia.VIDEO
     * PickerPolicy.mediaOf(PickKind.DOCUMENT) // null
     */
    fun mediaOf(kind: PickKind): PickerMedia? = when (kind) {
        PickKind.IMAGE -> PickerMedia.IMAGE
        PickKind.VIDEO -> PickerMedia.VIDEO
        PickKind.IMAGE_VIDEO -> PickerMedia.IMAGE_VIDEO
        PickKind.SINGLE_MEDIA, PickKind.DOCUMENT -> null
    }

    /**
     * 计算传给自带选图页的最大张数。
     * 多选时取参数指定的上限，单选时强制为 1。
     *
     * @param multiple 是否多选
     * @param max 传入的最大数量
     * @return 实际限制张数
     * @example
     * PickerPolicy.resolveMaxCount(multiple = false, max = 20) // 1
     * PickerPolicy.resolveMaxCount(multiple = true, max = 9) // 9
     */
    fun resolveMaxCount(multiple: Boolean, max: Int): Int =
        if (multiple) max else 1

    /** 没传 edit 时的默认编辑模式：全部能力（裁剪、旋转、形状、套索） */
    val DEFAULT_EDIT_MODES: List<String> =
        listOf(PickerConst.MODE_CROP, PickerConst.MODE_ROTATE, PickerConst.MODE_SHAPE, PickerConst.MODE_LASSO)

    /**
     * 解析选图页允许的编辑模式：缺省开全部模式；空数组关闭编辑；非空取合法值，全是非法值时按缺省（全部）处理。
     *
     * @param raw 页面传入的 edit 数组，缺省为 null
     * @return 允许的模式；空列表表示不显示编辑按钮
     * @example
     * PickerPolicy.resolveEditModes(null) // ["crop","rotate","shape","lasso"]
     * PickerPolicy.resolveEditModes(JSONArray("[]")) // []
     */
    fun resolveEditModes(raw: JSONArray?): List<String> {
        if (raw == null) return DEFAULT_EDIT_MODES
        if (raw.length() == 0) return emptyList()
        return parseEditModes(raw).ifEmpty { DEFAULT_EDIT_MODES }
    }

    /**
     * 解析 edit 参数：只保留 crop、rotate、shape、lasso，去重并保持出现顺序。
     *
     * @param arr 页面传入的 JSON 数组，可为 null
     * @return 合法模式列表
     * @example PickerPolicy.parseEditModes(JSONArray("[\"crop\",\"x\",\"crop\"]")) // ["crop"]
     */
    fun parseEditModes(arr: JSONArray?): List<String> {
        if (arr == null) return emptyList()
        val valid = setOf(PickerConst.MODE_CROP, PickerConst.MODE_ROTATE, PickerConst.MODE_SHAPE, PickerConst.MODE_LASSO)
        return (0 until arr.length()).mapNotNull { arr.optString(it, "").takeIf { m -> m in valid } }.distinct()
    }

    /**
     * 组装 native.file.pick 的返回结果 JSON。
     *
     * @param items 成功选中的项列表
     * @param failed 失败项列表
     * @param camera 是否因点击悬浮拍照按钮而返回
     * @return 符合 bridge 协议约定的 JSONObject
     * @example
     * PickerPolicy.buildPickResponse(JSONArray(), JSONArray(), camera = true) // {"items":[],"failed":[],"camera":true}
     */
    fun buildPickResponse(items: JSONArray, failed: JSONArray, camera: Boolean): JSONObject {
        val json = JSONObject().put("items", items).put("failed", failed)
        if (camera) {
            json.put("camera", true)
        }
        return json
    }
}
