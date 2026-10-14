package com.let188.arkli.qrcode

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject

/** 二维码相关常量 */
internal object QrConst {
    /** 一帧最多返回的码数，实际上等于不设限 */
    const val MAX_SYMBOLS = 255

    /** 相册图解码前降采样的目标边长（像素），zxing-cpp 自己还会再缩 */
    const val IMAGE_TARGET_EDGE = 4096

    /** 扫码页返回的 Intent 附加数据：识别结果 JSON 数组字符串 */
    const val EXTRA_RESULTS = "qr_results"

    /** 扫码页返回码：相机权限被拒 */
    const val RESULT_DENIED = 2

    /** 结果 JSON 字段：文本 */
    const val KEY_TEXT = "text"

    /** 结果 JSON 字段：码种名称，如 QR_CODE */
    const val KEY_FORMAT = "format"

    /** 结果 JSON 字段：原始字节的 base64 */
    const val KEY_BYTES = "bytes"
}

/**
 * 一个识别结果。
 *
 * @property text 解码文本
 * @property format 码种名称（zxing-cpp 枚举名，如 `QR_CODE`、`EAN_13`）
 * @property bytes 原始字节的 base64（无换行）
 */
data class QrHit(val text: String, val format: String, val bytes: String)

/**
 * 一套解码选项（与 zxing-cpp 无关的纯数据，方便单测）。
 *
 * @property tryHarder 是否多花时间换识别率
 * @property tryRotate 是否尝试旋转 90 度
 * @property tryInvert 是否尝试反色码
 * @property tryDownscale 是否对大图缩小后再试
 * @property tryDenoise 是否先降噪
 */
internal data class QrDecodeSpec(
    val tryHarder: Boolean,
    val tryRotate: Boolean,
    val tryInvert: Boolean,
    val tryDownscale: Boolean,
    val tryDenoise: Boolean,
)

/** 扫码页的结果 */
sealed interface QrScanOutcome {
    /** 识别到了，带这一帧里的全部码 */
    data class Scanned(val hits: List<QrHit>) : QrScanOutcome

    /** 用户取消 */
    data object Cancelled : QrScanOutcome

    /** 相机权限被拒 */
    data object Denied : QrScanOutcome
}

/**
 * 二维码识别的纯逻辑：选项构造、结果映射、JSON 往返、参数校验。不依赖 android 与 zxing-cpp，可 JVM 单测。
 *
 * 使用示例：`QrPolicy.mapHit("QR_CODE", "hi", "hi".toByteArray(), ::b64)`
 */
internal object QrPolicy {
    /** 实时取景：关掉 tryHarder/tryRotate/tryInvert 保帧率，大帧仍允许缩小 */
    val LIVE_SPEC = QrDecodeSpec(tryHarder = false, tryRotate = false, tryInvert = false, tryDownscale = true, tryDenoise = false)

    /** 相册图：全部打开，慢一点没关系 */
    val IMAGE_SPEC = QrDecodeSpec(tryHarder = true, tryRotate = true, tryInvert = true, tryDownscale = true, tryDenoise = true)

    /**
     * 把引擎的一个结果映射成 [QrHit]。
     *
     * @param format 码种枚举名
     * @param text 解码文本，可能为空
     * @param bytes 原始字节，可能为空
     * @param encode 字节转 base64 的函数
     * @return 映射结果；文本和字节都没有时返回 null（视为无效）
     */
    fun mapHit(format: String, text: String?, bytes: ByteArray?, encode: (ByteArray) -> String): QrHit? {
        val raw = bytes ?: ByteArray(0)
        if (text.isNullOrEmpty() && raw.isEmpty()) return null
        return QrHit(text.orEmpty(), format, encode(raw))
    }

    /**
     * 去重：同码种同字节只留第一个，保持出现顺序。
     *
     * @param hits 原始结果
     * @return 去重后的结果
     */
    fun dedupe(hits: List<QrHit>): List<QrHit> = hits.distinctBy { it.format to it.bytes }

    /**
     * 结果列表转 JSON 数组，字段见 [QrConst]。
     *
     * @param hits 结果
     * @return `[{ text, format, bytes }]`
     */
    fun hitsToJson(hits: List<QrHit>): JSONArray = JSONArray().also { arr ->
        hits.forEach {
            arr.put(JSONObject().put(QrConst.KEY_TEXT, it.text).put(QrConst.KEY_FORMAT, it.format).put(QrConst.KEY_BYTES, it.bytes))
        }
    }

    /**
     * 从 [hitsToJson] 的字符串还原，格式不对或缺字段的项直接跳过。
     *
     * @param json JSON 数组字符串，可为空
     * @return 结果列表，解析失败返回空列表
     */
    fun hitsFromJson(json: String?): List<QrHit> {
        if (json.isNullOrEmpty()) return emptyList()
        val arr = runCatching { JSONArray(json) }.getOrNull() ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val format = o.optString(QrConst.KEY_FORMAT)
            if (format.isEmpty()) null else QrHit(o.optString(QrConst.KEY_TEXT), format, o.optString(QrConst.KEY_BYTES))
        }
    }

    /**
     * 组装 `native.qrcode.scan` 的返回。
     *
     * @param outcome 扫码页结果
     * @return `{ cancelled, results }`
     * @throws BridgeException 相机权限被拒时抛 PERMISSION_DENIED
     */
    fun scanReply(outcome: QrScanOutcome): JSONObject = when (outcome) {
        is QrScanOutcome.Scanned -> JSONObject().put("cancelled", false).put("results", hitsToJson(outcome.hits))
        QrScanOutcome.Cancelled -> JSONObject().put("cancelled", true).put("results", JSONArray())
        QrScanOutcome.Denied -> throw BridgeException(BridgeErrors.PERMISSION_DENIED, "没有相机权限")
    }

    /**
     * 组装 `native.qrcode.decodeImage` 的返回。
     *
     * @param hits 识别结果，可为空
     * @return `{ results }`
     */
    fun decodeReply(hits: List<QrHit>): JSONObject = JSONObject().put("results", hitsToJson(hits))

    /**
     * 取并校验 `decodeImage` 的 `path` 参数。
     *
     * @param params 调用参数
     * @return 页面路径
     * @throws BridgeException 缺失或为空时抛 BAD_PARAMS
     */
    fun requirePath(params: JSONObject): String =
        params.optString("path").takeIf { it.isNotBlank() } ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "path 必须是非空字符串")
}
