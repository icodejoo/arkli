package com.let188.arkli

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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

    /** 单选任意文件（SAF） */
    private val docOne = registerForActivityResult(ActivityResultContracts.OpenDocument()) { finishPick(listOfNotNull(it)) }

    /** 多选任意文件（SAF） */
    private val docMany = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { finishPick(it) }

    /** 运行时权限申请 */
    private val permReq = registerForActivityResult(ActivityResultContracts.RequestPermission()) { permSlot.complete(it) }

    /** 创建界面并接管返回键 */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        files = FileEnv(this, this)
        files.cleanup(startup = true)
        setContent {
            // 返回键：能后退就后退，否则交给系统
            BackHandler(enabled = true) {
                val wv = page?.webView
                if (wv != null && wv.canGoBack()) wv.goBack() else finish()
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
        pickSlot.await(releaseOnCancel = false) { withContext(Dispatchers.Main) { launchPicker(mime, multiple) } }

    /** 申请运行时权限，见 [ActivityHost.requestPermission]；拉起失败或协程取消都会释放槽位 */
    override suspend fun requestPermission(permission: String): Boolean =
        permSlot.await { withContext(Dispatchers.Main) { permReq.launch(permission) } }

    /** 按 mime 种类拉起对应的选择器，必须在主线程 */
    private fun launchPicker(mime: String, multiple: Boolean) {
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
        page?.destroy()
        page = null
        super.onDestroy()
    }
}
