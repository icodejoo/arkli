package com.let188.arkli.image

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import org.json.JSONObject

/**
 * `native.image.stitch` 处理器：解析参数、解析源路径（只认缓存目录，任一非法整体拒绝）、交给 [ImageStitcher]，
 * 进度推 `image.progress`。参数契约见 [StitchPlan]，返回见 [StitchResult.toJson]。
 *
 * 使用示例：`bridge.register("native.image.stitch", ImageStitchHandler(resolver, stitcher))`
 *
 * @param resolver 路径解析器，必须拒绝路径穿越
 * @param stitcher 拼接流水线
 */
class ImageStitchHandler(
    private val resolver: SourceResolver,
    private val stitcher: ImageStitcher,
) : BridgeHandler {
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        if (!ctx.isMainFrame) throw BridgeException(BridgeErrors.PERMISSION_DENIED, "仅主页面可调用")
        val plan = StitchPlan.parse(params)
        // 先全部解析：任何一个路径不合法就整体拒绝
        val files = plan.paths.mapIndexed { i, p ->
            resolver.resolve(p) ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "items[$i].path 不是有效的缓存路径")
        }
        val result = stitcher.run(plan, files) { done, total, name, phase, percent ->
            val data = JSONObject().put("done", done).put("total", total).put("name", name).put("phase", phase)
            if (percent != null) data.put("percent", percent)
            ctx.emit(ImageConst.EVENT_PROGRESS, data)
        }
        return result.toJson()
    }
}
