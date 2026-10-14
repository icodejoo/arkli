package com.let188.arkli.image

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.ActivityHost
import org.json.JSONObject

/**
 * `native.image.preview`：打开原生全屏图片预览（缩放、翻页，超长图局部高清）。
 *
 * 参数：`{ paths: string[1..50], index?: number = 0 }`，`paths` 是缓存相对路径（如 `cache/out/a.png`），
 * 只认缓存目录，穿越路径整体拒绝。返回 `{ shown: number }`，不等用户关闭预览。
 *
 * @param resolver 路径解析器，必须拒绝路径穿越
 * @param host 打开预览的宿主
 */
class ImagePreviewHandler(
    private val resolver: SourceResolver,
    private val host: ActivityHost,
) : BridgeHandler {
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        if (!ctx.isMainFrame) throw BridgeException(BridgeErrors.PERMISSION_DENIED, "仅主页面可调用")
        val arr = params.optJSONArray("paths") ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "paths 必须是数组")
        if (arr.length() < 1 || arr.length() > MAX_ITEMS) throw BridgeException(BridgeErrors.BAD_PARAMS, "paths 需要 1~$MAX_ITEMS 项")
        val files = (0 until arr.length()).map { i ->
            val f = resolver.resolve(arr.optString(i)) ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "paths[$i] 不是有效的缓存路径")
            if (!f.isFile) throw BridgeException(BridgeErrors.BAD_PARAMS, "paths[$i] 文件不存在")
            f
        }
        host.previewImages(files, params.optInt("index", 0).coerceIn(0, files.lastIndex))
        return JSONObject().put("shown", files.size)
    }

    private companion object {
        /** 一次最多预览的张数 */
        const val MAX_ITEMS = 50
    }
}
