package com.let188.arkli.picker

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.LruCache
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 自带的多选图片页：相册网格，点图即选（右上角圆圈显示选中序号），点完按“完成”返回。
 * 系统选择器在部分机型上点一下就直接返回，这里统一成 checkbox 多选。
 * 需要相册读取权限；被拒时以 [PickerConst.RESULT_DENIED] 结束，由调用方回退到系统选择器。
 */
class ImagePickerActivity : ComponentActivity() {
    /** 最多可选张数 */
    private var maxCount = PickerConst.DEFAULT_MAX

    /** 是否已获得相册权限 */
    private var granted by mutableStateOf(false)

    /** 相册权限申请，被拒就回退 */
    private val permReq = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) granted = true else deny()
    }

    /** 创建界面：先确认权限，再显示网格 */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        maxCount = intent.getIntExtra(PickerConst.EXTRA_MAX, PickerConst.DEFAULT_MAX).coerceAtLeast(1)
        val perm = readPermission()
        if (checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED) granted = true else permReq.launch(perm)
        setContent { if (granted) PickerScreen() }
    }

    /** 当前系统版本对应的相册读取权限 */
    private fun readPermission(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.READ_MEDIA_IMAGES
        else Manifest.permission.READ_EXTERNAL_STORAGE

    /** 权限被拒：通知调用方回退 */
    private fun deny() {
        setResult(PickerConst.RESULT_DENIED)
        finish()
    }

    /** 带着选好的图片返回 */
    private fun finishWith(uris: List<Uri>) {
        setResult(Activity.RESULT_OK, Intent().putParcelableArrayListExtra(PickerConst.EXTRA_URIS, ArrayList(uris)))
        finish()
    }

    /** 选图主界面：顶栏 + 缩略图网格 */
    @Composable
    private fun PickerScreen() {
        val dark = isSystemInDarkTheme()
        val bg = if (dark) Color(0xFF121212) else Color.White
        val fg = if (dark) Color(0xFFEEEEEE) else Color(0xFF222222)
        val muted = fg.copy(alpha = MUTED_ALPHA)
        val resolver = contentResolver
        var images by remember { mutableStateOf<List<MediaImage>?>(null) }
        var selected by remember { mutableStateOf(emptyList<Long>()) }
        LaunchedEffect(Unit) { images = withContext(Dispatchers.IO) { MediaImages.list(resolver) } }
        val cache = remember {
            object : LruCache<Long, ImageBitmap>((Runtime.getRuntime().maxMemory() / PickerConst.CACHE_HEAP_DIVISOR).toInt()) {
                override fun sizeOf(key: Long, value: ImageBitmap): Int = value.width * value.height * BYTES_PER_PIXEL
            }
        }
        Column(Modifier.fillMaxSize().background(bg)) {
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Label("取消", fg, Modifier.clickable { finish() })
                Label("选择图片 ${selected.size}/$maxCount", fg, bold = true)
                Label(
                    "完成",
                    if (selected.isEmpty()) muted else ACCENT,
                    Modifier.clickable(enabled = selected.isNotEmpty()) {
                        val byId = images.orEmpty().associateBy { it.id }
                        finishWith(selected.mapNotNull { byId[it]?.uri })
                    },
                    bold = true,
                )
            }
            val list = images
            if (list.isNullOrEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Label(if (list == null) "加载中…" else "相册里没有图片", muted)
                }
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(PickerConst.GRID_COLUMNS),
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = WindowInsets.navigationBars.asPaddingValues(),
                    verticalArrangement = Arrangement.spacedBy(GRID_GAP),
                    horizontalArrangement = Arrangement.spacedBy(GRID_GAP),
                ) {
                    items(list, key = { it.id }) { img ->
                        Cell(img, PickSelection.orderOf(selected, img.id), cache) {
                            val next = PickSelection.toggle(selected, img.id, maxCount)
                            if (next == null) Toast.makeText(this@ImagePickerActivity, "最多选 $maxCount 张", Toast.LENGTH_SHORT).show()
                            else selected = next
                        }
                    }
                }
            }
        }
    }

    /** 一格缩略图：右上角圆圈，选中时填色并显示序号 */
    @Composable
    private fun Cell(img: MediaImage, order: Int, cache: LruCache<Long, ImageBitmap>, onClick: () -> Unit) {
        val resolver = contentResolver
        val thumb by produceState(cache.get(img.id), img.id) {
            if (value == null) {
                value = withContext(Dispatchers.IO) {
                    MediaImages.thumbnail(resolver, img.uri, PickerConst.THUMB_PX)?.asImageBitmap()
                }?.also { cache.put(img.id, it) }
            }
        }
        Box(Modifier.aspectRatio(1f).background(PLACEHOLDER).clickable(onClick = onClick)) {
            thumb?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
            Box(
                Modifier.align(Alignment.TopEnd).padding(6.dp).size(24.dp).clip(CircleShape)
                    .background(if (order > 0) ACCENT else BADGE_IDLE)
                    .border(2.dp, Color.White, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                if (order > 0) BasicText("$order", style = TextStyle(color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold))
            }
        }
    }

    /** 一段文字 */
    @Composable
    private fun Label(text: String, color: Color, modifier: Modifier = Modifier, bold: Boolean = false) {
        BasicText(text, modifier, TextStyle(color = color, fontSize = 16.sp, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal))
    }

    private companion object {
        /** 位图缓存按每像素 4 字节估算 */
        const val BYTES_PER_PIXEL = 4

        /** 次要文字、不可点状态的透明度 */
        const val MUTED_ALPHA = 0.4f

        /** 网格间距 */
        val GRID_GAP = 2.dp

        /** 主题蓝，与前端 vant 主色一致 */
        val ACCENT = Color(0xFF1989FA)

        /** 缩略图未加载时的底色 */
        val PLACEHOLDER = Color(0xFFDDDDDD)

        /** 未选中时圆圈的半透明底 */
        val BADGE_IDLE = Color(0x66000000)
    }
}
