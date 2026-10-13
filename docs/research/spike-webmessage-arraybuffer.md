---
title: Spike 报告：WebMessageListener 与 ArrayBuffer 通道
status: draft
updated: 2026-10-13
summary: 在真机上验证 WebMessageListener 作为 bridge 通道的可行性、二进制吞吐、来源限制与兜底方案
---
## TL;DR
- **有条件 GO**：`WebMessageListener` 做 JSON 通道、限来源、异步处理器、取消、重载与崩溃恢复，在真机上全部通过；**但 ArrayBuffer 在这台机器上不可用**（`WEB_MESSAGE_ARRAY_BUFFER = false`，WebView 为华为 Chromium 114），不能把它当协议前提。
- **最大的坑**：不支持时页面若发 `ArrayBuffer`，WebView 在原生回调里抛异常，**整个 App 进程直接崩**（try/catch 接不住）。必须以原生探测结果为准，并在文档起点脚本里再挡一层（已验证有效）。
- 兜底可用：latin1 字符串帧约 **21 MB/s**，base64 JSON 流水线约 **14 MB/s**（串行等回包只有 4 到 7 MB/s）；下行用 PathHandler + fetch 约 **90 MB/s**。
- 来源限制有效，"旧方案注入所有 frame"得到证实（跨源 frame 的调用真的到了原生）。
- **大对象推荐**：几 MB 以内走分块（latin1 或 base64，能用 ArrayBuffer 时优先）；几十 MB 以上（视频、大图）走**回环 HTTP**（约 90 MB/s，页面进程内存基本不涨，但要加 INTERNET 和一条回环明文放行），或者干脆不上传、用 `pick` 返回的不透明句柄让原生直接读。分块路径的进程内存随文件大小近似线性放大（整块发约 6 到 10 倍），所以"整块一次发"不要作为方案。

## 一、设备与 WebView
| 项 | 值 |
|---|---|
| 设备 | 华为 STG-AL00，Android 12，arm64，8GB 内存 |
| WebView 包 | `com.huawei.webview` 114.0.5.302（versionCode 21705），UA 为 Chromium 114.0.5735.196 |
| 多进程 | `dumpsys webviewupdate` 显示 `Multiprocess enabled: true`，实际存在 `webview_zygote` 与 `sandboxed_process0`，渲染在独立进程 |
| 备选 WebView | 机器上装了 Chrome 154，但被判 `Invalid package ... Incorrect signature`，不能当 WebView 提供者，所以这台机器没法靠更新 WebView 解决 |

`WebViewFeature.isFeatureSupported`：

| 特性 | 结果 |
|---|---|
| `WEB_MESSAGE_LISTENER` | true |
| `WEB_MESSAGE_ARRAY_BUFFER` | **false** |
| `DOCUMENT_START_SCRIPT` | true |
| `POST_WEB_MESSAGE` | true |
| `WEB_MESSAGE_PORT_POST_MESSAGE` | true |

结论：监听器可用，二进制不可用。ArrayBuffer 需要的 WebView 版本没有在官方文档里核实，只能说 114 不够；华为 WebView 靠自家渠道更新，国内机型大概率有一批停在老版本（推测）。

## 二、基础往返
做法：`addWebMessageListener(webView, "ArkliNative", setOf("https://appassets.androidplatform.net"), listener)`，页面 `postMessage(JSON字符串)`，原生用 `replyProxy.postMessage(String)` 回，页面 `onmessage` 收。同一页面里同时挂旧通道 `ArkliLegacy`（生产的 `ArkliBridge`，`@JavascriptInterface` + `evaluateJavascript`），交替各跑 3 轮、每轮 100 次 `native.ping`（先预热 20 次），次数是任务指定的 100 次。

测试期间手机在被另一个 spike 占用一个核（负载约 11），数字偏高、有噪声，已按多轮取看。

| 通道 | 均值 ms（三轮） | P50 ms | P95 ms | 最大 ms |
|---|---|---|---|---|
| WebMessageListener（协程版） | 1.31 / 1.72 / 1.42 | 1.2 到 1.3 | 2.5 到 3.9 | 3.2 到 4.1 |
| `@JavascriptInterface` + evaluateJavascript | 0.77 / 1.02 / 0.86 | 0.7 到 0.9 | 1.4 到 2.1 | 2.8 到 3.6 |

