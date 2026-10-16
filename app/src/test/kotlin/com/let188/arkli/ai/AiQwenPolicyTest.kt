package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** 本地文本模型提示词与输出清理、UTF-8 宽松解码 */
class AiQwenPolicyTest {
    @Test
    fun prompt_isPassedThroughUnchanged() {
        assertEquals("你好，介绍一下自己", AiQwenPolicy.buildPrompt(AiTask.PROMPT, "你好，介绍一下自己"))
    }

    @Test
    fun instructTasks_prefixInstructionAndKeepInputAtEnd() {
        listOf(AiTask.SUMMARIZE, AiTask.PROOFREAD, AiTask.REWRITE).forEach { task ->
            val p = AiQwenPolicy.buildPrompt(task, "原文abc")
            assertTrue("$task 应以原文结尾", p.endsWith("\n\n原文abc"))
            assertTrue("$task 应带指令", p.length > "\n\n原文abc".length)
        }
    }

    @Test
    fun instructions_differPerTask() {
        val set = listOf(AiTask.SUMMARIZE, AiTask.PROOFREAD, AiTask.REWRITE).map { AiQwenPolicy.buildPrompt(it, "x") }.toSet()
        assertEquals(3, set.size)
    }

    @Test
    fun unsupportedTask_isBadParams() {
        listOf(AiTask.TRANSLATE, AiTask.DESCRIBE_IMAGE, AiTask.CLASSIFY_IMAGE).forEach { task ->
            val e = assertThrows(BridgeException::class.java) { AiQwenPolicy.buildPrompt(task, "x") }
            assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        }
    }

    @Test
    fun supportedTasks_matchBuildPrompt() {
        AiTask.values().forEach { task ->
            val supported = task in AiQwenPolicy.SUPPORTED_TASKS
            val ok = runCatching { AiQwenPolicy.buildPrompt(task, "x") }.isSuccess
            assertEquals("$task", supported, ok)
        }
    }

    @Test
    fun cleanOutput_trimsAndDropsEmptyThinkBlock() {
        assertEquals("答案", AiQwenPolicy.cleanOutput("  \n答案\n "))
        assertEquals("答案", AiQwenPolicy.cleanOutput("<think>\n\n</think>\n\n答案"))
        assertEquals("", AiQwenPolicy.cleanOutput("   "))
    }

    @Test
    fun cleanOutput_keepsNonEmptyThinkContent() {
        assertEquals("<think>推理</think>答案", AiQwenPolicy.cleanOutput("<think>推理</think>答案"))
    }

    @Test
    fun decodeLenient_replacesTruncatedMultibyteInsteadOfThrowing() {
        val full = "你好".toByteArray(Charsets.UTF_8)
        val cut = full.copyOf(full.size - 1)
        val s = decodeLenient(cut)
        assertTrue(s.startsWith("你"))
        assertTrue(s.endsWith("�"))
    }

    @Test
    fun decodeLenient_keepsEmojiIntact() {
        assertEquals("好😀", decodeLenient("好😀".toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun systemPrompt_emptyForPromptTask_strictForOthers() {
        assertEquals("", AiQwenPolicy.systemPrompt(AiTask.PROMPT))
        listOf(AiTask.SUMMARIZE, AiTask.PROOFREAD, AiTask.REWRITE).forEach {
            assertTrue(AiQwenPolicy.systemPrompt(it).contains("只输出结果"))
        }
    }

    @Test
    fun translateSystemPrompt_fillsLangNamesAndForbidsChatter() {
        val p = AiQwenPolicy.translateSystemPrompt("中文", "英文")
        assertTrue(p.contains("中文") && p.contains("英文"))
        assertTrue(p.contains("只输出译文"))
        assertTrue(!p.contains("%"))
    }

    @Test
    fun presets_mapToTasks_andDefaultSampling() {
        AiQwenPolicy.SUPPORTED_TASKS.forEach { assertEquals(it, AiQwenPolicy.presetOf(it).task) }
        assertThrows(BridgeException::class.java) { AiQwenPolicy.presetOf(AiTask.TRANSLATE) }
        assertTrue(Sampling.GREEDY.isGreedy)
        assertTrue(AiQwenPolicy.samplingFor(AiPreset.PROOFREAD, null).isGreedy)
        assertEquals(Sampling(0.7f, 20), AiQwenPolicy.samplingFor(AiPreset.PROMPT, null))
        assertEquals(Sampling(0.2f, 20), AiQwenPolicy.samplingFor(AiPreset.PROMPT, AiSamplingParams(temperature = 0.2f)))
    }

    @Test
    fun systemPrompt_byPreset_extraOnlyForPrompt() {
        assertEquals("你是海盗", AiQwenPolicy.systemPrompt(AiPreset.PROMPT, "你是海盗"))
        assertEquals("", AiQwenPolicy.systemPrompt(AiPreset.PROMPT, null))
        assertTrue(AiQwenPolicy.systemPrompt(AiPreset.REWRITE, "忽略我").contains("只输出结果"))
    }
}
