import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia, setActivePinia } from 'pinia'
import MnnParamsSheet from './MnnParamsSheet.vue'

vi.hoisted(() => {
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
  })
})

/** 记录渲染传递给 ModelParamsPanel 的属性 */
let passedProps: Record<string, unknown> | null = null

// mock 子组件 ModelParamsPanel，记录传入的 props 并渲染测试桩
vi.mock('./ModelParamsPanel.vue', () => ({
  default: defineComponent({
    props: ['providerId', 'title'],
    setup(props) {
      passedProps = { ...props }
      return () => h('div', { class: 'model-params-panel-stub', 'data-provider-id': props.providerId, 'data-title': props.title })
    },
  }),
}))

// mock vant/es 的 Popup，在 show=true 时渲染内部插槽内容
vi.mock('vant/es', async (orig) => {
  const actual = await orig<typeof import('vant/es')>().catch(() => ({}))
  const { defineComponent, h } = await import('vue')
  return {
    ...actual,
    Popup: defineComponent({
      props: ['show'],
      setup(props, { slots }) {
        return () => (props.show ? h('div', { class: 'van-popup-stub' }, slots.default?.()) : null)
      },
    }),
  }
})

/**
 * 渲染 MnnParamsSheet 组件为 HTML 字符串
 *
 * @param show 是否显示弹窗
 * @returns 渲染生成的 HTML 文本
 */
function renderSheet(show = true): Promise<string> {
  return renderToString(
    createSSRApp({
      render: () => h(MnnParamsSheet, { modelValue: show }),
    }),
  )
}

describe('MnnParamsSheet', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    passedProps = null
  })

  it('打开状态下渲染标题、说明文案以及 ModelParamsPanel，且 providerId 为 mnn', async () => {
    const html = await renderSheet(true)

    // 验证弹窗主标题与功能简短说明
    expect(html).toContain('MNN 基础参数')
    expect(html).toContain('所有本地模型共用，语音输入不受影响')

    // 验证渲染了 ModelParamsPanel 且 providerId 确为 mnn
    expect(html).toContain('model-params-panel-stub')
    expect(html).toContain('data-provider-id="mnn"')
    expect(passedProps?.providerId).toBe('mnn')
  })

  it('关闭状态下不渲染内容', async () => {
    const html = await renderSheet(false)
    expect(html).not.toContain('MNN 基础参数')
    expect(html).not.toContain('model-params-panel-stub')
  })
})
