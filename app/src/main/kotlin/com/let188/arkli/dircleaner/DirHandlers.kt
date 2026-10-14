package com.let188.arkli.dircleaner

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.ActivityHost
import com.let188.arkli.files.requireMainFrame
import com.let188.arkli.system.SystemParams
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** 进度事件名 */
internal const val EVENT_DIR_PROGRESS = "dir.progress"

/** 目录授权的读写标志 */
private const val GRANT_FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

/** 令牌失效时的提示 */
private const val MSG_BAD_TOKEN = "文件夹授权不存在或已失效，请重新选择"

/**
 * 基于 SAF 的子项来源：用 buildChildDocumentsUriUsingTree 查直接子项。
 *
 * @param resolver 内容解析器
 * @param tree 目录树 URI
 */
internal class SafDirSource(private val resolver: ContentResolver, private val tree: Uri) : DirSource {
    /** 查询一个文件夹的直接子项；查询异常转成 [DirReadException] */
    override fun children(docId: String): List<DirEntry> {
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        try {
            val out = ArrayList<DirEntry>()
            resolver.query(uri, cols, null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    out.add(
                        DirEntry(
                            docId = c.getString(0).orEmpty(),
                            name = c.getString(1).orEmpty(),
                            mime = c.getString(2).orEmpty(),
                            size = if (c.isNull(3)) -1 else c.getLong(3),
                            lastModifiedMs = if (c.isNull(4)) 0 else c.getLong(4),
                        ),
                    )
                }
            }
            return out
        } catch (e: SecurityException) {
            throw DirReadException("没有该文件夹的访问权限", e)
        } catch (e: RuntimeException) {
            throw DirReadException(e.message ?: "读取文件夹失败", e)
        }
    }
}

/** 取令牌对应的记录，并确认系统仍持有它的持久授权，否则抛 BAD_PARAMS */
private fun requireGranted(store: DirStore, resolver: ContentResolver, token: String): Pair<DirRecord, Uri> {
    val rec = store.find(token) ?: throw BridgeException(BridgeErrors.BAD_PARAMS, MSG_BAD_TOKEN)
    val uri = Uri.parse(rec.uri)
    val held = resolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission && it.isWritePermission }
    if (!held) throw BridgeException(BridgeErrors.BAD_PARAMS, MSG_BAD_TOKEN)
    return rec to uri
}

/**
 * `native.dir.pick`：`{}` -> `{ token, name }`，取消时 `{ token: null, name: null }`。
 * 弹系统文件夹选择器并申请持久读写授权；已授权过的同一文件夹复用令牌。
 *
 * @param context 应用上下文
 * @param host 选择器宿主
 * @param store 授权记录
 */
