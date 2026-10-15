package com.let188.arkli.camera

import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.ActivityHost
import com.let188.arkli.files.FileRoots
import com.let188.arkli.files.requireMainFrame
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * `native.camera.capture`：拉起原生全屏相机拍照或录像。
 *
 * 参数：`{ modes?: ('photo'|'video'|'album')[], facing?: 'back'|'front', maxDurationSec?: number, lensSwitch?: boolean }`
 * 返回：`{ kind, path, name, mime, size, width, height, durationMs? }`、`{ cancelled: true }` 或 `{ album: true }`。
 *
 * 每次拍摄前先清掉上一次的旧文件。
 *
 * @param host Activity 宿主
 * @param roots 目录根，用来定位相机缓存目录
 */
internal class CameraCaptureHandler(private val host: ActivityHost, private val roots: FileRoots) : BridgeHandler {
    /** 校验参数并拉起全屏相机 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val req = CameraPolicy.parseParams(params)
        withContext(Dispatchers.IO) { CameraPolicy.clearDirectory(CameraPolicy.camDir(roots.cacheRoot)) }
        val outcome = host.captureCamera(req)
        return CameraPolicy.captureReply(outcome)
    }
}

/**
 * `native.camera.clear`：清理相机专用临时产物目录（`cacheDir/arkli/pick/cam`）。
 *
 * 参数：无。返回：`{ cleared: true, count: number }`。
 *
 * @param roots 目录根，用来获取缓存根目录
 */
internal class CameraClearHandler(private val roots: FileRoots) : BridgeHandler {
    /** 在 IO 线程清空相机缓存目录 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val count = withContext(Dispatchers.IO) {
            CameraPolicy.clearDirectory(CameraPolicy.camDir(roots.cacheRoot))
        }
        return JSONObject().apply {
            put("cleared", true)
            put("count", count)
        }
    }
}
