import { describe, expect, it, vi } from 'vitest'
import { createBlobWorker, DEFAULT_MAX_LINES, DEFAULT_TIMEOUT_MS, runCode, WORKER_SOURCE, type WorkerLike } from './logic'

/** 带可断言 terminate 的测试 Worker */
type TestWorker = WorkerLike & { terminated: number }

/** 回环 Worker：把真实的 WORKER_SOURCE 跑在假 self 里，消息经微任务异步回传 */
function loopbackWorker(): TestWorker {
  const w = {
    onmessage: null as WorkerLike['onmessage'],
    onerror: null as WorkerLike['onerror'],
    terminated: 0,
    terminate() {
      this.terminated++
    },
    postMessage(msg: unknown) {
      self.onmessage?.({ data: msg })
    },
  }
  const self: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void } = {
    onmessage: null,
    postMessage: (m) => queueMicrotask(() => w.onmessage?.({ data: m })),
  }
  new Function('self', WORKER_SOURCE)(self)
  return w
}

/** 永不回应的 Worker，用来测超时 */
function silentWorker(): TestWorker {
  return { onmessage: null, onerror: null, terminated: 0, terminate() { this.terminated++ }, postMessage: () => {} }
}

describe('runCode 基本流程（真实 Worker 源码）', () => {
  it('捕获 console 输出并正常结束', async () => {
    const w = loopbackWorker()
    const r = await runCode('console.log("hi", 1 + 1); console.error("bad")', { createWorker: () => w }).result
    expect(r.status).toBe('ok')
    expect(r.logs.map((l) => [l.level, l.text])).toEqual([
      ['log', 'hi 2'],
      ['error', 'bad'],
    ])
    expect(w.terminated).toBe(1)
  })
  it('对象、数组、undefined、null、bigint 的格式化', async () => {
    const code = 'console.log({a:1,b:[1,2]}, [1,2], undefined, null, 10n, NaN, -0, new Map([[1,2]]), new Set([3]))'
    const r = await runCode(code, { createWorker: loopbackWorker }).result
    expect(r.logs[0].text).toBe('{"a":1,"b":[1,2]} [1,2] undefined null 10n NaN -0 {"Map":[[1,2]]} {"Set":[3]}')
  })
  it('循环引用不会崩', async () => {
    const r = await runCode('const o = {}; o.self = o; console.log(o)', { createWorker: loopbackWorker }).result
    expect(r.status).toBe('ok')
    expect(r.logs[0].text).toContain('[Circular]')
  })
  it('支持顶层 await 与 return 值', async () => {
    const r = await runCode('await new Promise((r) => setTimeout(r, 5)); return 42', { createWorker: loopbackWorker }).result
    expect(r.status).toBe('ok')
    expect(r.logs).toMatchObject([{ level: 'result', text: '42' }])
  })
  it('运行时错误与语法错误都变成 error 状态', async () => {
    const a = await runCode('throw new TypeError("boom")', { createWorker: loopbackWorker }).result
    expect(a).toMatchObject({ status: 'error', error: 'TypeError: boom' })
    const b = await runCode('let = = 1', { createWorker: loopbackWorker }).result
    expect(b.status).toBe('error')
    expect(b.error).toContain('SyntaxError')
  })
  it('用户代码里的 console 不会污染全局 console', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runCode('console.log("x")', { createWorker: loopbackWorker }).result
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  it('onLog 实时回调', async () => {
    const seen: string[] = []
    await runCode('console.log(1); console.log(2)', { createWorker: loopbackWorker, onLog: (e) => seen.push(e.text) }).result
    expect(seen).toEqual(['1', '2'])
  })
})

describe('runCode 超时与终止', () => {
  it('超时强杀并提示', async () => {
    const w = silentWorker()
    const r = await runCode('while(true){}', { createWorker: () => w, timeoutMs: 30 }).result
    expect(r.status).toBe('timeout')
    expect(r.error).toContain('强制终止')
    expect(w.terminated).toBeGreaterThan(0)
  })
  it('手动 cancel', async () => {
    const w = silentWorker()
    const h = runCode('1', { createWorker: () => w, timeoutMs: 5000 })
    h.cancel()
    const r = await h.result
    expect(r.status).toBe('cancelled')
    expect(w.terminated).toBe(1)
  })
  it('结束后再 cancel 无效，状态不被改写', async () => {
    const h = runCode('console.log(1)', { createWorker: loopbackWorker })
    const r = await h.result
    h.cancel()
    expect(r.status).toBe('ok')
  })
  it('Worker 抛未捕获错误', async () => {
    const w = silentWorker()
    const h = runCode('x', { createWorker: () => w })
    w.onerror?.({ message: 'oops' })
    expect(await h.result).toMatchObject({ status: 'error', error: 'oops' })
  })
  it('无关消息被忽略', async () => {
    const w = silentWorker()
    const h = runCode('x', { createWorker: () => w })
    w.onmessage?.({ data: null })
    w.onmessage?.({ data: 'str' })
    w.onmessage?.({ data: { type: 'unknown' } })
    w.onmessage?.({ data: { type: 'done' } })
    expect((await h.result).status).toBe('ok')
  })
})

describe('runCode 边界', () => {
  it('空代码不创建 Worker', async () => {
    let created = 0
    const factory = (): WorkerLike => {
      created++
      return silentWorker()
    }
    const r = await runCode('   ', { createWorker: factory }).result
    expect(r.status).toBe('ok')
    expect(created).toBe(0)
  })
  it('工厂抛错变成 error', async () => {
    const r = await runCode('1', {
      createWorker: () => {
        throw new Error('没有 Worker')
      },
    }).result
    expect(r).toMatchObject({ status: 'error', error: '没有 Worker' })
  })
  it('输出超过上限后丢弃并只提示一次', async () => {
    const r = await runCode('for (let i = 0; i < 10; i++) console.log(i)', { createWorker: loopbackWorker, maxLines: 3 }).result
    expect(r.logs).toHaveLength(4)
    expect(r.logs[3].level).toBe('system')
    expect(r.logs[3].text).toContain('3')
  })
  it('单条超长输出被截断', async () => {
    const r = await runCode('console.log("a".repeat(20000))', { createWorker: loopbackWorker }).result
    expect(r.logs[0].text.length).toBeLessThan(10100)
    expect(r.logs[0].text).toContain('已截断')
  })
  it('非法参数抛 RangeError', () => {
    expect(() => runCode('1', { timeoutMs: 0 })).toThrow(RangeError)
    expect(() => runCode('1', { timeoutMs: NaN })).toThrow(RangeError)
    expect(() => runCode('1', { maxLines: 0 })).toThrow(RangeError)
  })
  it('默认值', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(5000)
    expect(DEFAULT_MAX_LINES).toBe(1000)
  })
})

describe('createBlobWorker', () => {
  it('环境没有 Worker 时抛错', () => {
    expect(() => createBlobWorker()).toThrow('不支持')
  })
})
