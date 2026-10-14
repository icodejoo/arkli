package com.let188.arkli.splash

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

/** 系统启动页只能用纯色，动画第一帧与它一致：取渐变中段色 */
private val SOLID = Color(0xFF8B5CF6)

/** 渐变三色，自上而下 */
private val GRADIENT_COLORS = listOf(Color(0xFF3B6CF6), Color(0xFF8B5CF6), Color(0xFFD946EF))

/** 箱子身体渐变：白到淡紫 */
private val BODY_COLORS = listOf(Color.White, Color(0xFFE8EBFF))

/** 锁扣颜色 */
private val LATCH = Color(0xFF8B5CF6)

/** 阴影层数、每层外扩（dp）与单层透明度：层多而淡，叠出柔边 */
private const val SHADOW_LAYERS = 10
private const val SHADOW_STEP = 2f
private const val SHADOW_LAYER_ALPHA = 0.03f

/** 阴影颜色 */
private val SHADOW = Color(0xFF281478)

/** 箱子几何（dp），要与 res/drawable/splash_icon.xml 一致：100×56 的箱身，居中 */
private const val BOX_W = 100f
private const val BODY_H = 56f

/** 爆发缓动：出手极快，快到位时才慢下来，像礼花炸开 */
private val BURST_EASING: Easing = CubicBezierEasing(0.05f, 0.9f, 0.2f, 1f)

/**
 * 一个爆出的工具图标。
 *
 * @property emoji 图标字符
 * @property endX 终点横向偏移（dp，相对屏幕中心）
 * @property endY 终点纵向偏移（负为向上）
 * @property fontDp 字号（dp），外圈大、内圈小
 * @property spinDeg 起始旋转角度，飞行中转回 0
 */
private data class Item(val emoji: String, val endX: Float, val endY: Float, val fontDp: Float, val spinDeg: Float)

/** 竖向半径相对横向半径的拉伸：上方空间比左右宽，炸得更高 */
private const val BURST_STRETCH_Y = 1.1f

/**
 * 按圆弧均匀排一圈图标。
 *
 * @param emojis 这一圈的图标，数量即个数
 * @param radius 横向半径（dp）
 * @param fromDeg 起始角度（度，0 为正右，负为向上）
 * @param toDeg 结束角度
 * @param fontDp 字号（dp）
 * @param seed 起始序号，用来错开旋转方向与幅度
 * @return 这一圈的图标
 */
private fun ring(emojis: List<String>, radius: Float, fromDeg: Float, toDeg: Float, fontDp: Float, seed: Int): List<Item> =
    emojis.mapIndexed { i, emoji ->
        val t = if (emojis.size == 1) 0.5f else i / (emojis.size - 1f)
        val rad = Math.toRadians((fromDeg + (toDeg - fromDeg) * t).toDouble())
        val k = seed + i
        Item(
            emoji = emoji,
            endX = (radius * Math.cos(rad)).toFloat(),
            endY = (radius * BURST_STRETCH_Y * Math.sin(rad)).toFloat(),
            fontDp = fontDp,
            spinDeg = (if (k % 2 == 0) 1 else -1) * (30f + (k * 13) % 40),
        )
    }

/** 三圈共 13 个图标，由内向外依次爆出：内圈 4 个小、中圈 4 个、外圈 5 个大 */
private val ITEMS: List<Item> =
    ring(listOf("📏", "🎵", "🎬", "🧭"), 67f, -155f, -25f, 26f, 0) +
        ring(listOf("📷", "🧮", "🧩", "📅"), 100f, -160f, -20f, 30f, 4) +
        ring(listOf("🌈", "💡", "🔢", "🎁", "🔐"), 133f, -150f, -30f, 32f, 8)

/** 爆发范围距屏幕左右边缘至少留出的空白（dp） */
private const val BURST_SIDE_MARGIN = 12f

