import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import BottomActions from './BottomActions.vue'
import type { BottomActionItem } from './bottomActions'

// 动作栏与子项换成桩，只看渲染出的 key / 文案 / 禁用
vi.mock('vant/es/action-bar/index.mjs', async () => {
  const { defineComponent, h } = await import('vue')
  return { ActionBar: defineComponent({ setup: (_p, { slots }) => () => h('nav', slots.default?.()) }) }
})
vi.mock('vant/es/action-bar-icon/index.mjs', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    ActionBarIcon: defineComponent({
      props: { text: String, disabled: Boolean },
      setup: (p) => () => h('i', { class: 'ico', 'data-off': String(p.disabled) }, p.text),
    }),
  }
})
vi.mock('vant/es/action-bar-button/index.mjs', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    ActionBarButton: defineComponent({
      props: { text: String, type: String, disabled: Boolean },
      setup: (p) => () => h('b', { class: 'btn', 'data-type': p.type, 'data-off': String(p.disabled) }, p.text),
    }),
  }
})

/** 渲染组件为 HTML */
function render(items: BottomActionItem[], slots?: Record<string, () => unknown>): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(BottomActions, { items }, slots as never) }))
}

describe('BottomActions', () => {
  it('按顺序渲染图标项与按钮项，文案自定义', async () => {
    const html = await render([
      { key: 'album', text: '相册', icon: 'photo-o' },
      { key: 'go', text: '翻译', kind: 'button' },
    ])
    expect(html.indexOf('相册')).toBeLessThan(html.indexOf('翻译'))
    expect(html).toContain('class="ico"')
    expect(html).toContain('data-type="primary"')
  })
  it('按钮配色与禁用态透传', async () => {
    const html = await render([{ key: 'go', text: '拍照', kind: 'button', type: 'danger', disabled: true }])
    expect(html).toContain('data-type="danger"')
    expect(html).toContain('data-off="true"')
  })
  it('item-<key> 插槽整项替换默认渲染', async () => {
    const html = await render([{ key: 'ai', text: '不该出现' }, { key: 'go', text: '翻译', kind: 'button' }], {
      'item-ai': () => h('span', { class: 'custom' }, 'AI'),
    })
    expect(html).toContain('<span class="custom">AI</span>')
    expect(html).not.toContain('不该出现')
    expect(html).toContain('翻译')
  })
})
