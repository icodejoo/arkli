package com.let188.arkli.picker

import android.Manifest
import android.content.ActivityNotFoundException
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.LruCache
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
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

    /** 是否显示右下角悬浮拍照圆钮 */
    private var showCamera = false

    /** 要选的媒体种类 */
    private var media = PickerMedia.IMAGE

    /** 是否已获得相册权限 */
    private var granted by mutableStateOf(false)

    /** 相册权限申请，被拒就回退 */
    private val permReq = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        if (res.values.all { it }) granted = true else deny()
    }

    /** 创建界面：先确认权限，再显示网格 */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        maxCount = intent.getIntExtra(PickerConst.EXTRA_MAX, PickerConst.DEFAULT_MAX).coerceAtLeast(1)
        showCamera = intent.getBooleanExtra(PickerConst.EXTRA_CAMERA, false)
        media = runCatching { PickerMedia.valueOf(intent.getStringExtra(PickerConst.EXTRA_MEDIA).orEmpty()) }.getOrDefault(PickerMedia.IMAGE)
        val perms = readPermissions()
        if (perms.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) granted = true else permReq.launch(perms)
        setContent { if (granted) PickerScreen() }
    }

    /** 当前系统版本、按媒体种类需要的相册读取权限 */
    private fun readPermissions(): Array<String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        return listOfNotNull(
            Manifest.permission.READ_MEDIA_IMAGES.takeIf { media != PickerMedia.VIDEO },
            Manifest.permission.READ_MEDIA_VIDEO.takeIf { media != PickerMedia.IMAGE },
        ).toTypedArray()
    }

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
        // 全屏浏览：当前看的图在「纯图片列表」里的下标，null 表示没在浏览
        var previewAt by remember { mutableStateOf<Int?>(null) }
        // 点多选框：切换选中；单选时点另一项直接换，再点同一项取消
        val toggle: (MediaImage) -> Unit = { img ->
            val next = if (maxCount == 1) (if (selected == listOf(img.key)) emptyList() else listOf(img.key))
            else PickSelection.toggle(selected, img.key, maxCount)
            if (next == null) Toast.makeText(this@ImagePickerActivity, "最多选 $maxCount 个", Toast.LENGTH_SHORT).show()
            else selected = next
        }
        val noun = when (media) {
            PickerMedia.IMAGE -> "图片"
            PickerMedia.VIDEO -> "视频"
            PickerMedia.IMAGE_VIDEO -> "图片或视频"
        }
        LaunchedEffect(Unit) { images = withContext(Dispatchers.IO) { MediaImages.list(resolver, media) } }
        val cache = remember {
            object : LruCache<Long, ImageBitmap>((Runtime.getRuntime().maxMemory() / PickerConst.CACHE_HEAP_DIVISOR).toInt()) {
                override fun sizeOf(key: Long, value: ImageBitmap): Int = value.width * value.height * BYTES_PER_PIXEL
            }
        }
        Box(Modifier.fillMaxSize().background(bg)) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                GlyphButton(Glyph.CLOSE, "取消", fg) { finish() }
                Label("选择$noun ${selected.size}/$maxCount", fg, bold = true)
                GlyphButton(Glyph.CHECK, "完成", if (selected.isEmpty()) muted else ACCENT, enabled = selected.isNotEmpty()) {
                    val byId = images.orEmpty().associateBy { it.key }
                    finishWith(selected.mapNotNull { byId[it]?.uri })
                }
            }
            val list = images
            if (list.isNullOrEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Label(if (list == null) "加载中…" else "相册里没有$noun", muted)
                }
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(PickerConst.GRID_COLUMNS),
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = WindowInsets.navigationBars.asPaddingValues(),
                    verticalArrangement = Arrangement.spacedBy(GRID_GAP),
                    horizontalArrangement = Arrangement.spacedBy(GRID_GAP),
                ) {
                    items(list, key = { it.key }) { img ->
                        Cell(
                            img,
                            PickSelection.orderOf(selected, img.key),
                            cache,
                            // 点图片本身：图片全屏浏览，视频交给系统播放器；只有点多选框才选中
                            onOpen = {
                                if (img.video) playVideo(img.uri) else previewAt = list.filter { !it.video }.indexOfFirst { it.key == img.key }
                            },
                            onToggle = { toggle(img) },
                        )
                    }
                }
            }
        }
        // 右下角相机图标：不论是否已选图，点击都丢弃已选并切回拍照
        if (showCamera) IconFab(FabIcon.CAMERA, "拍照", Modifier.align(Alignment.BottomEnd)) { cameraBack() }
        // 全屏浏览：盖在网格上，返回键先关它
        val at = previewAt
        val photos = images.orEmpty().filter { !it.video }
        if (at != null && at in photos.indices) {
            BackHandler { previewAt = null }
            PreviewOverlay(photos, at, selected, toggle) { previewAt = null }
        }
        }
    }

    /** 用系统播放器看视频（视频不在选择页里内嵌播放），没有播放器时提示 */
    private fun playVideo(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "video/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "没有可用的视频播放器", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * 全屏浏览：黑底、左右翻页，点图片关闭；右上角多选框与网格里是同一套选中状态，点它切换选中并直接关闭浏览。
     *
     * @param photos 可浏览的图片（不含视频）
     * @param start 起始下标
     * @param selected 已选 key，按点选顺序
     * @param onToggle 切换某张图的选中状态
     * @param onClose 关闭浏览
     */
    @Composable
    private fun PreviewOverlay(photos: List<MediaImage>, start: Int, selected: List<Long>, onToggle: (MediaImage) -> Unit, onClose: () -> Unit) {
        val pager = rememberPagerState(initialPage = start) { photos.size }
        val resolver = contentResolver
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            HorizontalPager(pager, Modifier.fillMaxSize(), key = { photos[it].key }) { page ->
                val img = photos[page]
                val bmp by produceState<ImageBitmap?>(null, img.key) {
                    value = withContext(Dispatchers.IO) { MediaImages.thumbnail(resolver, img.uri, PickerConst.PREVIEW_PX)?.asImageBitmap() }
                }
                Box(
                    Modifier.fillMaxSize().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClose),
                    contentAlignment = Alignment.Center,
                ) {
                    bmp?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit) }
                }
            }
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Label("${pager.currentPage + 1}/${photos.size}", Color.White, Modifier.padding(start = 12.dp), bold = true)
                val cur = photos[pager.currentPage]
                // 点多选框：切换选中后直接关闭全屏，回到网格
                SelectBox(PickSelection.orderOf(selected, cur.key)) {
                    onToggle(cur)
                    onClose()
                }
            }
        }
    }


    /** 点拍照按钮：以 RESULT_CAMERA 结束，已选的直接丢弃 */
    private fun cameraBack() {
        setResult(PickerConst.RESULT_CAMERA)
        finish()
    }

    /** 一格缩略图：右上角圆圈，选中时填色并显示序号 */
    @Composable
    private fun Cell(img: MediaImage, order: Int, cache: LruCache<Long, ImageBitmap>, onOpen: () -> Unit, onToggle: () -> Unit) {
        val resolver = contentResolver
        val thumb by produceState(cache.get(img.key), img.key) {
            if (value == null) {
                value = withContext(Dispatchers.IO) {
                    MediaImages.thumbnail(resolver, img.uri, PickerConst.THUMB_PX, img.video)?.asImageBitmap()
                }?.also { cache.put(img.key, it) }
            }
        }
        Box(Modifier.aspectRatio(1f).background(PLACEHOLDER).clickable(onClick = onOpen)) {
            thumb?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
            if (img.video) {
                BasicText(
                    durationText(img.durationMs),
                    Modifier.align(Alignment.BottomStart).padding(6.dp).background(BADGE_IDLE, RoundedCornerShape(4.dp)).padding(horizontal = 4.dp),
                    TextStyle(color = Color.White, fontSize = 11.sp),
                )
            }
            SelectBox(order, Modifier.align(Alignment.TopEnd), onToggle)
        }
    }

    /**
     * 多选框：圆圈本身 24dp 不变，外面套一层 48dp 的点击区（宽高都放大一倍），点它才切换选中。
     *
     * @param order 选中序号，0 表示未选
     * @param modifier 外部布局修饰
     * @param onClick 点击回调
     */
    @Composable
    private fun SelectBox(order: Int, modifier: Modifier = Modifier, onClick: () -> Unit) {
        Box(
            modifier.size(HIT_SIZE).clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                Modifier.size(BOX_SIZE).clip(CircleShape)
                    .background(if (order > 0) ACCENT else BADGE_IDLE)
                    .border(2.dp, Color.White, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                if (order > 0) BasicText("$order", style = TextStyle(color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold))
            }
        }
    }

    /** 视频时长文案：mm:ss，超过一小时为 h:mm:ss */
    private fun durationText(ms: Long): String {
        val total = ms / MS_PER_SEC
        val h = total / SEC_PER_HOUR
        val m = total % SEC_PER_HOUR / SEC_PER_MIN
        val sec = total % SEC_PER_MIN
        return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
    }

    /** 一段文字 */
    @Composable
    private fun Label(text: String, color: Color, modifier: Modifier = Modifier, bold: Boolean = false) {
        BasicText(text, modifier, TextStyle(color = color, fontSize = 16.sp, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal))
    }

    private companion object {
        /** 多选框圆圈直径 */
        val BOX_SIZE = 24.dp

        /** 多选框点击区边长：圆圈的两倍 */
        val HIT_SIZE = 48.dp

        /** 毫秒转秒 */
        const val MS_PER_SEC = 1000L

        /** 每小时秒数 */
        const val SEC_PER_HOUR = 3600L

        /** 每分钟秒数 */
        const val SEC_PER_MIN = 60L

        /** 位图缓存按每像素 4 字节估算 */
        const val BYTES_PER_PIXEL = 4

        /** 次要文字、不可点状态的透明度 */
        const val MUTED_ALPHA = 0.4f

        /** 网格间距 */
        val GRID_GAP = 4.dp

        /** 主题蓝，与前端 vant 主色一致 */
        val ACCENT = Color(0xFF1989FA)

        /** 缩略图未加载时的底色 */
        val PLACEHOLDER = Color(0xFFDDDDDD)

        /** 未选中时圆圈的半透明底 */
        val BADGE_IDLE = Color(0x66000000)
    }
}
