package com.let188.arkli.picker

import androidx.annotation.DrawableRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.let188.arkli.R

/**
 * 悬浮图标按钮的图标种类。图形都在 `res/drawable/ic_*.xml`（VectorDrawable），
 * 想改形状改对应的 XML，想改大小改 [FabStyle.ICON]。
 *
 * @property res 图标资源
 */
internal enum class FabIcon(@DrawableRes val res: Int) {
    /** 相机：切到拍照 */
    CAMERA(R.drawable.ic_camera),

    /** 相册：切到相册 */
    ALBUM(R.drawable.ic_album),
}

/** 悬浮图标按钮的统一外观：拍照页与相册页共用，保证位置、大小、颜色一致 */
private object FabStyle {
    /** 按钮外边距 */
    val MARGIN = 20.dp

    /** 按钮直径 */
    val SIZE = 56.dp

    /** 图标边长 */
    val ICON = 28.dp

    /** 底色，与前端 vant 主色一致 */
    val BG = Color(0xFF1989FA)

    /** 图标颜色 */
    val FG = Color.White
}

/**
 * 右下角悬浮图标按钮：拍照页的“相册”与相册页的“拍照”都用它，放在 `BottomEnd`，外观完全一致。
 *
 * @param icon 图标种类
 * @param description 无障碍描述，如“相册”“拍照”
 * @param modifier 外部修饰，通常带 `Modifier.align(Alignment.BottomEnd)`
 * @param onClick 点击回调
 *
 * 使用示例：`IconFab(FabIcon.ALBUM, "相册", Modifier.align(Alignment.BottomEnd)) { open() }`
 */
@Composable
internal fun IconFab(icon: FabIcon, description: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier.navigationBarsPadding().padding(FabStyle.MARGIN).size(FabStyle.SIZE).clip(CircleShape)
            .background(FabStyle.BG)
            .semantics { contentDescription = description }
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painterResource(icon.res), contentDescription = null,
            modifier = Modifier.size(FabStyle.ICON), colorFilter = ColorFilter.tint(FabStyle.FG),
        )
    }
}

/**
 * 顶栏图标的种类与显示大小。形状在 `res/drawable/ic_*.xml`，大小在这里调。
 *
 * @property res 图标资源
 * @property size 显示边长；各图标的矢量画布不同，这里按视觉大小对齐
 */
internal enum class Glyph(@DrawableRes val res: Int, val size: Dp) {
    /** 关闭/取消：叉 */
    CLOSE(R.drawable.ic_close, 24.dp),

    /** 完成/确认：勾 */
    CHECK(R.drawable.ic_check, 24.dp),

    /** 编辑：铅笔 */
    EDIT(R.drawable.ic_edit, 24.dp),

    /** 还原：回退箭头 */
    RESTORE(R.drawable.ic_restore, 24.dp),

    /** 翻转镜头：画布 48，边长 32.5dp（原 21.67dp 的 1.5 倍） */
    FLIP(R.drawable.ic_camera_flip, 32.5.dp),
}

/** 顶栏图标按钮的点击热区边长 */
private val GLYPH_TOUCH = 44.dp

/**
 * 顶栏图标按钮：无底色，只显示一个线条图标，用来替代“取消/完成/翻转”这类文字按钮。
 *
 * @param glyph 图标种类
 * @param description 无障碍描述，如“取消”“完成”
 * @param tint 图标颜色
 * @param modifier 外部修饰
 * @param enabled 是否可点；不可点时由调用方用 [tint] 表现置灰
 * @param onClick 点击回调
 *
 * 使用示例：`GlyphButton(Glyph.CLOSE, "取消", Color.White) { cancel() }`
 */
@Composable
internal fun GlyphButton(
    glyph: Glyph,
    description: String,
    tint: Color,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Box(
        modifier.size(GLYPH_TOUCH).clip(CircleShape)
            .semantics { contentDescription = description }
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painterResource(glyph.res), contentDescription = null,
            modifier = Modifier.size(glyph.size), colorFilter = ColorFilter.tint(tint),
        )
    }
}
