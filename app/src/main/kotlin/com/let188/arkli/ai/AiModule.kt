package com.let188.arkli.ai

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.files.requireMainFrame
import org.json.JSONObject

/**
 * 原生 AI 模块：目前只有 `native.ai.status`，原生 AI 运行时尚未接入，所有模型一律报未就绪。
 * 待 sherpa / ort 接入后替换（届时按模型文件是否存在、能否加载返回真实状态，并注册其余 `native.ai.*`）。
 *
 * 使用示例：`AiModule.install(bridge)`
 */
object AiModule {
    /** 方法名：模型状态 */
    const val METHOD_STATUS = "native.ai.status"

    /** 前端约定的模型名，顺序即返回顺序 */
    val MODEL_NAMES: List<String> = listOf("ocr", "upscale", "classify", "matte", "fuse", "colorize")

    /**
     * 生成状态数据：全部模型 false。纯函数，可单测。
     *
     * @return `{ models: { ocr:false, ... } }`
     */
    fun statusJson(): JSONObject {
        val models = JSONObject()
        MODEL_NAMES.forEach { models.put(it, false) }
        return JSONObject().put("models", models)
    }

    /**
     * 注册 AI 方法。
     *
     * @param bridge 当前会话的 Bridge
     */
    fun install(bridge: ArkliBridge) {
        bridge.register(METHOD_STATUS, BridgeHandler { ctx, _ ->
            requireMainFrame(ctx)
            statusJson()
        })
    }
}
