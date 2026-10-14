package com.let188.arkli.qrcode

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
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
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 全屏扫码页：CameraX 预览 + `ImageAnalysis`（Y 平面）喂 zxing-cpp，识别到码就带着这一帧的全部码返回。
 * 自己申请相机权限；被拒以 [QrConst.RESULT_DENIED] 结束。带闪光灯开关（设备没有闪光灯则不显示）。
 * 仅应用内部拉起，见 [QrScanContract]。
 */
class QrScanActivity : ComponentActivity() {
    /** 相机权限是否已获得，驱动界面显示 */
    private var granted by mutableStateOf(false)

    /** 闪光灯是否开启 */
    private var torchOn by mutableStateOf(false)

    /** 当前设备是否有闪光灯 */
    private var hasFlash by mutableStateOf(false)

    /** 已绑定的相机，用来控制闪光灯 */
    private var camera: Camera? = null

    /** 是否已经交出结果，避免连续帧重复 finish */
    private val finished = AtomicBoolean(false)

    /** 分析线程，单线程串行处理帧 */
    private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    /** 实时取景用的读码器，只在分析线程使用 */
    private val engine by lazy { QrEngine(QrPolicy.LIVE_SPEC) }

    /** 相机权限申请 */
    private val permReq = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) granted = true else deny()
    }

    /** 创建界面：先确认权限，再显示取景 */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) granted = true
        else permReq.launch(Manifest.permission.CAMERA)
        setContent { ScanScreen() }
    }

    /** 销毁时关掉分析线程 */
    override fun onDestroy() {
        analysisExecutor.shutdown()
        super.onDestroy()
    }

    /** 权限被拒：通知调用方 */
    private fun deny() {
        setResult(QrConst.RESULT_DENIED)
        finish()
    }

    /** 带着识别结果返回，只会生效一次 */
    private fun finishWith(hits: List<QrHit>) {
        if (!finished.compareAndSet(false, true)) return
        runOnUiThread {
            setResult(Activity.RESULT_OK, Intent().putExtra(QrConst.EXTRA_RESULTS, QrPolicy.hitsToJson(hits).toString()))
            finish()
        }
    }

    /** 分析一帧：识别到就返回，无论如何都关帧，否则相机不会再给下一帧 */
    private fun analyze(frame: androidx.camera.core.ImageProxy) {
        try {
            if (finished.get()) return
            val hits = engine.decode(frame)
            if (hits.isNotEmpty()) finishWith(hits)
        } finally {
            frame.close()
        }
    }

    /** 绑定预览与分析用例到本 Activity 的生命周期 */
    private fun bindCamera(previewView: PreviewView) {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { it.setAnalyzer(analysisExecutor, ::analyze) }
            provider.unbindAll()
            camera = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            hasFlash = camera?.cameraInfo?.hasFlashUnit() == true
        }, ContextCompat.getMainExecutor(this))
    }

    /** 切换闪光灯 */
    private fun toggleTorch() {
        torchOn = !torchOn
        camera?.cameraControl?.enableTorch(torchOn)
    }

    /** 扫码主界面：取景 + 取景框 + 顶部取消 + 底部闪光灯 */
    @Composable
    private fun ScanScreen() {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            if (granted) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx -> PreviewView(ctx).also { bindCamera(it) } },
                )
            }
            Box(
                Modifier.align(Alignment.Center).size(FRAME_SIZE).border(2.dp, Color.White.copy(alpha = FRAME_ALPHA), RoundedCornerShape(12.dp)),
            )
            Label("取消", Modifier.align(Alignment.TopStart).statusBarsPadding().padding(16.dp).clickable { finish() })
            Label("将二维码或条码放入框内", Modifier.align(Alignment.Center).padding(top = FRAME_SIZE + 40.dp), small = true)
            if (hasFlash) {
                Label(
                    if (torchOn) "关闭闪光灯" else "打开闪光灯",
                    Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 32.dp)
                        .clip(RoundedCornerShape(20.dp)).background(Color.White.copy(alpha = CHIP_ALPHA))
                        .clickable { toggleTorch() }.padding(horizontal = 20.dp, vertical = 10.dp),
                )
            }
        }
    }

    /** 一段白字 */
    @Composable
    private fun Label(text: String, modifier: Modifier = Modifier, small: Boolean = false) {
        BasicText(text, modifier, TextStyle(color = Color.White, fontSize = if (small) 13.sp else 16.sp))
    }

    private companion object {
        /** 取景框边长 */
        val FRAME_SIZE = 240.dp

        /** 取景框描边透明度 */
        const val FRAME_ALPHA = 0.8f

        /** 闪光灯按钮底色透明度 */
        const val CHIP_ALPHA = 0.2f
    }
}

/**
 * 拉起 [QrScanActivity] 的契约：无入参，出参是 [QrScanOutcome]。
 */
class QrScanContract : ActivityResultContract<Unit, QrScanOutcome>() {
    /** 组装启动意图 */
    override fun createIntent(context: Context, input: Unit): Intent = Intent(context, QrScanActivity::class.java)

    /** 解析返回：OK 带结果 JSON，自定义码表示权限被拒，其余按取消 */
    override fun parseResult(resultCode: Int, intent: Intent?): QrScanOutcome = when (resultCode) {
        Activity.RESULT_OK -> {
            val hits = QrPolicy.hitsFromJson(intent?.getStringExtra(QrConst.EXTRA_RESULTS))
            if (hits.isEmpty()) QrScanOutcome.Cancelled else QrScanOutcome.Scanned(hits)
        }
        QrConst.RESULT_DENIED -> QrScanOutcome.Denied
        else -> QrScanOutcome.Cancelled
    }
}
