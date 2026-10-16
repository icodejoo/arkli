package com.let188.arkli.picker

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.content.IntentCompat

/** 自带选图页的结果 */
sealed interface PickOutcome {
    /** 用户选好了，按点选顺序 */
    data class Picked(val uris: List<Uri>) : PickOutcome

    /** 用户取消 */
    data object Cancelled : PickOutcome

    /** 相册权限被拒，调用方应回退到系统选择器 */
    data object Denied : PickOutcome

    /** 用户点击了拍照按钮，丢弃已选并切回拍照 */
    data object Camera : PickOutcome
}

/** 自带选择页能选的媒体种类 */
enum class PickerMedia {
    /** 只选图片 */
    IMAGE,

    /** 只选视频 */
    VIDEO,

    /** 图片和视频混选 */
    IMAGE_VIDEO,
}

/**
 * 自带选择页启动参数。
 *
 * @property max 最多可选个数（单选传 1）
 * @property camera 是否在页面内显示悬浮拍照按钮
 * @property media 媒体种类，默认图片
 * @property editModes 预览页允许的编辑模式，空表示不显示编辑按钮；默认裁剪与旋转
 */
data class PickerParams(
    val max: Int = PickerConst.DEFAULT_MAX,
    val camera: Boolean = false,
    val media: PickerMedia = PickerMedia.IMAGE,
    val editModes: List<String> = PickerPolicy.DEFAULT_EDIT_MODES,
)

/**
 * 拉起 [ImagePickerActivity] 的契约：入参是 [PickerParams]，出参是 [PickOutcome]。
 */
class PickerContract : ActivityResultContract<PickerParams, PickOutcome>() {
    /** 组装启动意图 */
    override fun createIntent(context: Context, input: PickerParams): Intent =
        Intent(context, ImagePickerActivity::class.java)
            .putExtra(PickerConst.EXTRA_MAX, input.max)
            .putExtra(PickerConst.EXTRA_CAMERA, input.camera)
            .putExtra(PickerConst.EXTRA_MEDIA, input.media.name)
            .putStringArrayListExtra(PickerConst.EXTRA_PICK_EDIT_MODES, ArrayList(input.editModes))

    /** 解析返回：OK 带 URI 列表，自定义码表示权限被拒或切回拍照，其余按取消 */
    override fun parseResult(resultCode: Int, intent: Intent?): PickOutcome = when (resultCode) {
        Activity.RESULT_OK -> {
            val uris = intent?.let { IntentCompat.getParcelableArrayListExtra(it, PickerConst.EXTRA_URIS, Uri::class.java) }
            if (uris.isNullOrEmpty()) PickOutcome.Cancelled else PickOutcome.Picked(uris)
        }
        PickerConst.RESULT_DENIED -> PickOutcome.Denied
        PickerConst.RESULT_CAMERA -> PickOutcome.Camera
        else -> PickOutcome.Cancelled
    }
}
