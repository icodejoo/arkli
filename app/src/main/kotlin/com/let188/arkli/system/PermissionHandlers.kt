package com.let188.arkli.system

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.ActivityHost
import com.let188.arkli.files.requireMainFrame
import org.json.JSONObject

/** 清单里没声明该权限时返回的 reason */
internal const val REASON_NOT_DECLARED = "not_declared"

/**
 * 权限检查与申请共用的逻辑。
 *
 * @param context 应用上下文
 */
internal class PermissionChecker(private val context: Context) {
    /** 清单里声明的全部权限，首次用到时取一次 */
    private val declared: Set<String> by lazy {
        try {
            @Suppress("DEPRECATION")
            val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
            info.requestedPermissions?.toSet().orEmpty()
        } catch (e: Exception) {
            emptySet()
        }
    }

    /**
     * 把页面传来的权限名解析成系统权限名。
     *
     * @param params 调用参数，含 `name`
     * @return 系统权限名；[PermissionMap.NOT_REQUIRED] 表示当前系统无需权限
     * @throws BridgeException name 缺失或不在白名单抛 BAD_PARAMS
     */
    fun resolve(params: JSONObject): String {
        val name = SystemParams.string(params, "name")
        return PermissionMap.permissionOf(name, Build.VERSION.SDK_INT)
            ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "不支持的 name：$name，可选 ${PermissionMap.NAMES.joinToString("/")}")
    }

    /** 清单是否声明了该权限；无需权限的视为已声明 */
    fun isDeclared(permission: String): Boolean = permission == PermissionMap.NOT_REQUIRED || permission in declared

    /** 是否已授予；无需权限的视为已授予 */
    fun isGranted(permission: String): Boolean =
        permission == PermissionMap.NOT_REQUIRED ||
            ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    /** 组装返回值 */
    fun result(granted: Boolean, reason: String? = null): JSONObject =
        JSONObject().put("granted", granted).also { if (reason != null) it.put("reason", reason) }
}

/**
 * `native.permission.check`：`{ name }` -> `{ granted: boolean, reason?: "not_declared" }`。只查询，不弹窗。
 *
 * @param checker 权限检查器
 */
internal class PermissionCheckHandler(private val checker: PermissionChecker) : BridgeHandler {
    /** 查询当前授予状态 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val perm = checker.resolve(params)
        if (!checker.isDeclared(perm)) return checker.result(false, REASON_NOT_DECLARED)
        return checker.result(checker.isGranted(perm))
    }
}

/**
 * `native.permission.request`：`{ name }` -> `{ granted: boolean, reason?: "not_declared" }`。
 * 已授予直接返回不弹窗；清单没声明返回 `not_declared`，不会崩。
 *
 * @param checker 权限检查器
 * @param host 弹出权限申请的宿主
 */
internal class PermissionRequestHandler(
    private val checker: PermissionChecker,
    private val host: ActivityHost,
) : BridgeHandler {
    /** 申请权限 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val perm = checker.resolve(params)
        if (!checker.isDeclared(perm)) return checker.result(false, REASON_NOT_DECLARED)
        if (checker.isGranted(perm)) return checker.result(true)
        return checker.result(host.requestPermission(perm))
    }
}
