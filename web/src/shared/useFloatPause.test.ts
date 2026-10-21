import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { useFloatPause } from './useFloatPause'

describe('useFloatPause', () => {
  it('首次挂载与卸载都不会触发 pause / resume（只在停用与激活时触发，配对见 floatLive.test）', async () => {
    const calls: string[] = []
    const C = defineComponent({
      setup() {
        useFloatPause({ pause: () => calls.push('pause'), resume: () => calls.push('resume') })
        return () => h('i')
      },
    })
    await renderToString(createSSRApp(C))
    expect(calls).toEqual([])
  })
})