结论：`native.ping` 往返可用。新通道慢约 0.5ms（多一次协程调度与主线程回传），对工具类调用没有意义，不构成选型依据。

## 三、页面到原生二进制上传
### 3.1 ArrayBuffer 本身（本机不可用）
- 页面发 `ArrayBuffer`：**App 进程崩溃**。logcat：`IllegalStateException: Expected String, but type is ArrayBuffer`，出在 androidx 适配层调用 `getData()` 时，发生在我的 listener 之前，接着 `jni_android.cc(289) Please include Java exception stack` abort。try/catch 无法拦截。
- 发 `Uint8Array`、`Blob`、数字、对象：页面侧抛 `TypeError`，不崩。只有 `ArrayBuffer` 会崩。
- **防崩措施已验证**：用 `addDocumentStartJavaScript` 注入脚本包一层 `ArkliNative.postMessage`，非字符串直接 `throw TypeError`，同样发 ArrayBuffer，页面只收到 `binary not supported`，App 存活。脚本见第八节。
- 因此 `WEB_MESSAGE_ARRAY_BUFFER` 为 true 的设备上的 ArrayBuffer 吞吐、一次发整块的上限，**这台机器无法测**，需要换支持的设备补测（未解决问题 1）。

### 3.2 替代做法：latin1 字符串帧（不依赖 ArrayBuffer）
纯文本消息，格式 `\x01 + 帧头8字符(handle4 + seq4，大端，每字符一字节) + 载荷(每字符一字节)`。原生按 `ISO_8859_1` 取字节，帧序、落盘逻辑与方案里的二进制帧完全一致，所以将来换回 ArrayBuffer 只改编码层。

每块 1MB，3 次取中位数，原生侧对落盘文件、页面侧对原数据做 sha256，**5 个尺寸全部字节一致，`badSeq` 全为 0（不丢块不乱序）**：

| 文件 | 端到端耗时 ms | 吞吐 MB/s | 其中页面编码+发送 ms | 发完后等原生写完 ms | 帧数 |
|---|---|---|---|---|---|
| 64KB | 9 | 6.9（小文件被固定开销主导） | 3 | 5 | 1 |
| 1MB | 73 | 13.6 | 39 | 33 | 1 |
| 5MB | 241 | 20.8 | 207 | 29 | 5 |
| 20MB | 924 | 21.7 | 895 | 32 | 20 |
| 50MB | 2372 | 21.1 | 2330 | 37 | 50 |

- 瓶颈在页面侧拼字符串，发完后原生只剩约 30ms 收尾，说明原生写盘跟得上。
- 原生侧内存（采样 RSS 峰值相对基线）：增量不到 20MB；Java 堆峰值 10 到 66MB（5MB 那轮 GC 没及时回收）。页面 JS 堆前后不变（外部缓冲不计入，渲染进程总量见第九节）。

### 3.3 不分块一次发整块（latin1 字符串）
| 大小 | 耗时 ms | 吞吐 MB/s | 结果 |
|---|---|---|---|
| 1MB | 139 | 7.2 | 一致 |
| 5MB | 568 | 8.8 | 一致 |
| 20MB | 2363 | 8.5 | 一致 |
| 50MB | 3995 | 12.5 | 一致 |
| 75MB | 8207 | 9.1 | 一致 |
| 100MB | - | - | **渲染进程崩溃**（`didCrash=true`，App 靠重建恢复） |

上限在 75MB 到 100MB 之间，但崩的原因多半是页面内存而不是通道限制（页面要同时拿着源数据、拼好的字符串）。整块比分块慢（8 到 12 对 21 MB/s），内存也更差（见第九节），所以不建议。

## 四、原生到页面下行
1MB 与 5MB，各 3 次取中位数，页面收到后校验内容，时间含页面侧解码：

| 方式 | 1MB ms | 1MB MB/s | 5MB ms | 5MB MB/s |
|---|---|---|---|---|
| `postMessage(ByteArray)` | 不可用 | - | 不可用 | - |
| JSON 里 base64 | 177 | 5.7 | 666 | 7.5 |
| latin1 字符串帧 | 48 | 20.8 | 199 | 25.1 |
| PathHandler 暴露缓存文件 + `fetch().arrayBuffer()` | 12 | 82 | 54 | 92 |

