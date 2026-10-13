import { createRouter, createWebHashHistory } from 'vue-router'

/** 路由表：首页与工具页；视图均懒加载 */
export const router = createRouter({
  // hash 模式不需要服务端回退，适合 assets 静态加载
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
    {
      path: '/tool/:id',
      name: 'tool',
      component: () => import('@/views/ToolView.vue'),
      props: true,
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
