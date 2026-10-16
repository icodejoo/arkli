/** 动作项形态：icon 为图标加小字，button 为实心按钮 */
export type BottomActionKind = 'icon' | 'button'

/** 底部动作栏的一项 */
export interface BottomActionItem {
  /** 唯一标识；点击时回传，也是插槽名 `item-<key>` 的后缀 */
  key: string
  /** 文案；纯插槽项可省 */
  text?: string
  /** Vant 图标名 */
  icon?: string
  /** 形态，默认 icon */
  kind?: BottomActionKind
  /** 按钮配色（仅 button 有效），默认 primary */
  type?: 'primary' | 'danger' | 'warning' | 'default'
  /** 是否禁用 */
  disabled?: boolean
}
