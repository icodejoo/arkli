package com.let188.arkli.system

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.ActivityHost
import com.let188.arkli.image.SourceResolver
import com.let188.arkli.files.requireMainFrame
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/** 剪贴板敏感标记的键：API 33+ 取系统常量，24~32 用同名字面量（二者值相同，分开写是为了契约清楚）。纯函数，可单测 */
internal object ClipboardKeys {
    /** API 33 之前的敏感标记键 */
    const val LEGACY_SENSITIVE = "android.content.extra.IS_SENSITIVE"

    /** 引入 `ClipDescription.EXTRA_IS_SENSITIVE` 的 API 级别 */
    private const val SDK_SENSITIVE = 33

    /**
     * 敏感标记用哪个键。
     *
     * @param sdk 当前 API 级别
     * @return 键名
     */
    fun sensitiveKey(sdk: Int): String =
        if (sdk >= SDK_SENSITIVE) ClipDescription.EXTRA_IS_SENSITIVE else LEGACY_SENSITIVE
}

/**
 * `native.clipboard.write`：`{ text: string, sensitive?: boolean }` -> `{ written: true }`。
 * `sensitive` 为 true 时给剪贴板内容打上敏感标记，系统预览会隐藏内容。
 *
 * @param context 应用上下文
 */
internal class ClipboardWriteHandler(private val context: Context) : BridgeHandler {
    /** 写剪贴板（主线程执行） */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val text = SystemParams.string(params, "text")
        if (text.length > MAX_TEXT) throw BridgeException(BridgeErrors.BAD_PARAMS, "text 超过 $MAX_TEXT 字符")
        val sensitive = SystemParams.boolOrNull(params, "sensitive") ?: false
        withContext(Dispatchers.Main) {
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = ClipData.newPlainText(CLIP_LABEL, text)
            if (sensitive) {
                clip.description.extras = PersistableBundle().apply { putBoolean(ClipboardKeys.sensitiveKey(Build.VERSION.SDK_INT), true) }
            }
            try {
                cm.setPrimaryClip(clip)
            } catch (e: SecurityException) {
                throw BridgeException(BridgeErrors.PERMISSION_DENIED, "系统拒绝写入剪贴板")
            }
        }
        return JSONObject().put("written", true)
    }

    private companion object {
        /** 剪贴板内容标签 */
        const val CLIP_LABEL = "arkli"

        /** 写入文本上限，远低于 Binder 事务上限（约 1MB） */
        const val MAX_TEXT = 200_000
    }
}

/**
 * `native.clipboard.read`：无参 -> `{ text: string | null }`。
 * Android 10+ 应用不在前台或剪贴板为空/非文本时拿不到，一律返回 null，不抛错。
 *
 * @param context 应用上下文
 */
internal class ClipboardReadHandler(private val context: Context) : BridgeHandler {
    /** 读剪贴板（主线程执行） */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val text = withContext(Dispatchers.Main) {
            try {
                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = cm.primaryClip
                if (clip == null || clip.itemCount == 0) null else clip.getItemAt(0).coerceToText(context)?.toString()
            } catch (e: Exception) {
                null
            }
        }
        return JSONObject().put("text", text ?: JSONObject.NULL)
    }
}

/**
 * 校验通过的分享请求。
 *
 * @property text 要分享的文本，可为 null
 * @property path 缓存相对路径，可为 null
 * @property mime 内容类型
 * @property title 选择器标题，可为 null
 */
internal class ShareSpec(val text: String?, val path: String?, val mime: String, val title: String?)

/** `native.share` 的参数校验，纯函数，可单测 */
internal object ShareParams {
    /** 文本分享的默认类型 */
    const val MIME_TEXT = "text/plain"

    /** 无法判断的文件默认类型 */
    const val MIME_BINARY = "application/octet-stream"

    /** 分享文本上限 */
    const val MAX_TEXT = 200_000

