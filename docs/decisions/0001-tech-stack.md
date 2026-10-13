---
title: 0001 技术栈与分层
status: active
updated: 2026-10-13
summary: 为什么选 Compose 壳 + Rust 核心 + WebView 里的 Vue SPA
---
## TL;DR
原生 Compose 做壳和复杂工具，Rust 做重计算，WebView 里一个 Vue SPA 承载轻量小工具。目标是体积小、功能多、加工具快。

## 背景
想做类似「一个木函」的小工具聚合 App：安装包要小，工具要多，后续能快速扩充。对比过原生、Flutter、Rust+原生、Rust+Flutter，以及加上 WebView+wasm 的方案，详见 [调研](../research/naming-and-stack.md)。

## 决定

- 原生壳：Kotlin + Compose。系统级工具（悬浮窗、无障碍、通知、相机）和复杂工具放这里。
- 核心库：Rust，通过 UniFFI 给 Kotlin 提供数据；OCR 等本地模型推理也在这里。
- 小工具层：WebView 加载 assets 里的 Vue 3 SPA，路由懒加载，一份框架多个工具。
- 通信：Web 页面经 bridge 调原生，原生再调 Rust，不让页面直连 Rust。

## 为什么不选 Flutter
Flutter 的引擎是一次性固定成本（arm64 约 10MB 以上，待实测），工具越多越被摊薄，其实也能接受。没选它，是因为系统级功能要写大量原生插件，而 WebView 方案对轻量小工具的体积更友好。如果后续一个人维护三套技术栈撑不住，Flutter 是退路。

## 代价
- 技术栈有三套：Kotlin、Rust、Web。
- bridge 是关键枢纽，协议要克制、要统一封装。
- WebView 在老设备和魔改 ROM 上有兼容差异，小工具页面要保守用语法。

## 细节拍板（2026-10-13）
前端用 Vue 3 + Vite + vue-router + Pinia + SCSS；Kotlin 调 Rust 用 UniFFI；WebView 通道已定升级为 `WebMessageListener`（骨架里暂时还是 `@JavascriptInterface`，见 [基础设施草案](../design/platform-infrastructure.md)）；加 INTERNET 权限；只发 arm64-v8a，minSdk 24；包名 `com.let188.arkli`。见 [当前状态](../status.md)。
