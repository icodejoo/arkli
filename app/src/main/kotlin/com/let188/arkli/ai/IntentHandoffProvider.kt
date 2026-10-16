package com.let188.arkli.ai

/**
 * 交接所需的平台能力，抽出来便于单测替身。
 */
interface HandoffPlatform {
    /**
     * 系统里是否有 `ACTION_PROCESS_TEXT` 响应者（`queryIntentActivities`）。
     *
     * @return 有则 true
     */
    fun hasProcessTextHandler(): Boolean

    /**
     * 把文本用 `ACTION_PROCESS_TEXT`（只读）交给系统里的应用。
     *
     * @param text 要交出的文本
     * @return 是否成功拉起了某个应用
     */
    fun sendProcessText(text: String): Boolean
}

/**
 * 交接提供者：把文本交给系统里已有的应用（翻译、AI 助手类），拿不回结果。
 * 第三方应用无法在通用层调用系统智能体并取回结果，这是目前零依赖、全机型可用的路径。
 *
 * 任务种类只影响页面文案：系统接口只能传文本，不能带「请摘要」之类的指令，
 * 所以所有文本类任务都是同一个动作——把原文交出去，用户在接手的应用里自己选操作。
 *
 * 使用示例：`IntentHandoffProvider(platform).run(AiTask.TRANSLATE, "hello")` -> `Handoff(true)`
 *
 * @param platform 平台能力
 */
class IntentHandoffProvider(private val platform: HandoffPlatform) : AiProvider {
    /** 固定 id */
    override val id: String = ID

    /** 展示名 */
    override val displayName: String = "系统应用交接"

    /** 系统提供的能力（交接型），属 L3 */
    override val layer: AiLayer = AiLayer.L3

    /** 支持全部文本类任务 */
    override fun capabilities(): Set<AiTask> = AiTask.values().filter { it.isText }.toSet()

    /** 有 PROCESS_TEXT 响应者才可用 */
    override fun availability(): AiAvailability =
        if (platform.hasProcessTextHandler()) AiAvailability.AVAILABLE else AiAvailability.unavailable(AiUnavailableReason.NO_HANDLER)

    /** 交出文本，handled 反映是否真有应用接手 */
    override suspend fun run(task: AiTask, input: String): AiRunResult = AiRunResult.Handoff(platform.sendProcessText(input))

    companion object {
        /** 提供者 id 常量 */
        const val ID = "intent-handoff"
    }
}
