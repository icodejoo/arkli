// 收尾字平仄粗查（只认登记过的常用收尾字），给手写对联的软提示用

/** 收尾字的仄声字表（现代汉语三声、四声），库内用到的结尾字都要登记在这里或平声表里 */
export const OBLIQUE_ENDINGS =
  '绿好岁客意顺绣在晓乐里字笑久印鸟睦事缔配广气至绕暖日到贺旺照喜下聚业展运老盛永寿树敬满健阔院物果住度理'
/** 收尾字的平声字表（现代汉语一声、二声） */
export const LEVEL_ENDINGS =
  '欢长春祥庭隆安颜康来年兴房缘圆成堂莲贤浓高时光霞方朋通临程开辰张疆松生真游容德留门'

/**
 * 查某字的声调类别（只认库里登记过的收尾字）。
 *
 * @param ch 单个汉字
 * @returns '平' / '仄'；没登记返回 null
 * @example toneOf('欢') // '平'
 */
export function toneOf(ch: string): '平' | '仄' | null {
  if ([...ch].length !== 1) return null
  if (LEVEL_ENDINGS.indexOf(ch) >= 0) return '平'
  if (OBLIQUE_ENDINGS.indexOf(ch) >= 0) return '仄'
  return null
}

