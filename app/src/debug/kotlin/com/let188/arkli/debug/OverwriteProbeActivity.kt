package com.let188.arkli.debug

import android.app.Activity
import android.content.ContentUris
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts

/** 探针日志 tag，adb logcat -s OvProbe 查看 */
private const val TAG = "OvProbe"

/**
 * 仅调试：实测“选图返回的 URI 能不能写回原图”。
 * 用法：`am start -n com.let188.arkli/.debug.OverwriteProbeActivity --es mode <pickvm|opendoc|opendocplain|treedoc>`，
 * 选一张图后，结果打到 logcat（tag OvProbe）。写入用“把原字节原样写回”，不改变图片内容。
 * 追加 `--ez ms true` 则对选中的图再走 MediaStore.createWriteRequest（API 30+）。
 */
class OverwriteProbeActivity : ComponentActivity() {
    /** 本次是否追加 createWriteRequest 实验 */
    private var tryMs = false

    /** 系统相册选择器（项目现用的方式） */
    private val pickVm = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { it?.let(::probe) ?: Log.i(TAG, "取消") }

    /** 带写授权标志的 OpenDocument */
    private val openDocW = registerForActivityResult(object : ActivityResultContracts.OpenDocument() {
        override fun createIntent(context: android.content.Context, input: Array<String>): Intent =
            super.createIntent(context, input).addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
    }) { it?.let(::probe) ?: Log.i(TAG, "取消") }

    /** 不带写标志的 OpenDocument（对照） */
    private val openDocPlain = registerForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(::probe) ?: Log.i(TAG, "取消") }

    /** createWriteRequest 的系统确认框 */
    private val writeReq = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { r ->
        Log.i(TAG, "createWriteRequest 结果 resultCode=${r.resultCode}（-1=允许）")
        pendingMs?.let { u -> if (r.resultCode == Activity.RESULT_OK) tryWrite("MS写授权后 $u", u) }
        finish()
    }

    /** 等待写授权的 MediaStore URI */
    private var pendingMs: Uri? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        tryMs = intent.getBooleanExtra("ms", false)
        Log.i(TAG, "设备 ${Build.MODEL} API ${Build.VERSION.SDK_INT} photoPickerAvailable=${ActivityResultContracts.PickVisualMedia.isPhotoPickerAvailable(this)}")
        when (intent.getStringExtra("mode")) {
            "pickvm" -> pickVm.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            "opendoc" -> openDocW.launch(arrayOf("image/*"))
            "opendocplain" -> openDocPlain.launch(arrayOf("image/*"))
            else -> { Log.i(TAG, "未知 mode"); finish() }
        }
    }

    /** 对选中的 URI 做全套探测 */
    private fun probe(uri: Uri) {
        Log.i(TAG, "选中 uri=$uri authority=${uri.authority} isDocument=${DocumentsContract.isDocumentUri(this, uri)}")
        val w = checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        val r = checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION)
        Log.i(TAG, "checkUriPermission 读=${r == 0} 写=${w == 0}（0=已授权）")
        Log.i(TAG, "getType=${contentResolver.getType(uri)}")
        try {
            contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_FLAGS, "_display_name"), null, null, null)?.use {
                if (it.moveToFirst()) {
                    val f = it.getInt(0)
                    Log.i(TAG, "COLUMN_FLAGS=$f supportsWrite=${f and DocumentsContract.Document.FLAG_SUPPORTS_WRITE != 0} name=${it.getString(1)}")
                }
            }
        } catch (e: Exception) { Log.i(TAG, "查 COLUMN_FLAGS 失败 $e") }
        tryWrite("直接写", uri)
        if (tryMs) {
            val ms = toMediaUri(uri)
            Log.i(TAG, "推导 MediaStore uri=$ms")
            if (ms != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                tryWrite("MS未授权直接写", ms)
                pendingMs = ms
                val sender = MediaStore.createWriteRequest(contentResolver, listOf(ms)).intentSender
                writeReq.launch(IntentSenderRequest.Builder(sender).build())
                return
            }
        }
        finish()
    }

    /** 读原字节，再用 wt 打开把它原样写回，记录每步结果 */
    private fun tryWrite(label: String, uri: Uri) {
        try {
            val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
            Log.i(TAG, "$label：读到 ${bytes.size} 字节")
            for (mode in listOf("wt", "w", "rwt")) {
                try {
                    val out = contentResolver.openOutputStream(uri, mode)
                    if (out == null) { Log.i(TAG, "$label：模式 $mode openOutputStream 返回 null"); continue }
                    out.use { it.write(bytes) }
                    Log.i(TAG, "$label：模式 $mode 写入成功")
                    return
                } catch (e: Exception) {
                    Log.i(TAG, "$label：模式 $mode 失败 ${e.javaClass.simpleName}: ${e.message}")
                }
            }
        } catch (e: Exception) {
            Log.i(TAG, "$label：读取失败 ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /** 选择器 URI 推导成 MediaStore 图片 URI：认 media.documents 的 image:ID 与 photopicker 的末段 ID */
    private fun toMediaUri(uri: Uri): Uri? {
        val id = when {
            uri.authority == "com.android.providers.media.documents" -> DocumentsContract.getDocumentId(uri).substringAfter("image:", "").toLongOrNull()
            uri.pathSegments.contains("picker") || uri.authority == "media" -> uri.lastPathSegment?.toLongOrNull()
            else -> null
        } ?: return null
        return ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
    }
}
