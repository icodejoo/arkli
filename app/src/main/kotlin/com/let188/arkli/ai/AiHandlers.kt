package com.let188.arkli.ai

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.ActivityHost
import com.let188.arkli.files.requireMainFrame
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
 * `native.ai.invoke`：统一入口 `{ task, input, provider?, entry?, options? }` -> 该任务端口的结果（与对应旧入口同形）。
 * 端口由路由推导，分派见 [AiInvoker]。
 *
 * @param invoker 分派器
 */
internal class AiInvokeHandler(private val invoker: AiInvoker) : BridgeHandler {
    /** 校验 -> 定端口 -> 分派 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return invoker.invoke(params)
    }
}

/**
 * `native.ai.run`（`native.ai.invoke` 钉死 run 端口的别名）：`{ provider, task, input }` -> `{ handoff, handled, text? }`。
 *
 * @param invoker 分派器
 */
internal class AiRunHandler(private val invoker: AiInvoker) : BridgeHandler {
    /** 按旧参数形状校验（provider 必填）后交给分派器 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val req = AiPolicy.parseRun(params)
        return invoker.dispatch(AiCall.Run(req.task, req.provider, req.input))
    }
}

/**
 * `native.ai.classify`（`native.ai.invoke` 钉死识图端口的别名）：`{ provider?, path, topK? }` -> 识别结果（见 [AiClassifyPolicy.resultJson]）。
 * 解码与推理在后台线程，同一时刻只跑一个（[AiHeavyGate]）。
 *
 * @param invoker 分派器
 */
internal class AiClassifyHandler(private val invoker: AiInvoker) : BridgeHandler {
    /** 按旧参数形状校验后交给分派器 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return invoker.dispatch(AiCall.Classify(AiClassifyPolicy.parse(params)))
    }
}

/**
 * `native.ai.ocr`（`native.ai.invoke` 钉死文字识别端口的别名）：`{ provider?, path }` -> 识别结果（见 [AiOcrPolicy.resultJson]）。
 * 解码与推理在后台线程，同一时刻只跑一个（[AiHeavyGate]）；取消（`native.task.cancel`）会打断 Rust 里的识别。
 *
 * @param invoker 分派器
 */
internal class AiOcrHandler(private val invoker: AiInvoker) : BridgeHandler {
    /** 按参数形状校验后交给分派器 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return invoker.dispatch(AiCall.Ocr(AiOcrPolicy.parse(params)))
    }
}

/**
 * `native.ai.matting`（`native.ai.invoke` 钉死抠图端口的别名）：`{ provider?, path, mode }` ->
 * `{ path, width, height, mode, elapsedMs, inferMs, refineMs, modelId }`（见 [AiMattingPolicy.resultJson]）。解码与推理在后台线程，
 * 同一时刻只跑一个（[AiHeavyGate]）；取消（`native.task.cancel`）最迟在一次前向结束后生效（前向不可中途打断）。
 *
 * @param invoker 分派器
 */
internal class AiMattingHandler(private val invoker: AiInvoker) : BridgeHandler {
    /** 按参数形状校验后交给分派器 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return invoker.dispatch(AiCall.Matting(AiMattingPolicy.parse(params)))
    }
}

/**
 * `native.ai.couplet`（`native.ai.invoke` 钉死对联端口的别名）：`{ provider?, text, temperature?, topK?, seed? }` ->
 * `{ text, elapsedMs, modelId }`（见 [AiCoupletPolicy.resultJson]）。推理在后台线程，同一时刻只跑一个（[AiHeavyGate]）；
 * 取消（`native.task.cancel`）会打断 Rust 里的生成。
 *
 * @param invoker 分派器
 */
internal class AiCoupletHandler(private val invoker: AiInvoker) : BridgeHandler {
    /** 按参数形状校验后交给分派器 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return invoker.dispatch(AiCall.Couplet(AiCoupletPolicy.parse(params)))
    }
}

/**
 * `native.ai.translate`（`native.ai.invoke` 钉死翻译端口的别名）：`{ text, src(可为 auto), tgt, numBeams?, provider? }` ->
 * `{ text, elapsedMs, modelId, src, tgt, detectedSrc, unrecognized }`。语言按选中提供者的报价约束校验。
 * 模型加载与推理在后台线程，同一时刻只跑一个 AI 重任务（[AiHeavyGate]，后来者排队）。
 *
 * @param invoker 分派器
 */
internal class AiTranslateHandler(private val invoker: AiInvoker) : BridgeHandler {
    /** 按旧参数形状校验后交给分派器 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return invoker.dispatch(AiCall.Translate(AiTranslatePolicy.parse(params)))
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
        val control = AiRouter.resolveById(registry.all(), AiPort.Session, id).port
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

/**
 * `native.ai.params.get`：`{ provider }` -> `{ provider, specs, values }`（values 含全部 key 的当前生效值）。
 *
 * @param registry 提供者登记处
 * @param store 用户参数存储
 */
internal class AiParamsGetHandler(private val registry: ProviderRegistry, private val store: AiParamStore) : BridgeHandler {
    /** 校验提供者后读当前值 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return AiParams.handleGet(params, registry.all(), store)
    }
}

/**
 * `native.ai.params.set`：`{ provider, values }` -> 同 get。整批原子：任一项非法整批拒绝（BAD_PARAMS），不夹取。
 *
 * @param registry 提供者登记处
 * @param store 用户参数存储
 */
internal class AiParamsSetHandler(private val registry: ProviderRegistry, private val store: AiParamStore) : BridgeHandler {
    /** 整批校验通过后落盘 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return AiParams.handleSet(params, registry.all(), store)
    }
}

/**
 * `native.ai.params.reset`：`{ provider, keys? }` -> 同 get。缺省 keys 恢复该提供者全部参数的默认值。
 *
 * @param registry 提供者登记处
 * @param store 用户参数存储
 */
internal class AiParamsResetHandler(private val registry: ProviderRegistry, private val store: AiParamStore) : BridgeHandler {
    /** 删掉已存的值即恢复默认 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return AiParams.handleReset(params, registry.all(), store)
    }
}
