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
}

/**
 * 拉起 [ImagePickerActivity] 的契约：入参是最多可选张数，出参是 [PickOutcome]。
 */
class PickerContract : ActivityResultContract<Int, PickOutcome>() {
    /** 组装启动意图 */
    override fun createIntent(context: Context, input: Int): Intent =
        Intent(context, ImagePickerActivity::class.java).putExtra(PickerConst.EXTRA_MAX, input)

    /** 解析返回：OK 带 URI 列表，自定义码表示权限被拒，其余按取消 */
    override fun parseResult(resultCode: Int, intent: Intent?): PickOutcome = when (resultCode) {
        Activity.RESULT_OK -> {
            val uris = intent?.let { IntentCompat.getParcelableArrayListExtra(it, PickerConst.EXTRA_URIS, Uri::class.java) }
            if (uris.isNullOrEmpty()) PickOutcome.Cancelled else PickOutcome.Picked(uris)
        }
        PickerConst.RESULT_DENIED -> PickOutcome.Denied
        else -> PickOutcome.Cancelled
    }
}
