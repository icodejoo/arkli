package com.let188.arkli.corpus

import com.let188.arkli.bridge.ArkliBridge
import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import com.let188.arkli.bridge.BridgeHandler
import com.let188.arkli.bridge.CallContext
import com.let188.arkli.files.requireMainFrame
import com.let188.arkli.model.ModelManager
import com.let188.arkli.model.ModelStateSource
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** 语料包解压后所在目录，相对 filesDir（与清单里的 dir 一致） */
const val COUPLET_CORPUS_DIR = "models/couplet-corpus"

/** 参数名：池编号 */
private const val KEY_POOL = "pool"

/** 参数名：池内下标 */
private const val KEY_INDEX = "index"

/**
 * 语料库的进程级持有者：语料装好才打开，文件变了（重装）就重开；删除前由管理器的释放钩子关掉。
 *
 * @param dir 语料包目录
 * @param state 模型状态来源，只有 installed 才允许读
 */
internal class CorpusHolder(private val dir: File, private val state: ModelStateSource) {
    /** 当前打开的读取器 */
    private var corpus: CoupletCorpus? = null

    /** 打开时 meta 文件的（长度，修改时间），变了就重开 */
    private var stamp: Pair<Long, Long>? = null

    /**
     * 取读取器。
     *
     * @return 已装好的语料读取器
     * @throws BridgeException NOT_READY：未安装；INTERNAL：包损坏
     */
    @Synchronized
    fun require(): CoupletCorpus {
        if (!ready()) throw BridgeException(BridgeErrors.NOT_READY, "对联语料库还没有下载")
        val meta = File(dir, FILE_META)
        val now = Pair(meta.length(), meta.lastModified())
        corpus?.let { if (stamp == now) return it }
        corpus?.close()
        corpus = null
        try {
            return CoupletCorpus.open(dir).also {
                corpus = it
                stamp = now
            }
        } catch (e: Exception) {
            throw BridgeException(BridgeErrors.INTERNAL, "语料库已损坏，请在 AI 中心重新校验或下载：${e.message}")
        }
    }

    /** 当前是否已安装（不打开文件） */
    fun ready(): Boolean = state.info(COUPLET_CORPUS_MODEL_ID).installed

    /** 关闭当前读取器（删除语料前调用） */
    @Synchronized
    fun close() {
        corpus?.close()
        corpus = null
        stamp = null
    }
}

/**
 * `native.corpus.couplet.info`：无参。未安装返回 `{ ready: false }`；已安装返回 `{ ready, count, pools:[{ pool, name, count }] }`。
 *
 * @param holder 语料持有者
 */
internal class CorpusInfoHandler(private val holder: CorpusHolder) : BridgeHandler {
    /** 读池信息 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        if (!holder.ready()) return JSONObject().put("ready", false)
        val c = holder.require()
        val pools = JSONArray()
        c.pools.forEachIndexed { i, p -> pools.put(JSONObject().put(KEY_POOL, i).put("name", p.name).put("count", p.count)) }
        return JSONObject().put("ready", true).put("count", c.count).put("pools", pools)
    }
}

/**
 * `native.corpus.couplet.get`：`{ pool, index }` -> `{ id, up, down, banner, cats[], primary }`。池与下标越界报 BAD_PARAMS，未安装报 NOT_READY。
 *
 * @param holder 语料持有者
 */
internal class CorpusGetHandler(private val holder: CorpusHolder) : BridgeHandler {
    /** 校验参数后按池内下标取一副 */
    override suspend fun handle(ctx: CallContext, params: JSONObject): Any? {
        requireMainFrame(ctx)
        val pool = intParam(params, KEY_POOL)
        val index = intParam(params, KEY_INDEX)
        val c = holder.require()
        val r = try {
            c.get(pool, index)
        } catch (e: IllegalArgumentException) {
            throw BridgeException(BridgeErrors.BAD_PARAMS, e.message ?: "参数越界")
        } catch (e: Exception) {
            throw BridgeException(BridgeErrors.INTERNAL, "读取语料失败：${e.message}")
        }
        return JSONObject().put("id", r.id).put("up", r.up).put("down", r.down).put("banner", r.banner)
            .put("cats", JSONArray(r.cats)).put("primary", r.primary)
    }

    /** 取非负整数参数，缺失或类型不对报 BAD_PARAMS */
    private fun intParam(p: JSONObject, key: String): Int {
        val v = p.opt(key)
        if (v !is Int || v < 0) throw BridgeException(BridgeErrors.BAD_PARAMS, "$key 需要是非负整数")
        return v
    }
}

/**
 * 对联语料库桥方法：`native.corpus.couplet.info` / `native.corpus.couplet.get`。语料本体由模型管理器当数据包下载解压，
 * 这里只读；随机与不重复的算法在前端（`web/src/tools/couplet/cursor.ts`），原生只按池内下标取。
 *
 * 使用示例：`CorpusModule.install(bridge, filesDir, manager)`
 */
object CorpusModule {
    /** 方法名：池信息 */
    const val METHOD_INFO = "native.corpus.couplet.info"

    /** 方法名：取一副 */
    const val METHOD_GET = "native.corpus.couplet.get"

    /** 进程内唯一的持有者（桥每会话重建，读取器不用跟着重开） */
    @Volatile
    private var holder: CorpusHolder? = null

    /**
     * 注册语料方法，并登记删除前释放钩子。
     *
     * @param bridge 当前会话的 Bridge
     * @param filesDir 应用私有 files 目录
     * @param manager 模型管理器（提供安装状态与释放钩子）
     */
    fun install(bridge: ArkliBridge, filesDir: File, manager: ModelManager) {
        val h = synchronized(this) { holder ?: CorpusHolder(File(filesDir, COUPLET_CORPUS_DIR), manager).also { holder = it } }
        manager.addReleaseHook(COUPLET_CORPUS_MODEL_ID) { h.close() }
        bridge.register(METHOD_INFO, CorpusInfoHandler(h))
        bridge.register(METHOD_GET, CorpusGetHandler(h))
    }
}
