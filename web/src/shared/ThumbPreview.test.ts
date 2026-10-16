import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import ThumbPreview from './ThumbPreview.vue'

vi.mock('vant', () => ({ showImagePreview: vi.fn(), showToast: vi.fn() }))
vi.mock('@/native/bridge', () => ({ call: vi.fn(), isNativeAvailable: () => false }))

/** 渲染成 HTML 字符串 */
const render = (props: { url: string; size?: number; scanning?: boolean }, slot?: () => unknown) => renderToString(createSSRApp({ render: () => h(ThumbPreview, props, slot ? { default: slot } : undefined) }))

describe('ThumbPreview', () => {
  it('默认渲染缩略图并按 size 定尺寸', async () => {
    const html = await render({ url: 'a.png', size: 40 })
    expect(html).toContain('src="a.png"')
    expect(html).toContain('width:40px')
    expect(html).not.toContain('tp__scan')
  })
  it('scanning 时带扫描线', async () => {
    expect(await render({ url: 'a.png', scanning: true })).toContain('tp__scan')
  })
  it('默认插槽可替换触发器', async () => {
    const html = await render({ url: 'a.png' }, () => h('b', 'X'))
    expect(html).toContain('<b>X</b>')
    expect(html).not.toContain('<img')
  })
})
