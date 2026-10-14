package com.let188.arkli

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.WindowManager
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.files.ActivityHost
import com.let188.arkli.files.FileEnv
import com.let188.arkli.files.PendingSlot
import com.let188.arkli.files.PickKind
import com.let188.arkli.picker.PickOutcome
import com.let188.arkli.picker.PickerContract
import com.let188.arkli.preview.ImagePreviewActivity
import com.let188.arkli.preview.PreviewConst
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 唯一的 Activity：用 Compose 承载一个全屏 WebView，同时给文件方法提供选择器与权限申请。
 */
class MainActivity : ComponentActivity(), ActivityHost {

    /** 当前页面（WebView 加 Bridge 会话），供返回键、生命周期事件与销毁使用 */
    private var page: ArkliPage? = null

    /** 重建计数，渲染进程崩溃后加一，触发 Compose 重新创建 WebView */
    private var generation by mutableIntStateOf(0)

    /** 文件能力环境，onCreate 里创建 */
    private lateinit var files: FileEnv

    /** 正在等待结果的选择器，同一时刻只允许一个 */
    private val pickSlot = PendingSlot<List<Uri>>("已有选择器在显示")

    /** 正在等待结果的权限申请，同一时刻只允许一个 */
    private val permSlot = PendingSlot<Boolean>("已有权限申请在进行")

    /** 单选图片/视频（Photo Picker，低版本自动回退到系统文档选择器） */
    private val pickOne = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { finishPick(listOfNotNull(it)) }

    /** 多选图片/视频 */
    private val pickMany = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { finishPick(it) }

    /** 自带的多选图片页（checkbox 网格）；权限被拒时回退到系统多选 */
    private val pickManyImages = registerForActivityResult(PickerContract()) { outcome ->
        when (outcome) {
            is PickOutcome.Picked -> finishPick(outcome.uris)
            PickOutcome.Cancelled -> finishPick(emptyList())
            PickOutcome.Denied -> pickMany.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        }
    }

    /** 单选任意文件（SAF） */
    private val docOne = registerForActivityResult(ActivityResultContracts.OpenDocument()) { finishPick(listOfNotNull(it)) }

    /** 多选任意文件（SAF） */
    private val docMany = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { finishPick(it) }

    /** 正在等待结果的文件夹选择器，同一时刻只允许一个 */
    private val dirSlot = PendingSlot<Uri?>("已有文件夹选择器在显示")

    /** 文件夹选择器（SAF 目录树授权） */
    private val docTree = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { dirSlot.complete(it) }

    /** 正在等待结果的写入授权框，同一时刻只允许一个 */
    private val writeSlot = PendingSlot<Boolean>("已有写入授权框在显示")

