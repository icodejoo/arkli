import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
// 函数式组件（showToast 等）不会被自动引入样式，这里手动补
import 'vant/es/toast/style'
import 'vant/es/dialog/style'
import 'vant/es/image-preview/style'
import './styles/index.scss'
import { installBackBridge, patchVantPopup } from './shared/backStack'

installBackBridge()
patchVantPopup()

// 应用入口：挂载 Pinia 与路由
createApp(App).use(createPinia()).use(router).mount('#app')