- `replyProxy.postMessage(ByteArray)` 在本机抛 `UnsupportedOperationException`（"not supported by the current version of the framework and the current WebView APK"），能被 try/catch 接住，不崩。
- **下行优先走文件**：原生先写缓存，页面 fetch，比任何消息通道快 4 倍以上；协议文档本来就是这个思路，这里用数字证实。fetch 的时间不含原生写文件的时间（写文件另算）。

## 五、来源限制
页面里建 5 种 iframe 加 Worker，frame 内检查两个对象是否存在，并尝试调用：

| frame 类型 | 来源 | `ArkliNative`（新） | `ArkliLegacy`（旧） |
|---|---|---|---|
| 主页面 | appassets | 有 | 有 |
| `srcdoc` | 继承父页面来源 | **有** | 有 |
| `sandbox="allow-scripts"` 的 srcdoc | 不透明来源 | 无 | **有** |
| `data:` URL | 不透明来源 | 无 | **有** |
| 跨源 `https://evil.example`（拦截后用 assets 响应） | 另一个站点 | **无** | **有**，调用也到了原生 |
| `about:blank`（初始空文档） | - | 无 | 无 |
| Web Worker | - | 无 | 无 |

- 旧方案证实：`addJavascriptInterface` 注入所有 frame，跨源和沙箱 frame 里的脚本能直接调到原生（logcat 里 4 次 `LEGACY native.ping invoked`，对应 srcdoc、sandbox、data、跨源）。
- 新方案有效：只有来源匹配的 frame 才有 `ArkliNative`；监听回调还会带 `sourceOrigin` 与 `isMainFrame`（日志里 srcdoc frame 的消息是 `main=false`），可以在原生侧再做一层判断。
- **要注意**：`srcdoc` frame 继承父页面来源，**也拿得到 `ArkliNative`**。基础设施文档"JS 解释器必须跑 Worker，不能放 iframe"的结论更有依据了：Worker 里两个对象都没有。如果以后必须用 iframe 跑不可信代码，要用 sandbox 且不带 `allow-same-origin`。
- 空白 `about:blank` 初始文档没有注入，属于预期，但页面脚本之后写入的内容拿不到。

## 六、base64 JSON 兜底（192KB 一块）
假设不支持 ArrayBuffer，JSON 里放 base64。3 次取中位数，sha256 一致：

| 文件 | 流水线（不等回包） | 串行（每块等回包） |
|---|---|---|
| 5MB | 351ms，14.2 MB/s | 691ms，7.2 MB/s |
| 20MB | 1378ms，14.5 MB/s | 5071ms，3.9 MB/s（4.5 到 5.5 秒波动） |

- 流水线明显好，建议按窗口发（如同时 8 块在途）。串行每块要等一次往返，大文件很慢。
- latin1 字符串帧比 base64 快约 45%，且无 33% 体积膨胀；缺点是它不是标准做法，要自己写帧编码，所以只算"本机已验证的可选项"。

### 退化探测逻辑
```ts
// 握手时原生返回特性，页面据此选通道；不要在页面里"试一下 ArrayBuffer"，试错会崩进程
const { features } = await call('native.hello')   // v2 新增，返回 { binary: boolean, session: number }
const mode = features.binary ? 'arraybuffer' : 'chunked-text'
```
原生侧：`binary = WebViewFeature.isFeatureSupported(WEB_MESSAGE_ARRAY_BUFFER)`；`false` 时同时注入第八节的防崩脚本。

## 七、生命周期
| 场景 | 结果 |
|---|---|
| 原生 `webView.reload()` | listener 仍有效，会话号不变，ping 正常 |
| SPA 导航（`location.hash`） | 通道正常 |
| 渲染进程崩溃（`loadUrl("chrome://crash")` 实测可触发 `onRenderProcessGone(didCrash=true)`） | 宿主销毁并重建 WebView，**先 `addWebMessageListener` 再 `loadUrl`**，新页面会话号为 2，ping 正常 |
| 晚注册（页面先加载，1.5 秒后才 `addWebMessageListener`） | 已加载的文档里对象**不出现**，重载后才出现 |

