package com.let188.arkli.net

import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.requireMainFrame
import org.json.JSONObject

/**
 * `native.net.http`：发 HTTP(S) 请求，手动跟随重定向并逐跳校验目标。
 *
 * @param engine 联网核心
 */
internal class NetHttpHandler(private val engine: NetEngine) : BridgeHandler {
    /** 校验参数后交给引擎 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return engine.http(NetParams.http(params))
    }
}

/**
 * `native.net.resolve`：DNS 解析，不做内网判断。
 *
 * @param engine 联网核心
 */
internal class NetResolveHandler(private val engine: NetEngine) : BridgeHandler {
    /** 校验参数后交给引擎 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return engine.resolve(NetParams.resolveHost(params))
    }
}

/**
 * `native.net.tcp`：TCP 连通探测，失败不抛错。
 *
 * @param engine 联网核心
 */
internal class NetTcpHandler(private val engine: NetEngine) : BridgeHandler {
    /** 校验参数后交给引擎 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return engine.tcp(NetParams.tcp(params))
    }
}

/**
 * `native.net.whois`：查 Whois 原文并跟随引荐。
 *
 * @param engine 联网核心
 */
internal class NetWhoisHandler(private val engine: NetEngine) : BridgeHandler {
    /** 校验参数后交给引擎 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return engine.whois(NetParams.whois(params))
    }
}

/**
 * `native.net.speed`：下行测速。
 *
 * @param engine 联网核心
 */
internal class NetSpeedHandler(private val engine: NetEngine) : BridgeHandler {
    /** 校验参数后交给引擎 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        return engine.speed(NetParams.speed(params))
    }
}
