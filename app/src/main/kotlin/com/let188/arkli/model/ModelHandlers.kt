package com.let188.arkli.model

import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.requireMainFrame
import org.json.JSONArray
import org.json.JSONObject

/**
 * `native.model.list`：无参，返回清单里全部模型的状态。
 *
 * @param manager 模型管理器
 */
internal class ModelListHandler(private val manager: ModelManager) : BridgeHandler {
    /** 汇总快照 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val arr = JSONArray()
        manager.list().forEach { arr.put(ModelPolicy.snapshotJson(it)) }
        return JSONObject().put("models", arr)
    }
}

/**
 * `native.model.status`：`{ id }` -> 状态。
 *
 * @param manager 模型管理器
 */
internal class ModelStatusHandler(private val manager: ModelManager) : BridgeHandler {
    /** 校验 id 后返回快照 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return ModelPolicy.snapshotJson(manager.status(ModelPolicy.requireEntry(params, manager.manifest).id))
    }
}

/**
 * `native.model.ensure`：`{ id }` -> 状态 + `started` + `meteredHint`。幂等，立即返回，下载在后台。
 *
 * @param manager 模型管理器
 */
internal class ModelEnsureHandler(private val manager: ModelManager) : BridgeHandler {
    /** 启动或确认 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val r = manager.ensure(ModelPolicy.requireEntry(params, manager.manifest).id)
        return ModelPolicy.snapshotJson(r.snapshot).put("started", r.started).put("meteredHint", r.meteredHint)
    }
}

/**
 * `native.model.cancel`：`{ id }` -> 状态。保留 .part 以便续传。
 *
 * @param manager 模型管理器
 */
internal class ModelCancelHandler(private val manager: ModelManager) : BridgeHandler {
    /** 取消任务 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return ModelPolicy.snapshotJson(manager.cancel(ModelPolicy.requireEntry(params, manager.manifest).id))
    }
}

/**
 * `native.model.remove`：`{ id }` -> 状态。删除文件并释放已加载的会话。
 *
 * @param manager 模型管理器
 */
internal class ModelRemoveHandler(private val manager: ModelManager) : BridgeHandler {
    /** 删除 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return ModelPolicy.snapshotJson(manager.remove(ModelPolicy.requireEntry(params, manager.manifest).id))
    }
}

/**
 * `native.model.verify`：`{ id }` -> 状态。重新计算 sha256，耗时与文件大小成正比。
 *
 * @param manager 模型管理器
 */
internal class ModelVerifyHandler(private val manager: ModelManager) : BridgeHandler {
    /** 校验 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return ModelPolicy.snapshotJson(manager.verify(ModelPolicy.requireEntry(params, manager.manifest).id))
    }
}

/**
 * `native.model.sources`：`{ id }` -> 下载来源（文件、大小、sha256、地址、release 页面）。只读，不改变下载行为。
 *
 * @param manager 模型管理器
 */
internal class ModelSourcesHandler(private val manager: ModelManager) : BridgeHandler {
    /** 校验 id 后只从随包清单取来源，不走 debug 覆盖 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return ModelPolicy.sourcesJson(ModelPolicy.requireEntry(params, manager.manifest))
    }
}