"必须在页面加载前注册"的满足方式：创建 WebView 的函数里顺序固定为"设置 client、`addWebMessageListener`、`addJavascriptInterface`、最后 `loadUrl`"，销毁重建时整段重走。渲染进程崩溃时 `AsyncBridge.close()` 取消在途协程，新 WebView 建新的 `AsyncBridge`（会话号加一），旧会话的回包不会串到新页面。

## 八、与 v2 协议的衔接
### 8.1 异步处理器骨架
spike 里已跑通（`SpikeAsyncBridge.kt`）：`SuspendBridgeHandler`、`CallContext(session, requestId, io)`、`AsyncBridge`（id 到 Job 的表、`native.task.cancel`、`close()`）。验证：
- `native.ping`、`native.file.openWrite/closeWrite` 走通，`closeWrite` 切到写盘线程，排在已投递的帧之后，所以不会在最后一块落盘前返回。
- 取消：页面起一个 `spike.sleep 5000`，200ms 后 `native.task.cancel`，原生返回 `{cancelled:true}`，原请求在 212ms 内以 `CANCELLED` 结束。
- 回传时 `replyProxy` 可能指向已销毁页面，`safeSend` 吞掉异常。
- 协程不用显式声明依赖：Compose 的 activity 库已传递带入 `kotlinx-coroutines-android`，编译通过；若要显式声明，体积增量需另测。

### 8.2 对现有 `ArkliBridge.kt` 的改造建议
不改生产代码，只给方向：
1. `BridgeHandler.handle` 改为 `suspend fun handle(ctx: CallContext, params: JSONObject): Any?`；`ArkliBridge` 持有 `CoroutineScope(SupervisorJob() + Dispatchers.Default)`，`postMessage` 改为 `dispatch(json, io)`，立即返回。
2. 去掉 `@JavascriptInterface`，通道换成 `WebMessageListener`，回包抽象成 `ReplyIo { sendJson; sendBinary }`，这样测试里可以塞假实现，也方便将来回退到旧通道。
3. `JS_DISPATCH` 全局函数和主线程 `evaluateJavascript` 回传一并删掉；`web/src/native/bridge.ts` 改成 `ArkliNative.onmessage` 收。
4. 请求 id 与 Job 登记，`native.task.cancel` 内置处理；WebView 重建时 `close()`。
5. 握手 `native.hello` 返回 `{ session, binary }`，页面据此选上传方式。
6. 防崩脚本（仅 `binary=false` 时安装）：
```kotlin
// 文档起点脚本：不支持二进制时把非字符串消息挡在页面侧，避免旧 WebView 在原生回调里抛异常导致进程崩溃
private const val GUARD_SCRIPT = "(function(){var o=window.ArkliNative;if(!o)return;var p=o.postMessage;" +
    "o.postMessage=function(m){if(typeof m!=='string')throw new TypeError('binary not supported');return p.call(o,m)}})();"
WebViewCompat.addDocumentStartJavaScript(webView, GUARD_SCRIPT, setOf(ALLOWED_ORIGIN))
```
7. 监听回调里按 `sourceOrigin` 与 `isMainFrame` 再校验一次；敏感方法（读写文件、权限）只接受主 frame。

## 九、内存与拷贝
### 9.1 问题
`WebMessageListener` 能不能引用传递、避免大对象占多份内存。

### 9.2 能不能引用传递：本机无法实测
- ArrayBuffer 路径在这台机器上不可用（会崩），没法直接数"拷贝了几份"。
- 渲染进程与 App 进程是两个进程（见第一节），消息要跨进程送达，数据至少会被复制进 IPC 缓冲；这是进程模型决定的，**不是 API 能改的**（推测，未在支持 ArrayBuffer 的设备上验证）。
- 所以问题要换个问法：同一份 50MB，不同发法下两个进程各涨多少。下面用 latin1 字符串帧实测（它比 ArrayBuffer 更费内存，因为字符串在 Java 侧是 UTF-16，ArrayBuffer 路径的数字只会更好，量级仍要补测）。

