package com.let188.arkli.camera

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaMetadataRetriever
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import android.media.ExifInterface
import com.let188.arkli.files.FileConst
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.input.pointer.pointerInput
import com.let188.arkli.picker.FabIcon
import com.let188.arkli.picker.Glyph
import com.let188.arkli.picker.GlyphButton
import com.let188.arkli.picker.IconFab
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import java.io.File

/**
 * 全屏相机页：CameraX 预览 + 拍照（ImageCapture）+ 录像（VideoCapture），可切换前后镜头，带相册入口。
 * 产物只写 `cacheDir/arkli/pick/cam`，绝不写入 MediaStore 或持久目录。
 * 相机权限被拒以 Denied 结束；录音权限被拒则静音录制，不报错。
 * 仅应用内部拉起，见 [CameraCaptureContract]。
 */
class CameraCaptureActivity : ComponentActivity() {
    /** 本次拍摄入参 */
    private lateinit var req: CameraCaptureRequest

    /** 相机权限是否已获得 */
    private var granted by mutableStateOf(false)

    /** 录像用例是否已就绪（设备不支持拍照录像同绑时为 false，此时不提示长按录像） */
    private var videoReady by mutableStateOf(false)

    /** 当前这次录像是否由“长按快门”触发（松手即停） */
    private var holdRecording = false

    /** 本次录像开始的时刻（elapsedRealtime 毫秒），驱动倒计时圆环 */
    private var recordStartMs = 0L

    /** 倒计时圆环剩余比例，1 满 0 空 */
    private var ringFraction by mutableStateOf(1f)

    /** 当前朝向 */
    private var facing by mutableStateOf(CameraConst.FACING_BACK)

    /** 是否正在录像 */
    private var recording by mutableStateOf(false)

    /** 已录时长（秒），界面计时用 */
    private var elapsedSec by mutableStateOf(0)

    /** 预览视图，模式或朝向变化时重新绑定 */
    private var previewView: PreviewView? = null

    /** 拍照用例 */
    private var imageCapture: ImageCapture? = null

    /** 录像用例 */
    private var videoCapture: VideoCapture<Recorder>? = null

    /** 进行中的录像 */
    private var activeRecording: Recording? = null

    /** 是否已交出结果，避免重复 finish */
    private var finished = false

    /** 相机缓存目录 */
    private val camDir: File by lazy { CameraPolicy.camDir(File(cacheDir, FileConst.CACHE_ROOT_DIR)) }

