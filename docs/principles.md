---
title: 项目原则
status: active
updated: 2026-10-13
summary: 体积、分层、工具归属等取舍冲突时按什么优先级办
---
## TL;DR
体积 > 加工具的速度 > 单个工具的体验上限。能放 Web 的不放原生；平台已有的硬件、系统级能力（图片编解码、视频转码）直接用原生 API，不再为它引 Rust 或 FFmpeg（见 [0003](decisions/0003-web-first-and-native-media.md)）；Rust 留给平台没有现成实现的重计算（如 AI 推理）。

## 优先级

1. **体积**：APK 越小越好。加依赖、加资源前先问"值不值这几 MB"。
2. **加工具快**：新增一个轻量工具应当只是加一个页面，不碰原生和 Rust。
3. **体验**：复杂工具允许花体积换体验，但要落在原生层，别拖累其它工具。

## 分层铁律

- Rust 只出数据，不碰 UI，不依赖安卓类型。
- 原生壳不写业务计算，只做导航、系统能力和 WebView 宿主。
- Web 页面不直接碰系统能力，一律走 bridge。
- 跨层只通过约定好的接口：Kotlin ↔ Rust 走 UniFFI 接口，Web ↔ 原生走 bridge 协议。

## 取舍记录

- 只发 arm64-v8a：老 32 位机型放弃，换来体积和构建时间。
- 大模型（OCR 等）按需下载，不进 APK。
- 一个 SPA 共享一份 Vue，不做多页面各带一份框架。
- 整个 App 固定竖屏，不做横竖适配（[0003](decisions/0003-web-first-and-native-media.md)）。
- 图片压缩统一原生做，PNG 自写缩色编码器；不引 FFmpeg，音视频走 Media3（[0003](decisions/0003-web-first-and-native-media.md)）。
