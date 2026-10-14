package com.let188.arkli.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** AI 状态占位的测试 */
class AiModuleTest {
    @Test
    fun status_all_models_false() {
        val models = AiModule.statusJson().getJSONObject("models")
        assertEquals(setOf("ocr", "upscale", "classify", "matte", "fuse", "colorize"), models.keys().asSequence().toSet())
        AiModule.MODEL_NAMES.forEach { assertFalse(models.getBoolean(it)) }
    }
}
