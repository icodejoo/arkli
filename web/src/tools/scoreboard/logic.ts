// 记分牌：2~8 人加减分、自定义步长、历史撤销、排名；状态存 localStorage

/** 本地存储的 key */
export const STORAGE_KEY = 'arkli:scoreboard:state'
/** 最少人数 */
export const MIN_PLAYERS = 2
/** 最多人数 */
export const MAX_PLAYERS = 8
/** 步长默认值 */
export const DEFAULT_STEP = 1
/** 步长上限 */
export const MAX_STEP = 9999
/** 历史最多保留条数，防止无限增长 */
export const MAX_HISTORY = 200
/** 名字最长字数 */
export const MAX_NAME_LEN = 12
/** 玩家色板（内容色，不随主题变） */
export const PLAYER_COLORS = ['#3b6cf6', '#ee0a24', '#07c160', '#ff976a', '#7232dd', '#1989fa', '#f2b600', '#e84393'] as const

/** 一位玩家 */
export interface Player {
  /** 名字 */
  name: string
  /** 分数 */
  score: number
}

/** 一步操作，用于撤销 */
export interface Move {
  /** 玩家下标 */
  index: number
  /** 分数变化量 */
  delta: number
}

/** 记分牌状态 */
export interface BoardState {
  /** 玩家列表 */
  players: Player[]
  /** 加减步长 */
  step: number
  /** 操作历史，最后一项最新 */
  history: Move[]
}

/**
 * 默认名字：玩家 1、玩家 2……
 *
 * @param i 玩家下标（从 0 起）
 * @returns 默认名
 * @example
 * defaultName(0) // '玩家 1'
 */
export function defaultName(i: number): string {
  return `玩家 ${i + 1}`
}

/**
 * 创建初始状态。
 *
 * @param count 人数，限制在 MIN_PLAYERS ~ MAX_PLAYERS
 * @returns 全零分的新状态
 * @example
 * createState(2).players.length // 2
 */
export function createState(count = MIN_PLAYERS): BoardState {
  const n = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.floor(count) || MIN_PLAYERS))
  return { players: Array.from({ length: n }, (_, i) => ({ name: defaultName(i), score: 0 })), step: DEFAULT_STEP, history: [] }
}

/**
 * 规范化步长：取整并限制在 1 ~ MAX_STEP。
 *
 * @param v 任意输入
 * @returns 合法步长；非法值回到默认值
 * @example
 * normalizeStep('5') // 5
 */
export function normalizeStep(v: unknown): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_STEP, n) : DEFAULT_STEP
}

/**
 * 给某位玩家加（正）减（负）分，返回新状态，不改原对象；下标越界或 delta 为 0 原样返回。
 *
 * @param s 当前状态
 * @param index 玩家下标
 * @param delta 变化量
 * @returns 新状态，历史里多一条
 * @example
 * addScore(createState(2), 0, 5).players[0].score // 5
 */
export function addScore(s: BoardState, index: number, delta: number): BoardState {
  if (!Number.isInteger(index) || index < 0 || index >= s.players.length || !delta) return s
  const players = s.players.map((p, i) => (i === index ? { ...p, score: p.score + delta } : p))
  const history = [...s.history, { index, delta }].slice(-MAX_HISTORY)
  return { ...s, players, history }
}

/**
 * 撤销最近一步；没有历史时原样返回。
 *
 * @param s 当前状态
 * @returns 撤销后的新状态
 * @example
 * undo(addScore(createState(2), 0, 5)).players[0].score // 0
 */
export function undo(s: BoardState): BoardState {
  const last = s.history[s.history.length - 1]
  if (!last) return s
  const players = s.players.map((p, i) => (i === last.index ? { ...p, score: p.score - last.delta } : p))
  return { ...s, players, history: s.history.slice(0, -1) }
}

/**
 * 分数清零并清空历史，保留名字、人数和步长。
 *
 * @param s 当前状态
 * @returns 新状态
 * @example
 * resetScores(addScore(createState(2), 0, 5)).players[0].score // 0
 */
export function resetScores(s: BoardState): BoardState {
  return { ...s, players: s.players.map((p) => ({ ...p, score: 0 })), history: [] }
}

/**
 * 调整人数：加人补默认名，减人砍掉末尾；历史里涉及被删玩家的记录一并丢弃。
 *
 * @param s 当前状态
 * @param count 目标人数，限制在 2~8
 * @returns 新状态
 * @example
 * setPlayerCount(createState(2), 4).players.length // 4
 */
