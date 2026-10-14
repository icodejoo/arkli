// 快递公司与单号规则表。
//
// 依据与可信度（务必读）：
// - 规则全部来自公开常见的"单号格式"总结与个人经验，没有官方文档逐条核对。快递公司会改号段，
//   纯数字单号尤其容易撞车（12 位数字中通/申通/顺丰都有），所以只给"可能是"，不保证。
// - confidence：3 = 有明确字母前缀/国际邮政 S10 格式，基本可信；
//               2 = 纯数字但号段较固定；
//               1 = 只按位数猜，仅作兜底候选。
// - 官网只放首页，没有核对各家查询页的具体路径（路径改版频繁，容易死链）。用户复制单号后到官网粘贴。

/** 单条识别规则 */
export interface TrackRule {
  /** 匹配（输入已规整为大写、无空格/连字符的单号） */
  pattern: RegExp
  /** 可信度：3 高，2 中，1 低 */
  confidence: 1 | 2 | 3
  /** 规则说明，展示给用户看 */
  note: string
}

/** 快递公司 */
export interface Carrier {
  /** 英文标识 */
  id: string
  /** 中文名 */
  name: string
  /** 官网首页（查询入口） */
  url: string
  /** 识别规则 */
  rules: TrackRule[]
}

/** 快递公司与规则（顺序即同可信度下的展示顺序） */
export const CARRIERS: Carrier[] = [
  {
    id: 'sf',
    name: '顺丰速运',
    url: 'https://www.sf-express.com/',
    rules: [
      { pattern: /^SF\d{10,13}$/, confidence: 3, note: 'SF 开头加 10~13 位数字' },
      { pattern: /^\d{12}$/, confidence: 1, note: '12 位纯数字，顺丰也用，但与中通、申通重叠' },
    ],
  },
  {
    id: 'jd',
    name: '京东物流',
    url: 'https://www.jdl.com/',
    rules: [{ pattern: /^JD[A-Z]{0,3}\d{10,16}$/, confidence: 3, note: 'JD 开头（含 JDV、JDX 等）后接数字' }],
  },
  {
    id: 'zto',
    name: '中通快递',
    url: 'https://www.zto.com/',
    rules: [
      { pattern: /^(73|75|76|78)\d{10}$/, confidence: 2, note: '12 位数字，73/75/76/78 开头' },
      { pattern: /^\d{12}$/, confidence: 1, note: '12 位纯数字，中通常见' },
    ],
  },
  {
    id: 'yto',
    name: '圆通速递',
    url: 'https://www.yto.net.cn/',
    rules: [
      { pattern: /^YT\d{13}$/, confidence: 3, note: 'YT 开头加 13 位数字' },
      { pattern: /^(6|8)\d{9}$/, confidence: 1, note: '10 位数字，6/8 开头，圆通老格式' },
    ],
  },
  {
    id: 'yunda',
    name: '韵达快递',
    url: 'https://www.yundaex.com/',
    rules: [
      { pattern: /^(1\d|31|43|46|55)\d{11}$/, confidence: 1, note: '13 位数字，号段按经验归纳，不确定' },
      { pattern: /^(43|46|31|55)\d{13}$/, confidence: 1, note: '15 位数字，号段按经验归纳，不确定' },
    ],
  },
  {
    id: 'sto',
    name: '申通快递',
    url: 'https://www.sto.cn/',
    rules: [
      {
        pattern: /^(268|368|468|568|668|768|868|968|888|588|688|009|038|088|128|139)\d{9}$/,
        confidence: 2,
        note: '12 位数字，268/368/…/888 等号段',
      },
      { pattern: /^77\d{10}$/, confidence: 2, note: '12 位数字，77 开头' },
      { pattern: /^\d{12}$/, confidence: 1, note: '12 位纯数字，申通常见' },
    ],
  },
  {
    id: 'jt',
    name: '极兔速递',
    url: 'https://www.jtexpress.com.cn/',
    rules: [{ pattern: /^JT[A-Z]{0,2}\d{11,14}$/, confidence: 3, note: 'JT 开头后接 11~14 位数字' }],
  },
  {
    id: 'ems',
    name: '中国邮政/EMS',
    url: 'https://www.ems.com.cn/',
    rules: [
      { pattern: /^E[A-Z]\d{9}[A-Z]{2}$/, confidence: 3, note: 'E 开头的 13 位国际邮政格式（EMS）' },
      { pattern: /^[A-Z]{2}\d{9}CN$/, confidence: 3, note: '2 字母 + 9 数字 + CN，中国邮政挂号/小包' },
      { pattern: /^(10|11)\d{9}$/, confidence: 2, note: '11 位数字，10/11 开头，EMS 国内常见' },
      { pattern: /^9\d{12}$/, confidence: 2, note: '13 位数字，9 开头，邮政包裹常见' },
    ],
  },
  {
    id: 'deppon',
    name: '德邦快递',
    url: 'https://www.deppon.com/',
    rules: [{ pattern: /^DPK\d{12}$/, confidence: 3, note: 'DPK 开头加 12 位数字' }],
  },
]
