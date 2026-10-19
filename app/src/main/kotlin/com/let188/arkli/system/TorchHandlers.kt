package com.let188.arkli.system

import android.content.Context
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.requireMainFrame
import org.json.JSONObject

/**
 * 手电筒开关的进程内持有者：缓存选中的相机 id，并让 Activity 能在退后台时关灯。
 * `CameraManager.setTorchMode` 不需要 CAMERA 运行时权限，也不需要 FLASHLIGHT 声明。
 */
internal object TorchSwitch {
    /** 已选中的闪光灯相机 id；`resolved` 为 true 后才有效，null 表示没有闪光灯 */
    private var cameraId: String? = null

    /** 是否已经查过相机列表 */
    private var resolved = false

    /** 手电筒当前是否开着（本应用设置的） */
    @Volatile
    private var lit = false

    /** 查（并缓存）可用的闪光灯相机 id */
    @Synchronized
    private fun resolve(manager: CameraManager): String? {
        if (!resolved) {
            val list = try {
                manager.cameraIdList.map { id ->
                    val c = manager.getCameraCharacteristics(id)
                    TorchCandidate(
                        id = id,
                        backFacing = c.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK,
                        hasFlash = c.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true,
                    )
                }
            } catch (_: CameraAccessException) {
                emptyList()
            }
            cameraId = TorchPolicy.pickCameraId(list)
            resolved = true
        }
        return cameraId
    }

    /**
     * 开关手电筒。
     *
     * @param context 应用上下文
     * @param on 是否点亮
     * @return 设置后的实际状态；没有闪光灯为 null
     * @throws BridgeException 相机被其他应用占用等系统拒绝的情况（INTERNAL）
     */
    @Synchronized
    fun set(context: Context, on: Boolean): Boolean? {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: return null
        val id = resolve(manager) ?: return null
        try {
            manager.setTorchMode(id, on)
        } catch (e: CameraAccessException) {
            throw BridgeException(BridgeErrors.INTERNAL, "手电筒不可用：${e.message}")
        } catch (e: IllegalArgumentException) {
            throw BridgeException(BridgeErrors.INTERNAL, "手电筒不可用：${e.message}")
        }
        lit = on
        return on
    }

    /**
     * 若本应用点亮了手电筒就关掉，用于退后台，失败静默。
     *
     * @param context 应用上下文
     */
    fun turnOff(context: Context) {
        if (!lit) return
        try {
            set(context, false)
        } catch (_: BridgeException) {
            lit = false
        }
    }
}

/**
 * `native.torch.set`：`{ on: boolean }` -> `{ on: boolean, available: boolean }`。
 * `on` 是设置后的实际状态；设备没有后置闪光灯时返回 `{ on: false, available: false }`，不报错。
 * 关灯由前端卸载页面时调用，退后台由 MainActivity.onStop 兜底。
 *
 * @param context 应用上下文
 */
internal class TorchHandler(private val context: Context) : BridgeHandler {
    /** 校验后开关手电筒 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val on = SystemParams.bool(params, "on")
        val actual = TorchSwitch.set(context, on)
        return JSONObject().put("on", actual ?: false).put("available", actual != null)
    }
}
