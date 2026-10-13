import type { Component } from 'vue'

/** 工具元信息 */
export interface ToolMeta {
  /** 工具唯一标识，用于路由 `/tool/:id` */
  id: string
  /** 展示名称 */
  name: string
  /** 一句话简介 */
  description: string
  /** 懒加载组件，每个工具会被打成独立 chunk */
  load: () => Promise<{ default: Component }>
}

/**
 * 工具注册表。新增工具：在 `src/tools/<id>/` 下建 index.vue，再在此处加一行。
 */
export const tools: ToolMeta[] = [
  {
    id: 'bridge-probe',
    name: 'Bridge 探针',
    description: '检测与原生/Rust 的通信是否正常',
    load: () => import('./bridge-probe/index.vue'),
  },
  { id: 'money-upper', name: '金额转大写', description: '金额转中文财务大写', load: () => import('./money-upper/index.vue') },
  { id: 'base-convert', name: '进制转换', description: '2/8/10/16 及任意进制互转，支持补码', load: () => import('./base-convert/index.vue') },
  { id: 'unit-convert', name: '单位换算', description: '长度、面积、质量、温度等 13 类单位换算', load: () => import('./unit-convert/index.vue') },
  { id: 'time-calc', name: '时间计算器', description: '时分秒加减、时间差与时长换算', load: () => import('./time-calc/index.vue') },
  { id: 'date-calc', name: '日期计算器', description: '日期间隔与日期加减推算', load: () => import('./date-calc/index.vue') },
  { id: 'kinship', name: '亲戚关系计算器', description: '拼出关系链，算出该怎么称呼', load: () => import('./kinship/index.vue') },
  { id: 'coin-flip', name: '抛硬币', description: '正反面随机，可连抛并统计', load: () => import('./coin-flip/index.vue') },
  { id: 'dice', name: '掷骰子', description: '1~10 颗骰子，4~100 面可选', load: () => import('./dice/index.vue') },
  { id: 'lottery', name: '自定义抽签', description: '输入选项，随机抽出 N 个', load: () => import('./lottery/index.vue') },
  { id: 'decide', name: '做个决定', description: '转盘帮你拿主意', load: () => import('./decide/index.vue') },
  { id: 'base64', name: 'Base64 编解码', description: '文本与 Base64 互转，支持 URL 安全', load: () => import('./base64/index.vue') },
  { id: 'password-gen', name: '密码生成器', description: '自定义长度与字符集，一次可生成多个', load: () => import('./password-gen/index.vue') },
  { id: 'color-convert', name: '颜色转换', description: 'HEX、RGB、HSL、HSV 互转', load: () => import('./color-convert/index.vue') },
  { id: 'ruler', name: '尺子', description: '厘米/英寸刻度，可用银行卡校准', load: () => import('./ruler/index.vue') },
  { id: 'compass', name: '指南针', description: '读取方向传感器，显示方位与度数', load: () => import('./compass/index.vue') },
  { id: 'clock-screen', name: '时间屏幕', description: '全屏大字时钟，数字/翻页，可显示农历', load: () => import('./clock-screen/index.vue') },
  { id: 'danmaku', name: '手持弹幕', description: '全屏滚动文字，LED 屏效果', load: () => import('./danmaku/index.vue') },
  { id: 'device-info', name: '设备信息', description: '屏幕、系统、硬件、网络与特性探测', load: () => import('./device-info/index.vue') },
]

/**
 * 按 id 查工具。
 *
 * @param id 工具 id
 * @returns 工具元信息；不存在时为 undefined
 * @example
 * findTool('bridge-probe')?.name // 'Bridge 探针'
 */
export function findTool(id: string): ToolMeta | undefined {
  return tools.find((t) => t.id === id)
}
