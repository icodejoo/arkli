import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia, setActivePinia } from 'pinia'
import AiView from './AiView.vue'

vi.hoisted(() => {
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
  })
})

// mock vue-router 路由跳转
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}))

// mock vant/es 组件为测试桩
vi.mock('vant/es', async (orig) => {
  const actual = await orig<typeof import('vant/es')>().catch(() => ({}))
  const { defineComponent, h } = await import('vue')
  return {
    ...actual,
    NavBar: defineComponent({
      props: ['title'],
      setup(props, { slots }) {
        return () => h('div', { class: 'van-nav-bar-stub' }, [props.title, slots.right?.()])
      },
    }),
    Icon: defineComponent({
      props: ['name'],
      setup(props) {
        return () => h('i', { class: `van-icon-${props.name}` })
      },
    }),
    Popup: defineComponent({
      props: ['show'],
      setup(props, { slots }) {
        return () => (props.show ? h('div', { class: 'van-popup-stub' }, slots.default?.()) : null)
      },
    }),
  }
})

describe('AiView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('真渲染：包含“MNN 基础参数”及“所有本地模型共用”，且仍包含“在线大模型配置（即将支持）”', async () => {
    const app = createSSRApp({
      render: () => h(AiView),
    })
    const html = await renderToString(app)

    // 在线大模型配置占位卡片保持原有文案
    expect(html).toContain('在线大模型配置（即将支持）')

    // MNN 基础参数入口标题及副文案
    expect(html).toContain('MNN 基础参数')
    expect(html).toContain('所有本地模型共用')

    // 容器类与对应图标
    expect(html).toContain('ai__entries')
    expect(html).toContain('van-icon-setting-o')
    expect(html).toContain('van-icon-bulb-o')
  })
})
