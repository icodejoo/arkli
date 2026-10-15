package com.let188.arkli.model

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** 纳秒转毫秒 */
private const val NANOS_PER_MS = 1_000_000L

/** 毫秒转秒的倍数 */
private const val MS_PER_SEC = 1_000L

/** 下载进度推送的最小间隔（毫秒），状态切换不受限 */
private const val PROGRESS_NOTIFY_MS = 300L

/**
 * 某个模型当前的简要情况，供其他模块（如 AI 提供者）判断可用性。
 *
 * @property installed 已安装且校验通过
 * @property diskBytes 磁盘占用（含 .part）
 * @property downloading 是否正在下载或校验
 */
data class ModelStateInfo(val installed: Boolean, val diskBytes: Long, val downloading: Boolean)

/** 模型状态来源，单测可换替身 */
fun interface ModelStateSource {
    /**
     * 查询某个模型的简要情况。
     *
     * @param id 清单里的模型 id；不在清单里返回“未安装、0 字节、未下载”
     */
    fun info(id: String): ModelStateInfo
}

/**
 * `ensure` 的结果。
 *
 * @property snapshot 调用后的状态
 * @property started 这次调用是否真的启动了下载或校验任务（已安装或已在下载为 false）
 * @property meteredHint 当前是否为计费网络；只在 started 时有意义，页面自行决定要不要提醒
 */
data class EnsureResult(val snapshot: ModelSnapshot, val started: Boolean, val meteredHint: Boolean)

/**
 * 模型下载管理器：进程内唯一。下载跑在自己的协程作用域里，不随页面会话关闭而取消，
 * 页面重载后用 `status` 即可接着看进度。同一模型同一时刻只允许一个任务。
 *
 * 使用示例：`manager.ensure("siglip2-q4_half")`，之后轮询 `manager.status(id)`
 *
 * @param manifest 随包清单
 * @param root 模型根目录的父目录（filesDir），清单里的 dir 相对于它
 * @param downloader 下载器
 * @param scope 下载任务的协程作用域，应使用 SupervisorJob
 * @param metered 当前是否计费网络
 * @param urlOverride 覆盖下载源（仅 debug 构建会返回非 null），null 用清单里的
 * @param nowMs 单调时钟（毫秒），用于算速度，单测可替换
 */