### 9.3 实测
同一份 50MB 与 20MB pattern 数据，页面用 `blob.slice(start,end).arrayBuffer()` 逐块读（"分块"）对比先 `blob.arrayBuffer()` 读成整块再发（"整块"）。宿主脚本每次冷启动 App，空闲 3 秒取基线，上传期间连续采样，结束后读 `/proc/<pid>/status` 的 VmHWM。渲染进程用"启动前后新增的 `sandboxed_process` PID"锁定（第一次采样误取了别的 App 的渲染进程，已更正）。单位 MB：

| 场景 | 渲染进程 HWM（基线 86） | 增量 | App 进程 HWM（基线约 165） | 增量 |
|---|---|---|---|---|
| 50MB 分块（1MB 一块） | 146 | **+60** | 248 | +84 |
| 50MB 整块 | 555 | **+469** | 559 | **+395** |
| 20MB 分块 | 130 | +44 | 219 | +55 |
| 20MB 整块 | 298 | +212 | 282 | +113 |

- **整块：峰值随文件大小线性放大**，渲染进程约 9 到 10 倍，App 进程约 6 到 8 倍（内存里同时有 Blob 数据、ArrayBuffer、拼好的字符串、IPC 缓冲，原生侧还有 UTF-16 的 Java String 加字节数组）。
- **分块：峰值基本是常数加源数据本身**。渲染进程 +44/+60 里大头是测试自己持有的 50MB Blob；App 进程 +55/+84 有轻微随大小增长，是 1MB 块的垃圾回收滞后，不是文件整体被持有（采样器看到 Java 堆峰值 27MB 不变）。
- 所以"到底拷贝几份"的粗略答案：整块路径渲染进程侧至少 5 到 10 份，原生侧 6 到 8 份；分块把它压回常数。**结论：不管通道是否支持 ArrayBuffer，大文件都要分块，别指望引用传递。**

### 9.4 回环 HTTP 上传原型（`SpikeLoopbackServer.kt`）
App 内只绑 `127.0.0.1` 的 `ServerSocket`（约 100 行），一次性 token 放 `x-token` 请求头，支持 OPTIONS 预检（带 `Access-Control-Allow-Private-Network`），POST 体流式落盘，同时核对内容。页面 `fetch(POST, body=Blob)`。

| 大小 | 页面端到端 ms | 吞吐 MB/s | 原生接收耗时 ms | 内容校验 |
|---|---|---|---|---|
| 20MB | 237 | 84.5 | 222 | 一致 |
| 50MB（第 1 次） | 551 | 90.8 | 518 | 一致 |
| 50MB（第 2 次） | 570 | 87.8 | 518 | 一致 |

内存（RSS，MB）：渲染进程 86 到 90，**上传期间基本不涨**（Blob 流式送出）；App 进程 50MB 一次 97 到 153、一次 205 到 207，增量最多约 50，基线本身波动大（97 到 205），这里没看出整文件被持有。比 latin1 分块快约 4 倍，内存还更省。

三个环境条件，**Android 12 上不能直接工作**，要改清单：

| 项 | 实测结果 | 怎么处理 |
|---|---|---|
| `INTERNET` 权限 | 没有时 `ServerSocket` 创建直接 `EPERM`（`socket failed: EPERM`），连监听都起不来 | 已计划加 INTERNET，可直接依赖；没有就不能用 |
| 明文 HTTP | 有 INTERNET 仍被拦：`net::ERR_CLEARTEXT_NOT_PERMITTED`（-29） | `networkSecurityConfig`：base 禁明文，`domain-config` 只对 `127.0.0.1` 放行（spike 的 `res/xml/spike_network_security_config.xml`，已验证后通过） |
| 混合内容 | `MIXED_CONTENT_NEVER_ALLOW` **没有**拦 https 页面请求 `http://127.0.0.1` | 不需要改（127.0.0.1 按"可信来源"处理） |
| CORS | 需要预检（自定义头）；服务端回 `Access-Control-Allow-Origin: https://appassets.androidplatform.net`、`Allow-Headers: x-token`、`Allow-Private-Network` 后通过 | 服务端处理 |
| CSP | **未测**（页面当前没有 CSP） | 方案 B 的 CSP 要给 `connect-src` 加 `http://127.0.0.1:*`（端口随机），落地前再实测 |

