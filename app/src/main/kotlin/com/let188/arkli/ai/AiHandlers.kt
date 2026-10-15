package com.let188.arkli.ai

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.ActivityHost
import com.let188.arkli.files.requireMainFrame
import com.let188.arkli.image.SourceResolver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** 处理文本用的 MIME，与 `native.intent.processText` 一致 */
private const val MIME_TEXT = "text/plain"

/**
 * 安卓实现的交接平台能力：用 PackageManager 探测、ActivityHost 拉起。
 *
 * @param context 应用上下文
 * @param host 启动 Intent 的宿主
 */
internal class AndroidHandoffPlatform(private val context: Context, private val host: ActivityHost) : HandoffPlatform {
    /** 构造一个 PROCESS_TEXT Intent；text 为 null 时只用于探测 */
    private fun intent(text: String?): Intent = Intent(Intent.ACTION_PROCESS_TEXT).setType(MIME_TEXT).apply {
        if (text != null) {
            putExtra(Intent.EXTRA_PROCESS_TEXT, text)
            putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, true)
        }
    }

    /** 查询是否有响应者；清单 `<queries>` 已声明该 Intent，API 30+ 也看得见 */
    override fun hasProcessTextHandler(): Boolean {
        val pm = context.packageManager
        val list = if (Build.VERSION.SDK_INT >= 33) {
            pm.queryIntentActivities(intent(null), PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.queryIntentActivities(intent(null), 0)
        }
        return list.isNotEmpty()
    }

    /** 拉起响应者 */
    override fun sendProcessText(text: String): Boolean = host.startIntent(intent(text))
}

/**
 * `native.ai.providers`：无参，返回各提供者与可用任务并集。
 *
 * @param registry 提供者登记处
 */
internal class AiProvidersHandler(private val registry: ProviderRegistry) : BridgeHandler {
    /** 汇总可用性 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return AiPolicy.providersJson(registry.all())
    }
}

/**
 * `native.ai.run`：`{ provider, task, input }` -> `{ handoff, handled, text? }`。
 *
 * @param registry 提供者登记处
 */
internal class AiRunHandler(private val registry: ProviderRegistry) : BridgeHandler {
    /** 校验后交给提供者执行 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val req = AiPolicy.parseRun(params)
        val provider = AiPolicy.requireRunnable(registry.get(req.provider), req)
        return AiPolicy.resultJson(provider.run(req.task, req.input))
    }
}

/**
 * `native.ai.classify`：`{ provider?, path, topK? }` -> 识别结果（见 [AiClassifyPolicy.resultJson]）。
 * 解码与推理在后台线程，同一时刻只跑一个（[AiHeavyGate]）。
 *
 * @param registry 提供者登记处
 * @param resolver 页面路径解析器，必须拒绝路径穿越
 */
internal class AiClassifyHandler(
    private val registry: ProviderRegistry,
    private val resolver: SourceResolver,
) : BridgeHandler {
    /** 校验 -> 选提供者 -> 解析路径 -> 识别 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val req = AiClassifyPolicy.parse(params)
        val classifier = AiClassifyPolicy.requireClassifier(registry.all(), req.provider)
        val file = resolver.resolve(req.path)?.takeIf { it.isFile }
            ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "path 不是有效的缓存图片路径")
        val result = withContext(Dispatchers.IO) { classifier.classify(file, req.topK) }
        return AiClassifyPolicy.resultJson(result)
    }
}

/**
 * `native.ai.translate`：`{ text, src(可为 auto), tgt, numBeams? }` -> `{ text, elapsedMs, modelId, src, tgt, detectedSrc, unrecognized }`。
 * 模型加载与推理在后台线程，同一时刻只跑一个 AI 重任务（[AiHeavyGate]，后来者排队）。
 *
 * @param registry 提供者登记处
 */
internal class AiTranslateHandler(private val registry: ProviderRegistry) : BridgeHandler {
    /** 校验 -> 选提供者 -> 翻译 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val req = AiTranslatePolicy.parse(params)
        val translator = AiTranslatePolicy.requireTranslator(registry.all())
        val result = withContext(Dispatchers.IO) { translator.translate(req) }
        return AiTranslatePolicy.resultJson(result)
    }
}

/**
 * `native.ai.warmup`：`{ provider }` -> `{ provider, loaded: true, elapsedMs }`。
 * 只加载模型会话、不推理；已加载幂等。在后台线程排队执行（[AiHeavyGate]），可取消。
 *
 * @param registry 提供者登记处
 */
internal class AiWarmupHandler(private val registry: ProviderRegistry) : BridgeHandler {
    /** 校验 -> 选提供者 -> 预热 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val id = AiLifecyclePolicy.parseWarmup(params)
        val (_, control) = AiLifecyclePolicy.requireWarmable(registry.all(), id)
        return AiLifecyclePolicy.warmupJson(withContext(Dispatchers.IO) { control.warmup() })
    }
}

/**
 * `native.ai.unload`：`{ provider? }` -> `{ unloaded: string[] }`。
 * 缺省卸载全部已加载的会话；幂等；有推理在跑时排在它后面（[AiHeavyGate]）。
 *
 * @param registry 提供者登记处
 */
internal class AiUnloadHandler(private val registry: ProviderRegistry) : BridgeHandler {
    /** 校验 -> 选会话 -> 卸载 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val sessions = AiLifecyclePolicy.selectSessions(registry.all(), AiLifecyclePolicy.parseUnload(params))
        return AiLifecyclePolicy.unloadJson(withContext(Dispatchers.IO) { AiLifecyclePolicy.unloadAll(sessions) })
    }
}
