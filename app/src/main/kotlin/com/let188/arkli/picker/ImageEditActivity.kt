package com.let188.arkli.picker

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.Path as ComposePath
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.IntentCompat
import com.let188.arkli.files.FileConst
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * 图片编辑页：双指缩放平移；裁剪框可拖四边和四角（自由或固定比例）；预设形状（圆、心形等）与手绘套索；
 * 左转 90°、左右/上下翻转、撤销、重置。手绘模式下单指画闭合轮廓，双指仍是缩放平移；旋转翻转时套索点跟着一起变换。
 * 预览用降采样图，点“完成”时按原图分辨率（最长边不超过 [PickerConst.EDIT_EXPORT_MAX_EDGE]）重放操作并导出：
 * 矩形输出 JPEG，带形状、套索或裁剪框超出图片（超出部分透明）输出带透明的 PNG。
 * 取消返回 RESULT_CANCELED；没改动就点完成时直接返回原 URI，不重新编码。
 * 入参见 [ImageEditContract]。
 */
class ImageEditActivity : ComponentActivity() {
    /** 待编辑图片 */
    private lateinit var srcUri: Uri

    /** 启用的编辑模式 */
    private var modes: List<String> = emptyList()

    /** 创建界面：缺参数直接取消 */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = IntentCompat.getParcelableExtra(intent, PickerConst.EXTRA_EDIT_URI, Uri::class.java)
        if (uri == null) {
            setResult(Activity.RESULT_CANCELED)
            finish()
            return
        }
        srcUri = uri
        modes = intent.getStringArrayListExtra(PickerConst.EXTRA_EDIT_MODES).orEmpty()
        setContent { EditScreen() }
    }

    /** Compose 矩形转 Android 整数矩形 */
    private fun Rect.toAndroidRect() = android.graphics.Rect(left.roundToInt(), top.roundToInt(), right.roundToInt(), bottom.roundToInt())

    /** 把给定窗口区域从系统手势（返回手势）里排除；API 29 以下没有此能力，什么都不做 */
    private fun applyGestureExclusion(rects: List<android.graphics.Rect>) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.decorView.systemGestureExclusionRects = rects
    }

    /** 带着结果返回 */
    private fun finishWith(uri: Uri) {
        setResult(Activity.RESULT_OK, Intent().putExtra(PickerConst.EXTRA_EDIT_RESULT, uri))
        finish()
    }

    /** 新建一个导出文件：`cacheDir/arkli/pick/edit/<随机>.<ext>`，[ext] 为 jpg 或 png */
    private fun newExportFile(ext: String): File =
        File(File(File(File(cacheDir, FileConst.CACHE_ROOT_DIR), FileConst.DIR_PICK), PickerConst.EDIT_DIR), "${UUID.randomUUID()}.$ext")

    /** 编辑主界面：顶栏 + 画布 + 底部工具栏 */
    @Composable
    private fun EditScreen() {
        val dark = isSystemInDarkTheme()
        val bg = if (dark) Color(0xFF121212) else Color.White
        val fg = if (dark) Color(0xFFEEEEEE) else Color(0xFF222222)
        val muted = fg.copy(alpha = MUTED_ALPHA)
        val cropOn = PickerConst.MODE_CROP in modes
        val rotateOn = PickerConst.MODE_ROTATE in modes
        val shapeOn = PickerConst.MODE_SHAPE in modes
        val lassoOn = PickerConst.MODE_LASSO in modes
        // 有裁剪框可拖：开了裁剪或形状
        val boxOn = cropOn || shapeOn
        val scope = rememberCoroutineScope()
        var source by remember { mutableStateOf<Bitmap?>(null) }
        var ops by remember { mutableStateOf(EditOps()) }
        // 固定比例（宽/高），null 为自由
        var ratio by remember { mutableStateOf<Float?>(null) }
        // 拖拽中的裁剪框（像素），松手后写进操作栈
        var liveRect by remember { mutableStateOf<EditRect?>(null) }
        var viewSize by remember { mutableStateOf(IntSize.Zero) }
        var vt by remember { mutableStateOf(ViewTransform(1f, 0f, 0f)) }
        // 左右手势排除带在窗口里的位置（API 29+ 才设置）
        var leftBand by remember { mutableStateOf<android.graphics.Rect?>(null) }
        var rightBand by remember { mutableStateOf<android.graphics.Rect?>(null) }
        LaunchedEffect(leftBand, rightBand) { applyGestureExclusion(listOfNotNull(leftBand, rightBand)) }
        var saving by remember { mutableStateOf(false) }
        // 是否处于手绘套索模式（单指画轮廓，裁剪框隐藏）
        var drawing by remember { mutableStateOf(false) }
        // 正在画的套索点（图像像素）
        var liveLasso by remember { mutableStateOf<List<EditPoint>>(emptyList()) }
        val state = ops.state
        // 吞掉系统返回（含手势返回）：边缘手柄极易误触发返回，只允许点顶栏退出；提示只弹一次
        var backHinted by remember { mutableStateOf(false) }
        BackHandler(enabled = true) {
            if (!backHinted) {
                backHinted = true
                Toast.makeText(this@ImageEditActivity, "请点左上角“取消”退出", Toast.LENGTH_SHORT).show()
            }
        }
        // 形状强制的比例优先于手选比例
        val effRatio = state.shape.ratio ?: ratio
        val boxActive = boxOn && !drawing

        LaunchedEffect(Unit) {
            val bmp = withContext(Dispatchers.IO) {
                EditBitmaps.decode(contentResolver, srcUri) { w, h -> MediaImages.sampleSize(min(w, h), PickerConst.PREVIEW_PX) }
            }
            if (bmp == null) {
                Toast.makeText(this@ImageEditActivity, "图片打不开", Toast.LENGTH_SHORT).show()
                setResult(Activity.RESULT_CANCELED)
                finish()
            } else {
                source = bmp
            }
        }
        val display: Bitmap? = remember(source, state.turns, state.flipH) { source?.let { EditBitmaps.transform(it, state) } }
        val image: ImageBitmap? = remember(display) { display?.asImageBitmap() }
        val dw = display?.width?.toFloat() ?: 0f
        val dh = display?.height?.toFloat() ?: 0f
        val vw = viewSize.width.toFloat()
        val vh = viewSize.height.toFloat()
        // 旋转后画面尺寸变了，重新适配
        LaunchedEffect(display, viewSize) { if (display != null) vt = EditMath.fitTransform(vw, vh, dw, dh) }
        val cropPx = liveRect ?: state.crop.scaledBy(dw, dh)

        /** 写入裁剪操作（与当前框相同则忽略） */
        fun commitCrop(px: EditRect) {
            val n = px.normalizedBy(dw, dh)
            if (n != state.crop) ops = ops.push(EditOp.Crop(n))
        }

        Column(Modifier.fillMaxSize().background(bg)) {
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                GlyphButton(Glyph.CLOSE, "取消", fg) {
                    setResult(Activity.RESULT_CANCELED)
                    finish()
                }
                Label("编辑图片", fg, bold = true)
                val ready = image != null && !saving
                GlyphButton(Glyph.CHECK, "完成", if (ready) ACCENT else muted, enabled = ready) {
                    if (state.isIdentity) {
                        finishWith(srcUri)
                        return@GlyphButton
                    }
                    saving = true
                    scope.launch {
                        try {
                            val dest = newExportFile(if (state.needsAlpha) EXPORT_EXT_PNG else EXPORT_EXT_JPG)
                            withContext(Dispatchers.IO) {
                                val job = coroutineContext[Job]!!
                                EditBitmaps.export(contentResolver, srcUri, state, dest) { job.ensureActive() }
                            }
                            finishWith(Uri.fromFile(dest))
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            saving = false
                            Toast.makeText(this@ImageEditActivity, "导出失败：${e.message ?: "未知错误"}", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
            Box(
                Modifier.fillMaxSize().padding(horizontal = PickerConst.EDIT_CANVAS_PAD_DP.dp).clipToBounds().onSizeChanged { viewSize = it }
                    // state、viewSize 变了要重建手势块，否则闭包里拿到的是旧的裁剪框和视图尺寸
                    .pointerInput(display, boxActive, drawing, effRatio, state, viewSize) {
                        val touchPx = CROP_TOUCH_DP.dp.toPx()
                        val minVis = PickerConst.EDIT_MIN_VISIBLE_DP.dp.toPx()
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            if (display == null) return@awaitEachGesture
                            val (ix, iy) = EditMath.viewToImage(vt, down.position.x, down.position.y)
                            val startRect = state.crop.scaledBy(dw, dh)
                            // 手势中实时的裁剪框（图像像素）：双指缩放时随图重算，保持屏幕位置不变
                            var curRect = startRect
                            // 拖框的边界：可见画布（框可超出图片，但不能拖出画布）
                            val startBounds = EditMath.viewBounds(vt, vw, vh)
                            var rectChanged = false
                            var handle = if (boxActive) EditMath.hitTest(startRect, ix, iy, touchPx / vt.scale) else null
                            // 手绘：记录手指划过的点，双指缩放时放弃本笔
                            var lasso: MutableList<EditPoint>? = if (drawing) mutableListOf(EditPoint(ix.coerceIn(0f, dw), iy.coerceIn(0f, dh))) else null
                            var totalX = 0f
                            var totalY = 0f
                            do {
                                val ev = awaitPointerEvent()
                                val pressed = ev.changes.filter { it.pressed }
                                if (pressed.size >= 2) {
                                    handle = null
                                    lasso = null
                                    liveLasso = emptyList()
                                    val c = ev.calculateCentroid()
                                    val pan = ev.calculatePan()
                                    if (boxActive) {
                                        val z = EditMath.zoomPanKeepBox(vt, curRect, ev.calculateZoom(), c.x, c.y, pan.x, pan.y, vw, vh, dw, dh, minVis)
                                        vt = z.transform
                                        if (z.crop != curRect) rectChanged = true
                                        curRect = z.crop
                                        liveRect = curRect
                                    } else {
                                        vt = EditMath.zoomPan(vt, ev.calculateZoom(), c.x, c.y, pan.x, pan.y, vw, vh, dw, dh, minVis)
                                    }
                                } else if (handle != null && pressed.isNotEmpty()) {
                                    // 手指位置夹在视图内再算位移，配合边界，框边不会被拖出画布
                                    val pos = pressed.first().position
                                    totalX = (pos.x.coerceIn(0f, vw) - down.position.x) / vt.scale
                                    totalY = (pos.y.coerceIn(0f, vh) - down.position.y) / vt.scale
                                    curRect = EditMath.dragCrop(startRect, handle, totalX, totalY, dw, dh, effRatio, bounds = startBounds)
                                    rectChanged = true
                                    liveRect = curRect
                                } else if (lasso != null && pressed.isNotEmpty()) {
                                    val pos = pressed.first().position
                                    val (px, py) = EditMath.viewToImage(vt, pos.x, pos.y)
                                    val pt = EditPoint(px.coerceIn(0f, dw), py.coerceIn(0f, dh))
                                    val last = lasso.last()
                                    // 太近的点不收，省得点数爆炸
                                    if (abs(pt.x - last.x) + abs(pt.y - last.y) >= LASSO_STEP_DP.dp.toPx() / vt.scale) {
                                        lasso.add(pt)
                                        liveLasso = lasso.toList()
                                    }
                                } else if (pressed.isNotEmpty()) {
                                    val pan = ev.calculatePan()
                                    if (boxActive) {
                                        val z = EditMath.zoomPanKeepBox(vt, curRect, 1f, 0f, 0f, pan.x, pan.y, vw, vh, dw, dh, minVis)
                                        vt = z.transform
                                        if (z.crop != curRect) rectChanged = true
                                        curRect = z.crop
                                        liveRect = curRect
                                    } else {
                                        vt = EditMath.zoomPan(vt, 1f, 0f, 0f, pan.x, pan.y, vw, vh, dw, dh, minVis)
                                    }
                                }
                                ev.changes.forEach { if (it.positionChange() != Offset.Zero) it.consume() }
                            } while (ev.changes.any { it.pressed })
                            // 只有框真的变了才写操作栈（单纯缩放平移图片不产生撤销步）
                            if (rectChanged) commitCrop(curRect)
                            liveRect = null
                            lasso?.let { pts ->
                                EditShapes.finishLasso(pts)?.let { poly -> ops = ops.push(EditOp.Lasso(poly.map { it.normalizedBy(dw, dh) })) }
                            }
                            liveLasso = emptyList()
                        }
                    },
            ) {
                Canvas(Modifier.fillMaxSize()) {
                    val img = image ?: return@Canvas
                    drawImage(
                        img,
                        dstOffset = IntOffset(vt.tx.roundToInt(), vt.ty.roundToInt()),
                        dstSize = IntSize((dw * vt.scale).roundToInt(), (dh * vt.scale).roundToInt()),
                        filterQuality = FilterQuality.Medium,
                    )
                    if (boxActive) drawCropOverlay(cropPx, vt, state.shape)
                    else if (drawing || state.lasso != null) drawLassoOverlay(state.lasso?.map { it.scaledBy(dw, dh) }, liveLasso, vt)
                }
            }
            // 屏幕左右边缘各一条透明排除带：这里的滑动不触发系统返回手势（API 29+ 才生效，系统每侧总高度约 200dp）
            Box(
                Modifier.align(Alignment.CenterStart).width(PickerConst.EDIT_GESTURE_BAND_DP.dp)
                    .height(PickerConst.EDIT_GESTURE_BAND_HEIGHT_DP.dp)
                    .onGloballyPositioned { leftBand = it.boundsInWindow().toAndroidRect() },
            )
            Box(
                Modifier.align(Alignment.CenterEnd).width(PickerConst.EDIT_GESTURE_BAND_DP.dp)
                    .height(PickerConst.EDIT_GESTURE_BAND_HEIGHT_DP.dp)
                    .onGloballyPositioned { rightBand = it.boundsInWindow().toAndroidRect() },
            )
            }
            Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(vertical = 8.dp)) {
                if (boxActive) {
                    val cur = effRatio
                    val locked = state.shape.ratio != null
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        for ((label, r) in RATIOS) {
                            // 旋转后比例会取倒数，所以互为倒数也算同一个按钮
                            val picked = cur == r || (r != null && cur != null && abs(cur * r - 1f) < RATIO_EPS)
                            // 圆形锁 1:1，比例按钮灰掉
                            Chip(label, picked, if (locked) muted else fg) {
                                if (locked) return@Chip
                                ratio = r
                                if (display != null) commitCrop(EditMath.applyRatio(cropPx, r, dw, dh, bounds = EditMath.viewBounds(vt, vw, vh)))
                            }
                        }
                    }
                }
                if (shapeOn || lassoOn) {
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (shapeOn) for (sh in EditShape.entries) {
                            Chip(sh.label, !drawing && state.shape == sh, fg) {
                                if (display == null) return@Chip
                                drawing = false
                                val forced = sh.ratio
                                if (forced != null) ratio = forced
                                val box = forced?.let { EditMath.applyRatio(cropPx, it, dw, dh, bounds = EditMath.viewBounds(vt, vw, vh)).normalizedBy(dw, dh) }
                                if (sh != state.shape || state.lasso != null || (box != null && box != state.crop)) ops = ops.push(EditOp.Shape(sh, box))
                            }
                        }
                        if (lassoOn) {
                            Chip("手绘", drawing, fg) { drawing = !drawing }
                            if (state.lasso != null) Chip("重画", false, fg) {
                                ops = ops.push(EditOp.Lasso(null))
                                drawing = true
                            }
                        }
                    }
                }
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (rotateOn) {
                        Chip("左转 90°", false, fg) {
                            ops = ops.push(EditOp.Rotate(false))
                            // 画面转了，固定比例的宽高也跟着对调
                            ratio = ratio?.let { 1f / it }
                        }
                        Chip("左右翻转", false, fg) { ops = ops.push(EditOp.Flip(true)) }
                        Chip("上下翻转", false, fg) { ops = ops.push(EditOp.Flip(false)) }
                    }
                    Chip("撤销", false, if (ops.canUndo) fg else muted) {
                        ops = ops.undo()
                        ratio = null
                    }
                    Chip("重置", false, if (ops.canUndo || !ops.base.isIdentity) fg else muted) {
                        ops = ops.reset()
                        ratio = null
                        drawing = false
                    }
                }
            }
        }
    }

    /** 把图像像素的折线转成视图坐标下的 Compose 路径 */
    private fun viewPath(pts: List<EditPoint>, t: ViewTransform, close: Boolean = true): ComposePath = ComposePath().apply {
        pts.forEachIndexed { i, p ->
            val (vx, vy) = EditMath.imageToView(t, p.x, p.y)
            if (i == 0) moveTo(vx, vy) else lineTo(vx, vy)
        }
        if (close) close()
    }

    /** 轮廓外压暗：整块视图减去轮廓，用奇偶填充镂空 */
    private fun DrawScope.dimOutside(outline: ComposePath) {
        val p = ComposePath().apply {
            fillType = PathFillType.EvenOdd
            addRect(Rect(0f, 0f, size.width, size.height))
            addPath(outline)
        }
        drawPath(p, Color.Black.copy(alpha = DIM_ALPHA))
    }

    /** 画手绘套索：已定的轮廓镂空压暗加白边；正在画的是一条白线，并用淡线预示闭合 */
    private fun DrawScope.drawLassoOverlay(done: List<EditPoint>?, live: List<EditPoint>, t: ViewTransform) {
        if (done != null && done.size >= 3) {
            val path = viewPath(done, t)
            dimOutside(path)
            drawPath(path, Color.White, style = Stroke(1.5.dp.toPx()))
        }
        if (live.size >= 2) {
            drawPath(viewPath(live, t, close = false), Color.White, style = Stroke(2.dp.toPx()))
            val (fx, fy) = EditMath.imageToView(t, live.first().x, live.first().y)
            val (lx, ly) = EditMath.imageToView(t, live.last().x, live.last().y)
            drawLine(Color.White.copy(alpha = GRID_ALPHA), Offset(lx, ly), Offset(fx, fy), 1.dp.toPx())
        }
    }

    /** 画裁剪框：框外压暗（非矩形形状按轮廓镂空）、白色边框、三分线（仅矩形）、四角加粗 */
    private fun DrawScope.drawCropOverlay(crop: EditRect, t: ViewTransform, shape: EditShape) {
        val (l, tp) = EditMath.imageToView(t, crop.left, crop.top)
        val (r, b) = EditMath.imageToView(t, crop.right, crop.bottom)
        val line = Color.White
        if (shape == EditShape.RECT) {
            val dim = Color.Black.copy(alpha = DIM_ALPHA)
            drawRect(dim, Offset.Zero, Size(size.width, tp.coerceAtLeast(0f)))
            drawRect(dim, Offset(0f, b), Size(size.width, (size.height - b).coerceAtLeast(0f)))
            drawRect(dim, Offset(0f, tp), Size(l.coerceAtLeast(0f), b - tp))
            drawRect(dim, Offset(r, tp), Size((size.width - r).coerceAtLeast(0f), b - tp))
            drawRect(line, Offset(l, tp), Size(r - l, b - tp), style = Stroke(1.5.dp.toPx()))
            val grid = line.copy(alpha = GRID_ALPHA)
            for (i in 1..2) {
                val gx = l + (r - l) * i / 3f
                val gy = tp + (b - tp) * i / 3f
                drawLine(grid, Offset(gx, tp), Offset(gx, b), 1.dp.toPx())
                drawLine(grid, Offset(l, gy), Offset(r, gy), 1.dp.toPx())
            }
        } else {
            val outline = viewPath(EditShapes.outline(shape, crop), t)
            dimOutside(outline)
            drawPath(outline, line, style = Stroke(1.5.dp.toPx()))
            // 外接框淡淡画出来，提示四边四角可拖
            drawRect(line.copy(alpha = GRID_ALPHA), Offset(l, tp), Size(r - l, b - tp), style = Stroke(1.dp.toPx()))
        }
        val arm = CORNER_ARM_DP.dp.toPx()
        val w = CORNER_WIDTH_DP.dp.toPx()
        // 每个角：x、y、水平方向符号、垂直方向符号
        val corners = listOf(listOf(l, tp, 1f, 1f), listOf(r, tp, -1f, 1f), listOf(l, b, 1f, -1f), listOf(r, b, -1f, -1f))
        for ((cx, cy, sx, sy) in corners) {
            drawLine(line, Offset(cx - sx * w / 2, cy), Offset(cx + sx * arm, cy), w)
            drawLine(line, Offset(cx, cy - sy * w / 2), Offset(cx, cy + sy * arm), w)
        }
    }

    /** 顶栏文字 */
    @Composable
    private fun Label(text: String, color: Color, bold: Boolean = false) {
        BasicText(text, style = TextStyle(color = color, fontSize = 16.sp, fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal))
    }

    /** 底部的文字按钮；选中时用主题色底 */
    @Composable
    private fun Chip(text: String, picked: Boolean, color: Color, onClick: () -> Unit) {
        Box(
            Modifier.clip(RoundedCornerShape(16.dp))
                .background(if (picked) ACCENT.copy(alpha = CHIP_PICKED_ALPHA) else color.copy(alpha = CHIP_IDLE_ALPHA))
                .clickable(onClick = onClick)
                .padding(horizontal = 14.dp, vertical = 8.dp),
        ) {
            BasicText(text, style = TextStyle(color = if (picked) ACCENT else color, fontSize = 14.sp))
        }
    }

    private companion object {
        /** 灰显透明度 */
        const val MUTED_ALPHA = 0.4f

        /** 框外压暗透明度 */
        const val DIM_ALPHA = 0.55f

        /** 三分线透明度 */
        const val GRID_ALPHA = 0.4f

        /** 按钮底色透明度：未选中 */
        const val CHIP_IDLE_ALPHA = 0.08f

        /** 按钮底色透明度：选中 */
        const val CHIP_PICKED_ALPHA = 0.16f

        /** 导出扩展名：矩形 */
        const val EXPORT_EXT_JPG = "jpg"

        /** 导出扩展名：带形状或套索（含透明） */
        const val EXPORT_EXT_PNG = "png"

        /** 套索相邻两点的最小间距（dp，曼哈顿距离） */
        const val LASSO_STEP_DP = 3

        /** 比例互为倒数的判定容差 */
        const val RATIO_EPS = 0.01f

        /** 裁剪框触摸命中半径（dp） */
        const val CROP_TOUCH_DP = 28

        /** 角标短臂长度（dp） */
        const val CORNER_ARM_DP = 20

        /** 角标线宽（dp） */
        const val CORNER_WIDTH_DP = 3

        /** 主题色，与选图页一致 */
        val ACCENT = Color(0xFF1989FA)

        /** 比例选项：显示名与宽/高，null 为自由 */
        val RATIOS: List<Pair<String, Float?>> = listOf(
            "自由" to null, "1:1" to 1f, "4:3" to 4f / 3f, "16:9" to 16f / 9f, "3:4" to 3f / 4f, "9:16" to 9f / 16f,
        )
    }
}
