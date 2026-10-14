package com.let188.arkli.image

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.FileConst
import com.let188.arkli.files.FileEnv
import android.util.Log
import java.io.File

/**
 * 把图片方法注册进一个会话的 Bridge。
 *
 * 成品落在缓存根的 `out/` 下，路径解析只认缓存目录（[com.let188.arkli.files.FileRoots.resolveCache]，
 * 已防穿越）。成品随缓存清理策略回收：保留 24 小时，超总量时最近 10 分钟写入的不动，
 * 页面拿到结果后立刻回显、保存都在这个窗口内。
 *
 * 使用示例：`ImageModule.install(bridge, env)`
 */
/** 图片模块日志 tag */
private const val IMAGE_LOG_TAG = "ArkliImage"

object ImageModule {
    /** 方法名：批量压缩 / 转格式 */
    const val METHOD_COMPRESS = "native.image.compress"

    /** 方法名：多图拼接，成品与缩略图写进 out/ */
    const val METHOD_STITCH = "native.image.stitch"

    /** 方法名：原生全屏图片预览 */
    const val METHOD_PREVIEW = "native.image.preview"

    /**
     * 注册图片方法。
     *
     * @param bridge 当前会话的 Bridge
     * @param env 文件环境，取缓存根与路径解析
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        val outDir = File(env.roots.cacheRoot, FileConst.DIR_OUT)
        val compressor = ImageCompressor(AndroidImageCodec(), outDir)
        bridge.register(METHOD_COMPRESS, ImageCompressHandler({ env.roots.resolveCache(it) }, compressor))
        bridge.register(METHOD_STITCH, ImageStitchHandler({ env.roots.resolveCache(it) }, ImageStitcher(AndroidStitchBackend(), outDir, log = { Log.i(IMAGE_LOG_TAG, it) })))
        bridge.register(METHOD_PREVIEW, ImagePreviewHandler({ env.roots.resolveCache(it) }, env.host))
    }
}
