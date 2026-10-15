package com.let188.arkli.camera

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom

/** 相机常量定义 */
object CameraConst {
    /** 选图/拍照缓存父目录名 */
    const val DIR_PICK = "pick"

    /** 相机拍摄产物子目录名 */
    const val DIR_CAM = "cam"

    /** 拍摄模式：拍照 */
    const val MODE_PHOTO = "photo"

    /** 拍摄模式：录像 */
    const val MODE_VIDEO = "video"

    /** 拍摄模式：相册入口 */
    const val MODE_ALBUM = "album"

    /** 摄像头朝向：后置 */
    const val FACING_BACK = "back"

    /** 摄像头朝向：前置 */
    const val FACING_FRONT = "front"

    /** 默认最大录制秒数（60 秒） */
    const val DEFAULT_MAX_DURATION_SEC = 60

    /** 录制秒数上限（300 秒） */
    const val MAX_DURATION_SEC_LIMIT = 300

    /** 产物类型：图片 */
    const val KIND_IMAGE = "image"

    /** 产物类型：视频 */
    const val KIND_VIDEO = "video"

    /** 图片 MIME */
    const val MIME_JPEG = "image/jpeg"

    /** 视频 MIME */
    const val MIME_MP4 = "video/mp4"

    /** JPEG 扩展名 */
    const val EXT_JPG = ".jpg"

    /** MP4 扩展名 */
    const val EXT_MP4 = ".mp4"

    /** 文件名前缀 */
    const val PREFIX_CAM = "cam_"

    /** Intent 传参 key：请求参数 JSON 字符串 */
    const val EXTRA_REQUEST = "camera_request"

    /** Intent 回传 key：结果 JSON 字符串 */
    const val EXTRA_RESULT = "camera_result"

    /** Activity 权限被拒退出码 */
    const val RESULT_DENIED = 2

    /** 字段 key：modes */
    const val KEY_MODES = "modes"

    /** 字段 key：facing */
    const val KEY_FACING = "facing"

    /** 字段 key：maxDurationSec */
    const val KEY_MAX_DURATION_SEC = "maxDurationSec"

    /** 字段 key：lensSwitch */
    const val KEY_LENS_SWITCH = "lensSwitch"

    /** 字段 key：kind */
    const val KEY_KIND = "kind"

    /** 字段 key：path */
    const val KEY_PATH = "path"

    /** 字段 key：name */
    const val KEY_NAME = "name"

    /** 字段 key：mime */
    const val KEY_MIME = "mime"

    /** 字段 key：size */
    const val KEY_SIZE = "size"

    /** 字段 key：width */
    const val KEY_WIDTH = "width"

    /** 字段 key：height */
    const val KEY_HEIGHT = "height"

    /** 字段 key：durationMs */
    const val KEY_DURATION_MS = "durationMs"

    /** 字段 key：cancelled */
    const val KEY_CANCELLED = "cancelled"

    /** 字段 key：album */
    const val KEY_ALBUM = "album"

    /** 字段 key：outcomeType */
    const val KEY_OUTCOME_TYPE = "outcomeType"

    /** 字段 key：errorMessage */
    const val KEY_ERROR_MESSAGE = "errorMessage"

    /** 页面路径前缀 */
    const val PAGE_PATH_PREFIX = "cache/pick/cam/"
}

/**
 * 相机拍摄请求入参。
 *
 * @property modes 支持的模式列表（photo/video/album），至少一项且无重复
 * @property facing 初始朝向（back/front）
 * @property maxDurationSec 录像最大秒数
 * @property lensSwitch 是否允许前后镜头切换
 */
data class CameraCaptureRequest(
    val modes: List<String>,
    val facing: String,
    val maxDurationSec: Int,
    val lensSwitch: Boolean,
)

/** 相机页面返回结果 */
sealed interface CameraCaptureOutcome {
    /**
     * 拍摄成功。
     *
     * @property kind 产物种类（image 或 video）
     * @property path 页面相对路径（cache/pick/cam/xxx）
     * @property name 文件名
     * @property mime 媒体 MIME 类型
     * @property size 文件字节数
     * @property width 宽（像素）
     * @property height 高（像素）
     * @property durationMs 视频时长（毫秒，仅视频有）
     */
    data class Success(
        val kind: String,
        val path: String,
        val name: String,
        val mime: String,
        val size: Long,
        val width: Int,
        val height: Int,
        val durationMs: Long? = null,
    ) : CameraCaptureOutcome

    /** 用户取消返回 */
    data object Cancelled : CameraCaptureOutcome

