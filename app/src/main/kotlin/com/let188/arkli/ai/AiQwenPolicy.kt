package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException

/**
 * 本地文本模型（Qwen）的提示词与长度策略：纯函数，无 Android 依赖，可单测。
 *
 * 使用示例：`AiQwenPolicy.buildPrompt(AiTask.SUMMARIZE, "一大段文字")`
 */
object AiQwenPolicy {
    /** 单次最多生成的 token 数；手机上约 17 tok/s，256 个约 15 秒，够摘要与改写，再长体验很差 */
    const val MAX_NEW_TOKENS = 256

    /** 摘要任务的指令 */
    private const val INSTRUCT_SUMMARIZE = "请用简洁的中文概括下面这段文字的要点，只输出概括，不要解释：\n\n"

    /** 校对任务的指令 */
    private const val INSTRUCT_PROOFREAD = "请校对下面这段文字，改正错别字和语病，只输出改正后的全文，不要解释：\n\n"

    /** 改写任务的指令 */
    private const val INSTRUCT_REWRITE = "请在保持原意的前提下改写下面这段文字，使表达更通顺自然，只输出改写后的全文，不要解释：\n\n"

    /** 关闭思考模式时模板会预填的空思考块 */
    private val EMPTY_THINK = Regex("<think>\\s*</think>")

    /** 本地文本模型支持的任务（提示词问答直接用原文） */
    val SUPPORTED_TASKS: Set<AiTask> = setOf(AiTask.PROMPT, AiTask.SUMMARIZE, AiTask.PROOFREAD, AiTask.REWRITE)

    /**
     * 按任务拼出送给模型的用户内容。
     *
     * @param task 任务，必须在 [SUPPORTED_TASKS] 内
     * @param input 用户输入的文本
     * @return 送给模型的用户内容；聊天模板由推理引擎套用，这里不加
     * @throws BridgeException BAD_PARAMS：任务不受支持
     */
    fun buildPrompt(task: AiTask, input: String): String = when (task) {
        AiTask.PROMPT -> input
        AiTask.SUMMARIZE -> INSTRUCT_SUMMARIZE + input
        AiTask.PROOFREAD -> INSTRUCT_PROOFREAD + input
        AiTask.REWRITE -> INSTRUCT_REWRITE + input
        else -> throw BridgeException(BridgeErrors.BAD_PARAMS, "本地文本模型不支持任务 ${task.wire}")
    }

    /**
     * 清理模型输出：去掉首尾空白，以及关闭思考后偶尔残留的空 `<think>` 块。
     *
     * @param raw 引擎原始输出
     * @return 清理后的文本
     */
    fun cleanOutput(raw: String): String = raw.replace(EMPTY_THINK, "").trim()
}
