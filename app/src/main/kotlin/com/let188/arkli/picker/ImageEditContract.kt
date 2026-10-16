package com.let188.arkli.picker

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.content.IntentCompat

/**
 * 图片编辑页启动参数。
 *
 * @property uri 待编辑的图片
 * @property modes 启用的编辑模式，取值见 [PickerConst.MODE_CROP]、[PickerConst.MODE_ROTATE]、[PickerConst.MODE_SHAPE]、[PickerConst.MODE_LASSO]
 */
data class ImageEditParams(val uri: Uri, val modes: List<String>)

/**
 * 拉起 [ImageEditActivity] 的契约：入参 [ImageEditParams]，出参为编辑后图片的 URI，用户取消返回 null。
 *
 * 使用示例：`val edit = registerForActivityResult(ImageEditContract()) { uri -> ... }`
 */
class ImageEditContract : ActivityResultContract<ImageEditParams, Uri?>() {
    /** 组装启动意图 */
    override fun createIntent(context: Context, input: ImageEditParams): Intent =
        Intent(context, ImageEditActivity::class.java)
            .putExtra(PickerConst.EXTRA_EDIT_URI, input.uri)
            .putStringArrayListExtra(PickerConst.EXTRA_EDIT_MODES, ArrayList(input.modes))

    /** 解析返回：OK 带导出 URI，其余一律视为取消 */
    override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
        if (resultCode == Activity.RESULT_OK) intent?.let { IntentCompat.getParcelableExtra(it, PickerConst.EXTRA_EDIT_RESULT, Uri::class.java) } else null
}
