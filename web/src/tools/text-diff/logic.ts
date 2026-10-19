// 文本对比：基于 LCS 的按行 / 按字符差异

/** 差异片段类型：相同 / 删除 / 新增 */
export type DiffType = 'eq' | 'del' | 'add'

/** 一个差异片段（按字符模式下 text 可含多个连续字符） */
export interface DiffPart {
  type: DiffType
  text: string
}

/** 对比模式 */
export type DiffMode = 'line' | 'char'

/** 统计 */
export interface DiffStats {
  /** 删除的单位数（行或字符） */
  del: number
  /** 新增的单位数 */
  add: number
}

/** 对比结果 */
export type DiffResult = { ok: true; parts: DiffPart[]; stats: DiffStats } | { ok: false; error: string }

/** LCS 表格最大格数，防止超长文本撑爆内存 */
export const MAX_CELLS = 4_000_000

/**
 * 对两个序列做 LCS 对比。
 * @param a 旧序列
 * @param b 新序列
 * @returns 按顺序的操作列表；序列过长时返回 null
 * @example diffSeq(['a', 'b'], ['a', 'c']) // eq a, del b, add c
 */
export function diffSeq(a: string[], b: string[]): { type: DiffType; item: string }[] | null {
  // 先剥掉公共前后缀，缩小 LCS 规模
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  if ((n + 1) * (m + 1) > MAX_CELLS) return null

  // lcs[i][j]：a 中段从 i、b 中段从 j 起的最长公共子序列长度
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }

  const ops: { type: DiffType; item: string }[] = []
  for (let i = 0; i < start; i++) ops.push({ type: 'eq', item: a[i] })
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      ops.push({ type: 'eq', item: a[start + i] })
      i++
      j++
    } else if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
      ops.push({ type: 'del', item: a[start + i] })
      i++
    } else {
      ops.push({ type: 'add', item: b[start + j] })
      j++
    }
  }
  for (let k = endA; k < a.length; k++) ops.push({ type: 'eq', item: a[k] })
  return ops
}

/**
 * 对比两段文本。
 * @param oldText 旧文本
 * @param newText 新文本
 * @param mode 'line' 按行 / 'char' 按字符
 * @returns 片段列表与增删统计；过长时返回错误
 * @example diffText('a\nb', 'a\nc', 'line').ok // true
 */
export function diffText(oldText: string, newText: string, mode: DiffMode = 'line'): DiffResult {
  const split = (s: string): string[] => (mode === 'line' ? (s === '' ? [] : s.replace(/\r\n?/g, '\n').split('\n')) : Array.from(s))
  const ops = diffSeq(split(oldText), split(newText))
  if (!ops) return { ok: false, error: '文本太长，请缩短后再对比（或改用按行对比）' }
  const stats: DiffStats = { del: 0, add: 0 }
  const parts: DiffPart[] = []
  for (const op of ops) {
    if (op.type === 'del') stats.del++
    if (op.type === 'add') stats.add++
    const last = parts[parts.length - 1]
    // 字符模式把连续同类字符并成一段；行模式每行独立
    if (mode === 'char' && last && last.type === op.type) last.text += op.item
    else parts.push({ type: op.type, text: op.item })
  }
  return { ok: true, parts, stats }
}
