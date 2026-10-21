import { createRouter, createWebHashHistory } from 'vue-router'

/** 工具首页子路由 name */
export const TOOL_HOME_ROUTE = 'tool'

/** 工具设置子路由 name */
export const TOOL_SETTING_ROUTE = 'tool-setting'

/** 工具首页 / 设置页占位组件：不渲染任何东西，真正的内容在 ToolView 的两个舞台里 */
const ToolHomePlaceholder = { render: () => null }

/** 路由表：四个根 tab（首页、AI、收藏、设置）、AI 应用二级页与工具页；视图均懒加载 */
export const router = createRouter({
  // hash 模式不需要服务端回退，适合 assets 静态加载
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
    { path: '/ai', name: 'ai', component: () => import('@/views/AiView.vue') },
    { path: '/ai/apps', name: 'ai-apps', component: () => import('@/views/AiAppsView.vue') },
    { path: '/favorites', name: 'favorites', component: () => import('@/views/FavoritesView.vue') },
    {
      path: '/tool/:id',
      component: () => import('@/views/ToolView.vue'),
      props: true,
      children: [
        // 空 path 是工具首页：内容由 ToolView 的工具舞台（keep-alive）渲染，这里只占位
        { path: '', name: TOOL_HOME_ROUTE, component: ToolHomePlaceholder },
        // 工具设置页：同样由 ToolView 的设置舞台（keep-alive）渲染，这里只占位
        { path: 'setting', name: TOOL_SETTING_ROUTE, component: ToolHomePlaceholder },
      ],
    },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
