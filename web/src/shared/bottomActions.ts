/** 自定义图标前缀：`arkli:xxx` 表示 src/assets/icons/xxx.svg，其余是 vant 内置图标名 */
export const CUSTOM_ICON_PREFIX = 'arkli:'

/** 内置项分组（仅用于归类，渲染顺序以注册表顺序为准） */
export type BottomActionGroup = 'pick' | 'edit' | 'output' | 'view' | 'play' | 'other' | 'main'

/** 内置项语气：danger 用危险色 */
export type BottomActionTone = 'default' | 'danger'

/** 注册表一项 */
export interface BottomActionDef {
  /** 键，同时是插槽名、事件名 */
  readonly key: string
  /** 默认文案 */
  readonly text: string
  /** 图标：`arkli:` 前缀的自定义图标（映射见 bottomActionIcons.ts）；主按钮没有图标 */
  readonly icon?: string
  /** 语气，默认 default */
  readonly tone?: BottomActionTone
  /** 分组 */
  readonly group: BottomActionGroup
}

/**
 * 内置动作注册表（有序，渲染顺序固定即此顺序）。新增内置项只改这张表：
 * 选图类 → 编辑类 → 输出类 → 查看类 → 播放类 → 其他 → 主按钮（最右，单独渲染）。
 * 图标统一用 Lucide（落在 assets/icons，`arkli:` 前缀），组件映射见 bottomActionIcons.ts。
 */
export const BOTTOM_ACTION_REGISTRY = [
  // 选图类
  { key: 'ai', text: 'AI', icon: 'arkli:ai', group: 'pick' },
  { key: 'album', text: '相册', icon: 'arkli:images', group: 'pick' },
  { key: 'photo', text: '拍照', icon: 'arkli:camera', group: 'pick' },
  { key: 'paste', text: '粘贴', icon: 'arkli:clipboard-paste', group: 'pick' },
  { key: 'import', text: '导入', icon: 'arkli:file-input', group: 'pick' },
  // 编辑类
  { key: 'edit', text: '编辑', icon: 'arkli:pencil', group: 'edit' },
  { key: 'undo', text: '撤销', icon: 'arkli:undo-2', group: 'edit' },
  { key: 'redo', text: '重做', icon: 'arkli:redo-2', group: 'edit' },
  { key: 'add', text: '添加', icon: 'arkli:plus', group: 'edit' },
  { key: 'selectAll', text: '全选', icon: 'arkli:check-check', group: 'edit' },
  { key: 'clear', text: '清空', icon: 'arkli:eraser', group: 'edit' },
  { key: 'reset', text: '重置', icon: 'arkli:rotate-ccw', group: 'edit' },
  { key: 'sample', text: '示例', icon: 'arkli:lightbulb', group: 'edit' },
  // 输出类
  { key: 'copy', text: '复制', icon: 'arkli:copy', group: 'output' },
  { key: 'save', text: '保存', icon: 'arkli:save', group: 'output' },
  { key: 'download', text: '下载', icon: 'arkli:download', group: 'output' },
  { key: 'export', text: '导出', icon: 'arkli:file-output', group: 'output' },
  { key: 'share', text: '分享', icon: 'arkli:share-2', group: 'output' },
  { key: 'print', text: '打印', icon: 'arkli:printer', group: 'output' },
  // 查看类
  { key: 'preview', text: '预览', icon: 'arkli:eye', group: 'view' },
  { key: 'fullscreen', text: '全屏', icon: 'arkli:maximize', group: 'view' },
  { key: 'search', text: '搜索', icon: 'arkli:search', group: 'view' },
  { key: 'history', text: '历史', icon: 'arkli:history', group: 'view' },
  { key: 'favorite', text: '收藏', icon: 'arkli:star', group: 'view' },
  { key: 'refresh', text: '刷新', icon: 'arkli:refresh-cw', group: 'view' },
  // 播放类
  { key: 'play', text: '播放', icon: 'arkli:play', group: 'play' },
  { key: 'pause', text: '暂停', icon: 'arkli:pause', group: 'play' },
  // 其他
  { key: 'settings', text: '设置', icon: 'arkli:settings', group: 'other' },
  { key: 'help', text: '帮助', icon: 'arkli:circle-help', group: 'other' },
  { key: 'delete', text: '删除', icon: 'arkli:trash-2', tone: 'danger', group: 'other' },
  // 主按钮
  { key: 'main', text: '生成', group: 'main' },
] as const satisfies readonly BottomActionDef[]