    /** 相机权限申请 */
    private val camPerm = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) granted = true else finishWith(CameraCaptureOutcome.Denied())
    }

    /** 录音权限申请：结果无关紧要，拒绝就静音录制 */
    private val audioPerm = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /** 创建界面：读入参、申请权限 */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        req = CameraPolicy.requestFromJson(intent.getStringExtra(CameraConst.EXTRA_REQUEST))
        facing = req.facing
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) granted = true
        else camPerm.launch(Manifest.permission.CAMERA)
        if (CameraConst.MODE_VIDEO in req.modes &&
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        ) audioPerm.launch(Manifest.permission.RECORD_AUDIO)
        setContent { CameraScreen() }
    }

    /** 销毁时停掉进行中的录像 */
    override fun onDestroy() {
        activeRecording?.stop()
        super.onDestroy()
    }

    /** 交出结果，只生效一次 */
    private fun finishWith(outcome: CameraCaptureOutcome) {
        if (finished) return
        finished = true
        setResult(Activity.RESULT_OK, Intent().putExtra(CameraConst.EXTRA_RESULT, CameraPolicy.outcomeToJson(outcome)))
        finish()
    }

    /** 按当前模式与朝向重新绑定用例 */
    private fun bind() {
        val view = previewView ?: return
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            val selector = if (facing == CameraConst.FACING_FRONT) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
            if (!provider.hasCamera(selector)) {
                finishWith(CameraCaptureOutcome.Error("这台设备没有可用的相机"))
                return@addListener
            }
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
            provider.unbindAll()
            val wantPhoto = CameraConst.MODE_PHOTO in req.modes
            val wantVideo = CameraConst.MODE_VIDEO in req.modes
            // 拍照与录像同时开时一起绑定（点按拍照、长按录像）；设备不支持这个组合就退成只拍照
            val bound = runCatching { bindUseCases(provider, selector, preview, photo = wantPhoto || !wantVideo, video = wantVideo) }
            if (bound.isFailure && wantPhoto && wantVideo) {
                provider.unbindAll()
                runCatching { bindUseCases(provider, selector, preview, photo = true, video = false) }
                    .onFailure { finishWith(CameraCaptureOutcome.Error("相机初始化失败：${it.message}")) }
            } else {
                bound.onFailure { finishWith(CameraCaptureOutcome.Error("相机初始化失败：${it.message}")) }
            }
        }, ContextCompat.getMainExecutor(this))
    }

    /** 按需创建并绑定拍照、录像用例，同时更新 [imageCapture]、[videoCapture]（不要的那个置空） */
    private fun bindUseCases(provider: ProcessCameraProvider, selector: CameraSelector, preview: Preview, photo: Boolean, video: Boolean) {
        val ic = if (photo) ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build() else null
        val vc = if (video) {
            val recorder = Recorder.Builder()
                .setQualitySelector(QualitySelector.from(Quality.HD, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)))
                .build()
            VideoCapture.withOutput(recorder)
        } else null
        val cases = listOfNotNull<androidx.camera.core.UseCase>(preview, ic, vc)
        provider.bindToLifecycle(this, selector, *cases.toTypedArray())
        imageCapture = ic
        videoCapture = vc
        videoReady = vc != null
    }

    /** 拍一张照片，写到相机缓存目录（只用 File 输出，不经 MediaStore） */
    private fun takePhoto() {
        val ic = imageCapture ?: return
        val file = CameraPolicy.generateTargetFile(camDir, isVideo = false)
        ic.takePicture(
            ImageCapture.OutputFileOptions.Builder(file).build(),
            ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    val (w, h) = orientedSize(file)
                    finishWith(
                        CameraCaptureOutcome.Success(
                            CameraConst.KIND_IMAGE, CameraPolicy.pagePath(file.name), file.name,
                            CameraConst.MIME_JPEG, file.length(), w, h,
                        ),
                    )
                }

                override fun onError(exception: ImageCaptureException) {
                    finishWith(CameraCaptureOutcome.Error("拍照失败：${exception.message}"))
                }
            },
        )
    }

    /** 读 JPEG 像素尺寸并按 EXIF 方向交换宽高，得到摆正后的宽高 */
    private fun orientedSize(file: File): Pair<Int, Int> {
        val exif = ExifInterface(file.absolutePath)
        val w = exif.getAttributeInt(ExifInterface.TAG_IMAGE_WIDTH, 0)
        val h = exif.getAttributeInt(ExifInterface.TAG_IMAGE_LENGTH, 0)
        val swap = when (exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90, ExifInterface.ORIENTATION_ROTATE_270,
            ExifInterface.ORIENTATION_TRANSPOSE, ExifInterface.ORIENTATION_TRANSVERSE -> true
            else -> false
        }
        return if (swap) h to w else w to h
    }

    /** 开始或停止录像；到 maxDurationSec 由录制器自动停止；无录音权限则静音 */
    private fun toggleRecord() {
        val current = activeRecording
        if (current != null) {
            current.stop()
            return
        }
        val vc = videoCapture ?: return
        val file = CameraPolicy.generateTargetFile(camDir, isVideo = true)
        val opts = FileOutputOptions.Builder(file).setDurationLimitMillis(req.maxDurationSec * MS_PER_SEC).build()
        val hasAudio = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        val start = SystemClock.elapsedRealtime()
        var pending = vc.output.prepareRecording(this, opts)
        if (hasAudio) pending = pending.withAudioEnabled()
        activeRecording = pending.start(ContextCompat.getMainExecutor(this)) { ev ->
            when (ev) {
                is VideoRecordEvent.Status -> elapsedSec = ((SystemClock.elapsedRealtime() - start) / MS_PER_SEC).toInt()
                is VideoRecordEvent.Finalize -> {
                    activeRecording = null
                    recording = false
                    if (cancelling) return@start
                    // 只有倒计时到点自动结束才震动；用户松手主动结束不震
                    if (ev.error == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED) vibrateDone()
                    if (ev.hasError() && !file.exists()) finishWith(CameraCaptureOutcome.Error("录像失败"))
                    else finishWith(videoOutcome(file))
                }
            }
        }
        recording = true
        elapsedSec = 0
        recordStartMs = start
    }

    /** 倒计时到点结束时震一下，提示用户录像已结束 */
    private fun vibrateDone() {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        vibrator.vibrate(VibrationEffect.createOneShot(VIBRATE_DONE_MS, VibrationEffect.DEFAULT_AMPLITUDE))
    }

    /** 用户取消中：录像收尾事件不再当成成功结果 */
    private var cancelling = false

    /** 读视频元数据组装结果 */
    private fun videoOutcome(file: File): CameraCaptureOutcome {
        val mmr = MediaMetadataRetriever()
        return try {
            mmr.setDataSource(file.absolutePath)
            fun meta(k: Int) = mmr.extractMetadata(k)?.toLongOrNull() ?: 0L
            var w = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH).toInt()
            var h = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT).toInt()
            val rot = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION).toInt()
            if (rot == ROT_90 || rot == ROT_270) w = h.also { h = w }
            CameraCaptureOutcome.Success(
                CameraConst.KIND_VIDEO, CameraPolicy.pagePath(file.name), file.name, CameraConst.MIME_MP4,
                file.length(), w, h, meta(MediaMetadataRetriever.METADATA_KEY_DURATION),
            )
        } catch (e: Exception) {
            CameraCaptureOutcome.Error("读取视频信息失败：${e.message}")
        } finally {
            mmr.release()
        }
    }

    /** 取消：录像中先停止并丢弃半成品，再返回取消 */
    private fun cancel() {
        cancelling = true
        activeRecording?.stop()
        CameraPolicy.clearDirectory(camDir)
        finishWith(CameraCaptureOutcome.Cancelled)
    }

    /** 主界面：取景 + 顶部取消/翻转图标 + 底部快门（点按拍照、长按录像）与说明 + 右下相册图标 */
    @Composable
    private fun CameraScreen() {
        val wantPhoto = CameraConst.MODE_PHOTO in req.modes
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            if (granted) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx -> PreviewView(ctx).also { previewView = it; bind() } },
                )
            }
            Row(
                Modifier.align(Alignment.TopCenter).fillMaxWidth().statusBarsPadding().padding(16.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                GlyphButton(Glyph.CLOSE, "取消", Color.White) { cancel() }
                if (recording) Label("● ${elapsedSec}s / ${req.maxDurationSec}s", color = Color.Red)
                if (req.lensSwitch && !recording) {
                    GlyphButton(Glyph.FLIP, "翻转镜头", Color.White) {
                        facing = if (facing == CameraConst.FACING_BACK) CameraConst.FACING_FRONT else CameraConst.FACING_BACK
                        bind()
                    }
                } else {
                    Box(Modifier.size(SIDE_SLOT))
                }
            }
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().navigationBarsPadding().padding(bottom = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // 录像时快门整体放大，红色圆环按剩余时间逆时针收缩
                val scale by animateFloatAsState(if (recording) RECORD_SCALE else 1f, label = "shutterScale")
                LaunchedEffect(recording) {
                    if (recording) {
                        while (true) {
                            withFrameMillis {
                                ringFraction = CameraPolicy.ringFraction(SystemClock.elapsedRealtime() - recordStartMs, req.maxDurationSec)
                            }
                        }
                    } else {
                        ringFraction = 1f
                    }
                }
                Box(Modifier.size(SHUTTER_SIZE).graphicsLayer { scaleX = scale; scaleY = scale }) {
                    Box(
                        Modifier.fillMaxSize()
                            .border(RING_STROKE, if (recording) RING_TRACK else Color.White, CircleShape)
                            .padding(6.dp).clip(CircleShape)
                            .background(if (recording) Color.Red else Color.White)
                            .pointerInput(videoReady, wantPhoto) {
                                detectTapGestures(
                                    // 长按录像后松手即结束
                                    onPress = {
                                        tryAwaitRelease()
                                        if (holdRecording) {
                                            holdRecording = false
                                            activeRecording?.stop()
                                        }
                                    },
                                    onLongPress = {
                                        if (videoReady && wantPhoto && activeRecording == null) {
                                            holdRecording = true
                                            toggleRecord()
                                        }
                                    },
                                    onTap = { if (wantPhoto) takePhoto() else toggleRecord() },
                                )
                            },
                    )
                    if (recording) {
                        Canvas(Modifier.fillMaxSize()) {
                            val stroke = RING_STROKE.toPx()
                            drawArc(
                                Color.Red, -90f, -360f * ringFraction, false,
                                topLeft = Offset(stroke / 2, stroke / 2), size = Size(size.width - stroke, size.height - stroke),
                                style = Stroke(stroke, cap = StrokeCap.Round),
                            )
                        }
                    }
                }
                // 同时支持拍照与录像时，给一句操作说明
                if (videoReady && wantPhoto) {
                    Label(if (recording) "松开结束" else "长按录像", Modifier.padding(top = if (recording) RECORD_CAPTION_GAP else 8.dp), fontSize = CAPTION_SP)
                }
            }
            // 右下角相册图标，与相册页的相机图标同款同位置
            if (CameraConst.MODE_ALBUM in req.modes && !recording) {
                IconFab(FabIcon.ALBUM, "相册", Modifier.align(Alignment.BottomEnd)) { finishWith(CameraCaptureOutcome.Album) }
            }
        }
    }

    /** 一段白字 */
    @Composable
    private fun Label(text: String, modifier: Modifier = Modifier, color: Color = Color.White, fontSize: Int = LABEL_SP) {
        BasicText(text, modifier.padding(horizontal = 8.dp, vertical = 4.dp), TextStyle(color = color, fontSize = fontSize.sp))
    }

    private companion object {
        /** 快门按钮外径 */
        val SHUTTER_SIZE = 72.dp

        /** 快门两侧占位宽度，保证快门居中 */
        val SIDE_SLOT = 48.dp

        /** 毫秒每秒 */
        const val MS_PER_SEC = 1000L

        /** 普通文字字号 */
        const val LABEL_SP = 16

        /** 快门下方说明文字字号（普通文字的一半） */
        const val CAPTION_SP = 8

        /** 录像时快门放大倍数 */
        const val RECORD_SCALE = 1.5f

        /** 快门圆环线宽 */
        val RING_STROKE = 4.dp

        /** 录像时圆环底轨颜色（半透明白） */
        val RING_TRACK = Color(0x55FFFFFF)

        /** 录像时快门放大后，与下方说明之间补的间距 */
        val RECORD_CAPTION_GAP = 26.dp

        /** 倒计时结束的震动时长（毫秒） */
        const val VIBRATE_DONE_MS = 200L

        /** 视频旋转角 90 */
        const val ROT_90 = 90

        /** 视频旋转角 270 */
        const val ROT_270 = 270
    }
}

/**
 * 拉起 [CameraCaptureActivity] 的契约：入参 [CameraCaptureRequest]，出参 [CameraCaptureOutcome]。
 */
class CameraCaptureContract : ActivityResultContract<CameraCaptureRequest, CameraCaptureOutcome>() {
    /** 组装启动意图，请求序列化后放进 extra */
    override fun createIntent(context: Context, input: CameraCaptureRequest): Intent =
        Intent(context, CameraCaptureActivity::class.java)
            .putExtra(CameraConst.EXTRA_REQUEST, CameraPolicy.requestToJson(input))

    /** 解析返回：OK 带结果 JSON，其余按取消 */
    override fun parseResult(resultCode: Int, intent: Intent?): CameraCaptureOutcome =
        if (resultCode == Activity.RESULT_OK) CameraPolicy.outcomeFromJson(intent?.getStringExtra(CameraConst.EXTRA_RESULT))
        else CameraCaptureOutcome.Cancelled
}