    /** 用户点击了相册入口 */
    data object Album : CameraCaptureOutcome

    /** 相机权限被拒 */
    data class Denied(val message: String = "没有相机权限") : CameraCaptureOutcome

    /** 内部错误（如设备无相机或初始化失败） */
    data class Error(val message: String) : CameraCaptureOutcome
}

/**
 * 相机策略纯逻辑：参数校验、路径计算、文件名生成、目录清理与结果转换。
 * 不依赖 Android 系统服务，可 JVM 单元测试。
 *
 * 使用示例：
 * ```
 * val req = CameraPolicy.parseParams(params)
 * val reply = CameraPolicy.captureReply(outcome)
 * ```
 */
object CameraPolicy {
    /** 随机数生成器 */
    private val rng = SecureRandom()

    /**
     * 录像倒计时圆环的剩余比例。
     *
     * @param elapsedMs 已录毫秒，负数按 0 算
     * @param maxDurationSec 录像最长秒数
     * @return 1 表示刚开始（满环），0 表示到点（空环）；上限非正时返回 0
     * @example ringFraction(1500, 3) // 0.5f
     */
    fun ringFraction(elapsedMs: Long, maxDurationSec: Int): Float {
        if (maxDurationSec <= 0) return 0f
        val total = maxDurationSec * 1000f
        return (1f - elapsedMs.coerceAtLeast(0L) / total).coerceIn(0f, 1f)
    }

    /** 合法的 modes 枚举值集合 */
    private val VALID_MODES = setOf(CameraConst.MODE_PHOTO, CameraConst.MODE_VIDEO, CameraConst.MODE_ALBUM)

    /**
     * 校验并解析 `native.camera.capture` 入参。
     *
     * @param params 调用传入的 JSON 参数对象
     * @return 校验后的请求参数
     * @throws BridgeException 参数非法时抛出 BAD_PARAMS
     * @example
     * ```
     * val req = CameraPolicy.parseParams(JSONObject("""{"modes":["photo","album"]}"""))
     * ```
     */
    fun parseParams(params: JSONObject): CameraCaptureRequest {
        val modes = parseModes(params)
        val facing = parseFacing(params)
        val maxDurationSec = parseMaxDurationSec(params)
        val lensSwitch = parseLensSwitch(params)
        return CameraCaptureRequest(modes, facing, maxDurationSec, lensSwitch)
    }

