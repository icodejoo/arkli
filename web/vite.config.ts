import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/** 构建基路径：WebViewAssetLoader 把 assets 映射到 https://appassets.androidplatform.net/assets/ 下 */
const BASE_PATH = '/assets/web/'

/** 构建目标：覆盖较老的 Android WebView（Chrome 80） */
const BUILD_TARGET = 'chrome80'

export default defineConfig({
  base: BASE_PATH,
  plugins: [vue()],
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
