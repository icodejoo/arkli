// 翻译：网页翻译入口清单（只放入口页，不拼文本进地址）

/** 网页翻译入口 */
export interface WebEntry {
  /** 名称 */
  name: string
  /** 入口地址，必须是 https 且不带查询串 */
  url: string
}

/** 翻译文本长度上限 */
export const TEXT_MAX = 5000

/** 网页翻译入口清单 */
export const WEB_ENTRIES: readonly WebEntry[] = [
  { name: 'Google 翻译', url: 'https://translate.google.com/' },
  { name: 'DeepL', url: 'https://www.deepl.com/translator' },
  { name: '有道翻译', url: 'https://fanyi.youdao.com/' },
]
