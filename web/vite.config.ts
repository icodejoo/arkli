import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { VantResolver } from '@vant/auto-import-resolver'
import Icons from 'unplugin-icons/vite'
import IconsResolver from 'unplugin-icons/resolver'
import { FileSystemIconLoader } from 'unplugin-icons/loaders'

/** 自定义图标集名：src/assets/icons/*.svg 用 <i-arkli-文件名 /> 引用 */
const ICON_COLLECTION = 'arkli'

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
  // Vant 组件与样式按需自动引入，d.ts 生成到 src/components.d.ts；
  // Iconify 图标编译期内联为组件（离线可用），自定义 SVG 放 src/assets/icons
  plugins: [
    vue(),
    Components({
      resolvers: [VantResolver(), IconsResolver({ customCollections: [ICON_COLLECTION] })],
      dts: 'src/components.d.ts',
    }),
    Icons({
      compiler: 'vue3',
      customCollections: {
        [ICON_COLLECTION]: FileSystemIconLoader('./src/assets/icons'),
      },
    }),
  ],
  // 单测里渲染含 van-* 的组件时，让 vite 处理 vant 的样式导入
  test: { server: { deps: { inline: [/vant/] } } },
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
