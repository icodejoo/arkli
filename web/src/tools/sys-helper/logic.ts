// 系统调试助手：参数校验与 ADB 命令生成。不直接改系统设置，只产出可复制的命令文本

/** DPI 下限 */
export const DPI_MIN = 120
/** DPI 上限 */
export const DPI_MAX = 960
/** 屏幕尺寸（像素）下限 */
export const SIZE_PX_MIN = 100
/** 屏幕尺寸（像素）上限 */
export const SIZE_PX_MAX = 10000
/** 电量下限 */
export const BATTERY_MIN = 0
/** 电量上限 */
export const BATTERY_MAX = 100
/** 动画倍数下限（0 即关闭动画） */
export const ANIM_MIN = 0
/** 动画倍数上限 */
export const ANIM_MAX = 10
/** Android 基准密度（mdpi），devicePixelRatio × 160 即推算 dpi */
export const BASE_DPI = 160
/** 命令前缀 */
const ADB = 'adb shell'

/** 校验结果：成功带命令列表，失败带中文提示 */
export type CmdResult = { ok: true; commands: string[] } | { ok: false; error: string }

/** 动画速度快捷选项 */
export const ANIM_PRESETS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '关' },
  { value: 0.5, label: '0.5x' },
  { value: 1, label: '1x' },
  { value: 2, label: '2x' },
]

/** 电池状态选项（对应 dumpsys battery 的 status 取值） */
export const BATTERY_STATUS_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 2, label: '充电中' },
  { value: 3, label: '放电中' },
  { value: 4, label: '未充电' },
  { value: 5, label: '已充满' },
]

/** 高级重启项：命令与说明 */
export interface RebootItem {
  /** 名称 */
  label: string
  /** 电脑上执行的命令 */
  adb: string
  /** 说明 */
  note: string
}

/** 高级重启命令清单 */
export const REBOOT_ITEMS: ReadonlyArray<RebootItem> = [
  { label: '恢复模式', adb: 'adb reboot recovery', note: '进入 Recovery，可清缓存或刷包' },
  { label: 'Bootloader', adb: 'adb reboot bootloader', note: '进入刷机模式（fastboot）' },
  { label: 'Fastbootd', adb: 'adb reboot fastboot', note: '用户空间 fastboot，动态分区机型用' },
  { label: 'Sideload', adb: 'adb reboot sideload', note: '进入 Recovery 的 ADB 侧载模式' },
  { label: '普通重启', adb: 'adb reboot', note: '正常重启' },
]

/** 手机上直接执行重启的说明 */
export const ROOT_REBOOT_NOTE =
  '想在手机上直接执行（如终端里敲 reboot recovery），需要 root 权限；未 root 的手机只能用电脑 + USB 调试。本应用不会替你执行。'

/** 电量校准建议 */
export const CALIBRATION_TIPS: ReadonlyArray<string> = [
  '现代锂电池有电量计芯片，不需要「用光再充满」之类的校准，反复深放反而伤电池。',
  '电量显示明显不准（突然掉电、关机时还有电），多半是电池老化，建议去官方检测电池健康度。',
  '日常保持 20%~80% 之间充放，少高温充电，对寿命更友好。',
  '本工具不提供任何所谓一键校准，那类功能没有实际作用。',
]

/** 判断是否为范围内整数 */
function intInRange(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max
}

/**
 * 按网页像素比推算 densityDpi（仅供参考）。
 *
 * @param dpr window.devicePixelRatio
 * @returns 推算的 dpi，取整；dpr 非法返回 0
 * @example estimateDensityDpi(2.75) // 440
 */
export function estimateDensityDpi(dpr: number): number {
  return Number.isFinite(dpr) && dpr > 0 ? Math.round(dpr * BASE_DPI) : 0
}

/**
 * 校验 DPI 是否在允许范围内。
 *
 * @param n 待校验值
 * @returns 合法为 true
 * @example isValidDpi(480) // true
 */
export function isValidDpi(n: number): boolean {
  return intInRange(n, DPI_MIN, DPI_MAX)
}

