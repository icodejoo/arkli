import { describe, expect, it } from 'vitest'

/** 所有 vue 源码的原文，路径为以 /src/ 开头的 key */
const sources = import.meta.glob('/src/**/*.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/**
 * 免除 main-loading 检查的白名单。
 * 键为文件在源码中的路径（以 /src/ 开头，例如 '/src/tools/example/index.vue'），值为免除加入白名单的具体原因。
 *
 * 【何时允许加入白名单】：
 * 1. 按钮文案或配色是基于瞬时/同步状态切换（例如纯前端 Tab/步骤切换、展示模式切换），无需任何异步等待或后台处理；
 * 2. 属于只读展示类页面，该按钮只负责同步切换前端渲染态，并已在需求设计中明确不需要 loading 心跳动画；
 * 3. 任何有异步处理（网络请求、模型推理、媒体转码等）的场景一律禁止加入白名单，必须配置 main-loading。
 */
export const LOADING_EXEMPT: Record<string, string> = {
  '/src/tools/image-base64/index.vue': '三元只是编码 / 解码模式切换（复制 / 保存图片），主按钮没有运行态；编码中的忙碌只体现在相册与拍照项',
  '/src/tools/level/index.vue': '三元是「授权并开始 / 解除锁定 / 锁定读数」的传感器流程阶段，主按钮自身不是运行中状态',
  '/src/tools/protractor/index.vue': '同水平仪：授权与锁定读数的阶段切换，主按钮没有运行态',
  '/src/tools/personality-test/index.vue': '三元是「下一题 / 提交 / 重新测试」的答题步骤，纯同步，没有运行态',
  '/src/tools/reaction-test/index.vue': '三元是反应测试的阶段（开始 / 再来一组 / 重新开始），页面本身做时间反馈，主按钮不适合再叠心跳',
}

/** 开始标签前缀常量 */
const TAG_PREFIX = '<bottom-actions'
/** 主按钮文案属性名 */
const MAIN_TEXT_PROP = 'main-text'
/** 主按钮类型属性名 */
const MAIN_TYPE_PROP = 'main-type'
/** actions 配置属性名 */
const ACTIONS_PROP = 'actions'

/**
 * 从 Vue 源码中稳健提取所有 <bottom-actions ...> 开始标签。
 * 按引号（双引号/单引号/反引号模板字符串）及花括号深度扫描，防止属性内箭头函数 `=>` 或三元运算符 `>` 导致提前截断。
 *
 * @param source Vue SFC 源码字符串
 * @returns 提取出的完整开始标签字符串数组（如 `['<bottom-actions main ... >']`）
 * @example
 * extractBottomActionsTags('<bottom-actions :main-text="a > b ? \'A\' : \'B\'" />')
 * // => ['<bottom-actions :main-text="a > b ? \'A\' : \'B\'" />']
 */
export function extractBottomActionsTags(source: string): string[] {
  const prefixLen = TAG_PREFIX.length
  const tags: string[] = []
  const len = source.length
  let i = 0

  while (i < len) {
    const start = source.indexOf(TAG_PREFIX, i)
    if (start === -1) break

    // 确认前缀之后紧随空白、/ 或 >，避免误匹配同前缀的其它标签
    const nextChar = source[start + prefixLen]
    if (nextChar && !/[\s/>]/.test(nextChar)) {
      i = start + prefixLen
      continue
    }

    let inQuote: '"' | "'" | '`' | null = null
    let escape = false
    let braceDepth = 0
    let end = -1

    for (let j = start + prefixLen; j < len; j++) {
      const ch = source[j]

      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\' && inQuote) {
        escape = true
        continue
      }

      if (inQuote) {
        if (ch === inQuote) {
          inQuote = null
        }
      } else {
        if (ch === '"' || ch === "'" || ch === '`') {
          inQuote = ch
        } else if (ch === '{') {
          braceDepth++
        } else if (ch === '}') {
          if (braceDepth > 0) braceDepth--
        } else if (ch === '>' && braceDepth === 0) {
          end = j
          break
        }
      }
    }

    if (end !== -1) {
      tags.push(source.slice(start, end + 1))
      i = end + 1
    } else {
      break
    }
  }

  return tags
}

/**
 * 提取标签中指定绑定的属性表达式。
 *
 * @param tag 开始标签字符串
 * @param propName 属性名（如 main-text 或 main-type）
 * @returns 绑定的表达式内容；未绑定则返回 null
 * @example
 * getBoundPropValue('<bottom-actions :main-text="busy ? \'A\' : \'B\'" />', 'main-text')
 * // => "busy ? 'A' : 'B'"
 */
export function getBoundPropValue(tag: string, propName: string): string | null {
  const regex = new RegExp(`(?:^|\\s)(?::|v-bind:)${propName}\\s*=\\s*(?:(["'])([\\s\\S]*?)\\1|([^\\s>]+))`, 'i')
  const match = tag.match(regex)
  if (!match) return null
  return match[2] ?? match[3] ?? null
}

