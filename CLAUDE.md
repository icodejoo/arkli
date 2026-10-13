文档索引：docs/README.md

# Arkli 项目约定

- 一个安卓小工具聚合 App：体积小、功能多。名字取自 arca（箱子）+ kli（工具）。
- 三层架构：Compose 原生壳 / Rust 核心库 / WebView 里的 Vue SPA。分工见 docs/design/architecture.md。
- 沿用本目录现有命名：Kotlin 包 `com.let188.arkli`，Rust crate 前缀 `arkli-`，前端目录 `web/`。
- 每个方法、属性、函数、类都写简短中文注释；公共 API 要有参数、返回值、示例。
- 同一字面量出现两次以上提取常量；新函数/模块要有单测。
- 引入新第三方依赖前先问用户，待确认清单在 docs/status.md。
