package com.let188.arkli.wallpaper

import android.app.WallpaperManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.FileConst
import com.let188.arkli.files.FileRoots
import com.let188.arkli.files.requireMainFrame
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/** 壁纸输出子目录（缓存 `out/` 下） */
private const val WALLPAPER_DIR = "wallpaper"

/** 壁纸输出文件名前缀，每次带时间戳，避免页面缓存到旧图 */
private const val WALLPAPER_PREFIX = "wallpaper-"

/** 壁纸输出扩展名 */
private const val WALLPAPER_EXT = ".png"

/** PNG 质量参数（PNG 无损，系统忽略） */
private const val PNG_QUALITY = 100

/** 读到的壁纸位图与来源 */
private class WallpaperBitmap(val bitmap: Bitmap, val fromFile: Boolean)

/**
 * `native.wallpaper.get`：`{}` ->
 * `{ available: true, path, width, height, kind: "current"|"default" }` 或
 * `{ available: false, reason: "restricted"|"unsupported"|"error", message }`。
 *
 * 尽力读取：先试壁纸文件（当前壁纸），再退到 WallpaperManager 的 Drawable。API 33+ 系统通常只给默认壁纸，
 * 甚至直接抛 SecurityException。任何异常都转成 `available:false`，不抛错；不申请新权限。
 * 成功后压成 PNG 写入缓存 `out/wallpaper/`，像素超过 2400 万会缩小。
 *
 * @param context 应用上下文
 * @param roots 目录根，用来把文件转成页面路径
 */
internal class WallpaperGetHandler(private val context: Context, private val roots: FileRoots) : BridgeHandler {
    /** 读取并落盘；协程取消照常向上抛，其余异常都转成不可用 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return try {
            withContext(Dispatchers.IO) { fetch() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            unavailable(WallpaperPolicy.classify(e))
        }
    }

    /** 读取壁纸、写文件，返回响应 */
    private fun fetch(): JSONObject {
        val wm = WallpaperManager.getInstance(context)
        if (!wm.isWallpaperSupported) return unavailable(WallpaperFailure.UNSUPPORTED)
        val got = readBitmap(wm) ?: return unavailable(WallpaperFailure.ERROR)
        val bmp = got.bitmap
        val dir = File(File(roots.cacheRoot, FileConst.DIR_OUT), WALLPAPER_DIR).apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val file = File(dir, WALLPAPER_PREFIX + System.currentTimeMillis() + WALLPAPER_EXT)
        try {
            FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.PNG, PNG_QUALITY, it) }
        } catch (e: Throwable) {
            file.delete()
            throw e
        }
        val path = roots.pagePathOf(file) ?: return unavailable(WallpaperFailure.ERROR)
        return JSONObject().put("available", true).put("path", path).put("width", bmp.width).put("height", bmp.height)
            .put("kind", WallpaperPolicy.kindOf(Build.VERSION.SDK_INT, got.fromFile))
    }

    /**
     * 读位图：壁纸文件优先，失败再试 Drawable。
     * 安全异常只在两条路都失败时才报，避免文件路径被拒、Drawable 路径可用时误报。
     */
    private fun readBitmap(wm: WallpaperManager): WallpaperBitmap? {
        var denied: Throwable? = null
        try {
            decodeFile(wm)?.let { return WallpaperBitmap(it, true) }
        } catch (e: SecurityException) {
            denied = e
        } catch (e: RuntimeException) {
            // 文件路径读不了就退到 Drawable
        }
        try {
            val drawable = wm.drawable ?: return null
            return WallpaperBitmap(toBitmap(drawable), false)
        } catch (e: SecurityException) {
            throw denied ?: e
        }
    }

    /** 从壁纸文件解码，按像素上限采样；没有文件（默认壁纸）返回 null */
    private fun decodeFile(wm: WallpaperManager): Bitmap? {
        val pfd = wm.getWallpaperFile(WallpaperManager.FLAG_SYSTEM) ?: return null
        pfd.use {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFileDescriptor(it.fileDescriptor, null, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            val opts = BitmapFactory.Options().apply { inSampleSize = WallpaperPolicy.sampleSize(bounds.outWidth, bounds.outHeight) }
            return BitmapFactory.decodeFileDescriptor(it.fileDescriptor, null, opts)
        }
    }

    /** Drawable 转位图，超过像素上限按比例缩小 */
    private fun toBitmap(d: Drawable): Bitmap {
        val w = d.intrinsicWidth.coerceAtLeast(1)
        val h = d.intrinsicHeight.coerceAtLeast(1)
        val scale = WallpaperPolicy.scaleFor(w, h)
        if (scale >= 1.0 && d is BitmapDrawable && d.bitmap != null) return d.bitmap
        val tw = (w * scale).toInt().coerceAtLeast(1)
        val th = (h * scale).toInt().coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(tw, th, Bitmap.Config.ARGB_8888)
        d.setBounds(0, 0, tw, th)
        d.draw(Canvas(bmp))
        return bmp
    }

    /** 不可用的响应 */
    private fun unavailable(f: WallpaperFailure): JSONObject =
        JSONObject().put("available", false).put("reason", f.wire).put("message", WallpaperPolicy.message(f))
}
