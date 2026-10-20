package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject

/**
 * 抠图模式，对应四个本地模型（后两个是实验模型）。`wire` 是桥协议里 `mode` 的取值，也是前端 `MattingMode` 的字面量。
 *
 * @property wire 桥协议里的名字
 * @property providerId 对应提供者 id
 * @property modelId 清单里的模型 id（与 `assets/ai/models.json` 一致）
 * @property modelDir 模型目录（相对 filesDir）
 * @property modelFile 模型文件名
 * @property displayName 提供者展示名
 * @property licenseFile 随模型包的许可证文件名（清单 files 里有，设备上必需）
 */
enum class MattingMode(
    val wire: String,
    val providerId: String,
    val modelId: String,
    val modelDir: String,
    val modelFile: String,
    val displayName: String,
    val licenseFile: String = LICENSE_APACHE,
) {
    /** 人像：MODNet，fp32，输入 512 */
    PORTRAIT(
        "portrait", "local-matting-portrait", "matting-modnet-mnn-fp32",
        "models/matting-modnet-mnn-fp32", "modnet512_fp32.mnn", "本地人像抠图（MODNet）",
    ),

    /** 通用：U2Net-p，f16，输入 320 */
    GENERAL(
        "general", "local-matting-general", "matting-u2netp-mnn-f16",
        "models/matting-u2netp-mnn-f16", "u2netp_f16.mnn", "本地通用抠图（U2Net-p）",
    ),

    /** 人像 v2（实验）：PP-MattingV2，w8，固定输入 512 */
    PPMATTING(
        "ppmatting", "local-matting-ppmatting", "matting-ppmattingv2-mnn-w8",
        "models/matting-ppmattingv2-mnn-w8", "ppmattingv2_w8.mnn", "本地人像抠图 v2（PP-MattingV2，实验）",
    ),

    /** 通用高精（非人像）：BiRefNet-lite，w8，固定输入 512（社区 512 重导出）；不建议用于人像，较慢、真机峰值约 1.9GB */
    BIREFNET(
        "birefnet", "local-matting-birefnet", "matting-birefnet-lite512-mnn-w8",
        "models/matting-birefnet-lite512-mnn-w8", "birefnet_lite512_w8.mnn", "本地通用高精抠图（BiRefNet-lite 512，非人像）", "LICENSE-MIT.txt",
    ),
    ;

    companion object {
        /** 默认许可证文件名（Apache-2.0） */
        private const val LICENSE_APACHE = "LICENSE-Apache-2.0.txt"

        /**
         * 按桥协议名查模式。
         *
         * @param wire 协议名，如 `portrait`
         * @return 对应模式，不认识返回 null
         */
        fun fromWire(wire: String): MattingMode? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * 一次 `native.ai.matting` 校验通过的请求。
 *
 * @property provider 提供者 id（总是与 [mode] 对应的那个）
 * @property path 页面缓存路径，如 `cache/pick/a.jpg`
 * @property mode 抠图模式
 * @property refine 边缘细化强度，缺省 [MattingRefine.DEFAULT]（强）
 */
data class AiMattingRequest(
    val provider: String,
    val path: String,
    val mode: MattingMode,
    val refine: MattingRefine = MattingRefine.DEFAULT,
)

/**
 * 抠图的纯逻辑：参数校验、尺寸收敛、结果序列化。无 Android 依赖，可单测。
 *
 * 使用示例：`AiMattingPolicy.parse(JSONObject("""{"path":"cache/pick/a.jpg","mode":"portrait"}"""))`
 */
object AiMattingPolicy {
    /** 参数键：模式 */
    const val KEY_MODE = "mode"

    /** 参数键：边缘细化强度 */
    const val KEY_REFINE = "refine"

    /** 解码后最长边上限（Rust 引擎上限是 4096）；留余量给 ARGB 与 RGB 两份像素缓冲，3072² 约 38MB + 28MB */
    const val MAX_EDGE = 3072

    /**
     * 解析并校验 `native.ai.matting` 的参数。`mode` 必填；`provider` 可省，给了就必须与 `mode` 对应
     * （每个模式各是一个提供者，选哪个模型就是选哪个模式）；`refine` 可选，缺省 strong。
     *
     * @param params `{ provider?: string, path: string, mode: "portrait" | "general" | "ppmatting" | "birefnet", refine?: "off" | "light" | "standard" | "strong" }`
     * @return 校验通过的请求，provider 已补成 mode 对应的提供者
     * @throws BridgeException BAD_PARAMS：path 缺失或过长、mode 缺失或不认识、provider 与 mode 不符、refine 不合法
     */
    fun parse(params: JSONObject): AiMattingRequest {
        val path = AiPolicy.pagePath(params)
        val wire = params.opt(KEY_MODE) as? String ?: throw bad("mode 需要是字符串（portrait / general / ppmatting / birefnet）")
        val mode = MattingMode.fromWire(wire) ?: throw bad("mode 不认识：$wire（应为 portrait / general / ppmatting / birefnet）")
        val given = AiPolicy.providerId(params.opt(AiPolicy.KEY_PROVIDER), required = false)
        if (given != null && given != mode.providerId) throw bad("provider $given 与 mode $wire 不符，应为 ${mode.providerId}")
        val refine = when (val raw = params.opt(KEY_REFINE)) {
            null, JSONObject.NULL -> MattingRefine.DEFAULT
            is String -> MattingRefine.fromWire(raw) ?: throw bad("refine 不认识：$raw（应为 off/light/standard/strong）")
            else -> throw bad("refine 需要是字符串（off/light/standard/strong）")
        }
        return AiMattingRequest(mode.providerId, path, mode, refine)
    }

    /**
     * 解码后若最长边超过 [MAX_EDGE]，算出等比缩小后的尺寸。
     *
     * @param width 宽
     * @param height 高
     * @return 需要缩小时给出（宽, 高），否则 null
     * @example `fitSize(6000, 3000)` 得 `(3072, 1536)`；`fitSize(1080, 2400)` 得 null
     */
    fun fitSize(width: Int, height: Int): Pair<Int, Int>? {
        val longest = maxOf(width, height)
        if (longest <= MAX_EDGE) return null
        val k = MAX_EDGE.toDouble() / longest
        return maxOf(1, (width * k).toInt()) to maxOf(1, (height * k).toInt())
    }

    /**
     * 序列化抠图结果。
     *
     * @param r 抠图结果
     * @return `{ path, width, height, mode, elapsedMs, inferMs, refineMs, modelId }`；`path` 是带透明通道的 PNG（缓存路径），
     *   宽高即这张 PNG 的尺寸（大图会被收敛到最长边 [MAX_EDGE]）；`inferMs` 含 `refineMs`
     */
    fun resultJson(r: MattingResult): JSONObject = JSONObject().put("path", r.path).put("width", r.width).put("height", r.height)
        .put(KEY_MODE, r.mode.wire).put("elapsedMs", r.elapsedMs).put("inferMs", r.inferMs).put("refineMs", r.refineMs)
        .put("modelId", r.modelId)

    /** 造 BAD_PARAMS 异常 */
    private fun bad(msg: String) = BridgeException(BridgeErrors.BAD_PARAMS, msg)
}
