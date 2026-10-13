---
title: 命名与技术选型调研
status: active
updated: 2026-10-13
summary: 四种技术路线对比，以及 Vade/Vadex/Vabox/Arkli 四个候选名的查重结论
---
## TL;DR
- 技术路线：原生 Compose 壳 + Rust 核心 + WebView 里的 Vue SPA，兼顾体积、扩展速度和系统能力。
- 名字：Arkli 最干净，只有 arkli.com 被占；Vade 有商标冲突，Vadex、Vabox 域名和联想上有瑕疵。
- 体积数字全部来自零散博客，量级可信，精确值要自己实测。

## 一、「一个木函」
- 功能：番茄钟、尺子、二维码、OCR、AI 识图、切图、表情包制作等，一篇横评称 100 多个工具、无广告。
- 体积：该横评称约 21MB。另有 2020 年第三方下载站记录的旧版约 4.24MB，仅供参考。
- 开发方：上海花筏科技。大概率闭源。
- 技术栈：没查到可靠信息，想确认可以反编译 APK 看有无 `libflutter.so` 等。

## 二、四种路线对比（量级，待实测）

| | 原生 Compose | Flutter | Rust+原生 | Rust+Flutter |
|---|---|---|---|---|
| 体积 | 最小，Compose 约增 1MB | 引擎固定成本，空项目常见 10MB 以上 | 原生基础上加几百 KB 到数 MB | Flutter 基线再加 Rust |
| 系统 API | 最顺手 | 要写 plugin 或原生代码 | 同原生 | 同 Flutter，多一层桥 |
| 开发效率 | 中 | 高 | 中偏低 | 中，构建链最复杂 |

加上 WebView：轻量小工具放 Web，体积增量几乎只是页面本身；系统级功能仍走原生。OCR 无论选哪条路线都应放原生/Rust 侧，模型按需下载。

## 三、候选名查重

| 候选 | 评级 | 主要问题 |
|---|---|---|
| Vade | 偏高 | VADE 在软件类（第 42 类）有有效商标，所有人疑似 Vade Secure |
| Vadex | 中偏低 | .com、.app 被占，GitHub 用户名被占，-dex 容易联想到去中心化交易所 |
| Vabox | 中偏低 | .com 被老域名占，GitHub 用户名被空号占，VBox/-box 泛滥 |
| **Arkli** | **低** | 仅 arkli.com 被占；GitHub 个人号 `arkli` 被闲置号占；.app/.dev/.io 看起来空着 |

Arkli 查到的情况：

- 域名：arkli.com 2024-12 注册、首页是占位页；.app/.dev/.io/.cn 与 getarkli.com 解析为 NXDOMAIN，大概率未注册（.app/.dev/.io 的 RDAP 没拿到有效结果）。
- 包仓库：npm、crates.io、pub.dev 的 `arkli` 全部 404。
- 应用商店：Google Play、App Store 没有同名 App。
- 商标：公开搜索没看到 ARKLI，**官方库没能直接查**，需自查。
- 含义：近似土耳其地名 Araklı，立陶宛语 arkl- 词根与"马"有关；英语读 "ark-lee"，中性。阿拉伯语、印地语没查。

## 四、没查到、需要实测的
- 各方案精确启动耗时。
- Rust `.so` 在 Android 上的实际增量。
- 空 Flutter 和空 Compose 工程的 arm64 release 体积。
- ARKLI 的商标记录。
