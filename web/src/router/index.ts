import { createRouter, createWebHashHistory } from 'vue-router'

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
      name: 'tool',
      component: () => import('@/views/ToolView.vue'),
      props: true,
    },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