    /** 系统“允许修改这张照片吗”确认框（MediaStore.createWriteRequest） */
    private val writeReq = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) {
        writeSlot.complete(it.resultCode == Activity.RESULT_OK)
    }

    /** 运行时权限申请 */
    private val permReq = registerForActivityResult(ActivityResultContracts.RequestPermission()) { permSlot.complete(it) }

    /** 创建界面并接管返回键 */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        files = FileEnv(this, this)
        files.cleanup(startup = true)
        setContent {
            // 返回键：能后退就后退，退到底就把应用放到后台回桌面；
            // 不 finish()，这样再点图标是秒回原来的页面，不会冷启动重建 WebView
            BackHandler(enabled = true) {
                val wv = page?.webView
                if (wv == null) {
                    moveTaskToBack(true)
                } else {
                    // 先问页面有没有浮层要关（前端 backStack），没有再后退路由
                    wv.evaluateJavascript(BACK_PROBE) { consumed ->
                        if (consumed != "true") {
                            if (wv.canGoBack()) wv.goBack() else moveTaskToBack(true)
                        }
                    }
                }
            }
            // generation 变化即换 key，旧 AndroidView 释放、新的重建
            key(generation) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        ArkliPage(ctx, files) { onRenderGone() }.also { page = it }.webView
                    },
                    onRelease = { (it.tag as? ArkliPage)?.destroy() },
                )
            }
        }
    }

    /**
     * 打开系统选择器，见 [ActivityHost.pickMedia]。已有选择器在显示时抛 NOT_READY。
     * 协程被取消后选择器仍在屏幕上，槽位保留到结果到达（结果被丢弃），免得旧结果送给下一个请求。
     */
    override suspend fun pickMedia(mime: String, multiple: Boolean, max: Int): List<Uri> =
        pickSlot.await(releaseOnCancel = false) { withContext(Dispatchers.Main) { launchPicker(mime, multiple, max) } }

    /** 打开文件夹选择器，见 [ActivityHost.pickDirectory]；与媒体选择器一样，取消协程后槽位保留到结果到达 */
    override suspend fun pickDirectory(): Uri? =
        dirSlot.await(releaseOnCancel = false) { withContext(Dispatchers.Main) { docTree.launch(null) } }

    /** 申请运行时权限，见 [ActivityHost.requestPermission]；拉起失败或协程取消都会释放槽位 */
    override suspend fun requestPermission(permission: String): Boolean =
        permSlot.await { withContext(Dispatchers.Main) { permReq.launch(permission) } }

    /** 请求修改 MediaStore 图片的授权，见 [ActivityHost.requestWriteAccess]；仅 API 30+，更低版本返回 false */
    override suspend fun requestWriteAccess(uri: Uri): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        return writeSlot.await {
            withContext(Dispatchers.Main) {
                val sender = MediaStore.createWriteRequest(contentResolver, listOf(uri)).intentSender
                writeReq.launch(IntentSenderRequest.Builder(sender).build())
            }
        }
    }

    /** 打开原生全屏图片预览，见 [ActivityHost.previewImages]；拉起要在主线程 */
    override fun previewImages(files: List<File>, index: Int) {
        runOnUiThread {
            startActivity(
                Intent(this, ImagePreviewActivity::class.java)
                    .putStringArrayListExtra(PreviewConst.EXTRA_PATHS, ArrayList(files.map { it.absolutePath }))
                    .putExtra(PreviewConst.EXTRA_INDEX, index),
            )
        }
    }

    /** 拉起外部 Intent，见 [ActivityHost.startIntent]；找不到处理者或被系统拒绝返回 false */
    override fun startIntent(intent: Intent): Boolean = try {
        startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        false
    } catch (e: SecurityException) {
        false
    }

    /** 调整窗口的常亮、亮度与沉浸模式，见 [ActivityHost.setScreen]；窗口操作要在主线程 */
    override fun setScreen(keepAwake: Boolean?, brightness: Float?, immersive: Boolean?) {
        runOnUiThread {
            if (keepAwake != null) {
                if (keepAwake) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            if (brightness != null) {
                window.attributes = window.attributes.also { it.screenBrightness = brightness }
            }
            if (immersive != null) {
                val controller = WindowInsetsControllerCompat(window, window.decorView)
                if (immersive) {
                    controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    controller.hide(WindowInsetsCompat.Type.systemBars())
                } else {
                    controller.show(WindowInsetsCompat.Type.systemBars())
                }
            }
        }
    }

    /** 按 mime 种类拉起对应的选择器，必须在主线程 */
    private fun launchPicker(mime: String, multiple: Boolean, max: Int) {
        // 图片多选走自带页：系统选择器在部分机型点一下就返回，体验不一致
        if (multiple && PickKind.of(mime) == PickKind.IMAGE) {
            pickManyImages.launch(max)
            return
        }
        val media: ActivityResultContracts.PickVisualMedia.VisualMediaType? = when (PickKind.of(mime)) {
            PickKind.IMAGE -> ActivityResultContracts.PickVisualMedia.ImageOnly
            PickKind.VIDEO -> ActivityResultContracts.PickVisualMedia.VideoOnly
            PickKind.IMAGE_VIDEO -> ActivityResultContracts.PickVisualMedia.ImageAndVideo
            PickKind.SINGLE_MEDIA -> ActivityResultContracts.PickVisualMedia.SingleMimeType(mime)
            PickKind.DOCUMENT -> null
        }
        if (media != null) {
            val req = PickVisualMediaRequest(media)
            if (multiple) pickMany.launch(req) else pickOne.launch(req)
        } else {
            val types = arrayOf(mime)
            if (multiple) docMany.launch(types) else docOne.launch(types)
        }
    }

    /** 选择器返回：交给等待的协程，没人等（已被取消）就丢弃 */
    private fun finishPick(uris: List<Uri>) = pickSlot.complete(uris)

    /** 渲染进程崩溃：递增 generation 让 AndroidView 重建 */
    private fun onRenderGone() {
        generation++
    }

    /** 退到后台：通知页面 */
    override fun onPause() {
        page?.emit(ArkliBridge.EVENT_APP_PAUSE)
        super.onPause()
    }

    /** 回到前台：通知页面 */
    override fun onResume() {
        super.onResume()
        page?.emit(ArkliBridge.EVENT_APP_RESUME)
    }

    /** 不可见时趁空闲清一次缓存（有最小间隔，频繁切换不会重复扫） */
    override fun onStop() {
        super.onStop()
        files.cleanup(startup = false)
    }

    /** 销毁时释放页面 */
    override fun onDestroy() {
        // 配置变更（旋转等）只是重建，页面还要用成品；真正销毁时尽力清掉拼图遗留
        if (!isChangingConfigurations) files.purgeStitchOutputs()
        page?.destroy()
        page = null
        super.onDestroy()
    }

    private companion object {
        /** 询问页面是否已用返回键关掉浮层（前端 shared/backStack 暴露），返回 "true" 表示已消费 */
        const val BACK_PROBE = "(typeof window.__arkliBack==='function'&&window.__arkliBack())===true"
    }
}