    /** 标题上限 */
    const val MAX_TITLE = 200

    /**
     * 校验分享参数。
     *
     * @param text 文本，可空
     * @param path 缓存相对路径，可空
     * @param mime 调用方指定的类型，可空；缺省时有 path 按扩展名猜，纯文本用 text/plain
     * @param title 选择器标题，可空
     * @param guess 按路径猜 mime 的函数，猜不出返回 null
     * @return 规范化后的请求
     * @throws IllegalArgumentException text 与 path 都没给，或长度超限
     */
    fun parse(text: String?, path: String?, mime: String?, title: String?, guess: (String) -> String?): ShareSpec {
        val t = text?.takeIf { it.isNotEmpty() }
        val p = path?.takeIf { it.isNotEmpty() }
        require(t != null || p != null) { "text 和 path 至少要给一个" }
        require(t == null || t.length <= MAX_TEXT) { "text 超过 $MAX_TEXT 字符" }
        require(title == null || title.length <= MAX_TITLE) { "title 超过 $MAX_TITLE 字符" }
        val m = mime?.takeIf { it.isNotEmpty() } ?: if (p != null) (guess(p) ?: MIME_BINARY) else MIME_TEXT
        require(m.count { it == '/' } == 1 && m.none { it.isWhitespace() }) { "mime 格式不对" }
        return ShareSpec(t, p, m, title?.takeIf { it.isNotEmpty() })
    }
}

/**
 * `native.share`：`{ text?, path?, mime?, title?, thumb? }`（`thumb` 为缓存里的图片，作纯文字分享的预览缩略图）-> `{ started: boolean }`。
 * 文件走 FileProvider 发 `content://` URI，只有缓存 `arkli/out/` 下的文件可分享；`started` 为 false 表示没能拉起选择器。
 *
 * @param context 应用上下文
 * @param host 启动 Intent 的宿主
 * @param resolver 缓存相对路径解析，必须拒绝路径穿越
 */
