# Arkli

一个安卓小工具聚合 App，目标是安装包小、工具多、加新工具快。

## 三层结构

| 层 | 目录 | 负责什么 |
|---|---|---|
| 原生壳 | `app/` | Kotlin + Compose：导航、系统级与复杂工具、WebView 宿主 |
| 核心库 | `core/` | Rust：OCR、图像、编解码等重计算，只出数据不碰 UI |
| 小工具 | `web/` | Vue SPA：纯渲染的轻量工具，打包进 assets |

详细设计见 [docs/README.md](docs/README.md)。

## 当前状态

骨架阶段：文档和最小源码桩已就位，构建配置（Gradle、Vite）等第三方依赖确认后再补，见 [docs/status.md](docs/status.md)。
