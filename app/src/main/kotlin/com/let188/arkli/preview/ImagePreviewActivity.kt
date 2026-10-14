package com.let188.arkli.preview

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.roundToInt

/** 放大后补上的高清局部：位图及它覆盖的图片区域 */
private class Detail(val bitmap: ImageBitmap, val rect: RectI)

/**
 * 全屏图片预览：左右翻页、双指缩放、放大后拖动、双击放大/还原、单击或返回键关闭。
 * 超长图靠局部解码保持清晰，见 [PreviewImage]。只能由应用内部拉起（不导出）。
 */
class ImagePreviewActivity : ComponentActivity() {
    /** 创建界面 */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val paths = intent.getStringArrayListExtra(PreviewConst.EXTRA_PATHS).orEmpty()
        if (paths.isEmpty()) {
            finish()
            return
        }
        val start = intent.getIntExtra(PreviewConst.EXTRA_INDEX, 0).coerceIn(0, paths.lastIndex)
        setContent { PreviewScreen(paths.map(::File), start) }
    }

    /** 预览主界面：黑底分页，多张时顶部显示页码 */
    @Composable
    private fun PreviewScreen(files: List<File>, start: Int) {
        val pager = rememberPagerState(initialPage = start) { files.size }
        // 当前页放大时禁止翻页，避免和拖动图片冲突
        var zoomed by remember { mutableStateOf(false) }
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            HorizontalPager(pager, Modifier.fillMaxSize(), userScrollEnabled = !zoomed, key = { it }) { page ->
                ZoomPage(files[page], onZoomed = { zoomed = it }, onTap = { finish() })
            }
            if (files.size > 1) {
                BasicText(
                    "${pager.currentPage + 1}/${files.size}",
                    Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 12.dp),
                    TextStyle(color = Color.White, fontSize = 16.sp),
                )
            }
        }
    }

    /**
     * 单页：底图 + 手势缩放 + 放大后的高清局部。
     *
     * @param file 图片文件
     * @param onZoomed 放大状态变化回调
     * @param onTap 单击回调
     */
    @Composable
    private fun ZoomPage(file: File, onZoomed: (Boolean) -> Unit, onTap: () -> Unit) {
        val img = remember(file) { PreviewImage(file) }
        DisposableEffect(img) { onDispose { img.close() } }
        val base by produceState<ImageBitmap?>(null, img) { value = withContext(Dispatchers.IO) { img.decodeBase()?.asImageBitmap() } }
        var box by remember { mutableStateOf(IntSize.Zero) }
        var scale by remember { mutableFloatStateOf(1f) }
        var ox by remember { mutableFloatStateOf(0f) }
        var oy by remember { mutableFloatStateOf(0f) }
        var detail by remember { mutableStateOf<Detail?>(null) }
        val ready = base != null && box.width > 0 && img.width > 0
        val fit = if (ready) ZoomMath.fit(img.width, img.height, box.width.toFloat(), box.height.toFloat()) else FitSize(1f, 1f)

        LaunchedEffect(scale > PreviewConst.ZOOMED_EPS) { onZoomed(scale > PreviewConst.ZOOMED_EPS) }
        // 手势停下后再解高清局部；缩回去就丢掉
        LaunchedEffect(scale, ox, oy, ready) {
            if (!ready || !img.hasDetail || scale <= PreviewConst.ZOOMED_EPS) {
                detail = null
                return@LaunchedEffect
            }
            delay(PreviewConst.DETAIL_DEBOUNCE_MS)
            val rect = ZoomMath.visibleRect(
                img.width, img.height, fit, scale, ox, oy, box.width.toFloat(), box.height.toFloat(), PreviewConst.DETAIL_MARGIN,
            ) ?: return@LaunchedEffect
            val sample = ZoomMath.detailSample(rect.width, box.width.toFloat())
            val bmp = withContext(Dispatchers.IO) { img.decodeRegion(rect, sample) } ?: return@LaunchedEffect
            detail = Detail(bmp.asImageBitmap(), rect)
        }

        Box(
            Modifier.fillMaxSize().onSizeChanged { box = it }
                // 单击关闭、双击在“还原 / 放大”之间切换
                .pointerInput(ready, fit) {
                    detectTapGestures(
                        onTap = { onTap() },
                        onDoubleTap = {
                            if (!ready) return@detectTapGestures
                            val target = ZoomMath.doubleTapTarget(scale, fit, box.width.toFloat())
                            scale = target
                            ox = ZoomMath.clampOffset(0f, target, fit.w, box.width.toFloat())
                            oy = ZoomMath.clampOffset(0f, target, fit.h, box.height.toFloat())
                        },
                    )
                }
                // 缩放与拖动：单指且未放大时不消费事件，留给翻页
                .pointerInput(ready, fit) {
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                        do {
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            val multi = event.changes.count { it.pressed } > 1
                            if (ready && (multi || scale > PreviewConst.ZOOMED_EPS)) {
                                val zoom = event.calculateZoom()
                                val pan = event.calculatePan()
                                val c = event.calculateCentroid(useCurrent = false)
                                val centroid = if (c == Offset.Unspecified) Offset.Zero else Offset(c.x - box.width / 2f, c.y - box.height / 2f)
                                val newScale = (scale * zoom).coerceIn(1f, ZoomMath.maxScale(fit, box.width.toFloat()))
                                val z = newScale / scale
                                ox = ZoomMath.clampOffset(ZoomMath.zoomAbout(ox, centroid.x, z) + pan.x, newScale, fit.w, box.width.toFloat())
                                oy = ZoomMath.clampOffset(ZoomMath.zoomAbout(oy, centroid.y, z) + pan.y, newScale, fit.h, box.height.toFloat())
                                scale = newScale
                                event.changes.forEach { if (it.positionChanged()) it.consume() }
                            }
                        } while (event.changes.any { it.pressed })
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            val b = base
            if (b == null) {
                BasicText("加载中…", style = TextStyle(color = Color.White.copy(alpha = 0.6f), fontSize = 16.sp))
            } else {
                Box(
                    Modifier.fillMaxSize().graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = ox
                        translationY = oy
                    },
                ) {
                    Image(b, null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                    detail?.let { d ->
                        Canvas(Modifier.fillMaxSize()) {
                            // 局部位图落在“适应图”里对应的位置
                            val left = (size.width - fit.w) / 2f + d.rect.left.toFloat() / img.width * fit.w
                            val top = (size.height - fit.h) / 2f + d.rect.top.toFloat() / img.height * fit.h
                            drawImage(
                                d.bitmap,
                                dstOffset = IntOffset(left.roundToInt(), top.roundToInt()),
                                dstSize = IntSize((d.rect.width.toFloat() / img.width * fit.w).roundToInt(), (d.rect.height.toFloat() / img.height * fit.h).roundToInt()),
                            )
                        }
                    }
                }
            }
        }
    }
}
