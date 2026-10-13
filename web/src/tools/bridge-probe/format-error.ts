import type { BridgeError } from '@/native/protocol'

/**
 * 把未知错误转成可读文本。
 *
 * @param e 捕获到的错误
 * @returns 形如 `CODE: message` 的文本
 * @example
 * formatError({ code: 'TIMEOUT', message: '超时' }) // 'TIMEOUT: 超时'
 */
export function formatError(e: unknown): string {
  const err = e as Partial<BridgeError>
  return err && err.code ? `${err.code}: ${err.message ?? ''}` : String(e)
}
