/**
 * 提醒封装：立即通知、闹钟（到点发通知，App 退后台也会响）。
 * 对应原生 `native.notify.show` / `native.alarm.*`，契约见 docs/design/bridge-protocol.md「提醒方法」。
 *
 * 无宿主（桌面浏览器调试）时全部抛 {@link NativeUnavailableError}，调用方用 `isNativeAvailable()` 判断后自行降级。
 * 设备重启后系统会丢掉闹钟，原生不做开机恢复。
 */
import { call as bridgeCall } from './bridge'
import { requireNative, type CallFn } from './system'

/** 方法名常量 */
export const REMINDER_METHODS = {
  notify: 'native.notify.show',
  alarmSet: 'native.alarm.set',
  alarmCancel: 'native.alarm.cancel',
  alarmList: 'native.alarm.list',
} as const

/** 立即通知参数 */
export interface NotifyOptions {
  /** 通知 id（0~2^31-1 的整数），同 id 会覆盖；缺省按时间生成 */
  id?: number
  /** 标题，1~100 字 */
  title: string
  /** 正文，≤500 字 */
  text?: string
}

/** 闹钟参数 */
export interface AlarmOptions {
  /** 闹钟标识（1~64 字符），同 id 再设会覆盖 */
  id: string
  /** 触发时刻（毫秒时间戳），必须在未来且不超过一年 */
  atEpochMs: number
  /** 通知标题，1~100 字 */
  title: string
  /** 通知正文，≤500 字 */
  text?: string
}

/** 一条待触发的闹钟 */
export interface AlarmItem {
  /** 闹钟标识 */
  id: string
  /** 触发时刻（毫秒时间戳） */
  atEpochMs: number
  /** 标题 */
  title: string
  /** 正文，可能为空串 */
  text: string
}

/**
 * 立即发一条通知，点击回到 App。
 *
 * 没有通知授权时以 PERMISSION_DENIED 拒绝，可先用 `requestPermission('notifications')`。
 *
 * @param options 通知内容
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 实际使用的通知 id
 * @example await showNotification({ title: '该喝水了' })
 */
export async function showNotification(options: NotifyOptions, call: CallFn = bridgeCall): Promise<number> {
  requireNative(REMINDER_METHODS.notify)
  const params: Record<string, unknown> = { title: options.title }
  if (options.id !== undefined) params.id = options.id
  if (options.text !== undefined) params.text = options.text
  const r = await call<{ id: number }>(REMINDER_METHODS.notify, params)
  return r.id
}

/**
 * 设一个闹钟：到点由系统唤起并发通知，不需要精确闹钟权限，状态栏会显示闹钟图标。
 *
 * @param options 闹钟内容
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @example await setAlarm({ id: 'pomodoro', atEpochMs: Date.now() + 25 * 60_000, title: '专注结束' })
 */
export async function setAlarm(options: AlarmOptions, call: CallFn = bridgeCall): Promise<void> {
  requireNative(REMINDER_METHODS.alarmSet)
  const params: Record<string, unknown> = { id: options.id, atEpochMs: options.atEpochMs, title: options.title }
  if (options.text !== undefined) params.text = options.text
  await call(REMINDER_METHODS.alarmSet, params)
}

/**
 * 取消一个闹钟。
 *
 * @param id 闹钟标识
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 该闹钟原先是否存在
 * @example await cancelAlarm('pomodoro')
 */
export async function cancelAlarm(id: string, call: CallFn = bridgeCall): Promise<boolean> {
  requireNative(REMINDER_METHODS.alarmCancel)
  const r = await call<{ cancelled: boolean }>(REMINDER_METHODS.alarmCancel, { id })
  return r.cancelled === true
}

/**
 * 列出待触发的闹钟，按触发时间升序。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 闹钟列表
 * @example const items = await listAlarms()
 */
export async function listAlarms(call: CallFn = bridgeCall): Promise<AlarmItem[]> {
  requireNative(REMINDER_METHODS.alarmList)
  const r = await call<{ items: AlarmItem[] }>(REMINDER_METHODS.alarmList)
  return r.items
}
