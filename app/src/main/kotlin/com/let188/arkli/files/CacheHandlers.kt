package com.let188.arkli.files

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * `native.file.discard`：丢弃 `cache/out/` 内的文件（页面不再需要的成品）。
 *
 * 参数：`{ paths: string[1..200] }`，缓存相对路径；任一路径穿越、不在 out/ 内或是目录则整体拒绝（BAD_PARAMS），
 * 不存在的忽略。拼图成品会连带删同 id 的缩略图。返回：`{ deleted: number }`。
 *
 * @param env 文件环境
 */
internal class DiscardHandler(private val env: FileEnv) : BridgeHandler {
    /** 丢弃一批成品 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val arr = params.optJSONArray("paths") ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "paths 必须是数组")
        val paths = (0 until arr.length()).map { arr.opt(it) as? String ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "paths[$it] 必须是字符串") }
        val n = withContext(Dispatchers.IO) { OutFiles.discard(env.outDir, env.roots::resolveCache, paths) }
        return JSONObject().put("deleted", n)
    }
}

/**
 * `native.cache.stats`：统计缓存占用。无参数。
 * 返回：`{ bytes, files, byDir: { pick: { bytes, files }, out: {...}, tmp: {...}, ... } }`。
 *
 * @param env 文件环境
 */
internal class CacheStatsHandler(private val env: FileEnv) : BridgeHandler {
    /** 统计 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val s = withContext(Dispatchers.IO) { env.cacheStats() }
        val dirs = JSONObject()
        for ((k, v) in s.byDir) dirs.put(k, JSONObject().put("bytes", v.bytes).put("files", v.files))
        return JSONObject().put("bytes", s.bytes).put("files", s.files).put("byDir", dirs)
    }
}

/**
 * `native.cache.clear`：清空缓存根下全部缓存，跳过活跃写句柄的临时文件与 1 分钟内修改过的文件（可能正在使用）。
 * 无参数。返回：`{ freedBytes, deleted, skipped }`。
 *
 * @param env 文件环境
 */
internal class CacheClearHandler(private val env: FileEnv) : BridgeHandler {
    /** 清空 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val r = withContext(Dispatchers.IO) { env.clearCache() }
        return JSONObject().put("freedBytes", r.freedBytes).put("deleted", r.deleted).put("skipped", r.skipped)
    }
}
