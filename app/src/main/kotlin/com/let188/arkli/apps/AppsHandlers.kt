package com.let188.arkli.apps

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.ActivityHost
import com.let188.arkli.files.FileRoots
import com.let188.arkli.files.FileNames
import com.let188.arkli.files.SizeLimitException
import com.let188.arkli.files.StreamCopy
import com.let188.arkli.files.requireMainFrame
import com.let188.arkli.system.SystemParams
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.text.Collator
import java.util.Locale
import java.util.UUID

/** 子目录名里随机串的长度 */
private const val DIR_ID_LENGTH = 8

/** 图标缓存文件的扩展名 */
private const val ICON_EXT = ".png"

/** 图标 PNG 质量参数（PNG 无损，系统忽略该值） */
private const val ICON_PNG_QUALITY = 100

/**
 * 应用信息读取：只能看到清单 `<queries>` 声明的那一类（可启动应用）和本应用自己。
 *
 * @param context 应用上下文
 */
internal class AppRepository(context: Context) {
    /** 包管理器 */
    private val pm: PackageManager = context.packageManager

    /**
     * 列出可启动应用。
     *
     * @param includeSystem 是否包含系统应用
     * @return 按应用名排序（中文按拼音）的列表
     */
    @Suppress("DEPRECATION")
    fun list(includeSystem: Boolean): List<AppItem> {
        val query = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val pkgs = pm.queryIntentActivities(query, 0).mapNotNull { it.activityInfo?.packageName }.distinct()
        val items = pkgs.mapNotNull { pkg -> info(pkg) }.filter { includeSystem || !it.isSystem }
        val collator = Collator.getInstance(Locale.CHINA)
        return AppsPolicy.sortByLabel(items, Comparator<String> { a, b -> collator.compare(a, b) })
    }

    /**
     * 读单个应用信息。
     *
     * @param pkg 包名
     * @return 信息；应用不存在或不可见返回 null
     */
    fun info(pkg: String): AppItem? {
        val pi = packageInfo(pkg) ?: return null
        val ai = pi.applicationInfo ?: return null
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) pi.longVersionCode else pi.versionCode.toLong()
        return AppItem(
            pkg = pkg,
            label = pm.getApplicationLabel(ai).toString(),
            versionName = pi.versionName.orEmpty(),
            versionCode = code,
            firstInstallMs = pi.firstInstallTime,
            lastUpdateMs = pi.lastUpdateTime,
            isSystem = ai.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0,
            apkBytes = File(ai.sourceDir.orEmpty()).length(),
        )
    }

    /** base APK 文件；应用不存在返回 null */
    fun apkFile(pkg: String): File? = packageInfo(pkg)?.applicationInfo?.sourceDir?.let { File(it) }

    /** 启动 Intent；应用没有启动入口返回 null */
    fun launchIntent(pkg: String): Intent? = pm.getLaunchIntentForPackage(pkg)

    /**
     * 把应用图标画成方形位图（自适应图标也会被画出来）。
     *
     * @param pkg 包名
     * @param size 边长（像素）
     * @return 位图；应用不存在返回 null
     */
    fun iconBitmap(pkg: String, size: Int): Bitmap? {
        val drawable = try {
            pm.getApplicationIcon(pkg)
        } catch (e: PackageManager.NameNotFoundException) {
            return null
        }
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        drawable.setBounds(0, 0, size, size)
        drawable.draw(Canvas(bmp))
        return bmp
    }

    /** 取包信息，不存在或不可见返回 null */
    private fun packageInfo(pkg: String): PackageInfo? = try {
        pm.getPackageInfo(pkg, 0)
    } catch (e: PackageManager.NameNotFoundException) {
        null
    }
}

/** 读并校验必填的 pkg 参数 */
private fun pkgParam(params: JSONObject): String =
    SystemParams.validated { AppsPolicy.requirePackage(SystemParams.string(params, "pkg")) }

/** 应用不存在或不可见时抛 BAD_PARAMS */
private fun missing(pkg: String): Nothing = throw BridgeException(BridgeErrors.BAD_PARAMS, "找不到应用或不可见：$pkg")

/**
 * `native.apps.list`：`{ includeSystem?: boolean = false }` ->
 * `{ items: [{ pkg, label, versionName, versionCode, firstInstallMs, lastUpdateMs, isSystem, apkBytes }] }`，按应用名排序。
 * 只列出可启动应用（清单 `<queries>` 的限制，没有申请查询全部应用的权限）。
 *
 * @param repo 应用信息读取器
 */
