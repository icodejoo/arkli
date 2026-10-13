package com.let188.arkli.image

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import org.json.JSONObject
import java.io.File

/** 把页面路径解析成真实文件的接口，阶段 2 注入基于 SafePath/FileRoots 的实现 */
fun interface SourceResolver {
    /**
     * 解析页面路径。
     *
     * @param pagePath 如 `cache/pick/a.jpg`
     * @return 文件；路径不合法（穿越、前缀不认识等）返回 null
     */
    fun resolve(pagePath: String): File?
}

/**
 * `native.image.compress` 处理器：解析参数、解析源路径、交给 [ImageCompressor]，进度推 `image.progress`。
 * 只写类，不在这里注册。参数与返回契约见 [CompressPlan] 与 [CompressResult.toJson]。
 *
 * 使用示例（阶段 2）：
 * ```
 * bridge.register("native.image.compress",
 *     ImageCompressHandler(resolver, ImageCompressor(AndroidImageCodec(), outDir)))
 * ```
 *
 * @param resolver 路径解析器，必须拒绝路径穿越
 * @param compressor 压缩流水线
 */
class ImageCompressHandler(
    private val resolver: SourceResolver,
    private val compressor: ImageCompressor,
) : BridgeHandler {
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        if (!ctx.isMainFrame) throw BridgeException(BridgeErrors.PERMISSION_DENIED, "仅主页面可调用")
        val plan = CompressPlan.parse(params)
        // 先全部解析：任何一个路径不合法就整体拒绝，不处理一半
        val files = plan.items.mapIndexed { i, item ->
            resolver.resolve(item.path)
                ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "items[$i].path 不是有效的缓存路径")
        }
        val result = compressor.run(plan, files) { done, total, name ->
            ctx.emit(
                ImageConst.EVENT_PROGRESS,
                JSONObject().put("done", done).put("total", total).put("name", name),
            )
        }
        return result.toJson()
    }
}
