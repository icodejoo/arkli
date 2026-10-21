package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一次 `native.ai.logoSymbol` 校验通过的请求。
 *
 * @property provider 指定的提供者 id；null 表示用第一个支持 logo 符号的
 * @property prompt 英文提示词（已 trim，UTF-8 不超过 [AiLogoPolicy.MAX_PROMPT_BYTES] 字节）
 * @property seed 随机种子；null 由服务随机一个并写进结果
 * @property removeRing 是否检测并去掉模型自画的外圈，缺省 true
 */
data class AiLogoRequest(
    val provider: String?,
    val prompt: String,
    val seed: Long? = null,
    val removeRing: Boolean = true,
)

/**
 * 符号质量特征（闸门的输入，调试与调参用）。
 *
 * @property inkCanvas 墨量占画布比例
 * @property rotIou 旋转对称最小 IoU（越高越像靶心圆）
 * @property comps 较大连通域个数
 * @property specks 小斑点个数
 * @property sizeRel 符号最大边相对画布（或外圈内径）的比例
 * @property off 质心偏离画布中心的比例
 * @property fillBbox 外接框内的填充率
 * @property empty 是否空图
 */
data class LogoFeatures(
    val inkCanvas: Float,
    val rotIou: Float,
    val comps: Int,
    val specks: Int,
    val sizeRel: Float,
    val off: Float,
    val fillBbox: Float,
    val empty: Boolean,
)

/**
 * 各段耗时（毫秒）。
 *
 * @property tokenizeMs 分词
 * @property textMs 文本编码
 * @property unetMs UNet 一步
 * @property stepMs 一步采样公式
 * @property vaeMs TAESD 解码
 * @property loadMs 模型加载（常驻模式只在被卸载后的首次出现；分段模式每次都有）
 * @property extractMs 二值化与符号提取
 * @property featuresMs 质量特征
 * @property gateMs 闸门
 * @property traceMs vtracer 描摹
 * @property totalMs Rust 侧总耗时（出图 + 后处理）
 */
data class LogoTimings(
    val tokenizeMs: Long,
    val textMs: Long,
    val unetMs: Long,
    val stepMs: Long,
    val vaeMs: Long,
    val loadMs: Long,
    val extractMs: Long,
    val featuresMs: Long,
    val gateMs: Long,
    val traceMs: Long,
    val totalMs: Long,
)

/**
 * 模型驻留方式。
 *
 * @property wire 桥协议里的取值
 */
enum class LogoResidency(val wire: String) {
    /** 三张图常驻内存：快，真机峰值约 1.3GB */
    RESIDENT("resident"),

    /** 每段用完即卸载：峰值约 720MB（低内存兜底），每次生成都要重新加载 */
    PER_STAGE("per_stage"),
}

/**
 * 一次生成的完整结果，交给 [AiLogoPolicy.resultJson] 序列化。
 *
 * @property svgPaths 单色符号的 `<path/>` 片段（fill 为 `#000000`，坐标系 512x512），空图为 null
 * @property pathCount 路径元素个数
 * @property gateOk 质量闸门是否通过（没过时 svgPaths 仍可能有值，由调用方取舍）
 * @property gateReasons 闸门未通过的原因代码
 * @property ringDetected 是否检测到并去掉了模型自画的外圈
 * @property features 质量特征
 * @property timings 各段耗时
 * @property seed 实际使用的种子
 * @property residency 本次会话的驻留方式
 * @property elapsedMs 总耗时（含加载，不含排队等闸门）
 * @property modelId 模型标识
 */
data class LogoResult(
    val svgPaths: String?,
    val pathCount: Int,
    val gateOk: Boolean,
    val gateReasons: List<String>,
    val ringDetected: Boolean,
    val features: LogoFeatures,
    val timings: LogoTimings,
    val seed: Long,
    val residency: LogoResidency,
    val elapsedMs: Long,
    val modelId: String,
)

/**
 * logo 符号生成的纯逻辑：参数校验、内存策略、结果序列化。无 Android 依赖，可单测。
 *
 * 使用示例：`AiLogoPolicy.parse(JSONObject("""{"prompt":"flat pictogram glyph of a carrot","seed":1}"""))`
 */
object AiLogoPolicy {
    /** 参数键：提示词 */
    const val KEY_PROMPT = "prompt"

    /** 参数键：随机种子（结果里也用同名字段回报实际种子） */
    const val KEY_SEED = "seed"

    /** 参数键：是否去外圈 */
    const val KEY_REMOVE_RING = "removeRing"

    /** 提示词最大 UTF-8 字节数，与 Rust 的 `MAX_PROMPT_BYTES` 一致 */
    const val MAX_PROMPT_BYTES = 2000

    /** JS 安全整数上限：种子经 JSON 数字传入，超过它会丢精度 */
    const val MAX_SEED = 9_007_199_254_740_991L

    /** 一兆字节 */
    private const val MB = 1024L * 1024L

