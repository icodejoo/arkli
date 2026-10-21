import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createRenderer, defineComponent, h, KeepAlive, nextTick, onBeforeUnmount, onMounted, provide, ref, type Component } from 'vue'
import { useFloatStore } from '@/stores/float'
import { KEEP_ALIVE_MAX, notifyToolPageLeft, reconcileLive, useLiveTools } from './floatLive'
import { ToolStage } from './ToolStage'
import { FLOAT_TOOL_ID, useFloatBusy, useFloatPause } from './useFloatPause'

describe('reconcileLive', () => {
  it('前台工具登记进列表', () => {
    expect(reconcileLive([], { current: 'a', floatId: null, max: 3 })).toEqual(['a'])
  })
  it('已停用只留浮窗', () => {
    expect(reconcileLive(['a', 'b'], { current: null, floatId: 'a', max: 3 })).toEqual(['a'])
    expect(reconcileLive(['a', 'b'], { current: null, floatId: null, max: 3 })).toEqual([])
  })
  it('浮窗不在列表里时停用后为空', () => {
    expect(reconcileLive(['b'], { current: null, floatId: 'a', max: 3 })).toEqual([])
  })
  it('超出上限挤掉最旧的，但前台和浮窗不被挤', () => {
    expect(reconcileLive(['f', 'x', 'y'], { current: 'z', floatId: 'f', max: 3 })).toEqual(['f', 'y', 'z'])
    expect(reconcileLive(['f', 'x'], { current: 'z', floatId: 'f', max: 2 })).toEqual(['f', 'z'])
  })
  it('被替换的旧浮窗剔除，但正在前台则保留', () => {
    expect(reconcileLive(['a', 'b'], { current: 'b', floatId: 'b', max: 3, dropped: 'a' })).toEqual(['b'])
    expect(reconcileLive(['a'], { current: 'a', floatId: null, max: 3, dropped: 'a' })).toEqual(['a'])
  })
  it('保活上限常量', () => {
    expect(KEEP_ALIVE_MAX).toBe(3)
  })
})

/** 极简节点：只够 Vue 渲染器和 keep-alive 的存储容器用 */
interface N {
  type: string
  children: N[]
  parent: N | null
}
const node = (type: string): N => ({ type, children: [], parent: null })
const { createApp } = createRenderer<N, N>({
  patchProp: () => {},
  insert(el, parent, anchor) {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1)
    el.parent = parent
    const i = anchor ? parent.children.indexOf(anchor) : -1
    if (i < 0) parent.children.push(el)
    else parent.children.splice(i, 0, el)
  },
  remove(el) {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1)
    el.parent = null
  },
  createElement: (t) => node(t),
  createText: () => node('#text'),
  createComment: () => node('#comment'),
  setText: () => {},
  setElementText: () => {},
  parentNode: (n) => n.parent,
  nextSibling: (n) => (n.parent ? (n.parent.children[n.parent.children.indexOf(n) + 1] ?? null) : null),
})

/** 事件日志：`挂载:a`、`暂停:a`、`恢复:a`、`卸载:a` */
let log: string[] = []
/** 假工具忙碌开关（按工具 id） */
const busyFlag = { a: ref(false), b: ref(false) }
/** 假工具：用 useFloatPause 记暂停/恢复，用生命周期记挂载/卸载，useFloatBusy 汇报忙碌 */
const fakeTool = (id: 'a' | 'b'): Component =>
  defineComponent({
    name: `Fake-${id}`,
    setup() {
      useFloatPause({ pause: () => log.push(`暂停:${id}`), resume: () => log.push(`恢复:${id}`) })
      useFloatBusy(() => busyFlag[id].value)
      onMounted(() => log.push(`挂载:${id}`))
      onBeforeUnmount(() => log.push(`卸载:${id}`))
      return () => h('div')
    },
  })
const tools: Record<string, Component> = { a: fakeTool('a'), b: fakeTool('b') }

/** 与 ToolView 同构的页面：状态机 + 舞台 */
const ToolPage = defineComponent({
  name: 'ToolView',
  props: { id: { type: String, required: true } },
  setup(props) {
    const live = useLiveTools(() => props.id)
    return () => h(ToolStage, { ids: live.value, activeId: props.id, resolve: (id: string) => tools[id] ?? null })
  },
})
const Home = defineComponent({ name: 'HomeView', setup: () => () => h('div') })

/** 当前“路由”：null 是首页，否则是工具 id */
const route = ref<string | null>(null)

/** 本用例起的应用，用例结束统一卸载（避免共享的 route 驱动旧应用） */
const apps: Array<{ unmount: () => void }> = []