/** 内置项 key 联合类型（由注册表推导） */
export type BottomActionKey = (typeof BOTTOM_ACTION_REGISTRY)[number]['key']

/** 所有内置 key（按注册表顺序） */
export const BOTTOM_ACTION_KEYS: readonly BottomActionKey[] = BOTTOM_ACTION_REGISTRY.map((d) => d.key)

/** 会触发同名事件的 key（ai 项内容走 #ai 插槽，自身不触发事件） */
export const BOTTOM_ACTION_EVENT_KEYS: readonly BottomActionKey[] = BOTTOM_ACTION_KEYS.filter((k) => k !== 'ai')

/** 统一事件名：任一项点击都会再发一次，参数为 key */
export const BOTTOM_ACTION_EVENT = 'action'

/** 组件 emits 声明：各项同名事件 + action */
export const BOTTOM_ACTION_EMITS: readonly string[] = [...BOTTOM_ACTION_EVENT_KEYS, BOTTOM_ACTION_EVENT]

/** 内置项的默认文案 / 图标（由注册表派生，兼容旧引用） */
export const BOTTOM_ACTION_DEFAULTS = Object.fromEntries(
  BOTTOM_ACTION_REGISTRY.map((d) => [d.key, { text: d.text, ...('icon' in d ? { icon: d.icon } : {}) }]),
) as { [K in BottomActionKey]: { text: string; icon?: string } }

/** 「更多」项文案 */
export const MORE_TEXT = '更多'

/** 「更多」项图标 */
export const MORE_ICON = 'arkli:ellipsis'

/** 图标项数量超过它就自动收纳进「更多」（含「更多」自身占一格） */
export const DEFAULT_MAX_VISIBLE = 4

/** 主按钮配色 */
export type MainType = 'primary' | 'danger' | 'warning' | 'default'

/** 单项配置：true 启用；对象可覆盖文案 / 图标 / 颜色 / 禁用，`false` 等于不启用 */
export type BottomActionOption = boolean | { disabled?: boolean; text?: string; icon?: string; color?: string }

/** `actions` 入参：key 数组，或 `{ key: true | 覆盖项 }` 对象 */
export type BottomActionsInput = readonly BottomActionKey[] | Partial<Record<BottomActionKey, BottomActionOption>>

/** 旧布尔 props 等别名，与 `actions` 并入同一归一化管线 */
export interface LegacyActionProps {
  /** 旧布尔开关：ai / album / photo / main */
  flags?: Partial<Record<BottomActionKey, boolean | undefined>>
  /** 主按钮文案 */
  mainText?: string
  /** 主按钮背景色 */
  mainColor?: string
  /** 图标项前景色 */
  iconColor?: string
  /** 按项禁用 */
  disabled?: Partial<Record<BottomActionKey, boolean>>
}

/** 归一化后的一项 */
export interface NormalizedAction {
  /** 键 */
  key: BottomActionKey
  /** 文案 */
  text: string
  /** 图标 */
  icon?: string
  /** 语气 */
  tone: BottomActionTone
  /** 是否禁用 */
  disabled: boolean
  /** 颜色：主按钮为背景色，图标项为前景色 */
  color?: string
}

/** 插槽作用域：替换某一项时可直接复用的状态与点击回调 */
export interface BottomActionSlotScope {
  /** 文案 */
  text?: string
  /** 图标名 */
  icon?: string
  /** 颜色：主按钮为背景色，图标按钮为前景色 */
  color?: string
  /** 是否禁用 */
  disabled: boolean
  /** 触发该项对应的事件 */
  click: () => void
}