/** 最外侧图标（含半个字号）距中心的横向最大距离（dp），用来按屏宽缩放爆发范围 */
private val BURST_MAX_X: Float = ITEMS.maxOf { Math.abs(it.endX) + it.fontDp / 2 }

/** 图标初始纵向偏移（藏在箱身后面，dp） */
private const val ITEM_START_Y = 0f

/** 起飞时的缩放，飞到位变成 1 */
private const val ITEM_START_SCALE = 0.3f

/** 图标透明度在进度的前这一段内淡入到 1 */
private const val ITEM_FADE_PORTION = 0.15f

/** 字标相对屏幕中心的纵向偏移（dp） */
private const val TITLE_Y = 75f

/** 副标题相对屏幕中心的纵向偏移（dp） */
private const val SUB_Y = 109f

/** 副标题最终透明度 */
private const val SUB_ALPHA = 0.85f

/**
 * 原生启动动画页：盖在 MainActivity 上，MainActivity 在下面预热 WebView。
 * 透明主题，自己画不透明内容，下面的 Activity 保持“可见但暂停”，WebView 不会被冻结。
 * 页面就绪且播够最短时长后淡出并关闭。
 */
class SplashActivity : ComponentActivity() {
    /** 创建界面：铺满全屏（含状态栏下方），内容由 Compose 绘制 */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.also {
                it.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        setContent {
            // 返回键直接跳过动画
            BackHandler { closeNow() }
            SplashContent(onExitStart = ::clearWindowBackground, onDone = ::closeNow)
        }
    }

    /**
     * 开始淡出时把窗口背景换成透明：否则淡出会透出窗口背景里那张静态图（合盖的箱子），
     * 看起来像盖子盖了回来，还会盖住下面已经画好的首页。
     */
    private fun clearWindowBackground() {
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT))
    }

    /** 关闭自己，不带系统转场，免得多一层动画 */
    private fun closeNow() {
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }
}

/**
 * 动画内容：纯色底上淡入渐变，箱子掀盖，图标弹出，字标淡入。
 *
 * @param onExitStart 开始淡出时回调，宿主据此撤掉窗口背景，让淡出露出下层页面
 * @param onDone 淡出结束后回调，宿主据此关闭页面
 */
