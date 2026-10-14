// 元素周期表静态数据：118 个元素，序号 = 数组下标 + 1
// 相对原子质量取 IUPAC 标准原子量的常用位数；没有标准原子量的放射性元素取最长寿命同位素的质量数。

/** 元素分类 */
export type Category =
  | 'alkali'
  | 'alkaline'
  | 'transition'
  | 'post-transition'
  | 'metalloid'
  | 'nonmetal'
  | 'halogen'
  | 'noble'
  | 'lanthanide'
  | 'actinide'

/** 分类的中文名与展示顺序 */
export const CATEGORY_LABELS: Record<Category, string> = {
  alkali: '碱金属',
  alkaline: '碱土金属',
  transition: '过渡金属',
  'post-transition': '后过渡金属',
  metalloid: '类金属',
  nonmetal: '非金属',
  halogen: '卤素',
  noble: '稀有气体',
  lanthanide: '镧系',
  actinide: '锕系',
}

/** 一个元素 */
export interface Element {
  /** 原子序数 */
  z: number
  /** 元素符号 */
  symbol: string
  /** 中文名 */
  cn: string
  /** 中文读音（仅生僻字元素有，104~118 号） */
  read?: string
  /** 英文名 */
  en: string
  /** 相对原子质量 */
  mass: number
  /** true 表示 mass 是质量数（无标准原子量，显示时加方括号） */
  massIsNumber: boolean
  /** 分类（104 号以后多为理论预测） */
  category: Category
}

/** 原始行：[符号, 中文名, 英文名, 原子质量, 分类] */
type Raw = [string, string, string, number, Category]

