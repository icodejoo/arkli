---
title: 0003 Web 优先、固定竖屏、图片与音视频走原生
status: active
updated: 2026-10-13
summary: 能在页面里做的就留在 web；App 固定竖屏；图片压缩统一原生做（不用 Rust、不用 FFmpeg）；音视频走 Media3 与平台 API
---
## TL;DR
- **Web 优先**：页面 JS 加浏览器 API 能做好的，只在 web 里做，不走 bridge，也不进 Rust。
- **固定竖屏**：整个 App 锁 portrait，不做横竖切换。
- **图片压缩统一由原生（Kotlin）做**，不用 Rust、不用 FFmpeg；PNG 压缩自写缩色编码器。
- **音视频**：不引 FFmpeg，走 Media3 Transformer 与平台 `MediaExtractor/Muxer`（新增依赖，落地前单独确认）。

## 背景
最初的原则是"能放 Web 的不放原生，重计算的算字部分一律下沉 Rust"（见 [项目原则](../principles.md)、[总体架构](../design/architecture.md)）。落地中发现两点：多数小工具的计算在 JS 里就够用；图片编解码、视频转码这类事，安卓平台已有硬件或系统级实现，再引一套 Rust 或 FFmpeg 只是为同一件事付两次体积。

## 决定与理由

### 1. Web 优先
纯输入、计算、输出的工具，以及 Canvas、Web Crypto、传感器事件、`Intl` 能完成的，全部放 web。已按此落地 25 个工具。原生只负责系统权限、文件选择与保存、前台服务、联网白名单、相机取景这类 web 做不了的事。

### 2. 固定竖屏
`MainActivity` 锁 `portrait`，页面不再做横竖适配。**这会推翻**三份工具设计里的"横屏"需求：`device-files.md`（时间屏幕、尺子支持横竖屏、可选横屏锁定）、`life-fun.md`（手持弹幕横屏）、`text-calc.md`（横竖屏切换时重算字号）。这些条目作废，以本文为准。
- 手持弹幕、时间屏幕固定竖屏后体验受限，是否在页面内旋转 90° 模拟横屏，**待用户定**。
- 备注（推测，未查证）：Android 16 起 target 36 的应用在大屏上可能忽略方向锁定；当前 targetSdk 35，不受影响，升级时再核实。

### 3. 图片压缩统一原生做
流程：原生选图（`native.file.pick`）→ 原生压缩（`native.image.compress`）→ 结果写进缓存 → 页面经 `/files/` 路径回显 → 保存走 `native.file.save`。
- **推翻**了此前"Rust 侧只读写 PNG、Canvas 管中小图压缩、重计算一律下沉 Rust"的说法。压缩与格式转换合并成一个工具，输出格式（JPEG/WebP/PNG）是参数。
- JPEG/WebP 用平台 `Bitmap.compress`；解码用 `ImageDecoder`/`BitmapFactory`，EXIF 用 `ExifInterface`。
- **PNG 自写**：中位切分缩色加索引色 PNG 编码器，IDAT 用 `Deflater` level 9 加逐行自适应滤波。不引现成库，理由：libimagequant/pngquant 是 GPL-3 或商业双协议；oxipng 是 Rust；Zopfli 上游已归档且无可用安卓绑定；LodePNG 要新增 C 构建链。效果不够再升级到 LodePNG（zlib 协议）。
- 拼接、九宫格是排版操作，仍用 web Canvas。桌面浏览器里压缩保留 Canvas 兜底，便于开发调试。

### 4. 不引 FFmpeg
`ffmpeg-kit` 已归档，替代品多为个人 fork，有供应链风险；自编精简 LGPL FFmpeg 要动态链接并长期维护构建。视频压缩、裁剪、提取音频走 [Media3 Transformer](../design/tools/media-ai.md)（Apache-2.0，底层调系统硬件编解码）与平台 `MediaExtractor/Muxer`。局限：没有内置 MP3 编码器，MKV/AVI 封装、复杂滤镜、视频转 GIF 不擅长。出现这类 P0 需求时再评估自编 FFmpeg。

## 影响与待办
- 平台已有的硬件编解码和系统图片能力，优先用原生 API，不再为图片、音视频引入 Rust 或 FFmpeg。
- 新增 Media3 依赖前要用户确认（见 [工具落地总览](../design/tools-overview.md) 的依赖清单）。
- 开源协议还没选：GPL 类依赖会牵连整个 App 的授权，选协议要早于引入这类依赖。
