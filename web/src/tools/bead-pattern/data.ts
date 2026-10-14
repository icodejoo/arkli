/**
 * 拼豆调色板数据。
 *
 * 注意：这是自编的「通用调色板」，色号 A01… 是本工具自己起的编号，
 * 不是任何品牌（Perler / Hama / Artkal / 国产品牌）的官方色号；品牌色号表待补。
 * 要换成品牌色板，只需新增一个符合 Palette 结构的对象并加进 PALETTES，logic.ts 与页面不用改。
 */

/** 调色板里的一种颜色 */
export interface PaletteColor {
  /** 色号，同一调色板内唯一 */
  code: string
  /** 颜色名（中文） */
  name: string
  /** 色值，#rrggbb */
  hex: string
}

/** 一套调色板 */
export interface Palette {
  /** 调色板标识 */
  id: string
  /** 显示名 */
  name: string
  /** 颜色列表 */
  colors: PaletteColor[]
}

/** 通用调色板：48 色，覆盖灰阶、红粉、橙黄、绿、蓝、紫、棕肤 */
export const GENERIC_PALETTE: Palette = {
  id: 'generic48',
  name: '通用 48 色（自编）',
  colors: [
    // 灰阶
    { code: 'A01', name: '白', hex: '#ffffff' },
    { code: 'A02', name: '米白', hex: '#f3ecd9' },
    { code: 'A03', name: '浅灰', hex: '#d5d6d8' },
    { code: 'A04', name: '中灰', hex: '#9a9ca0' },
    { code: 'A05', name: '深灰', hex: '#5b5d61' },
    { code: 'A06', name: '黑', hex: '#1b1b1d' },
    // 红粉
    { code: 'A07', name: '浅粉', hex: '#fbd3dc' },
    { code: 'A08', name: '粉', hex: '#f59bb4' },
    { code: 'A09', name: '玫红', hex: '#e03e7e' },
    { code: 'A10', name: '珊瑚', hex: '#f4766a' },
    { code: 'A11', name: '红', hex: '#e02b2b' },
    { code: 'A12', name: '深红', hex: '#a3141f' },
    { code: 'A13', name: '酒红', hex: '#6d1230' },
    { code: 'A14', name: '桃', hex: '#ffb59a' },
    // 橙黄
    { code: 'A15', name: '浅黄', hex: '#fff3a8' },
    { code: 'A16', name: '黄', hex: '#ffd91f' },
    { code: 'A17', name: '金黄', hex: '#f4b400' },
    { code: 'A18', name: '橙', hex: '#ff8a1f' },
    { code: 'A19', name: '深橙', hex: '#e8590c' },
    { code: 'A20', name: '杏', hex: '#f8c88b' },
    // 绿
    { code: 'A21', name: '嫩绿', hex: '#d4ec8b' },
    { code: 'A22', name: '草绿', hex: '#8cd13f' },
    { code: 'A23', name: '绿', hex: '#2fae4a' },
    { code: 'A24', name: '深绿', hex: '#1b7a3a' },
    { code: 'A25', name: '墨绿', hex: '#10432b' },
    { code: 'A26', name: '薄荷', hex: '#a6e8cf' },
    { code: 'A27', name: '青绿', hex: '#19a58c' },
    { code: 'A28', name: '橄榄', hex: '#7a8a2c' },
    // 蓝
    { code: 'A29', name: '浅蓝', hex: '#bfe3f7' },
    { code: 'A30', name: '天蓝', hex: '#5cbcf0' },
    { code: 'A31', name: '蓝', hex: '#2b78e4' },
    { code: 'A32', name: '深蓝', hex: '#1c3f94' },
    { code: 'A33', name: '藏青', hex: '#14234f' },
    { code: 'A34', name: '青', hex: '#11b5c9' },
    { code: 'A35', name: '灰蓝', hex: '#7e97b5' },
    { code: 'A36', name: '雾蓝', hex: '#b7c7dc' },
    // 紫
    { code: 'A37', name: '浅紫', hex: '#d9c6f0' },
    { code: 'A38', name: '紫', hex: '#9457d6' },
    { code: 'A39', name: '深紫', hex: '#5a2a8c' },
    { code: 'A40', name: '紫红', hex: '#b2339f' },
    // 棕肤
    { code: 'A41', name: '肤色', hex: '#f9d9bf' },
    { code: 'A42', name: '深肤', hex: '#e2a67a' },
    { code: 'A43', name: '浅棕', hex: '#c58a52' },
    { code: 'A44', name: '棕', hex: '#8a5a33' },
    { code: 'A45', name: '深棕', hex: '#53341f' },
    { code: 'A46', name: '咖啡', hex: '#3a2316' },
    { code: 'A47', name: '土黄', hex: '#b8924a' },
    { code: 'A48', name: '砖红', hex: '#b5503c' },
  ],
}

/** 可选调色板列表，新增品牌色板往这里加 */
export const PALETTES: Palette[] = [GENERIC_PALETTE]
