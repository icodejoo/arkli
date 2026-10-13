import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles/index.scss'

// 应用入口：挂载 Pinia 与路由
createApp(App).use(createPinia()).use(router).mount('#app')