/** 按 key 查注册表项 */
const DEF_BY_KEY = new Map<string, (typeof BOTTOM_ACTION_REGISTRY)[number]>(BOTTOM_ACTION_REGISTRY.map((d) => [d.key, d]))

/** 默认的未知 key 警告：生产环境静默 */
function defaultWarn(msg: string): void {
  if (!import.meta.env?.PROD) console.warn(msg)
}

/**
 * 把 `actions` 与旧别名 props 归一化成按注册表顺序排序的项列表。
 * 未知 key 会 warn 并忽略；值为 false / undefined 视为不启用。
 *
 * @param input 数组或对象写法的启用项，可省略
 * @param legacy 旧布尔 props 等别名
 * @param warn 未知 key 的警告回调，默认非生产环境 console.warn
 * @returns 启用项列表（含 ai / main，按注册表顺序）
 * @example normalizeActions(['copy', 'save'], { flags: { main: true }, mainText: '翻译' })
 */
export function normalizeActions(
  input?: BottomActionsInput,
  legacy: LegacyActionProps = {},
  warn: (msg: string) => void = defaultWarn,
): NormalizedAction[] {
  const options = new Map<string, Exclude<BottomActionOption, false>>()
  const enable = (key: string, opt: BottomActionOption | undefined): void => {
    if (!DEF_BY_KEY.has(key)) return warn(`[BottomActions] 未知的内置项 "${key}"，已忽略`)
    if (opt) options.set(key, opt)
  }
  for (const [key, on] of Object.entries(legacy.flags ?? {})) enable(key, on)
  if (Array.isArray(input)) for (const key of input as readonly string[]) enable(key, true)
  else for (const [key, opt] of Object.entries((input ?? {}) as Record<string, BottomActionOption>)) enable(key, opt)

  const result: NormalizedAction[] = []
  for (const def of BOTTOM_ACTION_REGISTRY) {
    const opt = options.get(def.key)
    if (!opt) continue
    const o = typeof opt === 'object' ? opt : {}
    const isMain = def.key === 'main'
    result.push({
      key: def.key,
      text: o.text ?? (isMain ? legacy.mainText : undefined) ?? def.text,
      icon: o.icon ?? ('icon' in def ? def.icon : undefined),
      tone: ('tone' in def ? def.tone : undefined) ?? 'default',
      disabled: o.disabled ?? !!legacy.disabled?.[def.key],
      color: o.color ?? (isMain ? legacy.mainColor : legacy.iconColor),
    })
  }
  return result
}

/** 收纳结果 */
export interface CollapseResult {
  /** 直接显示的图标项 */
  visible: NormalizedAction[]
  /** 收进「更多」的图标项 */
  more: NormalizedAction[]
}

/**
 * 判定哪些图标项收进「更多」。ai / main 不参与；图标项数不超过 maxVisible 或 maxVisible 为 0 / 非有限数时不收纳；
 * 超出时前 maxVisible - 1 项显示，其余收纳（「更多」自身占一格）。
 *
 * @param items normalizeActions 的结果
 * @param maxVisible 最多同时显示的图标项数，0 / Infinity 关闭收纳
 * @returns 显示项与收纳项
 * @example splitCollapsed(items, 4) // 5 项 → 3 项显示 + 2 项进「更多」
 */
export function splitCollapsed(items: readonly NormalizedAction[], maxVisible: number): CollapseResult {
  const icons = items.filter((i) => i.key !== 'ai' && i.key !== 'main')
  if (!(maxVisible > 0) || !Number.isFinite(maxVisible) || icons.length <= maxVisible) return { visible: icons, more: [] }
  const keep = Math.max(Math.floor(maxVisible) - 1, 0)
  return { visible: icons.slice(0, keep), more: icons.slice(keep) }
}
