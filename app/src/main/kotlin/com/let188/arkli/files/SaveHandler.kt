package com.let188.arkli.files

import android.Manifest
import android.content.ContentValues
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import kotlin.coroutines.coroutineContext
import kotlin.coroutines.resume

/** 一次保存请求里的单个文件 */
private class SaveItem(val file: File, val name: String, val mime: String)

/**
 * `native.file.save`：把缓存里的文件存到公共目录，按顺序保存。
 *
 * - API 29+：MediaStore，`IS_PENDING` 流程，不需要权限。
 * - API 24~28：需要 WRITE_EXTERNAL_STORAGE，没有时在这里临时申请（`native.permission.*` 做好后应改走它）。
 * - 目录：图片 `Pictures/Arkli`、视频 `Movies/Arkli`、音频 `Music/Arkli`，其他 `Download/Arkli`。
 *
 * 参数：`{ items: [{ path: "cache/...", name?: string, mime?: string }] }`。
 * 返回：`{ items: [{ uri, name, size, dir }], failed: [{ path, message }] }`；全部失败时抛 INTERNAL。
 *
 * @param env 文件环境
 */
internal class SaveHandler(private val env: FileEnv) : BridgeHandler {
    /** 保存一批文件 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val arr = params.optJSONArray("items") ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "缺少 items 数组")
        if (arr.length() == 0 || arr.length() > MAX_ITEMS) {
            throw BridgeException(BridgeErrors.BAD_PARAMS, "items 数量必须在 1..$MAX_ITEMS")
        }
        val items = (0 until arr.length()).map { parse(arr.opt(it)) }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) ensureLegacyPermission()
        val ok = JSONArray()
        val failed = JSONArray()
        var firstError: String? = null
        for (item in items) {
            coroutineContext.ensureActive()
            try {
                ok.put(withContext(Dispatchers.IO) { saveOne(item) })
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                val msg = e.message ?: e.javaClass.simpleName
                if (firstError == null) firstError = msg
                failed.put(JSONObject().put("path", env.roots.pagePathOf(item.file) ?: "").put("message", msg))
            }
        }
        if (ok.length() == 0) throw BridgeException(BridgeErrors.INTERNAL, "保存失败：$firstError")
        return JSONObject().put("items", ok).put("failed", failed)
    }

    /** 校验并解析一项，路径必须落在缓存目录内 */
    private fun parse(raw: Any?): SaveItem {
        val o = raw as? JSONObject ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "items 的元素必须是对象")
        val path = o.optString("path")
        if (path.isEmpty()) throw BridgeException(BridgeErrors.BAD_PARAMS, "缺少 path")
        val file = env.roots.resolveCache(path)
        if (file == null || !file.isFile) throw BridgeException(BridgeErrors.BAD_PARAMS, "path 无效或文件不存在：$path")
        val mime = o.optString("mime").ifEmpty { mimeOf(file) }
        val name = FileNames.withExt(FileNames.sanitize(o.optString("name").ifEmpty { file.name }), mime)
        return SaveItem(file, name, mime)
    }

    /** 保存单个文件，返回结果条目 */
    private suspend fun saveOne(item: SaveItem): JSONObject {
        val kind = kindOf(item.mime)
        val dir = "${kind.dirType}/${FileConst.SAVE_SUBDIR}"
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) saveMediaStore(item, kind, dir) else saveLegacy(item, kind, dir)
    }

    /** API 29+：MediaStore 插入，写完去掉 IS_PENDING；失败回滚删除条目 */
    private suspend fun saveMediaStore(item: SaveItem, kind: Kind, dir: String): JSONObject {
        val resolver = env.appContext.contentResolver
        val collection = kind.collection()
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, item.name)
            put(MediaStore.MediaColumns.MIME_TYPE, item.mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, dir)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values) ?: throw BridgeException(BridgeErrors.INTERNAL, "MediaStore 插入失败")
        try {
            val out = resolver.openOutputStream(uri) ?: throw BridgeException(BridgeErrors.INTERNAL, "无法打开输出流")
            out.use { copy(item.file, it) }
            val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            resolver.update(uri, done, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        val shown = resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: item.name
        return result(uri.toString(), shown, item.file.length(), dir)
    }

    /** API 24~28：直接写公共目录再通知媒体库扫描 */
    private suspend fun saveLegacy(item: SaveItem, kind: Kind, dir: String): JSONObject {
        @Suppress("DEPRECATION")
        val folder = File(Environment.getExternalStoragePublicDirectory(kind.dirType), FileConst.SAVE_SUBDIR)
        if (!folder.mkdirs() && !folder.isDirectory) throw BridgeException(BridgeErrors.INTERNAL, "无法创建目录 $dir")
        val target = FileNames.unique(folder, item.name)
        try {
            FileOutputStream(target).use { copy(item.file, it) }
        } catch (e: Exception) {
            target.delete()
            throw e
        }
        val uri = suspendCancellableCoroutine<Uri?> { cont ->
            MediaScannerConnection.scanFile(env.appContext, arrayOf(target.path), arrayOf(item.mime)) { _, u -> cont.resume(u) }
        }
        return result((uri ?: Uri.fromFile(target)).toString(), target.name, target.length(), dir)
    }

    /** 分块拷贝，响应取消 */
    private suspend fun copy(src: File, out: java.io.OutputStream) {
        src.inputStream().use { input ->
            val buf = ByteArray(COPY_BUF)
            while (true) {
                coroutineContext.ensureActive()
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
            }
        }
    }

    /** 24~28 上确保有写权限，没有就申请，被拒返回 PERMISSION_DENIED */
    private suspend fun ensureLegacyPermission() {
        val perm = Manifest.permission.WRITE_EXTERNAL_STORAGE
        if (env.appContext.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED) return
        if (!env.host.requestPermission(perm)) throw BridgeException(BridgeErrors.PERMISSION_DENIED, "需要存储写入权限才能保存到相册")
    }

    /** 组装结果条目 */
    private fun result(uri: String, name: String, size: Long, dir: String) =
        JSONObject().put("uri", uri).put("name", name).put("size", size).put("dir", dir)

    /** 按扩展名猜 mime */
    private fun mimeOf(file: File): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "application/octet-stream"

    /** 按 mime 分类 */
    private fun kindOf(mime: String): Kind = when {
        mime.startsWith("image/") -> Kind.IMAGE
        mime.startsWith("video/") -> Kind.VIDEO
        mime.startsWith("audio/") -> Kind.AUDIO
        else -> Kind.OTHER
    }

    /**
     * 保存类别：对应公共目录名与 MediaStore 集合。
     *
     * @property dirType 公共目录名
     */
    private enum class Kind(val dirType: String) {
        /** 图片 */
        IMAGE(Environment.DIRECTORY_PICTURES),

        /** 视频 */
        VIDEO(Environment.DIRECTORY_MOVIES),

        /** 音频 */
        AUDIO(Environment.DIRECTORY_MUSIC),

        /** 其他，进 Download */
        OTHER(Environment.DIRECTORY_DOWNLOADS);

        /** 对应的 MediaStore 集合，仅 API 29+ 调用 */
        @android.annotation.SuppressLint("NewApi")
        fun collection(): Uri = when (this) {
            IMAGE -> MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            VIDEO -> MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            AUDIO -> MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            OTHER -> MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        }
    }

    private companion object {
        /** 单次保存的文件数上限 */
        const val MAX_ITEMS = 100

        /** 拷贝缓冲区大小 */
        const val COPY_BUF = 64 * 1024
    }
}
