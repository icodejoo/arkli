// JS 运行器逻辑：Worker 源码、消息协议、超时强杀。Worker 工厂可注入，便于单测

/** 日志级别：result 是代码 return 的值，system 是运行器自己的提示 */
export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'result' | 'system'

/** 一条输出 */
export interface LogEntry {
  /** 级别 */
  level: LogLevel
  /** 文本 */
  text: string
  /** 距开始执行的毫秒数 */
  t: number
}

/** 执行状态：ok 正常结束，error 抛错，timeout 超时被杀，cancelled 被手动终止 */
export type RunStatus = 'ok' | 'error' | 'timeout' | 'cancelled'

/** 执行结果 */
export interface RunResult {
  /** 最终状态 */
  status: RunStatus
  /** 错误或超时的说明 */
  error?: string
  /** 全部输出 */
  logs: LogEntry[]
  /** 总耗时（毫秒） */
  ms: number
}

/** 运行器所需的 Worker 最小接口（真实 Worker 与测试替身都满足） */
export interface WorkerLike {
  /** 向 Worker 发消息 */
  postMessage(msg: unknown): void
  /** 强制终止 */
  terminate(): void
  /** 收到 Worker 消息 */
  onmessage: ((e: { data: unknown }) => void) | null
  /** Worker 抛出未捕获错误 */
  onerror: ((e: { message?: string }) => void) | null
}

/** 运行选项 */
export interface RunOptions {
  /** 超时毫秒数，默认 5000 */
  timeoutMs?: number
  /** 最多保留的输出行数，默认 1000，超出后丢弃并提示一次 */
  maxLines?: number
  /** Worker 工厂，默认用内联 Blob Worker；测试时注入替身 */
  createWorker?: () => WorkerLike
  /** 每产生一条输出就回调（用于界面实时刷新） */
  onLog?: (entry: LogEntry) => void
}

/** 运行句柄：result 等待结果，cancel 手动终止 */
export interface RunHandle {
  /** 执行结果（永远 resolve，不会 reject） */
  result: Promise<RunResult>
  /** 手动终止，已结束则无效 */
  cancel(): void
}

/** 默认超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 5000
/** 默认输出行数上限 */
export const DEFAULT_MAX_LINES = 1000
/** 单条输出最大字符数，防止刷屏撑爆内存 */
const MAX_TEXT_CHARS = 10000

/** Worker 内部执行的源码（字符串，运行时塞进 Blob）。用户代码以 async 函数执行，支持顶层 await，console 只对用户代码可见 */
export const WORKER_SOURCE = String.raw`
var MAX_TEXT = ${MAX_TEXT_CHARS};
function replacer() {
  var seen = [];
  return function (k, v) {
    if (typeof v === 'bigint') return v + 'n';
    if (typeof v === 'function') return String(v);
    if (typeof v === 'symbol') return String(v);
    if (v instanceof Map) return { Map: Array.from(v.entries()) };
    if (v instanceof Set) return { Set: Array.from(v.values()) };
    if (v instanceof Error) return v.name + ': ' + v.message;
    if (v && typeof v === 'object') {
      if (seen.indexOf(v) >= 0) return '[Circular]';
      seen.push(v);
    }
    return v;
  };
}
function fmt(v) {
  var t = typeof v;
  if (t === 'string') return v;
  if (t === 'undefined') return 'undefined';
  if (t === 'bigint') return v + 'n';
  if (t === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (t === 'boolean' || t === 'symbol' || t === 'function') return String(v);
  if (v === null) return 'null';
  if (v instanceof Error) return v.name + ': ' + v.message;
  try {
    var s = JSON.stringify(v, replacer());
    if (s !== undefined && s.length > 80) s = JSON.stringify(v, replacer(), 2);
    return s === undefined ? String(v) : s;
  } catch (e) {
    return String(v);
  }
}
function send(m) { self.postMessage(m); }
var cons = {};
['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
  cons[level] = function () {
    var text = Array.prototype.slice.call(arguments).map(fmt).join(' ');
    send({ type: 'log', level: level, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…（已截断）' : text });
  };
});
self.onmessage = function (e) {
  var d = e.data;
  if (!d || d.type !== 'run') return;
  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  Promise.resolve()
    .then(function () { return new AsyncFunction('console', d.code)(cons); })
    .then(function (r) {
      if (r !== undefined) send({ type: 'log', level: 'result', text: fmt(r) });
      send({ type: 'done' });
    })
    .catch(function (err) {
      send({ type: 'error', message: err && err.name ? err.name + ': ' + err.message : String(err) });
    });
};
`

