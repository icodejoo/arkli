---
title: Bridge 协议
status: active
updated: 2026-10-13
summary: 小工具页与原生/Rust 之间的消息格式、方法命名、错误码、大数据与安全约定
---
## TL;DR
- 一问一答的异步 JSON 消息，靠 `id` 配对；原生主动推送用事件。
- 方法名 `域.模块.动作`，域只有 `native`（原生能力）和 `rust`（核心库）。
- 大数据（图片、音频）不进 JSON，只传文件路径，实际文件放 App 缓存目录。
- 协议与传输通道解耦：通道可以是 `@JavascriptInterface`，也可以换 WebMessageListener。

## 请求

```json
{ "v": 1, "id": "7f3a", "method": "rust.ocr.recognize", "params": { "path": "cache/in-001.png" } }
```

| 字段 | 说明 |
|---|---|
| `v` | 协议版本，目前为 1；不兼容变更时递增 |
| `id` | 请求编号，由页面生成，响应原样带回 |
| `method` | `域.模块.动作`，如 `native.clipboard.write` |
| `params` | 对象，由具体方法定义 |

## 响应

成功：

```json
{ "v": 1, "id": "7f3a", "ok": true, "data": { "text": "..." } }
```

失败：

```json
{ "v": 1, "id": "7f3a", "ok": false, "error": { "code": "PERMISSION_DENIED", "message": "需要相机权限" } }
```

## 事件（原生 → 页面）

```json
{ "v": 1, "event": "download.progress", "data": { "name": "ocr-model", "percent": 42 } }
```

页面通过统一的 `on(event, handler)` 订阅，离开页面时取消订阅。

## 错误码

| code | 含义 |
|---|---|
| `UNKNOWN_METHOD` | 方法不存在 |
| `BAD_PARAMS` | 参数缺失或类型不对 |
| `PERMISSION_DENIED` | 用户拒绝了所需权限 |
| `NOT_READY` | 依赖未就绪，如模型还没下载 |
| `INTERNAL` | 原生或 Rust 内部错误，message 里给简述 |
| `TIMEOUT` | 超时 |

## 大数据

- 页面把文件交给原生保存，或原生把结果写到缓存目录，双方只传相对路径。
- 页面读取原生产出的文件，走 WebViewAssetLoader 的 PathHandler 暴露的只读路径，不用 `file://`。
- 单次 JSON 消息体积建议不超过 256KB，超过就改走文件。

## 安全

- WebView 只加载应用自己的 assets 域，禁用 `file://` 与任意外链。
- 敏感方法（读写文件、剪贴板、权限相关）原生侧再做一次校验，不信任页面传来的路径，路径一律归一化后限制在缓存目录内。
- 方法白名单：原生侧注册表里有才可调用，没有就返回 `UNKNOWN_METHOD`。

## 内置方法

| 方法 | params | 成功时的 data |
|---|---|---|
| `native.ping` | 无 | `{ "pong": true, "ts": 1760000000000 }`，`ts` 为原生侧毫秒时间戳 |
| `rust.core.version` | 无 | `{ "version": "0.1.0" }`，取自 Rust 核心库 |

## 页面侧用法示例

```ts
import { call } from '@/native/bridge'

// 调用 Rust 核心库做 OCR，参数为缓存目录里的图片相对路径
const { text } = await call('rust.ocr.recognize', { path: 'cache/in-001.png' })
```

## 原生侧注册示例

```kotlin
// 注册一个处理器，方法名与页面调用一致
bridge.register("native.clipboard.write", ClipboardWriteHandler())
```