/** 起一个与 App 同构的应用（外层 keep-alive 缓存 ToolView），返回跳转函数 */
async function boot(): Promise<{ go: (id: string | null) => Promise<void> }> {
  const root = defineComponent({
    setup: () => () => h(KeepAlive, { include: ['ToolView', 'HomeView'] }, { default: () => (route.value ? h(ToolPage, { id: route.value }) : h(Home)) }),
  })
  const app = createApp(root)
  app.mount(node('root'))
  apps.push(app)
  await nextTick()
  const go = async (id: string | null): Promise<void> => {
    route.value = id
    await nextTick()
    // 模拟离开转场结束
    notifyToolPageLeft()
    await nextTick()
  }
  return { go }
}

describe('ToolView 保活状态机（真实 keep-alive）', () => {
  afterEach(() => {
    route.value = null
    apps.splice(0).forEach((a) => a.unmount())
  })
  beforeEach(() => {
    setActivePinia(createPinia())
    log = []
    route.value = 'a'
    busyFlag.a.value = false
    busyFlag.b.value = false
  })

  it('没浮起：离开即卸载', async () => {
    const { go } = await boot()
    await go(null)
    expect(log).toEqual(['挂载:a', '暂停:a', '卸载:a'])
  })

  it('浮起：离开后实例存活并暂停，点回来恢复且浮窗被取回', async () => {
    const f = useFloatStore()
    const { go } = await boot()
    f.floating = { id: 'a', name: 'A' }
    await go(null)
    expect(log).toEqual(['挂载:a', '暂停:a'])
    await go('a')
    expect(log).toEqual(['挂载:a', '暂停:a', '恢复:a'])
    expect(f.floating).toBeNull()
    await go(null)
    expect(log[log.length - 1]).toBe('卸载:a')
  })

  it('浮起期间去别的工具再回首页：浮窗实例不被误卸载，也不重复暂停', async () => {
    const f = useFloatStore()
    const { go } = await boot()
    f.floating = { id: 'a', name: 'A' }
    await go(null)
    await go('b')
    await go(null)
    expect(log).toEqual(['挂载:a', '暂停:a', '挂载:b', '暂停:b', '卸载:b'])
  })

  it('A 浮着时在 B 里浮 B：A 被销毁，B 存活', async () => {
    const f = useFloatStore()
    const { go } = await boot()
    f.floating = { id: 'a', name: 'A' }
    await go(null)
    await go('b')
    f.floating = { id: 'b', name: 'B' }
    await nextTick()
    await go(null)
    expect(log).toEqual(['挂载:a', '暂停:a', '挂载:b', '卸载:a', '暂停:b'])
  })

  it('浮窗被关闭：实例立即销毁', async () => {
    const f = useFloatStore()
    const { go } = await boot()
    f.floating = { id: 'a', name: 'A' }
    await go(null)
    f.close()
    await nextTick()
    expect(log).toEqual(['挂载:a', '暂停:a', '卸载:a'])
  })

  it('工具之间互跳再返回：非浮窗的历史实例保留到离开工具页', async () => {
    const { go } = await boot()
    await go('b')
    await go('a')
    expect(log).toEqual(['挂载:a', '暂停:a', '挂载:b', '恢复:a', '暂停:b'])
    await go(null)
    expect(log.filter((x) => x.startsWith('卸载')).sort()).toEqual(['卸载:a', '卸载:b'])
  })

  it('忙碌汇报：开始计数、结束清零、卸载时撤销', async () => {
    const f = useFloatStore()
    const { go } = await boot()
    busyFlag.a.value = true
    await nextTick()
    expect(f.isBusy('a')).toBe(true)
    busyFlag.a.value = false
    await nextTick()
    expect(f.isBusy('a')).toBe(false)
    busyFlag.a.value = true
    await nextTick()
    await go(null)
    expect(f.isBusy('a')).toBe(false)
  })
})

describe('useFloatBusy 在工具页之外', () => {
  it('没有工具 id 注入时不动 store', async () => {
    setActivePinia(createPinia())
    const f = useFloatStore()
    const Loose = defineComponent({
      setup() {
        useFloatBusy(() => true)
        return () => h('i')
      },
    })
    createApp(Loose).mount(node('root'))
    await nextTick()
    expect(f.busy).toEqual({})
  })
  it('注入 id 后立即汇报', async () => {
    setActivePinia(createPinia())
    const f = useFloatStore()
    const Child = defineComponent({
      setup() {
        useFloatBusy(() => true)
        return () => h('i')
      },
    })
    const Root = defineComponent({
      setup() {
        provide(FLOAT_TOOL_ID, 'dice')
        return () => h(Child)
      },
    })
    createApp(Root).mount(node('root'))
    await nextTick()
    expect(f.isBusy('dice')).toBe(true)
  })
})
