package com.let188.arkli.system

/**
 * 一个相机的与手电筒相关的特征。
 *
 * @property id 相机 id
 * @property backFacing 是否后摄
 * @property hasFlash 是否带闪光灯
 */
internal class TorchCandidate(val id: String, val backFacing: Boolean, val hasFlash: Boolean)

/**
 * `native.torch.set` 的选相机逻辑，纯函数，可单测。
 *
 * 使用示例：`TorchPolicy.pickCameraId(listOf(TorchCandidate("0", true, true)))`
 */
internal object TorchPolicy {
    /**
     * 选用于手电筒的相机：第一个带闪光灯的后摄。
     *
     * @param candidates 设备上全部相机的特征，保持系统给出的顺序
     * @return 相机 id；没有符合条件的相机为 null
     */
    fun pickCameraId(candidates: List<TorchCandidate>): String? =
        candidates.firstOrNull { it.backFacing && it.hasFlash }?.id
}
