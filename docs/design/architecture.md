---
title: 总体架构
status: active
updated: 2026-10-13
summary: 三层职责、工具归属规则、目录结构、体积策略、构建流水线
---
## TL;DR
- 壳在最外层，里面一个 WebView 跑 Vue SPA，旁边挂 Rust 核心库。
- 判断一个工具放哪：要系统权限、硬件、重计算 → 原生；纯界面加轻量计算 → Web；重计算的"算"字部分一律下沉到 Rust。
- 体积靠四招：只发 arm64、Rust 激进瘦身、模型按需下载、SPA 路由懒加载。

## 分层

```
┌──────────────────────────────────────────────┐
│ app/  原生壳 (Kotlin + Compose)               │
│  ├─ 导航、设置、系统级/复杂工具               │
│  ├─ WebView 宿主 (WebViewAssetLoader)         │
│  └─ ArkliBridge：Web 消息的唯一入口           │
│        │                  │                   │
│        ▼                  ▼                   │
│   web/ Vue SPA      core/ Rust 核心库         │
│  (轻量小工具)       (OCR/图像/编解码…)        │
│        │                  ▲                   │
│        └── bridge 消息 ───┘ (经原生转发)      │
└──────────────────────────────────────────────┘
```

| 层 | 职责 | 不做 |
|---|---|---|
| app | 导航、系统能力、WebView 宿主、bridge 路由、模型下载管理 | 业务计算 |
| core | 重计算、本地模型推理，只出数据 | UI、安卓类型依赖 |
| web | 轻量工具的界面与交互，统一主题 | 直接碰系统能力、直连 Rust |

## 工具归属规则

按顺序判断，命中即定：

1. 要悬浮窗、无障碍、前台服务、相机取景等系统/硬件能力 → **原生**。
2. 要 GPU 或大块内存的重处理，页面做会卡 → **原生视图 + Rust**。
3. 纯输入→计算→输出，计算量小 → **Web**，计算在 JS 里直接做。
4. 计算量中等或需要 Rust 现成逻辑 → **Web 界面 + bridge 调 Rust**。
5. 拿不准 → 先放 Web，卡了再迁原生。

## 目录结构

```
arkli/
├── app/                      原生壳
│   └── src/main/kotlin/com/let188/arkli/
│       └── bridge/           bridge 协议的原生侧实现
├── core/                     Rust workspace
│   └── crates/arkli-core/    核心计算库（无第三方依赖的纯逻辑）
├── web/                      Vue SPA
│   └── src/
│       ├── native/           与原生通信的统一封装
│       └── tools/            每个小工具一个目录（待建）
└── docs/
```

后续会再加 `core/crates/arkli-ffi/`（UniFFI 绑定层），原因是绑定层依赖第三方库，要和纯逻辑 crate 分开，方便单测。

## 体积策略

1. **只发 arm64-v8a**：Rust 和 native 库只编一个 ABI。
2. **Rust 瘦身**：release 开 `opt-level = "s"`、LTO、`strip`、`panic = "abort"`、`codegen-units = 1`，已写进 `core/Cargo.toml`。
3. **模型按需下载**：OCR 模型（约 10MB 量级，待实测）首次使用时下载，APK 里不带；下载与校验由原生壳负责。
4. **SPA 懒加载**：每个工具单独成 chunk，进到哪个工具才加载。
5. **资源克制**：字体只带必要字形，图片优先矢量。
6. **R8 全量**：开混淆和资源压缩，去掉未使用的 Compose/AppCompat 组件。

## 构建流水线（目标形态）

1. `core/`：`cargo ndk` 交叉编译出 arm64 `.so`，拷进 `app/src/main/jniLibs/arm64-v8a/`。
2. `web/`：Vite 打包，产物拷进 `app/src/main/assets/web/`。
3. `app/`：Gradle 打 APK，WebView 通过 `https://appassets.androidplatform.net/` 域名加载 assets，不用 `file://`。

上述两个产物目录都在 `.gitignore` 里，由构建脚本生成。

## 风险与应对

| 风险 | 应对 |
|---|---|
| 三套技术栈维护成本 | 严守分层铁律，bridge 协议统一，降低跨层沟通 |
| WebView 兼容差异 | 小工具页面保守使用 JS/CSS 特性，真机多测几款 ROM |
| WebView 崩溃导致整个工具箱白屏 | 原生侧处理渲染进程崩溃回调，自动重建 |
| 返回键与前端路由打架 | 原生拦截返回键，先问 SPA 能不能后退，再决定退出 |
| 热更新合规 | 暂不做；要做前先看目标商店对下发代码的规定 |
