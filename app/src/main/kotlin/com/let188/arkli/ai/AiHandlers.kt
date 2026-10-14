package com.let188.arkli.ai

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.ActivityHost
import com.let188.arkli.files.requireMainFrame
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