export function setPlayerCount(s: BoardState, count: number): BoardState {
  const n = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.floor(count) || MIN_PLAYERS))
  if (n === s.players.length) return s
  const players = s.players.slice(0, n)
  for (let i = players.length; i < n; i++) players.push({ name: defaultName(i), score: 0 })
  return { ...s, players, history: s.history.filter((m) => m.index < n) }
}

/**
 * 改名：去首尾空白、截断到 MAX_NAME_LEN，空名回退默认名。
 *
 * @param s 当前状态
 * @param index 玩家下标
 * @param name 新名字
 * @returns 新状态
 * @example
 * renamePlayer(createState(2), 0, '小明').players[0].name // '小明'
 */
export function renamePlayer(s: BoardState, index: number, name: string): BoardState {
  if (!Number.isInteger(index) || index < 0 || index >= s.players.length) return s
  const clean = Array.from(name.trim()).slice(0, MAX_NAME_LEN).join('') || defaultName(index)
  return { ...s, players: s.players.map((p, i) => (i === index ? { ...p, name: clean } : p)) }
}

/** 排名结果项 */
export interface Rank {
  /** 玩家下标 */
  index: number
  /** 名次（并列同名次，从 1 起） */
  rank: number
  /** 是否领先（第一名且分数不是大家都一样） */
  leading: boolean
}

/**
 * 按分数高到低排名，并列同名次；全员同分时不标领先。
 *
 * @param players 玩家列表
 * @returns 排名列表（按名次顺序，同分按原下标）
 * @example
 * rankPlayers([{ name: 'a', score: 1 }, { name: 'b', score: 3 }])[0] // { index: 1, rank: 1, leading: true }
 */
export function rankPlayers(players: Player[]): Rank[] {
  const order = players.map((_, i) => i).sort((a, b) => players[b].score - players[a].score || a - b)
  const allSame = players.every((p) => p.score === players[0].score)
  const out: Rank[] = []
  order.forEach((idx, pos) => {
    const prev = out[pos - 1]
    const rank = prev && players[order[pos - 1]].score === players[idx].score ? prev.rank : pos + 1
    out.push({ index: idx, rank, leading: rank === 1 && !allSame })
  })
  return out
}

/**
 * 校验并还原存储里读出的数据，任何不合规的字段都回退成默认。
 *
 * @param raw JSON.parse 后的任意值
 * @returns 合法状态；整体不可用时返回默认状态
 * @example
 * sanitizeState(null).players.length // 2
 */
export function sanitizeState(raw: unknown): BoardState {
  const base = createState()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Partial<Record<keyof BoardState, unknown>>
  if (!Array.isArray(r.players) || r.players.length < MIN_PLAYERS || r.players.length > MAX_PLAYERS) return base
  const players: Player[] = r.players.map((p, i) => {
    const o = (p && typeof p === 'object' ? p : {}) as Partial<Player>
    const score = typeof o.score === 'number' && Number.isFinite(o.score) ? Math.trunc(o.score) : 0
    const name = typeof o.name === 'string' && o.name.trim() ? Array.from(o.name.trim()).slice(0, MAX_NAME_LEN).join('') : defaultName(i)
    return { name, score }
  })
  const history: Move[] = Array.isArray(r.history)
    ? r.history
        .filter((m): m is Move => !!m && Number.isInteger((m as Move).index) && (m as Move).index >= 0 && (m as Move).index < players.length && Number.isFinite((m as Move).delta))
        .map((m) => ({ index: m.index, delta: m.delta }))
        .slice(-MAX_HISTORY)
    : []
  return { players, step: normalizeStep(r.step), history }
}

/**
 * 从 localStorage 读状态；读取或解析失败时返回默认状态。
 *
 * @returns 状态
 * @example
 * const state = loadState()
 */
export function loadState(): BoardState {
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    return text ? sanitizeState(JSON.parse(text)) : createState()
  } catch {
    return createState()
  }
}

/**
 * 把状态写进 localStorage，失败（隐私模式、配额）时静默忽略。
 *
 * @param s 要保存的状态
 * @returns 是否写入成功
 * @example
 * saveState(state)
 */
export function saveState(s: BoardState): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    return true
  } catch {
    return false
  }
}