    /** 常驻模式真机峰值 VmHWM（STG-AL00 spike 实测 1307MB） */
    const val RESIDENT_PEAK_BYTES = 1307L * MB

    /** 常驻模式要求的安全余量：留给 WebView、系统与波动 */
    const val SAFETY_MARGIN_BYTES = 512L * MB

    /** 选常驻模式所需的最小可用内存 */
    const val RESIDENT_NEED_BYTES = RESIDENT_PEAK_BYTES + SAFETY_MARGIN_BYTES

    /**
     * 按可用内存选驻留方式：可用内存（已卸掉其他模型之后）不低于“常驻峰值 + 安全余量”才常驻，
     * 否则或未知（<= 0）用每段即卸（峰值约 720MB，慢约 50%）。
     *
     * @param availBytes 系统可用内存字节数，未知传 0 或负数
     * @return 驻留方式
     * @example `chooseResidency(2000L * 1024 * 1024)` 得 RESIDENT
     */
    fun chooseResidency(availBytes: Long): LogoResidency =
        if (availBytes >= RESIDENT_NEED_BYTES) LogoResidency.RESIDENT else LogoResidency.PER_STAGE

    /**
     * 解析并校验 `native.ai.logoSymbol` 的参数（invoke 的 input + options 已被拍平）。
     *
     * @param params `{ provider?, prompt, seed?, removeRing? }`
     * @return 校验通过的请求
     * @throws BridgeException BAD_PARAMS：prompt 缺失、为空或超过 [MAX_PROMPT_BYTES] 字节；seed 非 0~[MAX_SEED] 整数；removeRing 不是布尔
     */
    fun parse(params: JSONObject): AiLogoRequest {
        val prompt = (params.opt(KEY_PROMPT) as? String)?.trim() ?: throw bad("$KEY_PROMPT 需要是字符串")
        if (prompt.isEmpty()) throw bad("$KEY_PROMPT 不能为空")
        if (prompt.toByteArray(Charsets.UTF_8).size > MAX_PROMPT_BYTES) throw bad("$KEY_PROMPT 不能超过 $MAX_PROMPT_BYTES 字节")
        val seed = optional(params, KEY_SEED)?.let {
            val n = it as? Number ?: throw bad("$KEY_SEED 需要是整数")
            if (n.toDouble() != n.toLong().toDouble()) throw bad("$KEY_SEED 需要是整数")
            if (n.toLong() < 0 || n.toLong() > MAX_SEED) throw bad("$KEY_SEED 需要在 0~$MAX_SEED 之间")
            n.toLong()
        }
        val removeRing = optional(params, KEY_REMOVE_RING)?.let { it as? Boolean ?: throw bad("$KEY_REMOVE_RING 需要是布尔值") } ?: true
        return AiLogoRequest(AiPolicy.providerId(params.opt(AiPolicy.KEY_PROVIDER), required = false), prompt, seed, removeRing)
    }

    /**
     * 序列化结果。
     *
     * @param r 生成结果
     * @return `{ svgPaths, pathCount, gateOk, gateReasons[], ringDetected, features{}, timings{}, seed, residency, elapsedMs, modelId }`；空图时 svgPaths 为 null
     */
    fun resultJson(r: LogoResult): JSONObject {
        val f = r.features
        val t = r.timings
        return JSONObject()
            .put("pathCount", r.pathCount)
            .put("gateOk", r.gateOk)
            .put("gateReasons", JSONArray(r.gateReasons))
            .put("ringDetected", r.ringDetected)
            .put(
                "features",
                JSONObject().put("inkCanvas", f.inkCanvas.toDouble()).put("rotIou", f.rotIou.toDouble()).put("comps", f.comps)
                    .put("specks", f.specks).put("sizeRel", f.sizeRel.toDouble()).put("off", f.off.toDouble())
                    .put("fillBbox", f.fillBbox.toDouble()).put("empty", f.empty),
            )
            .put(
                "timings",
                JSONObject().put("tokenizeMs", t.tokenizeMs).put("textMs", t.textMs).put("unetMs", t.unetMs).put("stepMs", t.stepMs)
                    .put("vaeMs", t.vaeMs).put("loadMs", t.loadMs).put("extractMs", t.extractMs).put("featuresMs", t.featuresMs)
                    .put("gateMs", t.gateMs).put("traceMs", t.traceMs).put("totalMs", t.totalMs),
            )
            .put(KEY_SEED, r.seed)
            .put("residency", r.residency.wire)
            .put("elapsedMs", r.elapsedMs)
            .put("modelId", r.modelId)
            // svgPaths 放最后：它可能很长，调试日志按行截断时不会把前面的小字段挤掉
            .put("svgPaths", r.svgPaths ?: JSONObject.NULL)
    }

    /** 取可选字段：缺省或 null 都当没传 */
    private fun optional(params: JSONObject, key: String): Any? = params.opt(key)?.takeIf { it != JSONObject.NULL }

    /** 造 BAD_PARAMS 异常 */
    private fun bad(msg: String) = BridgeException(BridgeErrors.BAD_PARAMS, msg)
}
