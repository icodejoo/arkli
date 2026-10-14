// 极简 IndexedDB 封装（Promise 化）：openStore 对应真实库，createMemoryStore 是同接口的内存实现，供单测注入。

/** 索引定义 */
export interface IndexDef {
  /** 索引名 */
  name: string
  /** 对应记录上的字段名 */
  keyPath: string
}

/** 记录仓库：记录必须有字符串 id 作主键 */
export interface RecordStore<T extends { id: string }> {
  /** 新增或覆盖一条记录 */
  put(value: T): Promise<void>
  /** 读取全部记录（按主键升序） */
  getAll(): Promise<T[]>
  /** 按主键删除，不存在也不报错 */
  delete(id: string): Promise<void>
  /** 按索引区间查询（闭区间，缺省端不限），结果按索引值升序 */
  queryByIndex(index: string, lower?: number, upper?: number): Promise<T[]>
  /** 清空仓库 */
  clear(): Promise<void>
}

/** 打开仓库的参数 */
export interface OpenOptions {
  /** 库名 */
  db: string
  /** 库版本（升级结构时加一） */
  version: number
  /** 仓库名 */
  store: string
  /** 要建的索引 */
  indexes?: IndexDef[]
}

/**
 * 把 IDBRequest 包成 Promise。
 *
 * @param req 请求对象
 * @returns 请求结果
 */
function wrap<R>(req: IDBRequest<R>): Promise<R> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * 打开（必要时创建）IndexedDB 仓库，主键为 id。
 *
 * @param opts 库名、版本、仓库名与索引
 * @param factory IndexedDB 工厂，默认用全局的（仅测试注入）
 * @returns 记录仓库
 * @example const store = await openStore<Entry>({ db: 'arkli', version: 1, store: 'ledger', indexes: [{ name: 'ts', keyPath: 'ts' }] })
 */
export function openStore<T extends { id: string }>(opts: OpenOptions, factory: IDBFactory = indexedDB): Promise<RecordStore<T>> {
  return new Promise((resolve, reject) => {
    const req = factory.open(opts.db, opts.version)
    req.onupgradeneeded = () => {
      const db = req.result
      const os = db.objectStoreNames.contains(opts.store)
        ? req.transaction!.objectStore(opts.store)
        : db.createObjectStore(opts.store, { keyPath: 'id' })
      for (const ix of opts.indexes ?? []) {
        if (!os.indexNames.contains(ix.name)) os.createIndex(ix.name, ix.keyPath)
      }
    }
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      /** 取只读/读写仓库 */
      const os = (mode: IDBTransactionMode) => db.transaction(opts.store, mode).objectStore(opts.store)
      resolve({
        put: async (v) => void (await wrap(os('readwrite').put(v))),
        getAll: () => wrap(os('readonly').getAll() as IDBRequest<T[]>),
        delete: async (id) => void (await wrap(os('readwrite').delete(id))),
        clear: async () => void (await wrap(os('readwrite').clear())),
        queryByIndex: (index, lower, upper) => {
          let range: IDBKeyRange | undefined
          if (lower !== undefined && upper !== undefined) range = IDBKeyRange.bound(lower, upper)
          else if (lower !== undefined) range = IDBKeyRange.lowerBound(lower)
          else if (upper !== undefined) range = IDBKeyRange.upperBound(upper)
          return wrap(os('readonly').index(index).getAll(range) as IDBRequest<T[]>)
        },
      })
    }
  })
}

/**
 * 创建内存仓库，接口与 openStore 返回的一致，用于单测或 IndexedDB 不可用时兜底。
 *
 * @param indexes 索引定义（只用到 keyPath 做区间过滤）
 * @returns 内存记录仓库
 * @example const store = createMemoryStore<Entry>([{ name: 'ts', keyPath: 'ts' }])
 */
export function createMemoryStore<T extends { id: string }>(indexes: IndexDef[] = []): RecordStore<T> {
  /** 数据表 */
  const map = new Map<string, T>()
  /** 拷贝一份，模拟真实库的结构化克隆，避免调用方改到库内对象 */
  const copy = (v: T): T => JSON.parse(JSON.stringify(v)) as T
  return {
    put: async (v) => void map.set(v.id, copy(v)),
    getAll: async () =>
      [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(copy),
    delete: async (id) => void map.delete(id),
    clear: async () => map.clear(),
    queryByIndex: async (index, lower, upper) => {
      const ix = indexes.find((i) => i.name === index)
      if (!ix) throw new Error(`索引不存在：${index}`)
      const key = (v: T) => (v as unknown as Record<string, number>)[ix.keyPath]
      return [...map.values()]
        .filter((v) => (lower === undefined || key(v) >= lower) && (upper === undefined || key(v) <= upper))
        .sort((a, b) => key(a) - key(b))
        .map(copy)
    },
  }
}
