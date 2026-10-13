// 剪贴板：优先 navigator.clipboard，不可用时退回 execCommand

/**
 * 复制文本到剪贴板。
 *
 * @param text 要复制的文本
 * @returns 是否复制成功（失败时由调用方给用户提示）
 * @example
 * if (!(await copyText('abc'))) tip.value = '复制失败，请手动长按选择'
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 无权限或非安全上下文，走下面的兜底
  }
  return legacyCopy(text)
}

/** 老办法：借临时 textarea + execCommand('copy')，失败返回 false */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(ta)
  }
}
