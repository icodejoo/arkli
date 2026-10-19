package com.let188.arkli.system

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 手电筒选相机逻辑 */
class TorchPolicyTest {
    /** 选第一个带闪光灯的后摄，跳过前摄和无闪光灯的后摄 */
    @Test
    fun picksFirstBackCameraWithFlash() {
        val list = listOf(
            TorchCandidate("1", backFacing = false, hasFlash = true),
            TorchCandidate("0", backFacing = true, hasFlash = false),
            TorchCandidate("2", backFacing = true, hasFlash = true),
            TorchCandidate("3", backFacing = true, hasFlash = true),
        )
        assertEquals("2", TorchPolicy.pickCameraId(list))
    }

    /** 没有符合条件的相机返回 null */
    @Test
    fun returnsNullWhenNoFlash() {
        assertNull(TorchPolicy.pickCameraId(emptyList()))
        assertNull(TorchPolicy.pickCameraId(listOf(TorchCandidate("0", backFacing = true, hasFlash = false))))
        assertNull(TorchPolicy.pickCameraId(listOf(TorchCandidate("1", backFacing = false, hasFlash = true))))
    }
}