/**
 * 判断标签的主按钮文案或配色是否是依赖条件的绑定（表达式含 `?`）。
 *
 * @param tag 开始标签字符串
 * @returns 是否包含条件绑定
 * @example
 * hasConditionalMainProp('<bottom-actions :main-text="busy ? \'生成中\' : \'生成\'" />')
 * // => true
 */
export function hasConditionalMainProp(tag: string): boolean {
  const textExpr = getBoundPropValue(tag, MAIN_TEXT_PROP)
  if (textExpr && textExpr.includes('?')) return true

  const typeExpr = getBoundPropValue(tag, MAIN_TYPE_PROP)
  if (typeExpr && typeExpr.includes('?')) return true

  return false
}

/**
 * 检查标签是否具备主按钮 loading 配置（main-loading 或 actions.main.loading）。
 *
 * @param tag 开始标签字符串
 * @returns 是否配置了主按钮 loading
 * @example
 * hasMainLoadingConfig('<bottom-actions :main-loading="busy" />')
 * // => true
 */
export function hasMainLoadingConfig(tag: string): boolean {
  // 1. 检查 main-loading、:main-loading、v-bind:main-loading
  if (/(?:^|\s)(?::|v-bind:)?main-loading(?=[\s=/>]|$)/.test(tag)) {
    return true
  }

  // 2. 检查 :actions 里包含 main: 且带 loading
  const actionsExpr = getBoundPropValue(tag, ACTIONS_PROP)
  if (actionsExpr && /main\s*:\s*\{[\s\S]*?loading/i.test(actionsExpr)) {
    return true
  }

  return false
}

describe('BottomActions 主按钮 loading 规则扫描', () => {
  describe('extractBottomActionsTags 标签提取器单测', () => {
    it('正确提取单行及跨多行标签', () => {
      const singleLine = '<bottom-actions main main-text="确定" />'
      expect(extractBottomActionsTags(singleLine)).toEqual([singleLine])

      const multiLine = `<bottom-actions
        ai
        main
        main-text="保存"
        @main="onSave"
      />`
      expect(extractBottomActionsTags(multiLine)).toEqual([multiLine])

      const multipleTags = `<div>
        <bottom-actions main main-text="上一步" />
        <p>分隔内容</p>
        <bottom-actions main main-text="下一步" />
      </div>`
      expect(extractBottomActionsTags(multipleTags)).toHaveLength(2)
    })

    it('正确处理属性表达式中包含 > 或 => 的情况，不提前截断', () => {
      const complexSnippet = `<bottom-actions
        main
        :main-text="count > 0 ? '确定' : '取消'"
        :main-type="ratio => ratio > 0.5 ? 'danger' : 'primary'"
        @main="go"
      />`
      const tags = extractBottomActionsTags(complexSnippet)
      expect(tags).toHaveLength(1)
      expect(tags[0]).toBe(complexSnippet)
    })

    it('正确处理模板字符串属性内嵌花括号与 > 的情况', () => {
      const templateSnippet = '<bottom-actions main :main-text="`状态: ${val > 10 ? \'高\' : \'低\'}`" />'
      const tags = extractBottomActionsTags(templateSnippet)
      expect(tags).toEqual([templateSnippet])
    })
  })

  describe('规则校验与防空转断言', () => {
    it('防空转：项目中必须存在 vue 源码且能提取出 bottom-actions 标签', () => {
      expect(Object.keys(sources).length).toBeGreaterThan(0)
      const allTags = Object.values(sources).flatMap(extractBottomActionsTags)
      expect(allTags.length).toBeGreaterThan(0)
    })

    it('LOADING_EXEMPT 白名单有效性校验：配置的路径必须真实存在且包含 bottom-actions 标签', () => {
      for (const [filePath, reason] of Object.entries(LOADING_EXEMPT)) {
        expect(sources[filePath], `白名单路径不存在: ${filePath}`).toBeDefined()
        expect(reason.trim().length, `白名单项必须填写豁免原因: ${filePath}`).toBeGreaterThan(0)
        const tags = extractBottomActionsTags(sources[filePath])
        expect(tags.length, `白名单文件内未找到 bottom-actions 标签: ${filePath}`).toBeGreaterThan(0)
      }
    })

    it('主按钮文案或配色条件绑定时必须显式声明 main-loading', () => {
      const violations: { file: string; tag: string }[] = []
      for (const [filePath, src] of Object.entries(sources)) {
        if (LOADING_EXEMPT[filePath]) continue
        const tags = extractBottomActionsTags(src)
        for (const tag of tags) {
          if (hasConditionalMainProp(tag) && !hasMainLoadingConfig(tag)) {
            violations.push({ file: filePath, tag })
          }
        }
      }
      expect(
        violations,
        `以下组件的主按钮条件变化未绑定 main-loading：\n${violations.map((v) => `${v.file}: ${v.tag}`).join('\n')}`,
      ).toEqual([])
    })
  })
})