internal class ShareHandler(
    private val context: Context,
    private val host: ActivityHost,
    private val resolver: SourceResolver,
) : BridgeHandler {
    /** 校验、组 Intent 并拉起系统分享面板 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val spec = SystemParams.validated {
            ShareParams.parse(
                SystemParams.stringOrNull(params, "text"), SystemParams.stringOrNull(params, "path"),
                SystemParams.stringOrNull(params, "mime"), SystemParams.stringOrNull(params, "title"),
            ) { MimeTypeMap.getSingleton().getMimeTypeFromExtension(File(it).extension.lowercase()) }
        }
        val send = Intent(Intent.ACTION_SEND).setType(spec.mime)
        spec.text?.let { send.putExtra(Intent.EXTRA_TEXT, it) }
        spec.path?.let { send.attachFile(it, context, resolver) }
        // 纯文字分享时，缩略图只挂在 ClipData 上（不挂 EXTRA_STREAM，免得被当成图片分享）
        val thumb = SystemParams.stringOrNull(params, "thumb")
        if (thumb != null && spec.path == null) send.attachThumb(thumb, context, resolver)
        // 分享面板预览（API 29+）优先显示 EXTRA_TITLE，不给就只显示文件名
        spec.title?.let { send.putExtra(Intent.EXTRA_TITLE, it) }
        val chooser = Intent.createChooser(send, spec.title)
        return JSONObject().put("started", host.startIntent(chooser))
    }

    /** 把缓存文件转成 FileProvider URI，路径无效或不在可分享目录抛 BAD_PARAMS */
    private fun uriOf(path: String, context: Context, resolver: SourceResolver): Pair<File, Uri> {
        val file = resolver.resolve(path)
        if (file == null || !file.isFile) throw BridgeException(BridgeErrors.BAD_PARAMS, "path 无效或文件不存在：$path")
        val uri: Uri = try {
            FileProvider.getUriForFile(context, "${context.packageName}$AUTHORITY_SUFFIX", file)
        } catch (e: IllegalArgumentException) {
            throw BridgeException(BridgeErrors.BAD_PARAMS, "该文件不在可分享目录：$path")
        }
        return file to uri
    }

    /** 把缓存文件以 FileProvider URI 挂到分享 Intent 上 */
    private fun Intent.attachFile(path: String, context: Context, resolver: SourceResolver) {
        val (file, uri) = uriOf(path, context, resolver)
        putExtra(Intent.EXTRA_STREAM, uri)
        clipData = ClipData.newRawUri(file.name, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    /** 把缓存里的图片挂成分享预览缩略图（仅 ClipData，API 29+ 的系统面板会读） */
    private fun Intent.attachThumb(path: String, context: Context, resolver: SourceResolver) {
        val (file, uri) = uriOf(path, context, resolver)
        clipData = ClipData.newRawUri(file.name, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    private companion object {
        /** FileProvider authority 后缀，与清单一致 */
        const val AUTHORITY_SUFFIX = ".fileprovider"
    }
}

/**
 * `native.settings.open`：`{ page }` -> `{ opened: boolean }`。page 见 [SettingsPages]，不在白名单抛 BAD_PARAMS。
 *
 * @param context 应用上下文，取包名
 * @param host 启动 Intent 的宿主
 */
internal class SettingsOpenHandler(private val context: Context, private val host: ActivityHost) : BridgeHandler {
    /** 解析页面并拉起系统设置 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val page = SystemParams.string(params, "page")
        val action = SettingsPages.actionOf(page, Build.VERSION.SDK_INT)
            ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "不支持的 page：$page，可选 ${SettingsPages.ACTIONS.keys.joinToString("/")}")
        val intent = Intent(action)
        if (SettingsPages.needsPackageUri(action)) intent.data = Uri.fromParts("package", context.packageName, null)
        // 通知设置页要带包名 extra
        if (page == SettingsPages.PAGE_NOTIFICATION && action != SettingsPages.ACTIONS[SettingsPages.PAGE_APP]) {
            intent.putExtra("android.provider.extra.APP_PACKAGE", context.packageName)
        }
        return JSONObject().put("opened", host.startIntent(intent))
    }
}

/**
 * `native.intent.open`：`{ kind, value }` -> `{ opened: boolean }`。校验见 [IntentPolicy]，不合法抛 BAD_PARAMS；
 * 没有能处理的应用时 `opened` 为 false。
 *
 * @param host 启动 Intent 的宿主
 */
internal class IntentOpenHandler(private val host: ActivityHost) : BridgeHandler {
    /** 校验后拉起外部应用 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val kind = SystemParams.string(params, "kind")
        val value = SystemParams.string(params, "value")
        val target = SystemParams.validated { IntentPolicy.validate(kind, value) }
        val intent = Intent(target.action, Uri.parse(target.uri))
        return JSONObject().put("opened", host.startIntent(intent))
    }
}

/**
 * `native.intent.processText`：`{ text }` -> `{ handled: boolean }`。把文本交给已安装的翻译等「处理文本」应用，没有则 `handled: false`。
 *
 * @param host 启动 Intent 的宿主
 */
internal class ProcessTextHandler(private val host: ActivityHost) : BridgeHandler {
    /** 拉起处理文本的应用 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val text = SystemParams.string(params, "text")
        if (text.isEmpty() || text.length > MAX_TEXT) throw BridgeException(BridgeErrors.BAD_PARAMS, "text 需要 1~$MAX_TEXT 字符")
        val intent = Intent(Intent.ACTION_PROCESS_TEXT).setType(ShareParams.MIME_TEXT)
            .putExtra(Intent.EXTRA_PROCESS_TEXT, text)
            .putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, true)
        return JSONObject().put("handled", host.startIntent(intent))
    }

    private companion object {
        /** 处理文本长度上限 */
        const val MAX_TEXT = 50_000
    }
}
