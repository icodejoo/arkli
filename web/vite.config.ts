import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { VantResolver } from '@vant/auto-import-resolver'

/** 构建基路径：WebViewAssetLoader 把 assets 映射到 https://appassets.androidplatform.net/assets/ 下 */
const BASE_PATH = '/assets/web/'

/** 构建目标：覆盖较老的 Android WebView（Chrome 80） */
const BUILD_TARGET = 'chrome80'

/** 开发服务器端口：与 App debug 包里的 DevProxyRules.PORT、package.json 的 dev:device 保持一致 */
const DEV_PORT = 5173

export default defineConfig({
  base: BASE_PATH,
  server: {
    // 热更新的 WebSocket 显式连回环地址：真机页面的域名是 appassets.androidplatform.net，
    // 按页面域名连必然失败；真机经 adb reverse 走 127.0.0.1，桌面浏览器同样适用
    hmr: { protocol: 'ws', host: '127.0.0.1', port: DEV_PORT },
  },
  // Vant 组件与样式按需自动引入，d.ts 生成到 src/components.d.ts
  plugins: [vue(), Components({ resolvers: [VantResolver()], dts: 'src/components.d.ts' })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  css: {
    preprocessorOptions: {
      // 每个 SCSS 自动注入变量，组件里可直接用 $space-* 等
      scss: { additionalData: '@use "@/styles/variables" as *;\n' },
    },
  },
  build: {
    target: BUILD_TARGET,
    cssTarget: BUILD_TARGET,
  },
})
