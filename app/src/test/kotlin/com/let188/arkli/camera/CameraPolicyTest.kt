package com.let188.arkli.camera

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** [CameraPolicy] 的纯逻辑单测 */
class CameraPolicyTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun 默认参数解析正确() {
        val req = CameraPolicy.parseParams(JSONObject())
        assertEquals(listOf(CameraConst.MODE_PHOTO), req.modes)
        assertEquals(CameraConst.FACING_BACK, req.facing)
        assertEquals(CameraConst.DEFAULT_MAX_DURATION_SEC, req.maxDurationSec)
        assertTrue(req.lensSwitch)
    }

    @Test
    fun 完整合法参数解析() {
        val json = JSONObject().apply {
            put(CameraConst.KEY_MODES, JSONArray(listOf(CameraConst.MODE_PHOTO, CameraConst.MODE_VIDEO, CameraConst.MODE_ALBUM)))
            put(CameraConst.KEY_FACING, CameraConst.FACING_FRONT)
            put(CameraConst.KEY_MAX_DURATION_SEC, 30)
            put(CameraConst.KEY_LENS_SWITCH, false)
        }
        val req = CameraPolicy.parseParams(json)
        assertEquals(listOf(CameraConst.MODE_PHOTO, CameraConst.MODE_VIDEO, CameraConst.MODE_ALBUM), req.modes)
        assertEquals(CameraConst.FACING_FRONT, req.facing)
        assertEquals(30, req.maxDurationSec)
        assertFalse(req.lensSwitch)
    }

    @Test
    fun modes非法校验抛BAD_PARAMS() {
        val badCases = listOf(
            JSONObject().put(CameraConst.KEY_MODES, "photo"), // 不是数组
            JSONObject().put(CameraConst.KEY_MODES, JSONArray()), // 空数组
            JSONObject().put(CameraConst.KEY_MODES, JSONArray(listOf("unknown_mode"))), // 未知值
            JSONObject().put(CameraConst.KEY_MODES, JSONArray(listOf("photo", "photo"))), // 重复值
            JSONObject().put(CameraConst.KEY_MODES, JSONArray(listOf("photo", "album", "photo"))), // 重复值
        )
        for (case in badCases) {
            try {
                CameraPolicy.parseParams(case)
                fail("应抛出 BAD_PARAMS: $case")
            } catch (e: BridgeException) {
                assertEquals(BridgeErrors.BAD_PARAMS, e.code)
            }
        }
    }

    @Test
    fun facing非法校验抛BAD_PARAMS() {
        val bad = JSONObject().put(CameraConst.KEY_FACING, "top")
        try {
            CameraPolicy.parseParams(bad)
            fail("应抛出 BAD_PARAMS")
        } catch (e: BridgeException) {
            assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        }
    }

    @Test
    fun maxDurationSec非法校验抛BAD_PARAMS() {
        val badCases = listOf(
            JSONObject().put(CameraConst.KEY_MAX_DURATION_SEC, 0),
            JSONObject().put(CameraConst.KEY_MAX_DURATION_SEC, -10),
            JSONObject().put(CameraConst.KEY_MAX_DURATION_SEC, 301),
            JSONObject().put(CameraConst.KEY_MAX_DURATION_SEC, "60"),
        )
        for (case in badCases) {
            try {
                CameraPolicy.parseParams(case)
                fail("应抛出 BAD_PARAMS: $case")
            } catch (e: BridgeException) {
                assertEquals(BridgeErrors.BAD_PARAMS, e.code)
            }
        }
    }

    @Test
    fun lensSwitch非法校验抛BAD_PARAMS() {
        val bad = JSONObject().put(CameraConst.KEY_LENS_SWITCH, "false")
        try {
            CameraPolicy.parseParams(bad)
            fail("应抛出 BAD_PARAMS")
        } catch (e: BridgeException) {
            assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        }
    }

    @Test
    fun 路径生成与文件名生成正确() {
        val cacheRoot = tempFolder.newFolder("arkli")
        val dir = CameraPolicy.camDir(cacheRoot)
        assertEquals(File(cacheRoot, "pick/cam"), dir)

        val pagePath = CameraPolicy.pagePath("cam_123.jpg")
        assertEquals("cache/pick/cam/cam_123.jpg", pagePath)

        val imageFile = CameraPolicy.generateTargetFile(dir, isVideo = false, suffixId = "abc12345")
        assertEquals("cam_abc12345.jpg", imageFile.name)
        assertEquals(dir.absolutePath, imageFile.parentFile?.absolutePath)

        val videoFile = CameraPolicy.generateTargetFile(dir, isVideo = true, suffixId = "def67890")
        assertEquals("cam_def67890.mp4", videoFile.name)
    }

    @Test
    fun 清空目录正常工作() {
        val dir = tempFolder.newFolder("cam_clear_test")
        val f1 = File(dir, "f1.jpg").apply { writeText("1") }
        val f2 = File(dir, "f2.mp4").apply { writeText("2") }
        val subDir = File(dir, "sub").apply { mkdir() }
        val f3 = File(subDir, "f3.tmp").apply { writeText("3") }

        assertEquals(3, CameraPolicy.clearDirectory(dir))
        assertEquals(0, dir.listFiles()?.size ?: 0)
    }

    @Test
    fun captureReply各结局分支响应格式正确() {
        val success = CameraCaptureOutcome.Success(
            kind = CameraConst.KIND_IMAGE,
            path = "cache/pick/cam/cam_1.jpg",
            name = "cam_1.jpg",
            mime = CameraConst.MIME_JPEG,
            size = 1024L,
            width = 1920,
            height = 1080,
            durationMs = null,
        )
        val rep1 = CameraPolicy.captureReply(success)
        assertEquals(CameraConst.KIND_IMAGE, rep1.getString(CameraConst.KEY_KIND))
        assertEquals("cache/pick/cam/cam_1.jpg", rep1.getString(CameraConst.KEY_PATH))
        assertEquals("cam_1.jpg", rep1.getString(CameraConst.KEY_NAME))
        assertEquals(CameraConst.MIME_JPEG, rep1.getString(CameraConst.KEY_MIME))
        assertEquals(1024L, rep1.getLong(CameraConst.KEY_SIZE))
        assertEquals(1920, rep1.getInt(CameraConst.KEY_WIDTH))
        assertEquals(1080, rep1.getInt(CameraConst.KEY_HEIGHT))
        assertFalse(rep1.has(CameraConst.KEY_DURATION_MS))

        val successVideo = CameraCaptureOutcome.Success(
            kind = CameraConst.KIND_VIDEO,
            path = "cache/pick/cam/cam_2.mp4",
            name = "cam_2.mp4",
            mime = CameraConst.MIME_MP4,
            size = 2048L,
            width = 1280,
            height = 720,
            durationMs = 5000L,
        )
        val repVideo = CameraPolicy.captureReply(successVideo)
        assertEquals(5000L, repVideo.getLong(CameraConst.KEY_DURATION_MS))

        val rep2 = CameraPolicy.captureReply(CameraCaptureOutcome.Cancelled)
        assertTrue(rep2.getBoolean(CameraConst.KEY_CANCELLED))

        val rep3 = CameraPolicy.captureReply(CameraCaptureOutcome.Album)
        assertTrue(rep3.getBoolean(CameraConst.KEY_ALBUM))

        try {
            CameraPolicy.captureReply(CameraCaptureOutcome.Denied("自定义没有权限"))
            fail("应抛 PERMISSION_DENIED")
        } catch (e: BridgeException) {
            assertEquals(BridgeErrors.PERMISSION_DENIED, e.code)
            assertEquals("自定义没有权限", e.message)
        }

        try {
            CameraPolicy.captureReply(CameraCaptureOutcome.Error("相机启动失败"))
            fail("应抛 INTERNAL")
        } catch (e: BridgeException) {
            assertEquals(BridgeErrors.INTERNAL, e.code)
            assertEquals("相机启动失败", e.message)
        }
    }

    @Test
    fun 请求与结果JSON往返测试() {
        val req = CameraCaptureRequest(listOf(CameraConst.MODE_PHOTO, CameraConst.MODE_VIDEO), CameraConst.FACING_FRONT, 45, false)
        val jsonStr = CameraPolicy.requestToJson(req)
        val parsedReq = CameraPolicy.requestFromJson(jsonStr)
        assertEquals(req, parsedReq)

        val outcome = CameraCaptureOutcome.Success(
            kind = CameraConst.KIND_VIDEO,
            path = "cache/pick/cam/cam_v.mp4",
            name = "cam_v.mp4",
            mime = CameraConst.MIME_MP4,
            size = 9999L,
            width = 1080,
            height = 1920,
            durationMs = 1234L,
        )
        val outcomeJson = CameraPolicy.outcomeToJson(outcome)
        val parsedOutcome = CameraPolicy.outcomeFromJson(outcomeJson)
        assertEquals(outcome, parsedOutcome)

        assertEquals(CameraCaptureOutcome.Cancelled, CameraPolicy.outcomeFromJson(CameraPolicy.outcomeToJson(CameraCaptureOutcome.Cancelled)))
        assertEquals(CameraCaptureOutcome.Album, CameraPolicy.outcomeFromJson(CameraPolicy.outcomeToJson(CameraCaptureOutcome.Album)))
        assertEquals(CameraCaptureOutcome.Denied("拒绝"), CameraPolicy.outcomeFromJson(CameraPolicy.outcomeToJson(CameraCaptureOutcome.Denied("拒绝"))))
        assertEquals(CameraCaptureOutcome.Error("错误"), CameraPolicy.outcomeFromJson(CameraPolicy.outcomeToJson(CameraCaptureOutcome.Error("错误"))))
    }

    /** 倒计时圆环：开始满环、过半一半、到点与超时都是空环，负数和非法上限不越界 */
    @Test
    fun ringFraction_clampsToUnitRange() {
        assertEquals(1f, CameraPolicy.ringFraction(0, 3), 0f)
        assertEquals(0.5f, CameraPolicy.ringFraction(1500, 3), 0.0001f)
        assertEquals(0f, CameraPolicy.ringFraction(3000, 3), 0f)
        assertEquals(0f, CameraPolicy.ringFraction(9000, 3), 0f)
        assertEquals(1f, CameraPolicy.ringFraction(-100, 3), 0f)
        assertEquals(0f, CameraPolicy.ringFraction(100, 0), 0f)
    }
}
