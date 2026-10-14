package com.let188.arkli.files

import android.content.ContentUris
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import kotlin.coroutines.coroutineContext

/**
 * `native.file.overwrite`：把缓存里的成品写回 `native.file.pick`（带 `keepSource`）选中的原图。
 *
 * 真机结论（见 bridge-protocol.md）：系统选图器返回的 URI 是只读的（`openOutputStream` 报 "Media is read-only"），
 * 所以改走 MediaStore：把选图 URI 认成 MediaStore 图片 URI，调 `createWriteRequest` 让系统弹“允许修改这张照片吗”，
 * 用户允许后再写。API 30 以下不支持。
 *
 * 安全：先校验格式一致（不一致抛 `FORMAT_MISMATCH`，不弹授权框）；写前把原图备份到 `tmp/`，
 * 写失败或写后大小不符就用备份还原；写完通知媒体库刷新。
 *
 * 参数：`{ path: 缓存相对路径, handle: sourceHandle }`；返回：`{ uri, size }`。
 *
 * @param env 文件环境
 * @param handles 本会话的不透明句柄表
 */
internal class OverwriteHandler(private val env: FileEnv, private val handles: HandleTable<Uri>) : BridgeHandler {
    /** 内容解析器 */
    private val resolver = env.appContext.contentResolver

    /** 随机数，备份文件起名用 */
    private val random = SecureRandom()

    /** 覆盖一张原图 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val path = params.opt("path") as? String ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "缺少 path")
        val handle = params.opt("handle") as? String ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "缺少 handle")
        val file = env.roots.resolveCache(path)?.takeIf { it.isFile } ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "path 无效或文件不存在")
        val source = handles.get(handle) ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "handle 无效或已过期，请重新选择原图")
        val srcMime = withContext(Dispatchers.IO) { resolver.getType(source) }
        if (!OverwritePolicy.sameFormat(srcMime, file.name)) throw BridgeException(BridgeErrors.FORMAT_MISMATCH, MISMATCH_MESSAGE)
        val target = locateTarget(source)
        return withContext(Dispatchers.IO) {
            val size = safeOverwrite(target, file)
            notifyMedia(target)
            JSONObject().put("uri", target.toString()).put("size", size)
        }
    }

    /** 选图 URI 换成可写入的 URI：认出 MediaStore id 就走授权框，认不出再试直接写（可写的 SAF 文档） */
    private suspend fun locateTarget(source: Uri): Uri {
        val id = OverwritePolicy.mediaId(source.toString()) ?: return source
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            throw BridgeException(BridgeErrors.NOT_READY, "覆盖原图需要 Android 11 及以上")
        }
        val media = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        if (!env.host.requestWriteAccess(media)) throw BridgeException(BridgeErrors.PERMISSION_DENIED, "没有获得修改原图的授权")
        // 选图 URI 与推导出的 MediaStore 行必须是同一张图，名字对不上宁可不写
        val a = displayName(source)
        val b = displayName(media)
        if (a != null && b != null && a != b) throw BridgeException(BridgeErrors.INTERNAL, "无法确认原图位置，已取消覆盖")
        return media
    }

    /** 备份 -> 写入 -> 校验大小；失败即还原备份。返回写入字节数 */
    private suspend fun safeOverwrite(target: Uri, src: File): Long {
        val tmpDir = File(env.roots.cacheRoot, FileConst.DIR_TMP).apply { mkdirs() }
        val backup = File(tmpDir, "ov_${randomId()}${FileConst.PART_SUFFIX}")
        try {
            try {
                resolver.openInputStream(target)?.use { input ->
                    backup.outputStream().use { out -> StreamCopy.copy(input, out, Long.MAX_VALUE) { coroutineContext.ensureActive() } }
                } ?: throw BridgeException(BridgeErrors.INTERNAL, "无法读取原图")
            } catch (e: SecurityException) {
                throw BridgeException(BridgeErrors.PERMISSION_DENIED, "没有修改原图的权限")
            }
            try {
                val out = resolver.openOutputStream(target, WRITE_MODE) ?: throw BridgeException(BridgeErrors.INTERNAL, "无法打开原图写入")
                out.use { o -> src.inputStream().use { StreamCopy.copy(it, o, Long.MAX_VALUE) { coroutineContext.ensureActive() } } }
                val written = resolver.openFileDescriptor(target, "r")?.use { it.statSize } ?: -1L
                if (written >= 0 && written != src.length()) throw BridgeException(BridgeErrors.INTERNAL, "写入后大小不符")
                return src.length()
            } catch (e: Throwable) {
                restore(target, backup)
                if (e is SecurityException || e is IllegalArgumentException) {
                    throw BridgeException(BridgeErrors.PERMISSION_DENIED, "该来源不允许修改原图")
                }
                throw e
            }
        } finally {
            backup.delete()
        }
    }

    /** 把备份写回原图，尽力而为 */
    private fun restore(target: Uri, backup: File) {
        try {
            resolver.openOutputStream(target, WRITE_MODE)?.use { o -> backup.inputStream().use { it.copyTo(o) } }
        } catch (_: Exception) {
            // 还原失败也只能放弃，异常会以原始失败上报
        }
    }

    /** 通知媒体库刷新：先发变更通知，再尽力按路径触发一次扫描 */
    private fun notifyMedia(target: Uri) {
        resolver.notifyChange(target, null)
        try {
            @Suppress("DEPRECATION")
            val data = resolver.query(target, arrayOf(MediaStore.MediaColumns.DATA), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
            if (data != null) MediaScannerConnection.scanFile(env.appContext, arrayOf(data), null, null)
        } catch (_: Exception) {
            // 部分系统不给 _data，变更通知已发
        }
    }

    /** 查显示名，查不到返回 null */
    private fun displayName(uri: Uri): String? = try {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
    } catch (_: Exception) {
        null
    }

    /** 随机十六进制 id */
    private fun randomId(): String = ByteArray(FileConst.RANDOM_ID_BYTES).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }

    companion object {
        /** 格式不一致的提示，前端可直接展示 */
        const val MISMATCH_MESSAGE = "格式与原图不同，请把输出格式改成一致"

        /** 覆盖写入模式：截断后写 */
        private const val WRITE_MODE = "wt"
    }
}
