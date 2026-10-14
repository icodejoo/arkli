package com.let188.arkli.system

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject

/**
 * 系统能力方法共用的参数读取：类型不对统一抛 BAD_PARAMS。
 *
 * 使用示例：`val text = SystemParams.string(params, "text")`
 */
internal object SystemParams {
    /** 读必填字符串，缺失或类型不对抛 BAD_PARAMS */
    fun string(p: JSONObject, key: String): String =
        stringOrNull(p, key) ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "缺少 $key")

    /** 读可选字符串，缺省或 null 返回 null，类型不对抛 BAD_PARAMS */
    fun stringOrNull(p: JSONObject, key: String): String? {
        val v = p.opt(key)
        if (v == null || v == JSONObject.NULL) return null
        return v as? String ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "$key 必须是字符串")
    }

    /** 读可选布尔，缺省或 null 返回 null，类型不对抛 BAD_PARAMS */
    fun boolOrNull(p: JSONObject, key: String): Boolean? {
        val v = p.opt(key)
        if (v == null || v == JSONObject.NULL) return null
        return v as? Boolean ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "$key 必须是布尔值")
    }

    /** 读必填布尔，缺失或类型不对抛 BAD_PARAMS */
    fun bool(p: JSONObject, key: String): Boolean =
        boolOrNull(p, key) ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "缺少 $key")

    /** 读必填数字，缺失或类型不对抛 BAD_PARAMS */
    fun number(p: JSONObject, key: String): Double {
        val v = p.opt(key)
        return (v as? Number)?.toDouble() ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "$key 必须是数字")
    }

    /**
     * 把纯函数里的参数校验失败转成 BAD_PARAMS。
     *
     * @param block 校验逻辑，不合法时抛 [IllegalArgumentException]
     * @return block 的结果
     */
    inline fun <T> validated(block: () -> T): T = try {
        block()
    } catch (e: IllegalArgumentException) {
        throw BridgeException(BridgeErrors.BAD_PARAMS, e.message ?: "参数不合法")
    }
}
