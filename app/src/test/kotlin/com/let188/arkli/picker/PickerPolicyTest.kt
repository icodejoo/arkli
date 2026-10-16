package com.let188.arkli.picker

import com.let188.arkli.files.PickKind
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 选图路由与返回组装的单测 */
class PickerPolicyTest {
    /** 图片、视频、图文混选都走自带页 */
    @Test
    fun mediaKindsUseCustom() {
        assertEquals(PickerMedia.IMAGE, PickerPolicy.mediaOf(PickKind.IMAGE))
        assertEquals(PickerMedia.VIDEO, PickerPolicy.mediaOf(PickKind.VIDEO))
        assertEquals(PickerMedia.IMAGE_VIDEO, PickerPolicy.mediaOf(PickKind.IMAGE_VIDEO))
    }

    /** 指定单个 mime 与普通文件仍走系统选择器 */
    @Test
    fun othersUseSystem() {
        assertNull(PickerPolicy.mediaOf(PickKind.SINGLE_MEDIA))
        assertNull(PickerPolicy.mediaOf(PickKind.DOCUMENT))
    }

    /** camera 仅图片场景生效 */
    @Test
    fun wantsCameraOnlyForImage() {
        assertTrue(PickerPolicy.wantsCamera(true, PickKind.IMAGE))
        assertFalse(PickerPolicy.wantsCamera(true, PickKind.VIDEO))
        assertFalse(PickerPolicy.wantsCamera(false, PickKind.IMAGE))
    }

    /** 单选上限为 1，多选取参数 */
    @Test
    fun resolveMax() {
        assertEquals(1, PickerPolicy.resolveMaxCount(false, 20))
        assertEquals(9, PickerPolicy.resolveMaxCount(true, 9))
    }

    /** 点拍照时返回带 camera 标记；否则不带该字段 */
    @Test
    fun responseCameraFlag() {
        val cam = PickerPolicy.buildPickResponse(JSONArray(), JSONArray(), true)
        assertTrue(cam.getBoolean("camera"))
        assertEquals(0, cam.getJSONArray("items").length())
        assertFalse(PickerPolicy.buildPickResponse(JSONArray(), JSONArray(), false).has("camera"))
    }

    /** 契约结果码：自定义码不与取消冲突 */
    @Test
    fun resultCodesDistinct() {
        assertTrue(PickerConst.RESULT_CAMERA >= android.app.Activity.RESULT_FIRST_USER)
        assertTrue(PickerConst.RESULT_CAMERA != PickerConst.RESULT_DENIED)
    }

    /** 缺省走默认基础模式，空数组关闭，非空取合法值，全非法回默认 */
    @Test
    fun resolveEditModes() {
        assertEquals(listOf("crop", "rotate", "shape", "lasso"), PickerPolicy.resolveEditModes(null))
        assertEquals(emptyList<String>(), PickerPolicy.resolveEditModes(JSONArray("[]")))
        assertEquals(listOf("crop", "lasso"), PickerPolicy.resolveEditModes(JSONArray("[\"crop\",\"x\",\"lasso\",\"crop\"]")))
        assertEquals(listOf("crop", "rotate", "shape", "lasso"), PickerPolicy.resolveEditModes(JSONArray("[\"x\"]")))
    }

    /** edit 参数只保留合法值、去重、保序；null 与非字符串都当空 */
    @Test
    fun parseEditModesFilters() {
        assertEquals(listOf("rotate", "crop"), PickerPolicy.parseEditModes(JSONArray("[\"rotate\",\"brush\",\"crop\",\"rotate\"]")))
        assertEquals(emptyList<String>(), PickerPolicy.parseEditModes(null))
        assertEquals(emptyList<String>(), PickerPolicy.parseEditModes(JSONArray("[1,2]")))
    }

    /** shape、lasso 是合法编辑模式，保序去重 */
    @Test
    fun parseEditModesAcceptsShapeAndLasso() {
        assertEquals(listOf("lasso", "shape", "crop"), PickerPolicy.parseEditModes(JSONArray("[\"lasso\",\"shape\",\"lasso\",\"crop\"]")))
    }
}
