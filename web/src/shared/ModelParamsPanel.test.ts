import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, nextTick } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia, setActivePinia } from 'pinia'
import type { AiParamSpec, AiParamsState } from '@/native/ai'

vi.hoisted(() => {
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
  })
})

const SAMPLE_SPECS: AiParamSpec[] = [
  {
    key: 'temperature',
    label: '采样温度',
    desc: '控制输出的发散程度',
    kind: 'slider',
    default: 0.7,
    min: 0,
    max: 1.5,
    step: 0.1,
    advanced: false,
    scope: 'call',
    applyTo: ['prompt'],
  },
  {
    key: 'threads',
    label: '线程数',
    desc: '推理计算所用 CPU 线程',
    kind: 'stepper',
    default: 4,
    min: 1,
    max: 8,
    step: 1,
    advanced: false,
    scope: 'session',
  },
  {
    key: 'filterNoise',
    label: '过滤低置信',
    desc: '丢弃低质量结果',
    kind: 'switch',
    default: 1,
    min: 0,
    max: 1,
    step: 1,
    advanced: false,
    scope: 'call',
  },
  {
    key: 'mode',
    label: '性能模式',
    desc: '核调度策略',
    kind: 'select',
    default: 0,
    min: 0,
    max: 2,
    step: 1,
    options: ['均衡', '性能', '省电'],
    advanced: false,
    scope: 'session',
  },
  {
    key: 'topK',
    label: 'TopK 采样',
    desc: '高级采样候选数量',
    kind: 'slider',
    default: 20,
    min: 1,
    max: 100,
    step: 1,
    advanced: true,
    scope: 'call',
  },
]

const SAMPLE_STATE: AiParamsState = {
  provider: 'local-qwen',
  specs: SAMPLE_SPECS,
  values: {
    temperature: 0.7,
    threads: 4,
    filterNoise: 1,
    mode: 0,
    topK: 20,
  },
}

// 模拟原生 ai 模块
vi.mock('@/native/ai', async (orig) => ({
  ...(await orig<typeof import('@/native/ai')>()),
  aiParamsGet: vi.fn(async () => SAMPLE_STATE),
  aiParamsSet: vi.fn(async (_p: string, values: Record<string, number>) => ({
    ...SAMPLE_STATE,
    values: { ...SAMPLE_STATE.values, ...values },
  })),
  aiParamsReset: vi.fn(async () => SAMPLE_STATE),
}))

// mock showToast
const mockToast = vi.fn()
vi.mock('vant', () => ({
  showToast: (msg: string) => mockToast(msg),
}))

// 测试桩事件收集
const triggers = {
  sliders: {} as Record<string, (val: number) => void>,
  steppers: {} as Record<string, (val: number) => void>,
  switchChange: null as ((val: boolean) => void) | null,
  buttonClick: null as (() => void) | null,
  iconClick: null as (() => void) | null,
}

// mock vant/es 下的按需引入组件
vi.mock('vant/es', () => ({
  Slider: defineComponent({
    props: ['modelValue', 'min', 'max', 'step'],
    emits: ['change', 'update:modelValue'],
    setup(props, { emit, attrs }) {
      const key = String(attrs['data-key'] ?? '')
      triggers.sliders[key] = (val) => {
        emit('update:modelValue', val)
        emit('change', val)
      }
      return () => h('div', { class: 'van-slider-stub', 'data-val': String(props.modelValue) })
    },
  }),
  Stepper: defineComponent({
    props: ['modelValue', 'min', 'max', 'step'],
    emits: ['change', 'update:modelValue'],
    setup(props, { emit }) {
      triggers.steppers[String(props.min)] = (val: number) => {
        emit('update:modelValue', val)
        emit('change', val)
      }
      return () => h('div', { class: 'van-stepper-stub', 'data-val': String(props.modelValue) })
    },
  }),
  Switch: defineComponent({
    props: ['modelValue'],
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      triggers.switchChange = (val) => emit('update:modelValue', val)
      return () => h('div', { class: 'van-switch-stub', 'data-val': String(props.modelValue) })
    },
  }),
  Icon: defineComponent({
    props: ['name'],
    emits: ['click'],
    setup(props, { emit }) {
      triggers.iconClick = () => emit('click')
      return () => h('i', { class: `van-icon-${props.name}` })
    },
  }),
  Collapse: defineComponent({
    setup(_props, { slots }) {
      return () => h('div', { class: 'van-collapse-stub' }, slots.default?.())
    },
  }),
  CollapseItem: defineComponent({
    props: ['title', 'name'],
    setup(props, { slots }) {
      return () => h('div', { class: 'van-collapse-item-stub', 'data-title': props.title }, slots.default?.())
    },
  }),
  Button: defineComponent({
    emits: ['click'],
    setup(_props, { slots, emit }) {
      triggers.buttonClick = () => emit('click')
      return () => h('button', { class: 'van-button-stub' }, slots.default?.())
    },
  }),
}))

