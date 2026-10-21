import { defineComponent, h, provide, type PropType, type Component } from 'vue'
import { FLOAT_TOOL_ID } from './useFloatPause'

/**
 * 工具宿主：给工具子树注入自己的工具 id（BottomActions 自动汇报忙碌用），并渲染工具组件。
 * 它是 keep-alive 的直接子节点，所以名字固定、可被缓存。
 *
 * 属性：id 工具 id；component 工具组件，为空渲染空内容。
 */
export const ToolHost = defineComponent({
  name: 'ToolHost',
  props: {
    id: { type: String, required: true },
    component: { type: [Object, Function] as PropType<Component | null>, default: null },
  },
  setup(props) {
    provide(FLOAT_TOOL_ID, props.id)
    return () => (props.component ? h(props.component) : null)
  },
})
