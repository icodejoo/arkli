package com.let188.arkli.shortcut

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.net.Uri
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.requireMainFrame
import com.let188.arkli.system.SystemParams
import org.json.JSONObject

/** 图标位图边长（像素），系统会再缩放 */
private const val ICON_SIZE_PX = 192

/** 圆角半径占边长的比例 */
private const val ICON_CORNER_RATIO = 0.22f

/** 首字字号占边长的比例 */
private const val ICON_TEXT_RATIO = 0.5f

/** 不支持固定快捷方式时的 reason */
private const val REASON_UNSUPPORTED = "unsupported"

/**
 * 生成「圆角色块 + 首字」图标。
 *
 * @param label 名称，取首字与底色
 * @param glyph 要画的字符（如 emoji），为空则取 label 首字
 * @param background 底色，为空则按名称取色
 * @return 位图
 */
internal fun renderShortcutIcon(label: String, glyph: String? = null, background: Int? = null): Bitmap {
    val bmp = Bitmap.createBitmap(ICON_SIZE_PX, ICON_SIZE_PX, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bmp)
    val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = background ?: ShortcutPolicy.colorOf(label) }
    val radius = ICON_SIZE_PX * ICON_CORNER_RATIO
    canvas.drawRoundRect(RectF(0f, 0f, ICON_SIZE_PX.toFloat(), ICON_SIZE_PX.toFloat()), radius, radius, bg)
    val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFFFFFFF.toInt()
        textSize = ICON_SIZE_PX * ICON_TEXT_RATIO
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
    }
    // 文字基线居中：中心减去上下伸展的一半
    val baseline = ICON_SIZE_PX / 2f - (text.descent() + text.ascent()) / 2f
    canvas.drawText(glyph ?: ShortcutPolicy.glyphOf(label), ICON_SIZE_PX / 2f, baseline, text)
    return bmp
}

/**
 * `native.shortcut.pin`：`{ id, label(≤24), url(http/https) }` -> `{ requested: boolean, reason?: "unsupported" }`。
 * `requested` 为 true 表示系统弹窗已发出，是否真的添加由用户在桌面确认，拿不到结果。
 *
 * @param context 应用上下文
 */
internal class ShortcutPinHandler(private val context: Context) : BridgeHandler {
    /** 校验后请求固定快捷方式 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val spec = SystemParams.validated {
            ShortcutPolicy.parse(SystemParams.string(params, "id"), SystemParams.string(params, "label"), SystemParams.string(params, "url"))
        }
        if (!ShortcutManagerCompat.isRequestPinShortcutSupported(context)) {
            return JSONObject().put("requested", false).put("reason", REASON_UNSUPPORTED)
        }
        val info = ShortcutInfoCompat.Builder(context, spec.id)
            .setShortLabel(spec.label)
            .setLongLabel(spec.label)
            .setIcon(IconCompat.createWithBitmap(renderShortcutIcon(spec.label)))
            .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse(spec.url)))
            .build()
        val requested = ShortcutManagerCompat.requestPinShortcut(context, info, null)
        return JSONObject().put("requested", requested).also { if (!requested) it.put("reason", REASON_UNSUPPORTED) }
    }
}

/** 工具图标的浅色底，emoji 在上面清晰 */
private const val TOOL_ICON_BACKGROUND = 0xFFF2F4F7.toInt()

/** 拉起工具页的 Intent action */
const val ACTION_OPEN_TOOL = "com.let188.arkli.OPEN_TOOL"

/** 工具页路由的 Intent extra 名 */
const val EXTRA_ROUTE = "route"

/**
 * `native.shortcut.pinTool`：`{ label(≤24), icon(emoji), route(/tool/<id>) }` -> `{ requested: boolean, reason?: "unsupported" }`。
 * 桌面图标点开后直接进 App 内对应工具页；同一工具重复固定只会更新。
 *
 * @param context 应用上下文
 */
internal class ShortcutPinToolHandler(private val context: Context) : BridgeHandler {
    /** 校验后请求固定快捷方式 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val spec = SystemParams.validated {
            ShortcutPolicy.parseTool(SystemParams.string(params, "label"), SystemParams.string(params, "icon"), SystemParams.string(params, "route"))
        }
        if (!ShortcutManagerCompat.isRequestPinShortcutSupported(context)) {
            return JSONObject().put("requested", false).put("reason", REASON_UNSUPPORTED)
        }
        val intent = Intent(ACTION_OPEN_TOOL)
            .setComponent(ComponentName(context, "com.let188.arkli.MainActivity"))
            .putExtra(EXTRA_ROUTE, spec.route)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val info = ShortcutInfoCompat.Builder(context, spec.id)
            .setShortLabel(spec.label)
            .setLongLabel(spec.label)
            .setIcon(IconCompat.createWithBitmap(renderShortcutIcon(spec.label, spec.icon, TOOL_ICON_BACKGROUND)))
            .setIntent(intent)
            .build()
        val requested = ShortcutManagerCompat.requestPinShortcut(context, info, null)
        return JSONObject().put("requested", requested).also { if (!requested) it.put("reason", REASON_UNSUPPORTED) }
    }
}
