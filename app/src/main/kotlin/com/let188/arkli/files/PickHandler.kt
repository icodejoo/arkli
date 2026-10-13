package com.let188.arkli.files

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.annotation.RequiresApi
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.SecureRandom
import kotlin.coroutines.coroutineContext
import kotlin.math.ceil
import kotlin.math.sqrt

/** 单个文件处理失败：不影响同批其他文件，进 `failed` 数组 */
private class PickFailure(message: String) : Exception(message)

/**
 * `native.file.pick`：打开系统选择器，把结果整理成页面能用的形式。
 *
 * - 图片：拷进缓存 `cache/pick/`，原样保留（含 EXIF，页面用 `imageOrientation: 'from-image'` 摆正）；
 *   HEIC/HEIF 用平台解码器转成 JPEG（API 28+，解码器已按容器信息摆正，输出不带 EXIF 方向）。
 * - 视频：不拷贝，返回不透明句柄 `uri:<id>`，真实 content URI 只留在原生侧。
 * - 其他文件（`mime` 不是图片/视频）：走系统文档选择器，≤ 64MB 拷进缓存。
 *
 * 参数：`{ mime?: string = 图片通配, multiple?: boolean = false, max?: number = 20 }`。
 * 返回：`{ items: [...], failed: [{ name, message }] }`，用户关闭选择器时 `items` 为空数组。
 *
 * @param env 文件环境
 * @param handles 本会话的不透明句柄表
 */
internal class PickHandler(private val env: FileEnv, private val handles: HandleTable<Uri>) : BridgeHandler {
    /** 内容解析器 */
    private val resolver = env.appContext.contentResolver

    /** 随机数，用来起缓存文件名 */
    private val random = SecureRandom()

    /** 处理一次选择 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val mime = params.optString("mime", MIME_IMAGE)
        if (!PickKind.isValid(mime)) throw BridgeException(BridgeErrors.BAD_PARAMS, "mime 格式不对：$mime")
        val multiple = params.optBoolean("multiple", false)
        val max = params.optInt("max", FileConst.DEFAULT_PICK_MAX).coerceIn(1, FileConst.PICK_MAX_LIMIT)
        val uris = env.host.pickMedia(mime, multiple, max).take(if (multiple) max else 1)
        val items = JSONArray()
        val failed = JSONArray()
        val made = ArrayList<File>()
        try {
            for (uri in uris) {
                coroutineContext.ensureActive()
                try {
                    items.put(withContext(Dispatchers.IO) { process(uri, made) })
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    failed.put(JSONObject().put("name", queryMeta(uri).first ?: "").put("message", e.message ?: "未知错误"))
                }
            }
        } catch (e: CancellationException) {
            // 被取消：已拷进缓存的文件页面永远拿不到，删掉
            made.forEach { it.delete() }
            throw e
        }
        return JSONObject().put("items", items).put("failed", failed)
    }

    /** 处理单个 URI，按 mime 分流 */
    private suspend fun process(uri: Uri, made: MutableList<File>): JSONObject {
        val (rawName, rawSize) = queryMeta(uri)
        val mime = resolver.getType(uri) ?: mimeFromName(rawName) ?: "application/octet-stream"
        val name = FileNames.sanitize(rawName ?: "file")
        return when {
            mime.startsWith("video/") -> videoItem(uri, name, mime, rawSize)
            mime.startsWith("image/") -> imageItem(uri, name, mime, made)
            else -> fileItem(uri, name, mime, rawSize, made)
        }
    }

