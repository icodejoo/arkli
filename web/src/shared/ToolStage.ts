import { defineComponent, Fragment, h, KeepAlive, type Component, type PropType } from 'vue'
import { ToolHost } from './ToolHost'

/**
 * 工具舞台：每个保活的工具各占一个独立的 keep-alive，只有前台那个渲染内容，其余（如被浮起的）停用但实例保留；
 * ids 里去掉某个 id，对应实例随之卸载（触发 onBeforeUnmount 清理）。
 *
 * 属性：ids 保活的工具 id；activeId 前台工具 id；resolve 按 id 取工具组件。
 */
export const ToolStage = defineComponent({
  name: 'ToolStage',
  props: {
    ids: { type: Array as PropType<readonly string[]>, required: true },
    activeId: { type: String, default: '' },
    resolve: { type: Function as PropType<(id: string) => Component | null>, required: true },
  },
  setup(props) {
    return () =>
      h(
        Fragment,
        props.ids.map((id) =>
          h(KeepAlive, { key: id }, { default: () => (id === props.activeId ? h(ToolHost, { id, component: props.resolve(id), key: id }) : null) }),
        ),
      )
  },
})
