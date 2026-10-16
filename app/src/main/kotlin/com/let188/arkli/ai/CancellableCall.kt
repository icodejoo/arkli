package com.let188.arkli.ai

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 在 IO 线程跑一段阻塞的原生推理，并让协程取消真正打断它（协程取消只在挂起点生效，阻塞调用里没有挂起点）。
 *
 * 做法：旁边挂一个 watcher，外层协程被取消时立刻调 [onCancel]（由它去置原生层的取消标志），
 * 阻塞调用随后以 `CancellationException` 抛出；正常结束（含抛别的异常）不触发 [onCancel]。
 *
 * 使用示例：`runCancellable(backend::cancel) { backend.translate(text, src, tgt, 0) }`
 *
 * @param onCancel 外层协程被取消且 [block] 还没结束时调用，须可在任意线程调用
 * @param block 阻塞的原生调用，会在 [Dispatchers.IO] 上执行
 * @return [block] 的返回值
 * @throws kotlinx.coroutines.CancellationException 协程被取消
 */
internal suspend fun <T> runCancellable(onCancel: () -> Unit, block: () -> T): T = coroutineScope {
    val finished = AtomicBoolean(false)
    val watcher = launch(start = CoroutineStart.UNDISPATCHED) {
        try {
            awaitCancellation()
        } finally {
            if (!finished.get()) onCancel()
        }
    }
    try {
        withContext(Dispatchers.IO) { block() }
    } finally {
        finished.set(true)
        watcher.cancel()
    }
}
