// 通用持久缓存：按命名空间（一般是工具 id）隔离的 localStorage 封装，键为 `${ns}_${key}`，值为 JSON 字符串。

/** 命名空间与键之间的分隔符 */
const SEP = '_'

/** 存储后端所需的最小接口（localStorage 满足；测试可传内存实现） */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

/** 持久缓存实例 */
export interface ToolStorage {
  /**
   * 读取并反序列化；不存在、解析失败或存储不可用时返回 fallback。
   * @param key 键（不含命名空间）
   * @param fallback 缺省值
   * @returns 缓存值或 fallback
   * @example store.get('count', 0)
   */
  get<T>(key: string, fallback: T): T
  /**
   * 序列化后写入；存储不可用或空间不足时静默失败。
   * @param key 键（不含命名空间）
   * @param value 可被 JSON.stringify 的值
   * @returns 写入成功返回 true
   * @example store.set('count', 1) // 写入 yyy_count = "1"
   */
  set(key: string, value: unknown): boolean
  /**
   * 删除一项。
   * @param key 键（不含命名空间）
   */
  remove(key: string): void
  /**
   * 是否存在该项。
   * @param key 键（不含命名空间）
   * @returns 存在返回 true
   */
  has(key: string): boolean
  /**
   * 列出本命名空间下所有键（不含命名空间前缀）。
   * @returns 键数组
   */
  keys(): string[]
  /** 清空本命名空间下所有项，不影响其他命名空间 */
  clear(): void
  /**
   * 迁移旧数据：新键不存在、旧的整键（localStorage 里的原始键名）存在时，把旧值转成新值写入，并删掉旧键；只迁一次。
   * @param legacyKey 旧的完整键名（不加命名空间）
   * @param key 新键（不含命名空间）
   * @param parse 把旧原文转成要存的值，默认按 JSON 解析、失败则按原字符串；返回 undefined 表示丢弃
   * @example store.adoptLegacy('arkli.ledger', 'records')
   */
  adoptLegacy(legacyKey: string, key: string, parse?: (raw: string) => unknown): void
}

/**
 * 取默认存储后端；不可用（隐私模式、被禁用）时返回 null。
 * @returns localStorage 或 null
 */
function defaultBackend(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * 创建一个命名空间持久缓存，每个工具建一个。
 *
 * @param ns 命名空间，通常用工具 id，不能为空
 * @param backend 存储后端，默认 localStorage
 * @returns 缓存实例
 * @example
 * const x = createToolStorage('yyy')
 * x.set('zzz', 1) // localStorage: yyy_zzz = "1"
 * x.get('zzz', 0) // 1
 */
export function createToolStorage(ns: string, backend?: StorageLike | null): ToolStorage {
  if (!ns) throw new Error('createToolStorage: ns 不能为空')
  const prefix = ns + SEP
  const store = (): StorageLike | null => (backend === undefined ? defaultBackend() : backend)

  const keys = (): string[] => {
    const s = store()
    if (!s) return []
    const out: string[] = []
    try {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i)
        if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length))
      }
    } catch {
      /* 存储不可用，按空处理 */
    }
    return out
  }

  return {
    get<T>(key: string, fallback: T): T {
      try {
        const raw = store()?.getItem(prefix + key)
        return raw == null ? fallback : (JSON.parse(raw) as T)
      } catch {
        return fallback
      }
    },
    set(key, value) {
      try {
        const s = store()
        const raw = JSON.stringify(value)
        if (!s || raw === undefined) return false
        s.setItem(prefix + key, raw)
        return true
      } catch {
        return false
      }
    },
    remove(key) {
      try {
        store()?.removeItem(prefix + key)
      } catch {
        /* 忽略 */
      }
    },
    has(key) {
      try {
        return store()?.getItem(prefix + key) != null
      } catch {
        return false
      }
    },
    keys,
    adoptLegacy(legacyKey, key, parse) {
      try {
        const s = store()
        if (!s || s.getItem(prefix + key) != null) return
        const raw = s.getItem(legacyKey)
        if (raw == null) return
        let value: unknown
        if (parse) value = parse(raw)
        else {
          try {
            value = JSON.parse(raw)
          } catch {
            value = raw
          }
        }
        if (value !== undefined) s.setItem(prefix + key, JSON.stringify(value))
        s.removeItem(legacyKey)
      } catch {
        /* 忽略 */
      }
    },
    clear() {
      const s = store()
      for (const k of keys()) {
        try {
          s?.removeItem(prefix + k)
        } catch {
          /* 忽略 */
        }
      }
    },
  }
}
