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

/** 24 色精简版保留的色号：从 48 色里按 Lab 距离挑出分布最开的 24 个，色号与 48 色一致 */
const LITE_CODES = new Set(['A01', 'A04', 'A06', 'A08', 'A09', 'A13', 'A14', 'A15', 'A16', 'A19', 'A22', 'A24', 'A25', 'A26', 'A27', 'A30', 'A32', 'A33', 'A37', 'A38', 'A40', 'A45', 'A47', 'A48'])

/** 扩展色：在 48 色基础上的淡 / 亮 / 暗 / 灰变体，按与已有颜色的区分度从大到小排，所以取前 N 个总是分布均匀 */
const EXTRA_COLORS: PaletteColor[] = [
  { code: 'A49', name: '灰紫', hex: '#8b69af' },
  { code: 'A50', name: '灰嫩绿', hex: '#aebb86' },
  { code: 'A51', name: '灰深蓝', hex: '#495c8b' },
  { code: 'A52', name: '灰玫红', hex: '#b55c7f' },
  { code: 'A53', name: '暗黄', hex: '#b89c16' },
  { code: 'A54', name: '灰珊瑚', hex: '#c07b74' },
  { code: 'A55', name: '暗橙', hex: '#b86316' },
  { code: 'A56', name: '淡紫红', hex: '#d58fca' },
  { code: 'A57', name: '灰酒红', hex: '#764454' },
  { code: 'A58', name: '灰深绿', hex: '#487d5a' },
  { code: 'A59', name: '暗紫红', hex: '#802572' },
  { code: 'A60', name: '暗薄荷', hex: '#78a795' },
  { code: 'A61', name: '灰橄榄', hex: '#7d8652' },
  { code: 'A62', name: '暗青', hex: '#0c8291' },
  { code: 'A63', name: '灰浅棕', hex: '#a68667' },
  { code: 'A64', name: '亮紫', hex: '#a979de' },
  { code: 'A65', name: '淡绿', hex: '#8dd29b' },
  { code: 'A66', name: '淡金黄', hex: '#f9d673' },
  { code: 'A67', name: '暗深红', hex: '#750e16' },
  { code: 'A68', name: '亮深棕', hex: '#755d4c' },
  { code: 'A69', name: '亮蓝', hex: '#5593e9' },
  { code: 'A70', name: '灰粉', hex: '#c08f9d' },
  { code: 'A71', name: '亮橙', hex: '#ffa14c' },
  { code: 'A72', name: '暗玫红', hex: '#a12d5b' },
  { code: 'A73', name: '暗橄榄', hex: '#586320' },
  { code: 'A74', name: '灰草绿', hex: '#87ad5c' },
  { code: 'A75', name: '暗深紫', hex: '#411e65' },
  { code: 'A76', name: '亮深橙', hex: '#ed7a3d' },
  { code: 'A77', name: '灰深红', hex: '#93454b' },
  { code: 'A78', name: '暗深绿', hex: '#13582a' },
  { code: 'A79', name: '灰紫红', hex: '#9c5691' },
  { code: 'A80', name: '淡青', hex: '#7cd6e1' },
  { code: 'A81', name: '淡深紫', hex: '#a48ac0' },
  { code: 'A82', name: '灰肤色', hex: '#c3b1a3' },
  { code: 'A83', name: '灰绿', hex: '#539962' },
  { code: 'A84', name: '淡红', hex: '#ee8a8a' },
  { code: 'A85', name: '暗深橙', hex: '#a74009' },
  { code: 'A86', name: '灰墨绿', hex: '#425e51' },
  { code: 'A87', name: '淡嫩绿', hex: '#e7f5bf' },
  { code: 'A88', name: '暗草绿', hex: '#65962d' },
  { code: 'A89', name: '亮紫红', hex: '#c15cb2' },
  { code: 'A90', name: '灰藏青', hex: '#454d65' },
  { code: 'A91', name: '亮深红', hex: '#b5434c' },
  { code: 'A92', name: '亮绿', hex: '#59be6e' },
  { code: 'A93', name: '暗天蓝', hex: '#4287ad' },
  { code: 'A94', name: '亮玫红', hex: '#e66598' },
  { code: 'A95', name: '灰深橙', hex: '#b96b40' },
  { code: 'A96', name: '亮草绿', hex: '#a3da65' },
  { code: 'A97', name: '灰黄', hex: '#c6b14b' },
  { code: 'A98', name: '灰深紫', hex: '#6b5187' },
  { code: 'A99', name: '淡砖红', hex: '#d69f94' },
  { code: 'A100', name: '暗砖红', hex: '#823a2b' },
  { code: 'A101', name: '淡蓝', hex: '#8ab5f0' },
  { code: 'A102', name: '淡薄荷', hex: '#cef2e5' },
  { code: 'A103', name: '暗青绿', hex: '#127765' },
  { code: 'A104', name: '暗浅紫', hex: '#9c8fad' },
  { code: 'A105', name: '暗金黄', hex: '#b08200' },
  { code: 'A106', name: '淡紫', hex: '#c4a3e8' },
  { code: 'A107', name: '亮深蓝', hex: '#4965a9' },
  { code: 'A108', name: '淡浅紫', hex: '#eae0f7' },
  { code: 'A109', name: '淡土黄', hex: '#d8c39b' },
  { code: 'A110', name: '暗酒红', hex: '#4e0d23' },
  { code: 'A111', name: '暗粉', hex: '#b07082' },
  { code: 'A112', name: '灰青绿', hex: '#479487' },
  { code: 'A113', name: '亮红', hex: '#e65555' },
  { code: 'A114', name: '暗土黄', hex: '#846935' },
  { code: 'A115', name: '暗深蓝', hex: '#142d6b' },
  { code: 'A116', name: '亮土黄', hex: '#c6a86e' },
  { code: 'A117', name: '淡深棕', hex: '#a08f84' },
  { code: 'A118', name: '亮深灰', hex: '#7c7d81' },
  { code: 'A119', name: '亮黄', hex: '#ffe14c' },
  { code: 'A120', name: '淡青绿', hex: '#81cec0' },
  { code: 'A121', name: '亮橄榄', hex: '#95a156' },
  { code: 'A122', name: '灰砖红', hex: '#9d665b' },
  { code: 'A123', name: '暗深灰', hex: '#424346' },
  { code: 'A124', name: '灰青', hex: '#439da8' },
  { code: 'A125', name: '淡深绿', hex: '#82b693' },
  { code: 'A126', name: '淡浅黄', hex: '#fff8cf' },
  { code: 'A127', name: '淡珊瑚', hex: '#f9b4ad' },
  { code: 'A128', name: '灰咖啡', hex: '#5a4d46' },
  { code: 'A129', name: '暗白', hex: '#b8b8b8' },
  { code: 'A130', name: '亮酒红', hex: '#8a4159' },
  { code: 'A131', name: '淡深蓝', hex: '#8295c4' },
  { code: 'A132', name: '暗蓝', hex: '#1f56a4' },
  { code: 'A133', name: '灰杏', hex: '#c2a886' },
  { code: 'A134', name: '亮深肤', hex: '#e8b895' },
  { code: 'A135', name: '暗墨绿', hex: '#0c301f' },
  { code: 'A136', name: '淡草绿', hex: '#c0e695' },
  { code: 'A137', name: '亮金黄', hex: '#f6c333' },
  { code: 'A138', name: '灰浅紫', hex: '#b1a7be' },
  { code: 'A139', name: '暗浅蓝', hex: '#8aa3b2' },
  { code: 'A140', name: '暗浅黄', hex: '#b8af79' },
  { code: 'A141', name: '暗珊瑚', hex: '#b0554c' },
  { code: 'A142', name: '灰金黄', hex: '#c09d3a' },
  { code: 'A143', name: '亮粉', hex: '#f7afc3' },
  { code: 'A144', name: '亮深紫', hex: '#7b55a3' },
]

/** 由 48 色基础色 + 前 extra 个扩展色拼出的调色板 */
function withExtra(id: string, name: string, extra: number): Palette {
  return { id, name, colors: [...GENERIC_PALETTE.colors, ...EXTRA_COLORS.slice(0, extra)] }
}

/** 通用 24 色：入门套装规格，颜色少、好配 */
export const LITE_PALETTE: Palette = {
  id: 'generic24',
  name: '通用 24 色（自编）',
  colors: GENERIC_PALETTE.colors.filter((c) => LITE_CODES.has(c.code)),
}

/** 可选调色板列表（由少到多），新增品牌色板往这里加 */
export const PALETTES: Palette[] = [
  LITE_PALETTE,
  GENERIC_PALETTE,
  withExtra('generic72', '通用 72 色（自编）', 24),
  withExtra('generic96', '通用 96 色（自编）', 48),
  withExtra('generic144', '通用 144 色（自编）', 96),
]