class ModelManager internal constructor(
    val manifest: ModelManifest,
    private val root: File,
    private val downloader: ModelDownloader,
    private val scope: CoroutineScope,
    private val metered: () -> Boolean = { false },
    private val urlOverride: () -> List<String>? = { null },
    private val nowMs: () -> Long = { System.nanoTime() / NANOS_PER_MS },
) : ModelStateSource {
    /** 一个进行中的任务 */
    private class Task(val startBytes: Long, val startedAt: Long) {
        /** 协程任务，放进任务表之前赋值 */
        lateinit var job: Job

        /** 模型级已完成字节 */
        val progress = AtomicLong(startBytes)

        /** 当前阶段 */
        @Volatile
        var phase: String = ModelPolicy.PHASE_DOWNLOAD

        /** 上次推送进度的时间（毫秒，单调时钟），用于节流 */
        val lastNotifyAt = AtomicLong(0)
    }

    /** 状态变化监听：进程内只有一个，由当前页面会话的桥安装；null 表示不推送 */
    @Volatile
    private var listener: ((ModelSnapshot) -> Unit)? = null

    /**
     * 设置状态变化监听（替换旧的）。下载进度按 300 毫秒节流，状态切换（开始、完成、失败、取消、删除、校验）即时推送。
     *
     * @param l 收到变化后的最新快照；传 null 取消监听。回调里抛的异常会被吞掉，不影响下载
     */
    fun setListener(l: ((ModelSnapshot) -> Unit)?) {
        listener = l
    }

    /** 把某模型最新快照推给监听者；没有监听者时不取快照 */
    private fun notifyChange(entry: ModelEntry) {
        val l = listener ?: return
        runCatching { l(snapshot(entry)) }
    }

    /** 进行中的任务，键为模型 id */
    private val tasks = ConcurrentHashMap<String, Task>()

    /** 最近一次失败，开始新任务或删除时清掉 */
    private val errors = ConcurrentHashMap<String, ModelDownloadException>()

    /** 删除某模型前要先释放的资源（如已加载的推理会话），键为模型 id */
    private val releaseHooks = ConcurrentHashMap<String, suspend () -> Unit>()

    /**
     * 登记“删除前释放资源”的钩子；同一 id 重复登记会替换。
     *
     * @param id 模型 id
     * @param hook 挂起函数，在删除文件之前调用
     */
    fun addReleaseHook(id: String, hook: suspend () -> Unit) {
        releaseHooks[id] = hook
    }

    /**
     * 全部清单模型的状态。
     *
     * @return 与清单同序的快照
     */
    fun list(): List<ModelSnapshot> = manifest.models.map { snapshot(it) }

    /**
     * 单个模型的状态。
     *
     * @param id 清单里的模型 id
     * @return 快照
     */
    fun status(id: String): ModelSnapshot = snapshot(require(id))

    /** 实现 [ModelStateSource]：给 AI 提供者用 */
    override fun info(id: String): ModelStateInfo {
        val entry = manifest.find(id) ?: return ModelStateInfo(false, 0, false)
        val s = snapshot(entry)
        return ModelStateInfo(s.state == ModelState.INSTALLED, s.diskBytes, s.state == ModelState.DOWNLOADING)
    }

    /**
     * 确保模型就绪（幂等）：已安装直接返回；正在下载直接返回；
     * 文件齐全但未校验会只做校验；其余启动下载（有 .part 就续传）。
     *
     * @param id 清单里的模型 id
     * @return 状态与是否新启动；失败原因通过之后的 [status] 的 error 字段读取
     */
    fun ensure(id: String): EnsureResult {
        val entry = require(id)
        val before = snapshot(entry)
        if (before.state == ModelState.INSTALLED || before.state == ModelState.DOWNLOADING) return EnsureResult(before, false, false)
        val task = Task(before.downloadedBytes, nowMs())
        task.job = scope.launch(Dispatchers.IO, start = CoroutineStart.LAZY) { run(entry, task) }
        if (tasks.putIfAbsent(id, task) != null) {
            task.job.cancel()
            return EnsureResult(snapshot(entry), false, false)
        }
        // 兜底：任务没来得及启动就被取消时也要移出任务表
        task.job.invokeOnCompletion { tasks.remove(id, task) }
        errors.remove(id)
        task.job.start()
        notifyChange(entry)
        return EnsureResult(snapshot(entry), true, metered())
    }

    /** 任务体：下载、写校验标记，失败记录错误；无论如何最后移出任务表 */
    private suspend fun run(entry: ModelEntry, task: Task) {
        try {
            val override = urlOverride()
            downloader.download(entry, dir(entry), { f -> override ?: f.urls }) { done, phase ->
                task.progress.set(done)
                val phaseChanged = task.phase != phase
                task.phase = phase
                val now = nowMs()
                val last = task.lastNotifyAt.get()
                if ((phaseChanged || now - last >= PROGRESS_NOTIFY_MS) && task.lastNotifyAt.compareAndSet(last, now)) notifyChange(entry)
            }
            writeMarker(entry)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ModelDownloadException) {
            errors[entry.id] = e
        } catch (e: Exception) {
            errors[entry.id] = ModelDownloadException(ModelErrorCode.INTERNAL, e.message ?: e.javaClass.simpleName)
        } finally {
            tasks.remove(entry.id, task)
            notifyChange(entry)
        }
    }

    /**
     * 取消下载（幂等）。不删 .part，下次 ensure 会续传。
     *
     * @param id 清单里的模型 id
     * @return 取消后的状态；协程被取消需要一小会儿落地，所以这里先等它结束
     */
    suspend fun cancel(id: String): ModelSnapshot {
        val entry = require(id)
        tasks[id]?.job?.cancelAndJoin()
        return snapshot(entry)
    }

    /**
     * 删除模型：先取消任务、释放资源，再删文件、.part 与校验标记。只删清单里列出的文件，不递归。
     *
     * @param id 清单里的模型 id
     * @return 删除后的状态
     * @throws BridgeException INTERNAL：有文件删不掉
     */
    suspend fun remove(id: String): ModelSnapshot {
        val entry = require(id)
        tasks[id]?.job?.cancelAndJoin()
        releaseHooks[id]?.let { runCatching { it() } }
        withContext(Dispatchers.IO) {
            val dir = dir(entry)
            val names = entry.files.flatMap { listOf(it.name, it.name + PART_SUFFIX) } + MARKER_NAME
            val stuck = names.filter { File(dir, it).let { f -> f.exists() && !f.delete() } }
            if (stuck.isNotEmpty()) throw BridgeException(BridgeErrors.INTERNAL, "有 ${stuck.size} 个文件删除失败")
            dir.delete() // 目录里还有别的东西就保留，不递归
        }
        errors.remove(id)
        notifyChange(entry)
        return snapshot(entry)
    }

    /**
     * 重新校验 sha256。通过则写入校验标记（状态变 installed）；不通过则删除该文件并记录 HASH_MISMATCH。
     *
     * @param id 清单里的模型 id
     * @return 校验后的状态
     * @throws BridgeException NOT_READY：正在下载；INTERNAL：读文件失败
     */
    suspend fun verify(id: String): ModelSnapshot {
        val entry = require(id)
        if (tasks.containsKey(id)) throw BridgeException(BridgeErrors.NOT_READY, "模型正在下载，请稍后再校验")
        val job = currentCoroutineContext()[Job]
        withContext(Dispatchers.IO) {
            val dir = dir(entry)
            val intact = entry.files.all { File(dir, it.name).let { f -> f.isFile && f.length() == it.bytes } }
            if (!intact) return@withContext
            for (f in entry.files) {
                val file = File(dir, f.name)
                if (ModelFiles.sha256Hex(file) { job?.isActive != false } != f.sha256) {
                    file.delete()
                    File(dir, MARKER_NAME).delete()
                    errors[id] = ModelDownloadException(ModelErrorCode.HASH_MISMATCH, "${f.name} 的 sha256 与清单不一致，已删除")
                    return@withContext
                }
            }
            errors.remove(id)
            writeMarker(entry)
        }
        notifyChange(entry)
        return snapshot(entry)
    }

    /** 清单里找不到则 BAD_PARAMS */
    private fun require(id: String): ModelEntry =
        manifest.find(id) ?: throw BridgeException(BridgeErrors.BAD_PARAMS, "未知的模型 id")

    /** 模型目录的绝对路径，只在原生内部使用，不返回给页面 */
    private fun dir(entry: ModelEntry): File = File(root, entry.dir)

    /** 读磁盘事实，与清单文件同序 */
    private fun facts(entry: ModelEntry): List<FileFacts> {
        val dir = dir(entry)
        return entry.files.map { f ->
            val target = File(dir, f.name)
            val part = File(dir, f.name + PART_SUFFIX)
            FileFacts(
                f.name,
                if (target.isFile) target.length() else null,
                if (target.isFile) target.lastModified() else null,
                if (part.isFile) part.length() else 0L,
            )
        }
    }

    /** 读校验标记，不存在或损坏为 null */
    private fun readMarker(entry: ModelEntry): VerifiedMarker? {
        val f = File(dir(entry), MARKER_NAME)
        return if (f.isFile) ModelPolicy.markerFromJson(runCatching { f.readText() }.getOrNull()) else null
    }

    /** 以当前文件的长度与修改时间写校验标记 */
    private fun writeMarker(entry: ModelEntry) {
        val dir = dir(entry)
        val files = entry.files.associate { it.name to Pair(it.bytes, File(dir, it.name).lastModified()) }
        val tmp = File(dir, "$MARKER_NAME.tmp")
        tmp.writeText(ModelPolicy.markerToJson(VerifiedMarker(entry.version, files)))
        if (!tmp.renameTo(File(dir, MARKER_NAME))) throw ModelDownloadException(ModelErrorCode.INTERNAL, "无法写入校验标记")
    }

    /** 综合任务、磁盘与最近错误，生成快照 */
    private fun snapshot(entry: ModelEntry): ModelSnapshot {
        val facts = facts(entry)
        val task = tasks[entry.id]
        val err = errors[entry.id]
        val disk = ModelPolicy.diskBytes(facts)
        if (task != null) {
            val done = task.progress.get().coerceAtMost(entry.totalBytes)
            val elapsed = nowMs() - task.startedAt
            val speed = if (elapsed > 0 && done > task.startBytes) (done - task.startBytes) * MS_PER_SEC / elapsed else null
            return ModelSnapshot(
                entry.id, entry.displayName, entry.version, ModelState.DOWNLOADING, entry.totalBytes, done, disk, task.phase, speed,
            )
        }
        val state = ModelPolicy.diskState(entry, facts, readMarker(entry))
        return ModelSnapshot(
            entry.id, entry.displayName, entry.version, state, entry.totalBytes, ModelPolicy.downloadedBytes(entry, facts), disk,
            errorCode = err?.code?.wire, errorMessage = err?.message,
        )
    }
}