import { useAiParamsStore } from '@/stores/aiParams'
import ModelParamsPanel from './ModelParamsPanel.vue'

function renderPanel(props: { providerId: string; title?: string }) {
  return renderToString(createSSRApp({ render: () => h(ModelParamsPanel, props) }))
}

describe('ModelParamsPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockToast.mockReset()
    triggers.sliders = {}
    triggers.steppers = {}
    triggers.switchChange = null
    triggers.buttonClick = null
    triggers.iconClick = null
  })

  it('未加载或无 specs 时不渲染面板内容', async () => {
    const html = await renderPanel({ providerId: 'empty-p' })
    expect(html).toBe('<!---->')
  })

  it('渲染各种控件、标题、desc、applyTo 与 session 提示', async () => {
    const store = useAiParamsStore()
    store.cache['local-qwen'] = SAMPLE_STATE

    const html = await renderPanel({ providerId: 'local-qwen', title: 'Qwen 模型参数' })

    // 标题与全局提示
    expect(html).toContain('Qwen 模型参数')
    expect(html).toContain('页面自带设置的功能以页面为准')

    // 字段 label 与 desc
    expect(html).toContain('采样温度')
    expect(html).toContain('控制输出的发散程度')
    expect(html).toContain('线程数')
    expect(html).toContain('性能模式')

    // applyTo 与 session 提示
    expect(html).toContain('只对：问答 生效')
    expect(html).toContain('下次使用时重新加载（约 3 秒）')

    // 各种控件 kind
    expect(html).toContain('van-slider-stub')
    expect(html).toContain('van-stepper-stub')
    expect(html).toContain('van-switch-stub')
    expect(html).toContain('均衡')
    expect(html).toContain('性能')
    expect(html).toContain('省电')

    // 高级折叠面板
    expect(html).toContain('van-collapse-stub')
    expect(html).toContain('data-title="高级设置"')
    expect(html).toContain('TopK 采样')

    // 底部恢复默认按钮
    expect(html).toContain('恢复默认')
  })

  it('默认值时无重置按钮，当值被修改后显示重置图标', async () => {
    const store = useAiParamsStore()
    store.cache['local-qwen'] = SAMPLE_STATE
    const normalHtml = await renderPanel({ providerId: 'local-qwen' })
    expect(normalHtml).not.toContain('van-icon-replay')

    // 将 temperature 设为修改后的值
    store.cache['local-qwen'] = {
      ...SAMPLE_STATE,
      values: { ...SAMPLE_STATE.values, temperature: 0.9 },
    }
    const modifiedHtml = await renderPanel({ providerId: 'local-qwen' })
    expect(modifiedHtml).toContain('van-icon-replay')
  })

  it('未传 title 时不渲染 h4 标题', async () => {
    const store = useAiParamsStore()
    store.cache['local-qwen'] = SAMPLE_STATE
    const html = await renderPanel({ providerId: 'local-qwen' })
    expect(html).not.toContain('<h4')
  })

  it('交互测试：提交变更成功时更新 store，失败时回滚并 showToast', async () => {
    const store = useAiParamsStore()
    store.cache['local-qwen'] = JSON.parse(JSON.stringify(SAMPLE_STATE))

    await renderPanel({ providerId: 'local-qwen' })

    // 成功提交 slider
    const setSpy = vi.spyOn(store, 'set').mockResolvedValueOnce({
      ...SAMPLE_STATE,
      values: { ...SAMPLE_STATE.values, temperature: 1.2 },
    })
    triggers.sliders.temperature?.(1.2)
    expect(setSpy).toHaveBeenCalledWith('local-qwen', { temperature: 1.2 })

    // 失败提交回滚
    vi.spyOn(store, 'set').mockRejectedValueOnce(new Error('BAD_PARAMS'))
    triggers.sliders.temperature?.(0.2)
    await nextTick()
    await Promise.resolve()
    expect(mockToast).toHaveBeenCalledWith('参数设置失败')
  })

  it('交互测试：单项重置与全部重置失败时给出提示', async () => {
    const store = useAiParamsStore()
    store.cache['local-qwen'] = {
      ...SAMPLE_STATE,
      values: { ...SAMPLE_STATE.values, temperature: 1.2 },
    }

    await renderPanel({ providerId: 'local-qwen' })

    // 单项重置失败
    vi.spyOn(store, 'reset').mockRejectedValueOnce(new Error('RESET_FAIL'))
    triggers.iconClick?.()
    await nextTick()
    await Promise.resolve()
    expect(mockToast).toHaveBeenCalledWith('恢复默认失败')

    // 全部重置失败
    vi.spyOn(store, 'reset').mockRejectedValueOnce(new Error('RESET_ALL_FAIL'))
    triggers.buttonClick?.()
    await nextTick()
    await Promise.resolve()
    expect(mockToast).toHaveBeenCalledWith('恢复默认失败')
  })
})
