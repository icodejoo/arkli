package com.let188.arkli.ai

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.pow
import kotlin.math.roundToLong

/**
 * 一次 `native.ai.ocr` 校验通过的请求。
 *
 * @property provider 指定的提供者 id；null 表示用第一个支持文字识别的
 * @property path 页面缓存路径，如 `cache/pick/a.jpg`
 * @property sensitivity 检测灵敏度：0 宽松、1 标准、2 严格；null 表示缺省
 * @property dropScore 识别最低得分阈值（0.0..=0.8）；null 表示缺省
 * @property maxSide 检测图最长边上限（只允许 640/960/1280）；null 表示缺省
 */
data class AiOcrRequest(
    val provider: String?,
    val path: String,
    val sensitivity: Int? = null,
    val dropScore: Float? = null,
    val maxSide: Int? = null,
)

/**
 * 文字识别的纯逻辑（选提供者归 [AiRouter]）：参数校验、尺寸收敛、结果序列化。无 Android 依赖，可单测。
 *
 * 使用示例：`AiOcrPolicy.parse(JSONObject("""{"path":"cache/pick/a.jpg"}"""))`
 */
object AiOcrPolicy {
    /** 参数键：检测灵敏度（select，0 宽松、1 标准、2 严格） */
    const val KEY_OCR_SENSITIVITY = "ocrSensitivity"

    /** 参数键：过滤低置信文字（slider，0~0.8） */
    const val KEY_OCR_DROP_SCORE = "ocrDropScore"

    /** 参数键：检测图最长边（select，640/960/1280） */
    const val KEY_OCR_MAX_SIDE = "ocrMaxSide"

    /** 默认检测灵敏度：1（标准） */
    const val DEFAULT_OCR_SENSITIVITY = 1

    /** 检测灵敏度档位标签 */
    val OCR_SENSITIVITY_OPTIONS: List<String> = listOf("宽松", "标准", "严格")

    /** 检测灵敏度档位对应值 */
    val OCR_SENSITIVITY_VALUES: List<Double> = listOf(0.0, 1.0, 2.0)

    /** 默认识别低置信过滤分：0.5（与 core/crates/arkli-ai/src/pipeline.rs 的 DEFAULT_DROP_SCORE 同值） */
    const val DEFAULT_DROP_SCORE = 0.5f

    /** 过滤低置信文字下限 */
    const val DROP_SCORE_MIN = 0.0

    /** 过滤低置信文字上限 */
    const val DROP_SCORE_MAX = 0.8

    /** 过滤低置信文字步进 */
    const val DROP_SCORE_STEP = 0.05

    /** 默认检测图最长边：960 */
    const val DEFAULT_OCR_MAX_SIDE = 960

    /** 检测图最长边档位标签 */
    val OCR_MAX_SIDE_OPTIONS: List<String> = listOf("640", "960", "1280")

    /** 检测图最长边档位对应值 */
    val OCR_MAX_SIDE_VALUES: List<Double> = listOf(640.0, 960.0, 1280.0)

    /**
     * 文字识别的可调参数规格列表。
     */
    val PARAM_SPECS: List<AiParamSpec> = listOf(
        AiParamSpec(
            key = KEY_OCR_SENSITIVITY,
            label = "检测灵敏度",
            desc = "标准档按模型自带的检测阈值；档位越严越可能漏淡字，越宽松越可能多出杂框",
            kind = AiParamKind.SELECT,
            default = DEFAULT_OCR_SENSITIVITY.toDouble(),
            min = OCR_SENSITIVITY_VALUES.min(),
            max = OCR_SENSITIVITY_VALUES.max(),
            step = 1.0,
            options = OCR_SENSITIVITY_OPTIONS,
            optionValues = OCR_SENSITIVITY_VALUES,
            applyTo = listOf(AiTask.OCR),
        ),
        AiParamSpec(
            key = KEY_OCR_DROP_SCORE,
            label = "过滤低置信文字",
            desc = "丢弃识别置信度低于该阈值的文字行，数值越高漏字风险越大，数值越低噪点越多",
            kind = AiParamKind.SLIDER,
            default = DEFAULT_DROP_SCORE.toDouble(),
            min = DROP_SCORE_MIN,
            max = DROP_SCORE_MAX,
            step = DROP_SCORE_STEP,
            applyTo = listOf(AiTask.OCR),
        ),
        AiParamSpec(
            key = KEY_OCR_MAX_SIDE,
            label = "检测图最长边",
            desc = "送入文字检测网络的最大尺寸；边长越大细小文字越清楚，耗时和内存也越高",
            kind = AiParamKind.SELECT,
            default = DEFAULT_OCR_MAX_SIDE.toDouble(),
            min = OCR_MAX_SIDE_VALUES.min(),
            max = OCR_MAX_SIDE_VALUES.max(),
            step = 1.0,
            options = OCR_MAX_SIDE_OPTIONS,
            optionValues = OCR_MAX_SIDE_VALUES,
            advanced = true,
            applyTo = listOf(AiTask.OCR),
        ),
    )