    /** 解析 modes 数组 */
    private fun parseModes(params: JSONObject): List<String> {
        if (!params.has(CameraConst.KEY_MODES)) {
            return listOf(CameraConst.MODE_PHOTO)
        }
        val arr = params.optJSONArray(CameraConst.KEY_MODES)
            ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "modes 必须是数组")
        if (arr.length() == 0) {
            throw BridgeException(BridgeErrors.BAD_PARAMS, "modes 至少需要包含一项")
        }
        val list = ArrayList<String>(arr.length())
        for (i in 0 until arr.length()) {
            val item = arr.optString(i)
            if (item !in VALID_MODES) {
                throw BridgeException(BridgeErrors.BAD_PARAMS, "modes 包含不支持的模式：$item")
            }
            list.add(item)
        }
        if (list.distinct().size != list.size) {
            throw BridgeException(BridgeErrors.BAD_PARAMS, "modes 不能包含重复项")
        }
        return list
    }

    /** 解析 facing 镜头朝向 */
    private fun parseFacing(params: JSONObject): String {
        if (!params.has(CameraConst.KEY_FACING)) return CameraConst.FACING_BACK
        val facing = params.optString(CameraConst.KEY_FACING)
        if (facing != CameraConst.FACING_BACK && facing != CameraConst.FACING_FRONT) {
            throw BridgeException(BridgeErrors.BAD_PARAMS, "facing 只能是 back 或 front")
        }
        return facing
    }

    /** 解析 maxDurationSec 视频最大秒数 */
    private fun parseMaxDurationSec(params: JSONObject): Int {
        if (!params.has(CameraConst.KEY_MAX_DURATION_SEC)) return CameraConst.DEFAULT_MAX_DURATION_SEC
        val obj = params.opt(CameraConst.KEY_MAX_DURATION_SEC)
        if (obj !is Number) {
            throw BridgeException(BridgeErrors.BAD_PARAMS, "maxDurationSec 必须是数字")
        }
        val sec = obj.toInt()
        if (sec <= 0 || sec > CameraConst.MAX_DURATION_SEC_LIMIT) {
            throw BridgeException(BridgeErrors.BAD_PARAMS, "maxDurationSec 必须在 1~${CameraConst.MAX_DURATION_SEC_LIMIT} 之间")
        }
        return sec
    }

    /** 解析 lensSwitch 是否允许切镜头 */
    private fun parseLensSwitch(params: JSONObject): Boolean {
        if (!params.has(CameraConst.KEY_LENS_SWITCH)) return true
        val obj = params.opt(CameraConst.KEY_LENS_SWITCH)
        if (obj !is Boolean) {
            throw BridgeException(BridgeErrors.BAD_PARAMS, "lensSwitch 必须是布尔值")
        }
        return obj
    }

    /**
     * 获取相机缓存存放目录：`cacheRoot/pick/cam`。
     *
     * @param cacheRoot 缓存根目录（即 `cacheDir/arkli`）
     * @return 相机专用的缓存目录
     * @example
     * ```
     * val dir = CameraPolicy.camDir(roots.cacheRoot)
     * ```
     */
    fun camDir(cacheRoot: File): File = File(File(cacheRoot, CameraConst.DIR_PICK), CameraConst.DIR_CAM)

    /**
     * 生成相对页面路径（`cache/pick/cam/<name>`）。
     *
     * @param fileName 文件名
     * @return 页面路径
     * @example
     * ```
     * val path = CameraPolicy.pagePath("cam_abc.jpg")
     * ```
     */
    fun pagePath(fileName: String): String = "${CameraConst.PAGE_PATH_PREFIX}$fileName"

    /**
     * 生成随机产物文件（只在 `camDir` 下）。
     *
     * @param camDir 相机缓存目录
     * @param isVideo 是否为视频文件
     * @param suffixId 自定义随机后缀（单测注入），默认生成 8 字节 16 进制随机串
     * @return 新建的目标文件对象
     * @example
     * ```
     * val file = CameraPolicy.generateTargetFile(camDir, isVideo = false)
     * ```
     */
    fun generateTargetFile(camDir: File, isVideo: Boolean, suffixId: String? = null): File {
        camDir.mkdirs()
        val rand = suffixId ?: run {
            val bytes = ByteArray(8)
            rng.nextBytes(bytes)
            bytes.joinToString("") { "%02x".format(it) }
        }
        val ext = if (isVideo) CameraConst.EXT_MP4 else CameraConst.EXT_JPG
        val name = "${CameraConst.PREFIX_CAM}$rand$ext"
        return File(camDir, name)
    }

    /**
     * 清空指定目录下的所有文件。
     *
     * @param dir 要清空的目录
     * @return 实际删除的文件数
     * @example
     * ```
     * val count = CameraPolicy.clearDirectory(camDir)
     * ```
     */
    fun clearDirectory(dir: File): Int {
        if (!dir.exists() || !dir.isDirectory) return 0
        val files = dir.listFiles() ?: return 0
        var count = 0
        for (f in files) {
            if (f.isFile && f.delete()) {
                count++
            } else if (f.isDirectory) {
                count += clearDirectory(f)
                f.delete()
            }
        }
        return count
    }

    /**
     * 将拍摄结果转换为给页面的 Bridge 响应 JSON。
     *
     * @param outcome 相机拍摄结局
     * @return 响应数据 JSON 对象
     * @throws BridgeException 权限拒绝或内部错误时抛出异常
     * @example
     * ```
     * val json = CameraPolicy.captureReply(outcome)
     * ```
     */
    fun captureReply(outcome: CameraCaptureOutcome): JSONObject = when (outcome) {
        is CameraCaptureOutcome.Success -> JSONObject().apply {
            put(CameraConst.KEY_KIND, outcome.kind)
            put(CameraConst.KEY_PATH, outcome.path)
            put(CameraConst.KEY_NAME, outcome.name)
            put(CameraConst.KEY_MIME, outcome.mime)
            put(CameraConst.KEY_SIZE, outcome.size)
            put(CameraConst.KEY_WIDTH, outcome.width)
            put(CameraConst.KEY_HEIGHT, outcome.height)
            if (outcome.durationMs != null) {
                put(CameraConst.KEY_DURATION_MS, outcome.durationMs)
            }
        }
        CameraCaptureOutcome.Cancelled -> JSONObject().put(CameraConst.KEY_CANCELLED, true)
        CameraCaptureOutcome.Album -> JSONObject().put(CameraConst.KEY_ALBUM, true)
        is CameraCaptureOutcome.Denied -> throw BridgeException(BridgeErrors.PERMISSION_DENIED, outcome.message)
        is CameraCaptureOutcome.Error -> throw BridgeException(BridgeErrors.INTERNAL, outcome.message)
    }

    /**
     * 将请求序列化为 JSON 字符串，供 Intent 跨进程或 Activity 传递。
     *
     * @param req 请求对象
     * @return JSON 字符串
     */
    fun requestToJson(req: CameraCaptureRequest): String = JSONObject().apply {
        put(CameraConst.KEY_MODES, JSONArray(req.modes))
        put(CameraConst.KEY_FACING, req.facing)
        put(CameraConst.KEY_MAX_DURATION_SEC, req.maxDurationSec)
        put(CameraConst.KEY_LENS_SWITCH, req.lensSwitch)
    }.toString()

    /**
     * 从 JSON 字符串解析请求对象。
     *
     * @param json 序列化字符串
     * @return 解析后的请求对象，解析失败时返回默认请求
     */
    fun requestFromJson(json: String?): CameraCaptureRequest {
        if (json.isNullOrEmpty()) return CameraCaptureRequest(listOf(CameraConst.MODE_PHOTO), CameraConst.FACING_BACK, CameraConst.DEFAULT_MAX_DURATION_SEC, true)
        return runCatching { parseParams(JSONObject(json)) }.getOrDefault(
            CameraCaptureRequest(listOf(CameraConst.MODE_PHOTO), CameraConst.FACING_BACK, CameraConst.DEFAULT_MAX_DURATION_SEC, true)
        )
    }

    /**
     * 将结果序列化为 JSON 字符串。
     *
     * @param outcome 结局对象
     * @return JSON 字符串
     */
    fun outcomeToJson(outcome: CameraCaptureOutcome): String = JSONObject().apply {
        when (outcome) {
            is CameraCaptureOutcome.Success -> {
                put(CameraConst.KEY_OUTCOME_TYPE, "success")
                put(CameraConst.KEY_KIND, outcome.kind)
                put(CameraConst.KEY_PATH, outcome.path)
                put(CameraConst.KEY_NAME, outcome.name)
                put(CameraConst.KEY_MIME, outcome.mime)
                put(CameraConst.KEY_SIZE, outcome.size)
                put(CameraConst.KEY_WIDTH, outcome.width)
                put(CameraConst.KEY_HEIGHT, outcome.height)
                if (outcome.durationMs != null) put(CameraConst.KEY_DURATION_MS, outcome.durationMs)
            }
            CameraCaptureOutcome.Cancelled -> put(CameraConst.KEY_OUTCOME_TYPE, "cancelled")
            CameraCaptureOutcome.Album -> put(CameraConst.KEY_OUTCOME_TYPE, "album")
            is CameraCaptureOutcome.Denied -> {
                put(CameraConst.KEY_OUTCOME_TYPE, "denied")
                put(CameraConst.KEY_ERROR_MESSAGE, outcome.message)
            }
            is CameraCaptureOutcome.Error -> {
                put(CameraConst.KEY_OUTCOME_TYPE, "error")
                put(CameraConst.KEY_ERROR_MESSAGE, outcome.message)
            }
        }
    }.toString()

    /**
     * 从 JSON 字符串反序列化结果。
     *
     * @param json 字符串
     * @return 结局对象，失败按 Cancelled 兜底
     */
    fun outcomeFromJson(json: String?): CameraCaptureOutcome {
        if (json.isNullOrEmpty()) return CameraCaptureOutcome.Cancelled
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return CameraCaptureOutcome.Cancelled
        return when (obj.optString(CameraConst.KEY_OUTCOME_TYPE)) {
            "success" -> CameraCaptureOutcome.Success(
                kind = obj.optString(CameraConst.KEY_KIND),
                path = obj.optString(CameraConst.KEY_PATH),
                name = obj.optString(CameraConst.KEY_NAME),
                mime = obj.optString(CameraConst.KEY_MIME),
                size = obj.optLong(CameraConst.KEY_SIZE),
                width = obj.optInt(CameraConst.KEY_WIDTH),
                height = obj.optInt(CameraConst.KEY_HEIGHT),
                durationMs = if (obj.has(CameraConst.KEY_DURATION_MS)) obj.optLong(CameraConst.KEY_DURATION_MS) else null,
            )
            "album" -> CameraCaptureOutcome.Album
            "denied" -> CameraCaptureOutcome.Denied(obj.optString(CameraConst.KEY_ERROR_MESSAGE, "没有相机权限"))
            "error" -> CameraCaptureOutcome.Error(obj.optString(CameraConst.KEY_ERROR_MESSAGE, "内部错误"))
            else -> CameraCaptureOutcome.Cancelled
        }
    }
}
