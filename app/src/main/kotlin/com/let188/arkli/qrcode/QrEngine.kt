package com.let188.arkli.qrcode

import android.graphics.Bitmap
import android.graphics.Rect
import android.util.Base64
import androidx.camera.core.ImageProxy
import zxingcpp.BarcodeReader

/**
 * zxing-cpp 的薄适配：按 [QrDecodeSpec] 建读码器，把结果映射成 [QrHit]。
 * formats 留空即识别全部码种。读码器不是线程安全的，每个使用线程各建一个。
 *
 * 使用示例：`QrEngine(QrPolicy.IMAGE_SPEC).decode(bitmap)`
 *
 * @param spec 解码选项
 */
internal class QrEngine(spec: QrDecodeSpec) {
    /** 底层读码器 */
    private val reader = BarcodeReader(
        BarcodeReader.Options().apply {
            formats = emptySet()
            tryHarder = spec.tryHarder
            tryRotate = spec.tryRotate
            tryInvert = spec.tryInvert
            tryDownscale = spec.tryDownscale
            tryDenoise = spec.tryDenoise
            maxNumberOfSymbols = QrConst.MAX_SYMBOLS
        },
    )

    /**
     * 解一帧相机画面（读 Y 平面，自动按旋转角与裁剪区处理）。调用方负责关闭 [frame]。
     *
     * @param frame 相机分析帧
     * @return 这一帧里的全部有效码，已去重
     */
    fun decode(frame: ImageProxy): List<QrHit> = hits(reader.read(frame))

    /**
     * 解一张位图。
     *
     * @param bitmap 位图
     * @return 全部有效码，已去重
     */
    fun decode(bitmap: Bitmap): List<QrHit> = hits(reader.read(bitmap, Rect(0, 0, bitmap.width, bitmap.height), 0))

    /** 映射并去重 */
    private fun hits(results: List<BarcodeReader.Result>): List<QrHit> =
        QrPolicy.dedupe(results.mapNotNull { QrPolicy.mapHit(it.format.name, it.text, it.bytes, ::base64) })

    private companion object {
        /** 字节转无换行 base64 */
        fun base64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
}