    /** Rust 管线接受的最长边上限，与 `arkli-ai` 的 `MAX_INPUT_SIDE` 一致 */
    const val MAX_EDGE = 4096

    /** 解码阶段的最长边：先降采样省内存；文本行从原分辨率里裁剪，所以不宜太小 */
    const val DECODE_MAX_EDGE = 2560

    /** 坐标保留的小数位数 */
    private const val COORD_DIGITS = 1

    /** 得分保留的小数位数 */
    private const val SCORE_DIGITS = 4

    /** 一个文本框的点数 */
    const val QUAD_POINTS = 4

    /**
     * 解析并校验 `native.ai.ocr` 的参数；多余的键（如旧前端的 `lang`）忽略，中英文由同一个模型一并识别。
     *
     * @param params `{ provider?: string, path: string }`
     * @return 校验通过的请求
     * @throws com.let188.arkli.bridge.BridgeException BAD_PARAMS：path 缺失或过长、provider 类型不对
     */
    fun parse(params: JSONObject): AiOcrRequest = AiOcrRequest(
        AiPolicy.providerId(params.opt(AiPolicy.KEY_PROVIDER), required = false),
        AiPolicy.pagePath(params),
    )

    /**
     * 解码后若最长边超过 [MAX_EDGE]，算出等比缩小后的尺寸。
     *
     * @param width 宽
     * @param height 高
     * @return 需要缩小时给出（宽, 高），否则 null
     * @example `fitSize(6000, 3000)` 得 `(4096, 2048)`；`fitSize(1080, 2400)` 得 null
     */
    fun fitSize(width: Int, height: Int): Pair<Int, Int>? {
        val longest = maxOf(width, height)
        if (longest <= MAX_EDGE) return null
        val k = MAX_EDGE.toDouble() / longest
        return maxOf(1, (width * k).toInt()) to maxOf(1, (height * k).toInt())
    }

    /**
     * 序列化识别结果（形状与前端旧 `OcrResult` 一致，另带 `inferMs`、`modelId`）。
     *
     * @param r 识别结果
     * @return `{ blocks:[{text, box:[x1,y1,x2,y2,x3,y3,x4,y4], score}], width, height, elapsedMs, inferMs, modelId }`，
     *   box 顺序为左上、右上、右下、左下，单位为 `width` x `height` 这张图的像素
     */
    fun resultJson(r: OcrResult): JSONObject {
        val blocks = JSONArray()
        r.outcome.lines.forEach { l ->
            val box = JSONArray()
            l.points.forEach { p ->
                box.put(round(p.x, COORD_DIGITS))
                box.put(round(p.y, COORD_DIGITS))
            }
            blocks.put(JSONObject().put("text", l.text).put("box", box).put("score", round(l.score, SCORE_DIGITS)))
        }
        return JSONObject().put("blocks", blocks).put("width", r.outcome.width).put("height", r.outcome.height)
            .put("elapsedMs", r.elapsedMs).put("inferMs", r.inferMs).put("modelId", r.modelId)
    }

    /** 四舍五入到 [digits] 位小数 */
    private fun round(v: Float, digits: Int): Double {
        val m = 10.0.pow(digits)
        return (v.toDouble() * m).roundToLong() / m
    }
}