@Composable
private fun SplashContent(onExitStart: () -> Unit, onDone: () -> Unit) {
    var elapsed by remember { mutableLongStateOf(0L) }
    var exiting by remember { mutableStateOf(false) }
    // 逐帧推进时间；页面就绪且播够就开始退出
    LaunchedEffect(Unit) {
        val start = withFrameMillis { it }
        while (!exiting) {
            withFrameMillis { elapsed = it - start }
            if (SplashTimeline.canExit(elapsed, SplashGate.ready.value)) exiting = true
        }
    }
    LaunchedEffect(exiting) { if (exiting) onExitStart() }
    val exitAlpha by animateFloatAsState(
        targetValue = if (exiting) 0f else 1f,
        animationSpec = tween(SplashTimeline.FADE_OUT_MS, easing = LinearEasing),
        label = "splashExit",
        finishedListener = { if (exiting) onDone() },
    )
    val density = LocalDensity.current
    // 屏幕窄就把整个爆发范围等比收小，最外圈图标不会被边缘切掉；宽屏保持原样
    val burstScale = minOf(1f, (LocalConfiguration.current.screenWidthDp / 2f - BURST_SIDE_MARGIN) / BURST_MAX_X)
    // 字号固定按 dp，不随系统字体缩放，保证几何与原生图标对得上
    fun fixedSp(v: Float) = with(density) { v.dp.toSp() }

    Box(Modifier.fillMaxSize().graphicsLayer { alpha = exitAlpha }.background(SOLID)) {
        Box(
            Modifier.fillMaxSize()
                .graphicsLayer { alpha = SplashTimeline.progress(elapsed, SplashTimeline.GRADIENT) }
                .background(Brush.verticalGradient(GRADIENT_COLORS)),
        )
        // 工具图标：在箱子身体后面（先画），一开场就向四周爆开
        ITEMS.forEachIndexed { i, item ->
            // 个数与时间轴不一致时跳过多出的，不越界崩溃
            val span = SplashTimeline.ITEMS.getOrNull(i) ?: return@forEachIndexed
            val p = SplashTimeline.progress(elapsed, span)
            val e = BURST_EASING.transform(p)
            BasicText(
                text = item.emoji,
                style = TextStyle(fontSize = fixedSp(item.fontDp)),
                modifier = Modifier.align(Alignment.Center)
                    .offset(0.dp, ITEM_START_Y.dp)
                    .graphicsLayer {
                        val d = this.density
                        alpha = (p / ITEM_FADE_PORTION).coerceAtMost(1f)
                        translationX = item.endX * burstScale * e * d
                        translationY = (item.endY * burstScale - ITEM_START_Y) * e * d
                        val s = ITEM_START_SCALE + (1f - ITEM_START_SCALE) * e
                        scaleX = s
                        scaleY = s
                        rotationZ = item.spinDeg * (1f - e)
                    },
            )
        }
        Canvas(Modifier.fillMaxSize()) { drawBox() }
        val titleP = SplashTimeline.progress(elapsed, SplashTimeline.TITLE)
        BasicText(
            text = "Arkli",
            style = TextStyle(color = Color.White, fontSize = fixedSp(34f), fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
            modifier = Modifier.align(Alignment.Center).offset(y = TITLE_Y.dp)
                .graphicsLayer {
                    alpha = titleP
                    translationY = 8.dp.toPx() * (1 - titleP)
                },
        )
        val subP = SplashTimeline.progress(elapsed, SplashTimeline.SUB)
        BasicText(
            text = "小工具，装一箱",
            style = TextStyle(color = Color.White, fontSize = fixedSp(13f)),
            modifier = Modifier.align(Alignment.Center).offset(y = SUB_Y.dp).graphicsLayer { alpha = SUB_ALPHA * subP },
        )
    }
}

/** 画箱子：阴影、渐变箱身与锁扣；与原生 splash_icon 对齐。 */
private fun DrawScope.drawBox() {
    val dp = density
    val cx = size.width / 2
    val cy = size.height / 2
    val left = cx - BOX_W / 2 * dp
    val bodyTop = cy - BODY_H / 2 * dp
    // 阴影：几层渐大的低透明圆角矩形叠出柔边，第一帧就在，与原生启动图一致
    for (i in 1..SHADOW_LAYERS) {
        val grow = i * SHADOW_STEP * dp
        drawRoundRect(
            color = SHADOW.copy(alpha = SHADOW_LAYER_ALPHA),
            topLeft = Offset(left - grow, bodyTop + 10f * dp - grow / 2),
            size = Size(BOX_W * dp + 2 * grow, BODY_H * dp + grow),
            cornerRadius = CornerRadius(14f * dp + grow),
        )
    }
    // 箱身：上小下大的圆角
    val body = Path().apply {
        addRoundRect(
            RoundRect(
                left = left,
                top = bodyTop,
                right = left + BOX_W * dp,
                bottom = bodyTop + BODY_H * dp,
                topLeftCornerRadius = CornerRadius(6f * dp),
                topRightCornerRadius = CornerRadius(6f * dp),
                bottomRightCornerRadius = CornerRadius(14f * dp),
                bottomLeftCornerRadius = CornerRadius(14f * dp),
            ),
        )
    }
    drawPath(body, Brush.verticalGradient(BODY_COLORS, startY = bodyTop, endY = bodyTop + BODY_H * dp))
    drawRoundRect(
        color = LATCH,
        topLeft = Offset(cx - 11f * dp, bodyTop + 14f * dp),
        size = Size(22f * dp, 8f * dp),
        cornerRadius = CornerRadius(4f * dp),
    )
}
