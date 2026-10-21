import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, h, provide } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia, setActivePinia } from 'pinia'
import { useFloatStore } from '@/stores/float'
import BottomActions from './BottomActions.vue'
import { FLOAT_TOOL_ID } from './useFloatPause'

// 动作栏与子项换成桩，只看渲染出的 key / 文案 / 禁用 / loading
vi.mock('vant/es/action-bar/index.mjs', async () => {
  const { defineComponent, h } = await import('vue')
  return { ActionBar: defineComponent({ setup: (_p, { slots }) => () => h('nav', slots.default?.()) }) }
})
vi.mock('vant/es/action-bar-icon/index.mjs', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    ActionBarIcon: defineComponent({
      props: { text: String, color: String, disabled: Boolean },
      setup: (p) => () => h('i', { class: 'ico', 'data-color': p.color, 'data-off': String(p.disabled) }, p.text),
    }),
  }
})
vi.mock('vant/es/action-bar-button/index.mjs', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    ActionBarButton: defineComponent({
      inheritAttrs: false,
      props: { text: String, type: String, color: String, disabled: Boolean },
      setup: (p, { attrs }) => () =>
        h(
          'b',
          {
            class: ['btn', attrs.class].filter(Boolean).join(' '),
            'data-type': p.type,
            'data-color': p.color,
            'data-off': String(p.disabled),
            'aria-busy': attrs['aria-busy'],
          },
          p.text,
        ),
    }),
  }
})

// 「更多」弹层桩：把 actions / select 回调存下来，测试里直接调用
const sheet: { actions: { name: string; key: string; color?: string }[]; select?: (a: unknown) => void } = { actions: [] }
vi.mock('vant/es/action-sheet/index.mjs', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    ActionSheet: defineComponent({
      props: { show: Boolean, actions: { type: Array, default: () => [] } },
      emits: ['select'],
      setup: (p, { emit }) => {
        sheet.actions = p.actions as never
        sheet.select = (a) => emit('select', a)
        return () => h('div', { class: 'sheet' }, (p.actions as { name: string }[]).map((a) => h('s', a.name)))
      },
    }),
  }
})

/** 渲染组件为 HTML */
function render(props: Record<string, unknown>, slots?: Record<string, (s: Record<string, unknown>) => unknown>): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(BottomActions, props, slots as never) }))
}

