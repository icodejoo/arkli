---
title: 0002 AI 推理基座
status: active
updated: 2026-10-13
summary: 需要 AI 模型的工具统一用 sherpa-onnx 做基座，模型不干涉，只要兼容 ONNX
---
## TL;DR
推理基座固定为 sherpa-onnx；模型是可替换的资源，只要是 ONNX 就行，按需下载，不进 APK。

## 决定（用户拍板，2026-10-13）
- 所有可能用到 AI 模型的工具，推理基座选用 **sherpa-onnx**。
- 对模型本身**不做干涉**：不绑定具体模型，只要兼容 ONNX 即可接入。
- 模型文件走"按需下载"，由原生壳管理下载与校验（见 [总体架构](../design/architecture.md) 的体积策略）。

## 加速方向（用户提出，2026-10-13，细节待调研）
推理时优先用本地芯片能力（NPU 等），其次才是 CPU 上的本地模型推理。落成"加速器优先级链"：NPU provider → GPU/XNNPACK → CPU，初始化失败自动回退，CPU 路径必须永远可用。默认按"给 ONNX 推理挂 NPU provider"理解，不走厂商系统 AI 服务（碎片化、依赖 GMS/HMS）；可行性、体积、对模型的要求等由调研文档给出结论后再定。

## 影响
- 不再引入 NCNN、MNN、llama.cpp 作为推理后端，减少多套推理库带来的体积。
- 工具设计只依赖"ONNX 模型 + 前后处理"，换模型不改代码，只换模型文件和配置。
- 模型清单（名称、版本、下载地址、校验值、大小）需要一份 manifest，由原生壳读取。

## 调研结论（2026-10-13，详见 [开源库选型清单](../research/open-source-libs.md)）
- sherpa-onnx v1.13.8（2026-09-10），Apache-2.0，主要覆盖语音类：识别、合成、VAD、说话人、降噪、关键词唤醒、加标点等。**不覆盖视觉任务**（OCR、抠图、超分等）。
- 它自带一份 onnxruntime 1.28.2，arm64 的 libonnxruntime.so 约 22MB 未压缩（AAR 内 deflate 约 8MB）；视觉模型直接**复用这一份 ORT**，不再打第二份推理库。视觉的前后处理自己写（放 Rust）。
- 所以"基座 sherpa-onnx"的实际口径是：语音类走 sherpa 的 API，视觉类走同一份 ORT 的 API。
- **NPU 现阶段不做**：NNAPI 已被官方弃用；QNN 等路线要求量化、静态 shape、按 SoC 编译模型，与"任何 ONNX 模型都能换"冲突；Google Play 禁止下载 .so，按芯片动态下发在 Play 渠道行不通（只有 Play 自己的设备定位分发有官方依据）。先把 CPU（XNNPACK）路径做好，provider 链和回退接口留好，以后只试高通。
- 上述"高通/华为再分发许可"和"国内商店对 so 动态下发的规则"没查到原文，属未知。

## 待用户拍板
AI 运行时（ORT + sherpa JNI，arm64 约 27MB 未压缩）要不要进 APK：进 APK 最省事，但与"轻便"冲突；做成按需下载的"AI 运行时包"能让基础包变小，但 Play 渠道不允许下载 so，国内渠道规则也没查到。默认：先随包带，等体积基线实测后再定。
