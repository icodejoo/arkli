// 搜图站入口清单：只放入口页地址，不拼接任何会泄漏图片的参数

/** 搜图站 */
export interface SearchSite {
  /** 站点名 */
  name: string
  /** 入口页（https） */
  url: string
  /** 一句话特点 */
  note: string
}

/** 常用以图搜图站点的入口页 */
export const SEARCH_SITES: ReadonlyArray<SearchSite> = [
  { name: 'Google Lens', url: 'https://lens.google.com/', note: '识物、找相似图、识别文字' },
  { name: 'Bing 视觉搜索', url: 'https://www.bing.com/visualsearch', note: '相似图与商品，中文环境友好' },
  { name: '百度识图', url: 'https://graph.baidu.com/', note: '中文内容覆盖多' },
  { name: 'TinEye', url: 'https://tineye.com/', note: '专查图片出处与原图' },
  { name: 'Yandex 图片', url: 'https://yandex.com/images/', note: '人像、场景相似图较强' },
]

/** 操作步骤说明 */
export const STEPS: ReadonlyArray<string> = [
  '选一张要查的图片。',
  '先保存到相册，或用「分享图片」交给系统里的相机、浏览器等应用。',
  '打开下面任一搜图站，点击上传图片，选刚才的图即可。',
]

/** 隐私与可用性提示 */
export const NOTES: ReadonlyArray<string> = [
  '本工具不会替你上传图片，也不会把图片内容拼进链接，上传由你在搜图站里自己完成。',
  '部分站点在部分网络环境下可能打不开，换一个站点试试。',
]