internal class AppsListHandler(private val repo: AppRepository) : BridgeHandler {
    /** 在 IO 线程列出应用 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val includeSystem = SystemParams.boolOrNull(params, "includeSystem") ?: false
        val items = withContext(Dispatchers.IO) { repo.list(includeSystem) }
        return JSONObject().put("items", AppsPolicy.toJson(items))
    }
}

/**
 * `native.apps.open`：`{ pkg }` -> `{ opened: boolean }`，应用没有启动入口时为 false。
 *
 * @param repo 应用信息读取器
 * @param host 启动 Intent 的宿主
 */
internal class AppsOpenHandler(private val repo: AppRepository, private val host: ActivityHost) : BridgeHandler {
    /** 启动目标应用 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val intent = repo.launchIntent(pkgParam(params))
        return JSONObject().put("opened", intent != null && host.startIntent(intent))
    }
}

/**
 * `native.apps.settings`：`{ pkg }` -> `{ opened: boolean }`。打开系统的应用详情页，用户可在那里卸载；本方法不直接卸载。
 *
 * @param host 启动 Intent 的宿主
 */
internal class AppsSettingsHandler(private val host: ActivityHost) : BridgeHandler {
    /** 拉起应用详情页 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val pkg = pkgParam(params)
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", pkg, null))
        return JSONObject().put("opened", host.startIntent(intent))
    }
}

/**
 * `native.apps.exportApk`：`{ pkg }` -> `{ path, name, bytes }`。把 base APK 拷到缓存 `out/`，文件名 `<应用名>_<版本名>.apk`。
 * 超过 300MB 返回 BAD_PARAMS；拷贝可被取消，失败或取消会清掉残留文件。分包安装（split APK）的应用只导出 base。
 *
 * @param repo 应用信息读取器
 * @param outDir 缓存 `out/` 目录
 * @param roots 目录根，用来把文件转成页面路径
 */
internal class AppsExportHandler(
    private val repo: AppRepository,
    private val outDir: File,
    private val roots: FileRoots,
) : BridgeHandler {
    /** 分块拷贝安装包 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val pkg = pkgParam(params)
        val info = repo.info(pkg) ?: missing(pkg)
        val src = repo.apkFile(pkg) ?: missing(pkg)
        SystemParams.validated { AppsPolicy.requireApkSize(src.length()) }
        val file = withContext(Dispatchers.IO) {
            val dir = File(outDir, "apk-" + UUID.randomUUID().toString().take(DIR_ID_LENGTH)).apply { mkdirs() }
            val target = FileNames.unique(dir, AppsPolicy.apkFileName(info.label, info.versionName, pkg))
            try {
                FileInputStream(src).use { input ->
                    FileOutputStream(target).use { out -> StreamCopy.copy(input, out, AppsPolicy.MAX_APK_BYTES) { ensureActive() } }
                }
            } catch (e: SizeLimitException) {
                target.delete()
                throw BridgeException(BridgeErrors.BAD_PARAMS, "安装包超过 ${AppsPolicy.MAX_APK_BYTES shr 20}MB，不支持导出")
            } catch (e: Throwable) {
                target.delete()
                dir.delete()
                throw e
            }
            target
        }
        val path = roots.pagePathOf(file) ?: throw BridgeException(BridgeErrors.INTERNAL, "产物不在缓存目录内")
        return JSONObject().put("path", path).put("name", file.name).put("bytes", file.length())
    }
}

/**
 * `native.apps.icon`：`{ pkg, size?: 48~192 = 96 }` -> `{ path }`。把应用图标渲染成 PNG 放进缓存 `out/`，
 * 同包同尺寸且应用没更新过时复用已有文件。
 *
 * @param repo 应用信息读取器
 * @param iconDir 图标缓存目录（缓存 `out/` 下）
 * @param roots 目录根，用来把文件转成页面路径
 */
internal class AppsIconHandler(
    private val repo: AppRepository,
    private val iconDir: File,
    private val roots: FileRoots,
) : BridgeHandler {
    /** 渲染或复用图标 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val pkg = pkgParam(params)
        val sizeValue = params.opt("size")
        val size = SystemParams.validated {
            AppsPolicy.iconSize(if (sizeValue == null || sizeValue == JSONObject.NULL) null else SystemParams.number(params, "size"))
        }
        val info = repo.info(pkg) ?: missing(pkg)
        val file = withContext(Dispatchers.IO) {
            iconDir.mkdirs()
            val f = File(iconDir, "${pkg}_$size$ICON_EXT")
            if (!f.isFile || f.lastModified() < info.lastUpdateMs) {
                val bmp = repo.iconBitmap(pkg, size) ?: missing(pkg)
                try {
                    FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.PNG, ICON_PNG_QUALITY, it) }
                } catch (e: Throwable) {
                    f.delete()
                    throw e
                } finally {
                    bmp.recycle()
                }
            }
            f
        }
        val path = roots.pagePathOf(file) ?: throw BridgeException(BridgeErrors.INTERNAL, "产物不在缓存目录内")
        return JSONObject().put("path", path)
    }
}
