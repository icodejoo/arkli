// 壳层（非工具页）共用的持久缓存：主题、收藏等应用级偏好都放在 app 命名空间下。
import { createToolStorage } from './toolStorage'

/** 应用级偏好的命名空间 */
export const APP_NS = 'app'

/** 应用级持久缓存，存储键形如 `app_theme`、`app_favorites` */
export const appStorage = createToolStorage(APP_NS)