/** 118 个元素的原始数据 */
const RAW: Raw[] = [
  ['H', '氢', 'Hydrogen', 1.008, 'nonmetal'],
  ['He', '氦', 'Helium', 4.0026, 'noble'],
  ['Li', '锂', 'Lithium', 6.94, 'alkali'],
  ['Be', '铍', 'Beryllium', 9.0122, 'alkaline'],
  ['B', '硼', 'Boron', 10.81, 'metalloid'],
  ['C', '碳', 'Carbon', 12.011, 'nonmetal'],
  ['N', '氮', 'Nitrogen', 14.007, 'nonmetal'],
  ['O', '氧', 'Oxygen', 15.999, 'nonmetal'],
  ['F', '氟', 'Fluorine', 18.998, 'halogen'],
  ['Ne', '氖', 'Neon', 20.18, 'noble'],
  ['Na', '钠', 'Sodium', 22.99, 'alkali'],
  ['Mg', '镁', 'Magnesium', 24.305, 'alkaline'],
  ['Al', '铝', 'Aluminium', 26.982, 'post-transition'],
  ['Si', '硅', 'Silicon', 28.085, 'metalloid'],
  ['P', '磷', 'Phosphorus', 30.974, 'nonmetal'],
  ['S', '硫', 'Sulfur', 32.06, 'nonmetal'],
  ['Cl', '氯', 'Chlorine', 35.45, 'halogen'],
  ['Ar', '氩', 'Argon', 39.95, 'noble'],
  ['K', '钾', 'Potassium', 39.098, 'alkali'],
  ['Ca', '钙', 'Calcium', 40.078, 'alkaline'],
  ['Sc', '钪', 'Scandium', 44.956, 'transition'],
  ['Ti', '钛', 'Titanium', 47.867, 'transition'],
  ['V', '钒', 'Vanadium', 50.942, 'transition'],
  ['Cr', '铬', 'Chromium', 51.996, 'transition'],
  ['Mn', '锰', 'Manganese', 54.938, 'transition'],
  ['Fe', '铁', 'Iron', 55.845, 'transition'],
  ['Co', '钴', 'Cobalt', 58.933, 'transition'],
  ['Ni', '镍', 'Nickel', 58.693, 'transition'],
  ['Cu', '铜', 'Copper', 63.546, 'transition'],
  ['Zn', '锌', 'Zinc', 65.38, 'transition'],
  ['Ga', '镓', 'Gallium', 69.723, 'post-transition'],
  ['Ge', '锗', 'Germanium', 72.63, 'metalloid'],
  ['As', '砷', 'Arsenic', 74.922, 'metalloid'],
  ['Se', '硒', 'Selenium', 78.971, 'nonmetal'],
  ['Br', '溴', 'Bromine', 79.904, 'halogen'],
  ['Kr', '氪', 'Krypton', 83.798, 'noble'],
  ['Rb', '铷', 'Rubidium', 85.468, 'alkali'],
  ['Sr', '锶', 'Strontium', 87.62, 'alkaline'],
  ['Y', '钇', 'Yttrium', 88.906, 'transition'],
  ['Zr', '锆', 'Zirconium', 91.224, 'transition'],
  ['Nb', '铌', 'Niobium', 92.906, 'transition'],
  ['Mo', '钼', 'Molybdenum', 95.95, 'transition'],
  ['Tc', '锝', 'Technetium', 98, 'transition'],
  ['Ru', '钌', 'Ruthenium', 101.07, 'transition'],
  ['Rh', '铑', 'Rhodium', 102.91, 'transition'],
  ['Pd', '钯', 'Palladium', 106.42, 'transition'],
  ['Ag', '银', 'Silver', 107.87, 'transition'],
  ['Cd', '镉', 'Cadmium', 112.41, 'transition'],
  ['In', '铟', 'Indium', 114.82, 'post-transition'],
  ['Sn', '锡', 'Tin', 118.71, 'post-transition'],
  ['Sb', '锑', 'Antimony', 121.76, 'metalloid'],
  ['Te', '碲', 'Tellurium', 127.6, 'metalloid'],
  ['I', '碘', 'Iodine', 126.9, 'halogen'],
  ['Xe', '氙', 'Xenon', 131.29, 'noble'],
  ['Cs', '铯', 'Caesium', 132.91, 'alkali'],
  ['Ba', '钡', 'Barium', 137.33, 'alkaline'],
  ['La', '镧', 'Lanthanum', 138.91, 'lanthanide'],
  ['Ce', '铈', 'Cerium', 140.12, 'lanthanide'],
  ['Pr', '镨', 'Praseodymium', 140.91, 'lanthanide'],
  ['Nd', '钕', 'Neodymium', 144.24, 'lanthanide'],
  ['Pm', '钷', 'Promethium', 145, 'lanthanide'],
  ['Sm', '钐', 'Samarium', 150.36, 'lanthanide'],
  ['Eu', '铕', 'Europium', 151.96, 'lanthanide'],
  ['Gd', '钆', 'Gadolinium', 157.25, 'lanthanide'],
  ['Tb', '铽', 'Terbium', 158.93, 'lanthanide'],
  ['Dy', '镝', 'Dysprosium', 162.5, 'lanthanide'],
  ['Ho', '钬', 'Holmium', 164.93, 'lanthanide'],
  ['Er', '铒', 'Erbium', 167.26, 'lanthanide'],
  ['Tm', '铥', 'Thulium', 168.93, 'lanthanide'],
  ['Yb', '镱', 'Ytterbium', 173.05, 'lanthanide'],
  ['Lu', '镥', 'Lutetium', 174.97, 'lanthanide'],
  ['Hf', '铪', 'Hafnium', 178.49, 'transition'],
  ['Ta', '钽', 'Tantalum', 180.95, 'transition'],
  ['W', '钨', 'Tungsten', 183.84, 'transition'],
  ['Re', '铼', 'Rhenium', 186.21, 'transition'],
  ['Os', '锇', 'Osmium', 190.23, 'transition'],
  ['Ir', '铱', 'Iridium', 192.22, 'transition'],
  ['Pt', '铂', 'Platinum', 195.08, 'transition'],
  ['Au', '金', 'Gold', 196.97, 'transition'],
  ['Hg', '汞', 'Mercury', 200.59, 'transition'],
  ['Tl', '铊', 'Thallium', 204.38, 'post-transition'],
  ['Pb', '铅', 'Lead', 207.2, 'post-transition'],
  ['Bi', '铋', 'Bismuth', 208.98, 'post-transition'],
  ['Po', '钋', 'Polonium', 209, 'post-transition'],
  ['At', '砹', 'Astatine', 210, 'halogen'],
  ['Rn', '氡', 'Radon', 222, 'noble'],
  ['Fr', '钫', 'Francium', 223, 'alkali'],
  ['Ra', '镭', 'Radium', 226, 'alkaline'],
  ['Ac', '锕', 'Actinium', 227, 'actinide'],
  ['Th', '钍', 'Thorium', 232.04, 'actinide'],
  ['Pa', '镤', 'Protactinium', 231.04, 'actinide'],
  ['U', '铀', 'Uranium', 238.03, 'actinide'],
  ['Np', '镎', 'Neptunium', 237, 'actinide'],
  ['Pu', '钚', 'Plutonium', 244, 'actinide'],
  ['Am', '镅', 'Americium', 243, 'actinide'],
  ['Cm', '锔', 'Curium', 247, 'actinide'],
  ['Bk', '锫', 'Berkelium', 247, 'actinide'],
  ['Cf', '锎', 'Californium', 251, 'actinide'],
  ['Es', '锿', 'Einsteinium', 252, 'actinide'],
  ['Fm', '镄', 'Fermium', 257, 'actinide'],
  ['Md', '钔', 'Mendelevium', 258, 'actinide'],
  ['No', '锘', 'Nobelium', 259, 'actinide'],
  ['Lr', '铹', 'Lawrencium', 266, 'actinide'],
  // 104 号起的中文名是生僻字，用码点转义避免手误；性质多为理论预测
  ['Rf', '\u{2CB3B}', 'Rutherfordium', 267, 'transition'],
  ['Db', '\u{2CB4A}', 'Dubnium', 268, 'transition'],
  ['Sg', '\u{2CB73}', 'Seaborgium', 271, 'transition'],
  ['Bh', '\u{2CB5B}', 'Bohrium', 272, 'transition'],
  ['Hs', '\u{2CB76}', 'Hassium', 270, 'transition'],
  ['Mt', '\u{9FCF}', 'Meitnerium', 276, 'transition'],
  ['Ds', '\u{2B7FC}', 'Darmstadtium', 281, 'transition'],
  ['Rg', '\u{2CB2D}', 'Roentgenium', 280, 'transition'],
  ['Cn', '\u{9FD4}', 'Copernicium', 285, 'transition'],
  ['Nh', '\u{9FED}', 'Nihonium', 284, 'post-transition'],
  ['Fl', '\u{2B4E7}', 'Flerovium', 289, 'post-transition'],
  ['Mc', '镆', 'Moscovium', 288, 'post-transition'],
  ['Lv', '\u{2B7F7}', 'Livermorium', 293, 'post-transition'],
  ['Ts', '\u{9FEC}', 'Tennessine', 294, 'halogen'],
  ['Og', '\u{9FEB}', 'Oganesson', 294, 'noble'],
]

/** 生僻字元素的读音（key 为原子序数） */
const READINGS: Record<number, string> = {
  104: 'lú',
  105: 'dù',
  106: 'xǐ',
  107: 'bō',
  108: 'hēi',
  109: 'mài',
  110: 'dá',
  111: 'lún',
  112: 'gē',
  113: 'nǐ',
  114: 'fū',
  116: 'lì',
  117: 'tián',
  118: 'ào',
}

/** 没有标准原子量、mass 取质量数的元素序号：Tc、Pm、84~89、93~118 */
function hasNoStandardWeight(z: number): boolean {
  return z === 43 || z === 61 || (z >= 84 && z <= 89) || z >= 93
}

/** 全部 118 个元素，按原子序数升序 */
export const ELEMENTS: Element[] = RAW.map(([symbol, cn, en, mass, category], i) => {
  const z = i + 1
  return { z, symbol, cn, read: READINGS[z], en, mass, massIsNumber: hasNoStandardWeight(z), category }
})
