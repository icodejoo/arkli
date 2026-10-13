/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  /** 单文件组件的默认导出 */
  const component: DefineComponent<object, object, unknown>
  export default component
}
