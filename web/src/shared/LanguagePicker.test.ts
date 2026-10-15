import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import LanguagePicker from './LanguagePicker.vue'

// 弹层默认懒渲染，SSR 里看不到内容：换成直接渲染默认插槽的 popup，picker 换成把列平铺的桩
vi.mock('vant/es/popup/index.mjs', async () => {
  const { defineComponent } = await import('vue')
  return { Popup: defineComponent({ setup: (_p, { slots }) => () => slots.default?.() }) }
})
vi.mock('vant/es/picker/index.mjs', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    Picker: defineComponent({
      props: { columns: { type: Array, default: () => [] } },
      setup: (p) => () => h('ul', (p.columns as Array<{ text: string; disabled: boolean }>).map((c) => h('li', { class: c.disabled ? 'off' : 'on' }, c.text))),
    }),
  }
})

/** 渲染组件为 HTML */
function render(props: { modelValue: string; title?: string; supported?: 'all' | string[] }, slots?: Record<string, (s: Record<string, unknown>) => unknown>): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(LanguagePicker, props, slots as never) }))
}

describe('LanguagePicker', () => {
  it('默认触发器：语言名 + aria-label', async () => {
    const html = await render({ modelValue: 'fr', title: '源语言' })
    expect(html).toContain('lp-trigger')
    expect(html).toContain('Français')
    expect(html).toContain('aria-label="源语言：Français"')
  })
  it('插槽覆盖默认触发器，并拿到 langName / code / show', async () => {
    const html = await render(
      { modelValue: 'ja' },
      { default: (s) => h('i', { class: 'custom' }, `${s.langName}|${s.code}|${typeof s.show}`) },
    )
    expect(html).toContain('<i class="custom">日本語|ja|function</i>')
    expect(html).not.toContain('lp-trigger')
  })
  it('未知语言码时显示码本身', async () => {
    expect(await render({ modelValue: 'xx' })).toContain('>xx<')
  })
  it('弹层列：支持的在前可选，不支持的在后置灰', async () => {
    const html = await render({ modelValue: 'en', supported: ['en', 'fr'] })
    const on = [...html.matchAll(/<li class="on">([^<]+)</g)].map((m) => m[1])
    const off = [...html.matchAll(/<li class="off">([^<]+)</g)].map((m) => m[1])
    expect(on).toEqual(['English', 'Français'])
    expect(off.length).toBeGreaterThan(30)
    expect(html.indexOf('class="on"')).toBeLessThan(html.indexOf('class="off"'))
  })
  it('supported 为 all 时没有置灰项', async () => {
    expect(await render({ modelValue: 'en' })).not.toContain('class="off"')
  })
})
