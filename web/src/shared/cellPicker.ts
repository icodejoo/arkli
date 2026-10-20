/** 单元格选择器的一个选项 */
export interface CellOption {
  /** 选项值（v-model 回传它） */
  value: string | number
  /** 显示文案 */
  label: string
  /** 是否禁用该项（置灰、不可选；即便是当前值也照样显示禁用） */
  disabled?: boolean
}

/** 当前选中项的显示文案；找不到时返回空串 */
export function optionLabel(options: readonly CellOption[], value: string | number): string {
  return options.find((o) => o.value === value)?.label ?? ''
}

/**
 * 转成 van-action-sheet 的 actions；当前选中项高亮。
 *
 * @param options 选项列表
 * @param value 当前值
 * @param activeColor 选中项文字色
 * @returns actions 数组，name 为文案，value 带回原始值；option.disabled 为真时带 disabled
 * @example toActions([{ value: 1, label: '甲' }], 1, '#07c160') // [{ name: '甲', value: 1, color: '#07c160' }]
 */
export function toActions(options: readonly CellOption[], value: string | number, activeColor: string): Array<{ name: string; value: string | number; color?: string; disabled?: boolean }> {
  return options.map((o) => ({
    name: o.label,
    value: o.value,
    ...(o.value === value ? { color: activeColor } : {}),
    ...(o.disabled !== undefined ? { disabled: o.disabled } : {}),
  }))
}