internal class DirPickHandler(private val context: Context, private val host: ActivityHost, private val store: DirStore) : BridgeHandler {
    /** 选择并登记 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val uri = host.pickDirectory() ?: return JSONObject().put(KEY_TOKEN, JSONObject.NULL).put("name", JSONObject.NULL)
        val resolver = context.contentResolver
        try {
            resolver.takePersistableUriPermission(uri, GRANT_FLAGS)
        } catch (e: SecurityException) {
            throw BridgeException(BridgeErrors.PERMISSION_DENIED, "无法保存该文件夹的授权：${e.message}")
        }
        val rec = withContext(Dispatchers.IO) { store.add(uri.toString(), displayName(resolver, uri)) }
        return JSONObject().put(KEY_TOKEN, rec.token).put("name", rec.name)
    }

    /** 读文件夹显示名，读不到退化为 URI 末段 */
    private fun displayName(resolver: ContentResolver, tree: Uri): String {
        val docUri = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val name = runCatching {
            resolver.query(docUri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull()
        return name?.takeIf { it.isNotEmpty() } ?: (tree.lastPathSegment ?: tree.toString())
    }
}

/**
 * `native.dir.list`：`{}` -> `{ items: [{ token, name }] }`，已授权的文件夹。
 * 系统已撤销授权的记录会被顺手清掉。
 *
 * @param context 应用上下文
 * @param store 授权记录
 */
internal class DirListHandler(private val context: Context, private val store: DirStore) : BridgeHandler {
    /** 列出并清理失效记录 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val items = withContext(Dispatchers.IO) {
            val held = context.contentResolver.persistedUriPermissions.map { it.uri.toString() }.toSet()
            val (alive, dead) = store.all().partition { it.uri in held }
            dead.forEach { store.remove(it.token) }
            alive
        }
        return JSONObject().put("items", DirPolicy.recordsJson(items))
    }
}

/**
 * `native.dir.forget`：`{ token }` -> `{ forgotten: boolean }`。释放持久授权并删除记录，不动文件夹里的内容。
 *
 * @param context 应用上下文
 * @param store 授权记录
 * @param registry 本会话的扫描结果登记
 */
internal class DirForgetHandler(
    private val context: Context,
    private val store: DirStore,
    private val registry: ScanRegistry,
) : BridgeHandler {
    /** 释放授权 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val token = SystemParams.string(params, KEY_TOKEN)
        val rec = withContext(Dispatchers.IO) { store.remove(token) }
        registry.forget(token)
        if (rec != null) {
            runCatching { context.contentResolver.releasePersistableUriPermission(Uri.parse(rec.uri), GRANT_FLAGS) }
        }
        return JSONObject().put("forgotten", rec != null)
    }
}

/**
 * `native.dir.scan`：`{ token, mode, minBytes?, maxItems?, maxDepth? }` ->
 * `{ items: [{ id, name, relPath, bytes, lastModifiedMs, isDir }], scanned, truncated }`。
 * 迭代遍历，可取消，每 500 个节点推一次 `dir.progress { scanned }`。
 *
 * @param context 应用上下文
 * @param store 授权记录
 * @param registry 本会话的扫描结果登记
 */
internal class DirScanHandler(
    private val context: Context,
    private val store: DirStore,
    private val registry: ScanRegistry,
) : BridgeHandler {
    /** 在 IO 线程扫描，结果登记后返回 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val token = SystemParams.string(params, KEY_TOKEN)
        val opts = DirPolicy.parseScan(params)
        val resolver = context.contentResolver
        val (_, tree) = requireGranted(store, resolver, token)
        val outcome = try {
            withContext(Dispatchers.IO) {
                DirScanner.scan(
                    SafDirSource(resolver, tree), DocumentsContract.getTreeDocumentId(tree), opts,
                    onProgress = { ctx.emit(EVENT_DIR_PROGRESS, JSONObject().put("scanned", it)) },
                    checkCancel = { ensureActive() },
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: DirReadException) {
            throw BridgeException(BridgeErrors.INTERNAL, e.message ?: "读取文件夹失败")
        }
        val ids = registry.replace(token, outcome.items)
        val arr = JSONArray()
        outcome.items.forEachIndexed { i, n -> arr.put(DirPolicy.itemJson(ids[i], n)) }
        return JSONObject().put("items", arr).put("scanned", outcome.scanned).put("truncated", outcome.truncated)
    }
}

/**
 * `native.dir.delete`：`{ token, ids }` -> `{ deleted, freedBytes, failed: [{ id, message }] }`。
 * 用 DocumentsContract.deleteDocument 逐个删除，不经回收站，删除后无法恢复。
 * id 必须属于该令牌最近一次扫描结果，否则记为失败；单个失败不影响其余；可取消。
 *
 * @param context 应用上下文
 * @param store 授权记录
 * @param registry 本会话的扫描结果登记
 */
internal class DirDeleteHandler(
    private val context: Context,
    private val store: DirStore,
    private val registry: ScanRegistry,
) : BridgeHandler {
    /** 校验后逐个删除 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val token = SystemParams.string(params, KEY_TOKEN)
        val ids = DirPolicy.parseIds(params)
        val resolver = context.contentResolver
        val (_, tree) = requireGranted(store, resolver, token)
        val failed = JSONArray()
        val known = ArrayList<Pair<String, DirNode>>()
        for (id in ids) {
            val node = registry.lookup(token, id)
            if (node == null) failed.put(failure(id, "不在最近一次扫描结果里")) else known.add(id to node)
        }
        val order = DirPolicy.deleteOrder(known.map { it.second })
        val idOf = known.associate { it.second to it.first }
        var deleted = 0
        var freed = 0L
        withContext(Dispatchers.IO) {
            for (node in order) {
                ensureActive()
                val id = idOf.getValue(node)
                val result = runCatching {
                    DocumentsContract.deleteDocument(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, node.docId))
                }
                if (result.getOrDefault(false)) {
                    deleted++
                    freed += node.bytes
                    registry.drop(token, id)
                } else {
                    failed.put(failure(id, result.exceptionOrNull()?.message ?: "系统拒绝删除"))
                }
            }
        }
        return JSONObject().put("deleted", deleted).put("freedBytes", freed).put("failed", failed)
    }

    /** 单条失败记录 */
    private fun failure(id: String, message: String): JSONObject = JSONObject().put("id", id).put("message", message)
}