/**
 * 创建内联源码的 Blob Worker（不依赖打包路径）。terminate 时会顺带释放 Blob 地址。
 *
 * @returns Worker 实例
 * @throws 当前环境没有 Worker / Blob 时抛 Error
 * @example
 * const w = createBlobWorker()
 * w.postMessage({ type: 'run', code: 'console.log(1)' })
 */
export function createBlobWorker(): WorkerLike {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    throw new Error('当前环境不支持 Web Worker')
  }
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
  const w = new Worker(url)
  const origTerminate = w.terminate.bind(w)
  w.terminate = () => {
    origTerminate()
    URL.revokeObjectURL(url)
  }
  return w as unknown as WorkerLike
}

/**
 * 在 Worker 里运行用户代码，超时强杀。
 * 支持顶层 await；setTimeout 等异步回调要自己 await 等待，否则代码一结束 Worker 就被回收。
 *
 * @param code 用户代码
 * @param opts 超时、行数上限、Worker 工厂、输出回调
 * @returns 句柄：result 永远 resolve（出错也是 resolve，看 status）；cancel 可手动终止
 * @throws timeoutMs 或 maxLines 不是正数时抛 RangeError
 * @example
 * const h = runCode('console.log(1 + 1)', { timeoutMs: 3000 })
 * const r = await h.result // r.status === 'ok'，r.logs[0].text === '2'
 */
export function runCode(code: string, opts: RunOptions = {}): RunHandle {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) throw new RangeError('超时时间必须是正数')
  if (!(maxLines > 0)) throw new RangeError('输出行数上限必须是正数')

  const logs: LogEntry[] = []
  const start = Date.now()
  let settled = false
  let truncated = false
  let worker: WorkerLike | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolveFn: (r: RunResult) => void = () => {}
  const result = new Promise<RunResult>((res) => {
    resolveFn = res
  })

  /** 记一条输出，超过上限只提示一次 */
  const push = (level: LogLevel, text: string): void => {
    if (logs.length >= maxLines) {
      if (truncated) return
      truncated = true
      level = 'system'
      text = `输出超过 ${maxLines} 行，后面的已丢弃`
    }
    const entry: LogEntry = { level, text, t: Date.now() - start }
    logs.push(entry)
    opts.onLog?.(entry)
  }

  /** 收尾：只生效一次，清定时器、杀 Worker */
  const finish = (status: RunStatus, error?: string): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    try {
      worker?.terminate()
    } catch {
      // Worker 已经没了，忽略
    }
    resolveFn({ status, error, logs, ms: Date.now() - start })
  }

  if (code.trim() === '') {
    finish('ok')
    return { result, cancel: () => {} }
  }

  try {
    worker = (opts.createWorker ?? createBlobWorker)()
  } catch (e) {
    finish('error', (e as Error).message)
    return { result, cancel: () => {} }
  }

  worker.onmessage = (e) => {
    const m = e.data as { type?: string; level?: LogLevel; text?: string; message?: string } | null
    if (!m || typeof m !== 'object') return
    if (m.type === 'log' && typeof m.text === 'string') push(m.level ?? 'log', m.text)
    else if (m.type === 'done') finish('ok')
    else if (m.type === 'error') finish('error', m.message ?? '未知错误')
  }
  worker.onerror = (e) => finish('error', e.message || 'Worker 出错')
  timer = setTimeout(() => finish('timeout', `执行超过 ${timeoutMs / 1000} 秒，已强制终止`), timeoutMs)
  worker.postMessage({ type: 'run', code })

  return { result, cancel: () => finish('cancelled', '已手动终止') }
}
