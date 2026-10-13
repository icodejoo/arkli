---
title: 当前状态与待办
status: active
updated: 2026-10-13
summary: 项目做到哪一步、下一步做什么、哪些依赖等用户确认
---
## TL;DR
- 骨架已跑通：Gradle、Vite、Rust 三个工程都建好，"页面 → bridge → Rust"在真机上通了，空壳 release APK 约 1.16MB。
- 下一步：复审 6 份工具设计，定公共基础设施（含 bridge 的异步处理与页面→原生的二进制上传），再按优先级落地工具。
- 名字已定 Arkli；商标和域名还要用户自己去查（见调研文档）。

## 已完成
- 三层架构、工具归属规则、bridge 协议定稿。
- 目录骨架：`app/`、`core/`、`web/` 各有最小源码桩。
- Rust 核心库桩可独立 `cargo test`。

## 已确认（2026-10-13，用户拍板）

| 事项 | 结论 |
|---|---|
| 前端 | Vue 3 + Vite + vue-router + Pinia + SCSS，TypeScript，SPA 路由懒加载 |
| Kotlin 调 Rust | UniFFI |
| WebView 通道 | **升级为 `WebMessageListener`**（2026-10-13 确认，取代 `@JavascriptInterface`）；落地前先做 ArrayBuffer 的真机 spike |
| INTERNET 权限 | **加**（2026-10-13 确认）；出站采用折中方案：联网以原生为主，页面只对 CSP 白名单里支持 CORS 的接口（汇率）直接请求 |
| 安卓 ABI / minSdk | 只发 arm64-v8a；minSdk 24 |
| 包名 | `com.let188.arkli`（由域名 arkli.let188.com 反写） |
| 原生 UI / Rust 交叉编译 | Compose、cargo-ndk（沿用推荐，用户未反对） |

## 本机环境（已查证）
Node 24、JDK 21、`ANDROID_HOME=E:\sdk\android`（platforms 35/36、build-tools 36.0.0、NDK 28.2.13676358）、Gradle 8.11.1 到 9.3.1 的分发包已缓存、Rust 的 Android 各 target 已装。缺 cargo-ndk，需要安装。

## 已跑通（2026-10-13，真机 STG-AL00 / Android 12 / 高通 SM6225 实测）
"页面 → bridge → Rust"整条链路通了：`native.ping` 与 `rust.core.version` 都成功，R8 混淆后的 release 包上 JNA 与 UniFFI 正常，返回键行为符合预期（工具页 → 首页 → 退出）。

**体积基线（空壳 release，arm64）**：APK 1,220,629 字节（约 1.16 MB）。classes.dex 1.2MB、libarkli_ffi.so 337KB、libjnidispatch.so 176KB、resources.arsc 54KB、assets 约 105KB。debug 包 8.1MB，不作参考。这是还没带 sherpa-onnx/ORT 时的数字，AI 运行时约再加 10MB（压缩后）。

版本：Gradle 8.11.1、AGP 8.10.1、Kotlin 2.1.21、Compose BOM 2025.05.01、compileSdk/targetSdk 35、webkit 1.13.0、JNA 5.17.0。这套是"稳定且互相兼容"的组合，不是最新，没查过有无更新。

## 遗留项
- 没有给 `app/` 写单测，需补（bridge 分发、未知方法、异常转换）。
- 渲染进程崩溃重建没触发过，未验证。
- R8 的 keep 规则偏宽（JNA 与 uniffi 整包），classes.dex 1.2MB 里有多少是它造成的没拆开看，后续可收窄。
- Compose 等版本偏旧，升级前要重跑真机验证。
- web 侧没有测试框架，vitest 等用户确认。
- 工具设计见 `docs/design/tools/`（6 份并行产出中），完成后要统一复审、汇总新增依赖和公共基础设施需求。

## 待办（按顺序）
1. 复审 6 份工具设计，汇总依赖与公共基础设施清单，请用户逐项确认。
2. 实现公共基础设施（选文件、保存、分享、剪贴板、权限、模型下载管理）。
3. 按优先级 P0 → P2 逐个落地工具。
4. AI 运行时是否随包：等体积基线评估后定。

## 用户自己要核实
- ARKLI 商标检索（USPTO / WIPO / 中国商标网，第 9、42、35 类）。
- 注册 arkli.app / arkli.dev，GitHub 用 `arkli-app` 之类变体。
- 国内安卓应用市场同名检索。