风险与注意：
- 回环端口同机其他 App 也能连，所以 token 必须一次性、随机、校验后立即作废（原型已做）；生产版还要限制单次大小、并发、超时、只接受固定路径。
- 这个口子要写进隐私/安全说明，并且和"页面出站只开白名单"的 CSP 一起设计，别让回环变成新的任意出站口。
- 回环服务的生命周期要跟 WebView 会话绑定，渲染进程崩溃重建时要重发 token。

### 9.5 `shouldInterceptRequest` 读不到 POST body
页面 `fetch('/post-probe', {method:'POST', body: 1MB Blob})`，原生在 `shouldInterceptRequest` 里记录：只能拿到 `method=POST`、`Origin`、`Referer`、`Accept`、`User-Agent`，**没有 `Content-Length`，也没有读 body 的 API**（`WebResourceRequest` 只有 url、method、requestHeaders 等）。所以"靠拦截器接收上传"这条路不通，只能走回环 HTTP 或消息通道。

## 十、改了哪些文件（spike 代码清单，均未提交）
| 文件 | 说明 |
|---|---|
| `app/src/main/kotlin/com/let188/arkli/spike/SpikeActivity.kt` | spike 宿主：新旧通道并存、渲染进程崩溃重建、晚注册开关、guard 开关、拦截器探针、假跨源域 |
| `app/src/main/kotlin/com/let188/arkli/spike/SpikeAsyncBridge.kt` | 异步 Bridge 骨架：挂起处理器、调用上下文、取消、会话 |
| `app/src/main/kotlin/com/let188/arkli/spike/SpikeHandlers.kt` | 文件存储（帧序校验、sha256）、内存采样器、全部测试用处理器 |
| `app/src/main/kotlin/com/let188/arkli/spike/SpikeLoopbackServer.kt` | 回环 HTTP 上传原型 |
| `app/src/main/assets/spike/spike.html`、`spike.js`、`frame.html` | 页面端测试，用 URL 参数选测试（`t=probe,latency,up,oneshot,down,frames,b64,life,cancel,abprobe,upblob,loop,postprobe`） |
| `app/src/main/res/xml/spike_network_security_config.xml` | 只放行 127.0.0.1 明文的 NSC，**目前没有被清单引用** |
| `app/src/main/AndroidManifest.xml` | 只多一个 `.spike.SpikeActivity` 声明（`exported=true`，便于 adb 启动，正式前应去掉） |

说明：验证回环时曾在清单里临时加 `INTERNET` 与 `networkSecurityConfig`，**验证完已撤掉**，生产清单没有联网权限；复测回环需把这两处加回去。启动方式：`adb shell am start -n com.let188.arkli/.spike.SpikeActivity --es q "t=latency"`，额外开关 `--ez late true`、`--ez guard true`；结果看 `adb logcat -s ArkliSpike`。`web/` 没有改动（页面是独立静态文件，避免每次走 `pnpm build:app`）。

## 十一、未解决问题
1. **ArrayBuffer 的实际吞吐、一次发整块的上限、引用或拷贝的份数**：本机 WebView 114 不支持，需要在支持 `WEB_MESSAGE_ARRAY_BUFFER` 的设备或 WebView 上补测（最好再挑一台国内机型，看支持比例）。
2. 国内机型 WebView 版本分布没有数据，决定了兜底路径是常态还是例外；建议上线后埋点 `native.hello` 的 `binary`。
3. 回环 HTTP 的 CSP 写法、与方案 B 白名单的叠加、生产级限流，没有测。
4. 回环服务能否被同机其他 App 利用，只在设计上用一次性 token 缓解，没有做攻击实测。
5. 防崩脚本只验证了"页面主动发 ArrayBuffer"一种情况，没有覆盖所有绕过方式（比如在脚本注入前就缓存了原始 `postMessage` 引用），页面代码都是自家的，目前可接受。
6. 并行 spike 占用手机 CPU，延迟与吞吐的绝对值偏保守，相对关系可信。
7. latin1 字符串帧是我自己试的，不属于任何标准做法；如果采用，要补单测和对超大块的内存保护。
