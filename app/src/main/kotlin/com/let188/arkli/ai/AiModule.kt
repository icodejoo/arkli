package com.let188.arkli.ai

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.files.FileEnv
import com.let188.arkli.files.requireMainFrame
import com.let188.arkli.model.ModelModule
import org.json.JSONObject

/**
 * 原生 AI 模块：
 * - `native.ai.status`：本地模型就绪状态，运行时尚未接入，一律报未就绪，待 sherpa / ort 接入后替换；
 * - `native.ai.providers` / `native.ai.run`：AI 提供者抽象（见 [AiProvider]），交接类提供者与本地识物提供者；
 * - `native.ai.classify`：本地 SigLIP2 识物，见 [AiClassifyPolicy] 与 [ClipService]；
 * - 同时注册 `native.model.*` 模型下载管理（见 [ModelModule]），本地模型一律经它按需下载。
 *
 * 使用示例：`AiModule.install(bridge, env)`
 */
object AiModule {
    /** 方法名：模型状态 */
    const val METHOD_STATUS = "native.ai.status"

    /** 方法名：提供者列表与能力探测 */
    const val METHOD_PROVIDERS = "native.ai.providers"

    /** 方法名：交给某个提供者执行任务 */
    const val METHOD_RUN = "native.ai.run"

    /** 方法名：识图（本地 SigLIP2 识物） */
    const val METHOD_CLASSIFY = "native.ai.classify"

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
     * @param env 文件环境，取上下文与宿主
     */
    fun install(bridge: ArkliBridge, env: FileEnv) {
        val models = ModelModule.install(bridge, env.appContext)
        val clip = ClipRuntime.get(env.appContext)
        // 删除识物模型前先释放已加载的 ORT 会话；按 id 登记，重复安装只会替换
        models.addReleaseHook(ClipService.MODEL_ID) { clip.unload() }
        val registry = ProviderRegistry(
            listOf(
                IntentHandoffProvider(AndroidHandoffPlatform(env.appContext, env.host)),
                LocalClipProvider(clip, models),
            ),
        )
        bridge.register(METHOD_PROVIDERS, AiProvidersHandler(registry))
        bridge.register(METHOD_RUN, AiRunHandler(registry))
        bridge.register(METHOD_CLASSIFY, AiClassifyHandler(registry) { env.roots.resolveCache(it) })
        bridge.register(METHOD_STATUS, BridgeHandler { ctx, _ ->
            requireMainFrame(ctx)
            statusJson()
        })
    }
}