describe('BottomActions', () => {
  it('默认什么都不渲染，布尔 props 控制各项有无', async () => {
    const empty = await render({})
    expect(empty).not.toContain('class="ico"')
    expect(empty).not.toContain('class="btn"')
    const html = await render({ album: true, photo: true, main: true })
    expect(html.indexOf('相册')).toBeLessThan(html.indexOf('拍照'))
    expect(html.indexOf('拍照')).toBeLessThan(html.indexOf('生成'))
  })
  it('主按钮文案、配色与按项禁用', async () => {
    const html = await render({ main: true, album: true, mainText: '翻译', mainType: 'danger', disabled: { main: true } })
    expect(html).toContain('翻译')
    expect(html).toContain('data-type="danger"')
    expect(html).toContain('data-off="true"')
    expect(html).toContain('data-off="false"')
  })
  it('mainColor / iconColor 分别作用于主按钮与图标按钮，并进插槽作用域', async () => {
    const html = await render({ main: true, album: true, mainColor: '#111', iconColor: '#222' })
    expect(html).toContain('class="btn" data-type="primary" data-color="#111"')
    expect(html).toContain('class="ico" data-color="#222"')
    const slot = await render({ album: true, iconColor: '#222' }, { album: (s) => h('u', String(s.color)) })
    expect(slot).toContain('#222')
  })
  it('ai 为真才渲染 #ai 插槽', async () => {
    const slots = { ai: () => h('span', { class: 'custom' }, 'AI') }
    expect(await render({ ai: true }, slots)).toContain('class="custom"')
    expect(await render({}, slots)).not.toContain('class="custom"')
  })
  it('具名插槽整项替换，且拿到作用域', async () => {
    const html = await render({ album: true }, { album: (s) => h('u', `换:${String(s.text)}:${String(s.disabled)}`) })
    expect(html).toContain('换:相册:false')
    expect(html).not.toContain('class="ico"')
  })
  it('默认插槽的额外项在拍照与主按钮之间', async () => {
    const html = await render({ photo: true, main: true }, { default: () => h('em', '额外') })
    expect(html.indexOf('拍照')).toBeLessThan(html.indexOf('额外'))
    expect(html.indexOf('额外')).toBeLessThan(html.indexOf('生成'))
  })
  it('actions 数组启用内置项，默认全关', async () => {
    expect(await render({ actions: [] })).not.toContain('class="ico"')
    const html = await render({ actions: ['share', 'copy', 'save'] })
    expect(html.indexOf('复制')).toBeLessThan(html.indexOf('保存'))
    expect(html.indexOf('保存')).toBeLessThan(html.indexOf('分享'))
  })
  it('actions 对象写法覆盖文案与禁用，主按钮仍在最右', async () => {
    const html = await render({ actions: { delete: { text: '删除所选', disabled: true } }, main: true })
    expect(html).toContain('删除所选')
    expect(html).toContain('data-off="true"')
    expect(html.indexOf('删除所选')).toBeLessThan(html.indexOf('生成'))
  })
  it('danger 项默认用危险色，显式 color 优先', async () => {
    expect(await render({ actions: ['delete'] })).toContain('data-color="var(--van-danger-color)"')
    expect(await render({ actions: { delete: { color: '#abc' } } })).toContain('data-color="#abc"')
  })
  it('具名插槽覆盖任意内置项，作用域带 click', async () => {
    const onSave = vi.fn()
    const onAction = vi.fn()
    let click: (() => void) | undefined
    const html = await render(
      { actions: ['save'], onSave, onAction },
      { save: (s) => ((click = s.click as () => void), h('u', `换:${String(s.text)}`)) },
    )
    expect(html).toContain('换:保存')
    click?.()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith('save')
  })
  it('旧事件 album / main 仍可用，并同时发 action', async () => {
    const onAlbum = vi.fn()
    const onMain = vi.fn()
    const onAction = vi.fn()
    const clicks: Record<string, () => void> = {}
    await render(
      { album: true, main: true, onAlbum, onMain, onAction },
      { album: (s) => ((clicks.album = s.click as () => void), null), main: (s) => ((clicks.main = s.click as () => void), null) },
    )
    clicks.album()
    clicks.main()
    expect(onAlbum).toHaveBeenCalledTimes(1)
    expect(onMain).toHaveBeenCalledTimes(1)
    expect(onAction.mock.calls).toEqual([['album'], ['main']])
  })
  it('超过 maxVisible 收纳进「更多」，点弹层项触发事件，danger 项标红', async () => {
    const onDelete = vi.fn()
    const onAction = vi.fn()
    const html = await render({ actions: ['copy', 'save', 'share', 'print', 'delete'], maxVisible: 4, onDelete, onAction })
    expect(html).toContain('更多')
    expect(html).toContain('复制')
    expect(html).toContain('分享')
    expect(sheet.actions.map((a) => a.key)).toEqual(['print', 'delete'])
    expect(sheet.actions[1].color).toBe('var(--van-danger-color)')
    sheet.select?.(sheet.actions[1])
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith('delete')
  })
  it('maxVisible 为 0 或刚好够数时没有「更多」', async () => {
    expect(await render({ actions: ['copy', 'save', 'share', 'print', 'delete'], maxVisible: 0 })).not.toContain('更多')
    expect(await render({ actions: ['copy', 'save', 'share', 'print'] })).not.toContain('更多')
  })
  it('未知 key 告警且忽略', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const html = await render({ actions: ['copy', 'nope'] })
    expect(html).toContain('复制')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // 主按钮 loading 相关测试
  it('loading 为真时主按钮带 ba-main--loading 类与 aria-busy，未 loading 时两者都没有', async () => {
    const loadingHtml = await render({ main: true, mainLoading: true })
    expect(loadingHtml).toContain('ba-main--loading')
    expect(loadingHtml).toContain('aria-busy="true"')

    const normalHtml = await render({ main: true, mainLoading: false })
    expect(normalHtml).not.toContain('ba-main--loading')
    expect(normalHtml).not.toContain('aria-busy')

    const defaultHtml = await render({ main: true })
    expect(defaultHtml).not.toContain('ba-main--loading')
    expect(defaultHtml).not.toContain('aria-busy')
  })

  it('actions 对象写法中 main.loading 同样生效', async () => {
    const html = await render({ actions: { main: { loading: true } } })
    expect(html).toContain('ba-main--loading')
    expect(html).toContain('aria-busy="true"')

    const notLoading = await render({ actions: { main: { loading: false } } })
    expect(notLoading).not.toContain('ba-main--loading')
    expect(notLoading).not.toContain('aria-busy')
  })

  it('loading 不影响 disabled 状态（data-off 不变）', async () => {
    const disabledAndLoading = await render({ main: true, mainLoading: true, disabled: { main: true } })
    expect(disabledAndLoading).toContain('data-off="true"')
    expect(disabledAndLoading).toContain('ba-main--loading')

    const enabledAndLoading = await render({ main: true, mainLoading: true, disabled: { main: false } })
    expect(enabledAndLoading).toContain('data-off="false"')
    expect(enabledAndLoading).toContain('ba-main--loading')
  })

  it('#main 具名插槽作用域暴露 loading 状态', async () => {
    const htmlOn = await render(
      { main: true, mainLoading: true },
      { main: (s) => h('span', { class: 'custom-main' }, `加载中:${String(s.loading)}`) },
    )
    expect(htmlOn).toContain('加载中:true')

    const htmlOff = await render(
      { main: true, mainLoading: false },
      { main: (s) => h('span', { class: 'custom-main' }, `加载中:${String(s.loading)}`) },
    )
    expect(htmlOff).toContain('加载中:false')
  })

  it('loading 仅添加视觉效果，不改变主按钮文案', async () => {
    const defaultText = await render({ main: true, mainLoading: true })
    expect(defaultText).toContain('生成')

    const customText = await render({ main: true, mainLoading: true, mainText: '立即处理' })
    expect(customText).toContain('立即处理')
  })
})

describe('BottomActions 自动汇报忙碌给浮窗', () => {
  /** 在带工具 id 的子树里渲染 */
  async function renderIn(id: string, props: Record<string, unknown>): Promise<void> {
    await renderToString(
      createSSRApp({
        setup() {
          provide(FLOAT_TOOL_ID, id)
          return () => h(BottomActions, props)
        },
      }),
    )
  }

  it('mainLoading 为 true 时该工具忙碌', async () => {
    setActivePinia(createPinia())
    await renderIn('ruler', { main: true, mainLoading: true })
    expect(useFloatStore().isBusy('ruler')).toBe(true)
  })
  it('actions 里 main.loading 同样算忙碌', async () => {
    setActivePinia(createPinia())
    await renderIn('dice', { actions: { main: { loading: true } } })
    expect(useFloatStore().isBusy('dice')).toBe(true)
  })
  it('没在加载就不忙碌', async () => {
    setActivePinia(createPinia())
    await renderIn('ruler', { main: true, mainLoading: false })
    expect(useFloatStore().isBusy('ruler')).toBe(false)
  })
})