/**
 * 校验电量是否为 0~100 的整数。
 *
 * @param n 待校验值
 * @returns 合法为 true
 */
export function isValidBatteryLevel(n: number): boolean {
  return intInRange(n, BATTERY_MIN, BATTERY_MAX)
}

/**
 * 校验动画倍数是否在 0~10 之间（可小数）。
 *
 * @param n 待校验值
 * @returns 合法为 true
 */
export function isValidAnimScale(n: number): boolean {
  return Number.isFinite(n) && n >= ANIM_MIN && n <= ANIM_MAX
}

/**
 * 生成修改 DPI 的命令。
 *
 * @param dpi 目标 dpi，需在 120~960
 * @returns 命令列表或错误
 * @example buildDpiCommands(420) // { ok: true, commands: ['adb shell wm density 420'] }
 */
export function buildDpiCommands(dpi: number): CmdResult {
  if (!isValidDpi(dpi)) return { ok: false, error: `DPI 需要是 ${DPI_MIN}~${DPI_MAX} 之间的整数` }
  return { ok: true, commands: [`${ADB} wm density ${dpi}`] }
}

/**
 * 生成修改分辨率的命令。
 *
 * @param w 宽（像素）
 * @param h 高（像素）
 * @returns 命令列表或错误
 * @example buildSizeCommands(1080, 2400) // { ok: true, commands: ['adb shell wm size 1080x2400'] }
 */
export function buildSizeCommands(w: number, h: number): CmdResult {
  if (!intInRange(w, SIZE_PX_MIN, SIZE_PX_MAX) || !intInRange(h, SIZE_PX_MIN, SIZE_PX_MAX)) {
    return { ok: false, error: `宽高需要是 ${SIZE_PX_MIN}~${SIZE_PX_MAX} 之间的整数` }
  }
  return { ok: true, commands: [`${ADB} wm size ${w}x${h}`] }
}

/** 还原 DPI 与分辨率的命令 */
export const RESET_DISPLAY_COMMANDS: ReadonlyArray<string> = [`${ADB} wm density reset`, `${ADB} wm size reset`]

/**
 * 生成电量伪装命令（仅让系统显示假电量，不改变真实电池，reset 后恢复）。
 *
 * @param level 电量 0~100
 * @param status 状态值 1~5，见 BATTERY_STATUS_OPTIONS
 * @param ac 是否模拟接入交流电
 * @returns 命令列表或错误
 * @example buildBatteryCommands(50, 3, false).ok // true
 */
export function buildBatteryCommands(level: number, status: number, ac: boolean): CmdResult {
  if (!isValidBatteryLevel(level)) return { ok: false, error: `电量需要是 ${BATTERY_MIN}~${BATTERY_MAX} 之间的整数` }
  if (!BATTERY_STATUS_OPTIONS.some((o) => o.value === status)) return { ok: false, error: '电池状态不在可选范围内' }
  return {
    ok: true,
    commands: [`${ADB} dumpsys battery set level ${level}`, `${ADB} dumpsys battery set status ${status}`, `${ADB} dumpsys battery set ac ${ac ? 1 : 0}`],
  }
}

/** 恢复真实电量显示的命令 */
export const BATTERY_RESET_COMMAND = `${ADB} dumpsys battery reset`

/**
 * 生成三项动画速度命令（窗口、过渡、动画时长）。
 *
 * @param scale 倍数 0~10，0 即关闭，倍数越大动画越慢
 * @returns 命令列表或错误
 * @example buildAnimationCommands(0.5).ok // true
 */
export function buildAnimationCommands(scale: number): CmdResult {
  if (!isValidAnimScale(scale)) return { ok: false, error: `动画倍数需要在 ${ANIM_MIN}~${ANIM_MAX} 之间` }
  return {
    ok: true,
    commands: ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'].map((k) => `${ADB} settings put global ${k} ${scale}`),
  }
}

/**
 * 把命令列表拼成可一次粘贴的多行文本。
 *
 * @param commands 命令列表
 * @returns 以换行连接的文本
 */
export function joinCommands(commands: readonly string[]): string {
  return commands.join('\n')
}
