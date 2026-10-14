package com.let188.arkli.qrcode

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.ActivityHost
import com.let188.arkli.files.FileRoots
import com.let188.arkli.files.requireMainFrame
import com.let188.arkli.image.ImageMath
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * `native.qrcode.scan`：打开全屏取景扫码页，识别到码即返回（一帧里的全部码）。
 *
 * 参数：无。返回：`{ cancelled: boolean, results: [{ text, format, bytes }] }`，
 * `bytes` 是原始字节的 base64；用户返回键取消时 `cancelled` 为 true。相机权限被拒抛 PERMISSION_DENIED。
 *
 * @param host 拉起扫码页的宿主
 */
internal class QrScanHandler(private val host: ActivityHost) : BridgeHandler {
    /** 拉起扫码页并等结果 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return QrPolicy.scanReply(host.scanQr())
    }
}

/**
 * `native.qrcode.decodeImage`：识别缓存里一张图片（如相册选图后的 `cache/pick/...`）。
 *
 * 参数：`{ path: string }`，只认缓存目录。返回：`{ results: [{ text, format, bytes }] }`，没识别到时为空数组。
 * 解码选项全开（tryHarder/tryRotate/tryInvert），大图先降采样到约 4096 边长。
 *
 * @param roots 目录根，用来安全解析路径
 */
internal class QrDecodeImageHandler(private val roots: FileRoots) : BridgeHandler {
    /** 解析路径、解码位图、识别 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val rel = QrPolicy.requirePath(params)
        val file = roots.resolveCache(rel)?.takeIf { it.isFile }
            ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "path 不是有效的缓存文件：$rel")
        val hits = withContext(Dispatchers.IO) {
            val bitmap = decodeBitmap(file.absolutePath)
                ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "无法解码这张图片")
            try {
                QrEngine(QrPolicy.IMAGE_SPEC).decode(bitmap)
            } finally {
                bitmap.recycle()
            }
        }
        return QrPolicy.decodeReply(hits)
    }

    /** 先读尺寸再按采样率解码，避免超大图 OOM */
    private fun decodeBitmap(path: String): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val opts = BitmapFactory.Options().apply {
            inSampleSize = ImageMath.sampleSize(bounds.outWidth, bounds.outHeight, QrConst.IMAGE_TARGET_EDGE, QrConst.IMAGE_TARGET_EDGE)
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        return BitmapFactory.decodeFile(path, opts)
    }
}