    /** 视频：登记不透明句柄并读取基本信息，不拷贝 */
    private fun videoItem(uri: Uri, name: String, mime: String, size: Long?): JSONObject {
        val json = JSONObject().put("kind", "video").put("handle", handles.put(uri))
            .put("name", name).put("mime", mime).put("size", size ?: sizeOf(uri))
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(env.appContext, uri)
            val w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
            val h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
            val rot = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            val swap = rot == 90 || rot == 270
            if (w != null && h != null) json.put("width", if (swap) h else w).put("height", if (swap) w else h)
            r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?.let { json.put("durationMs", it) }
        } catch (_: Exception) {
            // 读不出元数据不算失败，句柄照样可用
        } finally {
            r.release()
        }
        return json
    }

    /** 图片：HEIC 转 JPEG，其余原样拷贝，再读尺寸与 EXIF 方向 */
    private suspend fun imageItem(uri: Uri, name: String, mime: String, made: MutableList<File>): JSONObject {
        if (FileNames.isHeif(mime)) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
                throw PickFailure("当前系统版本（Android ${Build.VERSION.RELEASE}）不支持 HEIC，请换用 JPEG 或 PNG 图片")
            }
            val dest = newFile("jpg", made)
            val (w, h) = heicToJpeg(uri, dest)
            return fileJson("image", dest, FileNames.replaceExt(name, "jpg"), "image/jpeg", w, h, 1)
        }
        val ext = name.substringAfterLast('.', "").lowercase().ifEmpty { FileNames.extForMime(mime) ?: "img" }
        val dest = newFile(ext, made)
        copyTo(uri, dest)
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(dest.path, opts)
        val orientation = if (mime == "image/jpeg") readOrientation(dest) else ExifInterface.ORIENTATION_NORMAL
        val swap = orientation in ORIENTATION_SWAP_MIN..ORIENTATION_SWAP_MAX
        val w = if (swap) opts.outHeight else opts.outWidth
        val h = if (swap) opts.outWidth else opts.outHeight
        return fileJson("image", dest, name, mime, w, h, orientation)
    }

    /** 其他文件：限大小后拷进缓存 */
    private suspend fun fileItem(uri: Uri, name: String, mime: String, size: Long?, made: MutableList<File>): JSONObject {
        val total = size ?: sizeOf(uri)
        if (total > FileConst.MAX_PICK_COPY_BYTES) throw PickFailure("文件超过 ${FileConst.MAX_PICK_COPY_BYTES shr 20}MB，暂不支持")
        val dest = newFile(name.substringAfterLast('.', "").lowercase().ifEmpty { "bin" }, made)
        copyTo(uri, dest)
        return fileJson("file", dest, name, mime, null, null, null)
    }

    /** HEIC 解码后写成 JPEG，返回最终宽高。像素过大时按采样率缩小防 OOM */
    @RequiresApi(Build.VERSION_CODES.P)
    private fun heicToJpeg(uri: Uri, dest: File): Pair<Int, Int> {
        val source = ImageDecoder.createSource(resolver, uri)
        val bitmap = try {
            ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                val pixels = info.size.width.toLong() * info.size.height
                if (pixels > FileConst.HEIC_MAX_DECODE_PIXELS) {
                    decoder.setTargetSampleSize(ceil(sqrt(pixels.toDouble() / FileConst.HEIC_MAX_DECODE_PIXELS)).toInt())
                }
            }
        } catch (e: Exception) {
            throw PickFailure("HEIC 解码失败：${e.message}")
        }
        try {
            FileOutputStream(dest).use { bitmap.compress(Bitmap.CompressFormat.JPEG, FileConst.JPEG_QUALITY, it) }
            return bitmap.width to bitmap.height
        } finally {
            bitmap.recycle()
        }
    }

    /** 读 JPEG 的 EXIF 方向，读不出按正常 */
    private fun readOrientation(file: File): Int = try {
        ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            .takeIf { it in ORIENTATION_MIN..ORIENTATION_SWAP_MAX } ?: ExifInterface.ORIENTATION_NORMAL
    } catch (_: Exception) {
        ExifInterface.ORIENTATION_NORMAL
    }

    /** 拷贝内容到缓存文件，分块并响应取消；出错时删掉残留 */
    private suspend fun copyTo(uri: Uri, dest: File) {
        try {
            val input = resolver.openInputStream(uri) ?: throw PickFailure("无法读取所选文件")
            input.use { src ->
                FileOutputStream(dest).use { out ->
                    val buf = ByteArray(COPY_BUF)
                    while (true) {
                        coroutineContext.ensureActive()
                        val n = src.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                    }
                }
            }
        } catch (e: Exception) {
            dest.delete()
            throw e
        }
    }

    /** 在 `pick/` 下起一个随机名新文件并登记，供取消时清理 */
    private fun newFile(ext: String, made: MutableList<File>): File {
        val dir = File(env.roots.cacheRoot, FileConst.DIR_PICK).apply { mkdirs() }
        val b = ByteArray(ID_BYTES)
        random.nextBytes(b)
        val file = File(dir, b.joinToString("") { "%02x".format(it) } + "." + ext.take(MAX_EXT))
        made += file
        return file
    }

    /** 组装一个文件条目 */
    private fun fileJson(kind: String, file: File, name: String, mime: String, w: Int?, h: Int?, orientation: Int?): JSONObject {
        val pagePath = env.roots.pagePathOf(file) ?: throw PickFailure("缓存路径异常")
        val json = JSONObject().put("kind", kind).put("path", pagePath).put("url", env.urlOf(pagePath))
            .put("name", name).put("mime", mime).put("size", file.length())
        if (w != null && h != null && w > 0 && h > 0) json.put("width", w).put("height", h)
        if (orientation != null) json.put("orientation", orientation)
        return json
    }

    /** 查显示名与大小，查不到返回 null */
    private fun queryMeta(uri: Uri): Pair<String?, Long?> {
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val name = c.getString(0)
                    val size = if (c.isNull(1)) null else c.getLong(1)
                    return name to size
                }
            }
        } catch (_: Exception) {
            // 部分 provider 不支持，当作未知
        }
        return null to null
    }

    /** 兜底取大小：打开文件描述符读 statSize */
    private fun sizeOf(uri: Uri): Long = try {
        resolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: 0L
    } catch (_: Exception) {
        0L
    }

    /** 按文件名扩展名猜 mime */
    private fun mimeFromName(name: String?): String? =
        name?.substringAfterLast('.', "")?.lowercase()?.takeIf { it.isNotEmpty() }
            ?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }

    private companion object {
        /** 默认只选图片 */
        const val MIME_IMAGE = "image/*"

        /** 拷贝缓冲区大小 */
        const val COPY_BUF = 64 * 1024

        /** 缓存文件名的随机字节数 */
        const val ID_BYTES = 8

        /** 扩展名最长保留字符数 */
        const val MAX_EXT = 8

        /** EXIF 方向合法值 1..8，其中 5..8 表示宽高互换 */
        const val ORIENTATION_MIN = 1
        const val ORIENTATION_SWAP_MIN = 5
        const val ORIENTATION_SWAP_MAX = 8
    }
}

/**
 * 敏感方法只接受主 frame 的调用。
 *
 * @param ctx 调用上下文
 * @throws BridgeException 非主 frame 时抛 PERMISSION_DENIED
 */
internal fun requireMainFrame(ctx: CallContext) {
    if (!ctx.isMainFrame) throw BridgeException(BridgeErrors.PERMISSION_DENIED, "仅主页面可调用")
}
