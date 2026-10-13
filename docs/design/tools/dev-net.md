---
title: 开发者、编码与网络类工具落地设计
status: draft
updated: 2026-10-13
summary: 「开发者、编码与网络」分类全部工具的落地方案：层归属、所用库、权限与优先级
---
## TL;DR
- 清单 17 项全部覆盖，合并后实际做 13 个页面：P0 4 项、P1 8 项、P2 4 项，建议不做 1 项（网速测试）；「短链生成」只留还原，生成砍掉。
- 13 个纯计算工具全在 Web 层，零原生、零 Rust；哈希、加密优先用 WebCrypto，只有 MD5 这类 WebCrypto 没有的才引 @noble/hashes。4 个联网工具共用一个原生 `native.net.*` 模块（HttpURLConnection + Socket，0 依赖）。**本类不需要 Rust。**
- 体积：JS chunk 合计约 50KB gzip（MD5、bowser 两项是实测，其余是推测）；原生网络模块 dex 推测 20–40KB。Linux 指令手册另带数据，全量约 0.6MB，精简版约 0.15MB。
- 要拍板的两件事：一是**加不加 INTERNET 权限**（IP 查询、Whois、网址探查都靠它）；二是加了以后，WebView 必须在原生侧拦掉所有外站请求，否则页面能绕过 bridge 直接 `fetch` 外网。

## 总览

可信度一栏是我对清单条目的判断：「真实」指多来源确认；「iOS 有」指只在 App Store 版本历史里出现，名字很具体，iOS 版大概率有，安卓版没法确认；「疑并入」指可能只是某个大工具里的子功能。

| # | 清单名称 | 可信度 | 落到哪个页面 | 层 | 首选方案 | 体积增量（gzip） | 优先级 |
|---|---|---|---|---|---|---|---|
| 1 | 网速测试 | 真实 | — | 原生 | 没有可靠免费的测速服务端 | — | 建议不做 |
| 2 | 短链生成与还原 | 真实 | 网址探查 | 原生+Web | 只做还原：手动跟随跳转，记录每一跳 | 合入 #3 | P1（只做还原） |
| 3 | 网页源码获取 | 存疑（旧文单来源） | 网址探查 | 原生+Web | `native.net.http` GET，页面只显示纯文本 | ~3KB + 原生模块 | P1 |
| 4 | IP 查询（全球） | 真实 | IP 查询 | 原生+Web | IPinfo Lite，备用 RDAP | ~2KB | P1 |
| 5 | HTTP 状态码查询 | iOS 有 | HTTP 状态码 | Web | 自写中文数据表，约 70 条 | ~4KB（推测） | P1 |
| 6 | UA 解析器 | iOS 有 | UA 解析 | Web | bowser 2.14.1 | 7.9KB（实测）+1KB | P2 |
| 7 | Whois 查询 | iOS 有 | Whois | 原生+Web | 先查 RDAP，查不到再走 43 端口 | ~2KB | P2 |
| 8 | CIDR 计算器 | iOS 有 | CIDR 计算器 | Web | 自写，约 200 行 | ~3KB（推测） | P1 |
| 9 | JavaScript 解释器 | iOS 有 | JS 运行器 | Web | 在 Web Worker 里跑 WebView 自带的 V8 | ~2KB（推测） | P1 |
| 10 | 颜色转换 | iOS 有 | 颜色工具 | Web | 自写 `shared/color.ts`，和图片类共用 | ~5KB（推测） | P0 |
| 11 | 颜色助手 | iOS 有，名字含糊 | 颜色工具 | Web | 在颜色工具里加对比度和配色 | ~1.5KB（推测） | P1 |
| 12 | 密码生成器 | iOS 有 | 密码生成器 | Web | `crypto.getRandomValues` + 拒绝采样 | ~2KB（推测） | P0 |
| 13 | Linux 指令手册 | iOS 有 | Linux 命令 | Web | linux-command 数据，构建时预渲染成 HTML | 索引 17.7KB（实测）+ 数据 | P2 |
| 14 | Base64 编码转换 | 疑并入「文字处理」 | 编解码 | Web | 内置 btoa/atob + TextEncoder | ~3KB（推测） | P0 |
| 15 | RC4 加解密 | 疑并入 | 加解密 | Web | 自写 RC4，约 30 行 | ~2KB（推测） | P2 |
| 16 | MD5 摘要 | 疑并入 | 哈希 | Web | @noble/hashes（md5 + sha2，支持流式） | 5.2KB（实测） | P0 |
| 17 | 摩斯电码 | 疑并入 | 编解码 | Web | 自写码表 + WebAudio 发声 | ~1KB（推测） | P1 |

体积口径：「实测」是我在草稿目录用 esbuild 0.25 `--bundle --minify` 打包后 `gzip -9` 量出来的，只量库本身，页面代码没算进去。md5 单独打包 2.0KB，md5+sha256+sha512 是 5.2KB，bowser 是 7.9KB。其余数字是按代码行数推的。

## 共用部件

### 1. 输入输出面板 `web/src/shared/components/ToolIO.vue`
编解码、哈希、加解密、UA、CIDR 这 5 个页面都用它。
- 上面是输入区：多行文本，带粘贴、清空、「从文件读」三个按钮（文件走 `native.file.pick`）。中间一条选项栏，放各工具自己的插槽。下面是只读输出区，带复制、分享、另存为。
- 输入变了就实时算，防抖 150ms。出错时输出区换成一行红字，不弹窗。
- 输出不超过 256KB 时直接显示；超过就写进缓存文件，页面只显示前 4KB 加一个「保存完整结果」按钮，免得撑爆 DOM 和 bridge 消息。

### 2. 字节与编码工具 `web/src/shared/codec/bytes.ts`
文本和字节互转（编码只支持 UTF-8，解码可选 UTF-8、GBK、UTF-16LE，用 `TextDecoder`）、hex、Base64（标准、URL 安全、去填充），约 100 行，零依赖。图片类的「图片转 Base64」、计算类的「进制转换」也用它，别各写一份。

### 3. 颜色模型 `web/src/shared/color.ts`
图片类设计稿（image.md）已经说了要和「颜色转换」共用，放在 `tools/image/_shared/color.ts`。我建议上提到 `web/src/shared/color.ts`，因为它跨两个分类。颜色工具在这个基础上再加 OKLCH、WCAG 对比度、配色。

### 4. IP 地址工具 `web/src/shared/ip.ts`
解析和格式化 IPv4、IPv6（压缩写法 `::`），掩码和前缀长度互转，判断私网、回环、保留段。CIDR 计算器和 IP 查询都用。IPv6 运算用 `BigInt`（要求 Chrome 67 以上的 WebView，见风险）。

### 5. 联网封装：原生 `NetClient` + 页面 `web/src/shared/net.ts`
4 个联网工具全走这一套，不在各页面里各自调 bridge。

**原生侧**（`app/.../net/`，Kotlin，约 500 行，不引 OkHttp）
- 用 `HttpURLConnection` 加协程 `Dispatchers.IO`。最多同时 4 个请求（Semaphore 限流）。
- 超时：连接 5s，读取 10s，总时长默认 15s，上限 30s。超时回 `TIMEOUT`。
- 体积上限：默认最多读 2MB，超了就截断并标 `truncated`；不超过 200KB 的直接放进响应，更大的写进缓存文件、只回路径。
- 跳转：一律关掉自动跟随，自己手动跟，最多 10 跳，每一跳记下 URL、状态码和 `Location`。短链还原就靠这个。
- 字符集：先看 `Content-Type`，没写就扫前 4KB 里的 `<meta charset>`，还没有就当 UTF-8。原始字节一并保留，页面可以手动换编码。
- 不存 Cookie，不带任何本地凭据。UA 默认是 `Arkli/版本 (Android)`，页面可以改成「手机浏览器」「桌面浏览器」两种预设。
- 取消：每个请求带一个页面生成的 `tag`；`native.net.cancel {tag}` 会断开连接并让原请求回 `CANCELLED`。页面在组件卸载时自动对所有在途请求调一次。

**Bridge 方法（本类自有，`native.net.*`）**

| 方法 | params | data |
|---|---|---|
| `native.net.http` | `{ tag, url, method: "GET"\|"HEAD", headers?, ua?, follow: bool, timeoutMs?, maxBytes? }` | `{ status, headers, hops:[{url,status,location}], finalUrl, charset, bodyText?, bodyPath?, truncated, ms:{ttfb,total} }` |
| `native.net.resolve` | `{ tag, host }` | `{ addresses: ["1.2.3.4","2001:db8::1"], ms }`，走系统 DNS（InetAddress） |
| `native.net.whois` | `{ tag, query, server? }` | `{ chain:[{server,text}] }`：43 端口原始 TCP，从 `whois.iana.org` 开始，按 `refer:` 往下跟，最多 3 跳，每跳最多 64KB |
| `native.net.cancel` | `{ tag }` | `{}` |

- 只接受 `http`、`https` 两种 scheme（43 端口那条除外）。URL 原生侧再解析校验一遍。目标是局域网或回环地址也允许（开发者本来就会测内网），但页面上要标出来。
- 错误码：现有表里没有网络类错误，需要协议补上 `NETWORK`（DNS 失败、连不上、TLS 出错，`message` 里写具体原因）和 `CANCELLED`，见「对公共基础设施的需求」。

**页面侧** `net.ts`：把上面几个方法包成支持 `AbortSignal` 的 Promise，统一把错误翻成中文提示（如「连接超时，可能是网络受限或对方不可达」）。另外有一个 `useNetConsent()`：每个联网工具第一次用时说明「会访问哪个服务、发出去什么」，用户同意一次就记住。

## 逐工具方案

### 编解码（Base64 编码转换 + 摩斯电码）｜P0｜S
- **Base64**：用 `ToolIO`。选项有方向、变体（标准 / URL 安全 / 去填充）、MIME 每 76 字符换行、解码后的字符集。纯文本走 `bytes.ts`；遇到 `data:xxx;base64,` 前缀自动剥掉。文件转 Base64：`native.file.pick` 拿到缓存路径，页面用 `fetch` 读只读路径，再用 `ToolIO` 的大输出规则处理；Base64 转文件则把解码后的字节写进缓存，交给 `native.file.save`。文件上限暂定 20MB。
- 顺带做 URL 编码、Hex、`\uXXXX` 转义、HTML 实体：每种十来行，共用同一个页面和选项栏，没必要单独成工具。
- **摩斯电码**（P1）：自写 ITU 码表，含字母、数字、常用标点，约 60 行。分隔符可设（字符之间用空格，单词之间用 `/`）。可以用 WebAudio 的 OscillatorNode 播放，WPM 可调。中文要靠「中文电码」四位码表（约 7000 条），太重，不做，遇到中文就提示不支持。闪光灯、震动播报要原生权限，砍掉。
- Bridge：无。公共：`native.file.pick`、`native.file.save`、`native.clipboard.write`、`native.share`。
- 风险与测试：用 emoji、生僻字、GBK 中文做往返测试；Base64 末尾填充缺失时要宽容解码；大文件时观察 WebView 的内存。

### 哈希（MD5 摘要）｜P0｜M
- 一次算出 MD5、SHA-1、SHA-256、SHA-512，可切大小写，可粘贴期望值比对（一致标绿）。另有 HMAC 模式（填密钥）。
- 库：@noble/hashes 2.4.0（MIT）。`legacy.js` 里有 md5、sha1，`sha2.js` 里有 sha256、sha512，`hmac.js` 做 HMAC；都按子路径导入，tree-shake 后实测 md5+sha256+sha512 是 5.2KB gzip。为什么 SHA 也不用 WebCrypto：`crypto.subtle.digest` 只能一次吃下整个文件，不能分块；noble 支持增量 `update`，大文件可以边读边算，内存恒定。
- 文件哈希：`native.file.pick` 拿缓存路径 → `fetch(只读URL).body` 按流读 → 逐块 `update`，进度按已读字节数显示。JS 算 MD5 在手机上的速度没测，推测每秒几十 MB；500MB 以上给个耗时提示。真慢的话再加 `rust.dev.hashFile`（RustCrypto `md-5`/`sha2`），现在先不做。
- Bridge：无。公共：`native.file.pick`（大文件最好不复制，见公共需求）。
- 测试：用 RFC 1321 / FIPS 180 的标准向量；空字符串；1GB 文件看内存曲线。

### 加解密（RC4 加解密）｜P2｜S
- 自写 RC4（KSA+PRGA，约 30 行），没找到合适的现成库：@noble/ciphers 2.4.0 的文件列表里没有 RC4（已查证，只有 aes、chacha、salsa、ff1 等），crypto-js 疑似停更。
- 兼容性是这个工具真正的门槛。国内在线工具大多是 CryptoJS 的「口令模式」：先用 `Salted__` 加 8 字节盐，再用 EVP_BytesToKey（基于 MD5）派生出密钥，跟「直接拿密钥」是两回事。所以给两个模式：「原始密钥」（文本或 hex）和「CryptoJS 兼容」（口令），后者复用哈希页的 noble md5，增量约 30 行。输出可选 Base64 或 hex。
- 页面顶部固定写一句「RC4 已不安全，只用于对接旧系统」。
- 可选扩展：顺手加 AES-CBC/GCM（WebCrypto，零体积），CryptoJS 的 AES 口令模式在国内其实比 RC4 常用得多。要不要做见未决问题。
- Bridge：无。测试：拿 RFC 6229 的向量，再和 CryptoJS 的输出逐字节对拍。

### 密码生成器｜P0｜S
- 选项：长度 4–128、字符集（大写 / 小写 / 数字 / 符号）、排除易混字符（`0O1lI`）、每类至少一个、批量 1–20 个。显示熵值（bit）和强弱等级。
- 用 `crypto.getRandomValues` 加拒绝采样，避免取模带来的偏差，约 120 行。随机部分和趣味类的 `shared/random.ts` 合并，那边的抽签、骰子也该用无偏采样。
- 口令短语（diceware）要带词表，EFF 英文词表 7776 词，体积约几十 KB（推测），先不做。
- 不保存历史。复制时让原生把剪贴板内容标成敏感（Android 13+ 系统剪贴板预览会打码），见公共需求。
- Bridge：无。公共：`native.clipboard.write`（带 `sensitive`）。测试：生成 10 万个，跑卡方检验看分布；确认「每类至少一个」时也没有偏差。

### 颜色工具（颜色转换 P0 + 颜色助手 P1）｜M
- **转换**（P0）：输入框能认 HEX（3/4/6/8 位）、`rgb()`、`hsl()`、`hwb()`、CSS 颜色名（148 个）、安卓 `0xAARRGGBB` 和 ARGB 整数。同时输出 HEX、RGB、HSL、HSV、CMYK（简单公式，不做 ICC，页面上注明）、OKLCH、安卓写法。每一行都能单独复制。
- 选色器：自己用 Canvas 画 HSV 面板加色相条，约 100 行。没用 `<input type=color>`，因为安卓 WebView 对它的支持各 ROM 不一致（推测）。屏幕或图片取色归图片类的「取色器」。
- **助手**（P1）：WCAG 2.x 对比度，可选对比白、黑或任意色，给出 AA/AAA 结论；配色给出互补、类似、三角、明暗阶梯，每个色块都能点、能复制。清单上「颜色助手」到底做什么没人说清，就按开发者最常用的这两项来，并进同一页面，不单独成工具。
- 库：自写。转换公式（含 OKLab）都是公开的，几十行就够；culori 4.0.2（MIT，1.1MB unpacked）功能多但没必要。
- Bridge：无。测试：拿 CSS Color 4 规范里的示例值对拍；HSL 和 HEX 来回转不能有累积误差。

### CIDR 计算器｜P1｜S
- 输入 `192.168.1.0/24`、`IP + 掩码`，或 IPv6 前缀。输出网络地址、广播地址、首末可用地址、主机数、掩码、反掩码、二进制对照，并标出私网 / 保留段。/31、/32 和 IPv6 按 RFC 3021 和 RFC 4291 的约定单独处理。
- 子网拆分（把 /24 拆成 4 个 /26）列出来就行，约 40 行；合并网段不做。
- 自写，基于 `shared/ip.ts`，约 200 行。Bridge：无。测试：边界前缀 /0、/31、/32、/127、/128，以及 `::ffff:1.2.3.4` 这种映射写法。

### HTTP 状态码查询｜P1｜S
- 自写数据表：1xx–5xx 常用码，加上 WebDAV 码和几个常见的非标准码（Nginx 499、Cloudflare 52x），约 70 条。每条有中文名、一句话含义、常见原因和排查方向。支持按码号或关键词搜。
- 释义我们自己写，不搬 MDN 原文（MDN 是 CC BY-SA，搬过来要沿用同一许可）。依据 RFC 9110。
- 和网址探查联动：探查结果里的状态码可以点，跳到这里的对应条目。Bridge：无。

### JS 运行器（JavaScript 解释器）｜P1｜M
- 不引解释器，直接用 WebView 自带的 V8。代码在专门的 Web Worker 里跑（Vite `new Worker(new URL(...))`，单独一个 worker 文件）。主线程把代码发过去，worker 用 async 包装后执行，所以支持顶层 `await`。`console.log/warn/error` 被劫持，用 postMessage 回传，输出最多 1000 行。
- 超时默认 3s，可调到 30s，到点直接 `worker.terminate()`，死循环卡不住页面。最近一次的代码存在本地。
- **为什么必须用 Worker、不能用 iframe**：`@JavascriptInterface` 注入的对象在 WebView 的每个 frame 里都能拿到，包括 iframe（安卓官方文档的说法，这次没重新抓原文）。用户贴进来的代码要是跑在 iframe 里，就能直接调 bridge。Worker 里没有注入对象（推测，要真机验证）。
- 如果 SPA 以后加了 CSP，要给这个 worker 留 `unsafe-eval`。
- Bridge：无。测试：写死循环、无限分配内存（看渲染进程崩了能不能自动恢复）、在 worker 里探 `window`/bridge 对象确认拿不到。

### UA 解析｜P2｜S
- bowser 2.14.1（MIT，2026-02 发布）。打开时默认填入当前 WebView 自己的 UA，输出浏览器、引擎、系统、设备类型。
- **别用 ua-parser-js**：它 2.x 开始改成 AGPL-3.0-or-later（已查证 npm 2.0.10）；还留在 MIT 的 1.x 线已经不怎么更新了。
- 局限要在页面上写明：Chrome 做了 UA 精简，安卓 UA 里固定写 `Android 10; K`，所以系统版本和机型解析不出来真值。
- Bridge：无。为什么 P2：开发者偶尔用，而且是引了库的工具里最可有可无的一个。

### Linux 命令（Linux 指令手册）｜P2｜M
- 数据：jaywcjlove/linux-command（MIT，npm 1.22.0，37k star，2026-09 还有推送）。包里有 615 篇中文 Markdown，原文 3.0MB，`tar+gzip -9` 后 617KB；另有一份索引 `dist/data.json`，67KB，gzip 后 17.7KB（均为实测）。
- 构建时用 marked 把 md 预渲染成 HTML 片段，放进 `assets/web/data/linux-command/`，页面按需 `fetch`。运行时不带 Markdown 解析器，marked 只是 devDependency；如果文本类以后真要在运行时带 marked，就共用那一份。
- 页面：搜索（命令名加简介）、分类、详情。详情 HTML 是我们构建时自己生成的，渲染前仍然过一遍白名单标签过滤，不信任上游内容。
- 备选数据源 tldr-pages：CC BY 4.0，中文包 689KB，例子多但说明短，要署名。选 linux-command 是因为它就是中文、MIT 许可、条目全。
- 体积：全量放进 APK 约 0.6MB（APK 会再压一次，推测略小）；只挑常用的约 150 条，约 0.15MB。选哪种见未决问题。Bridge：无。

### 网址探查（网页源码获取 + 短链还原）｜P1｜M
- 一个页面两个用途。输入网址后调 `native.net.http`（`follow:true`），结果分三个标签：**跳转链**（每一跳的状态码和地址，最后落到哪里，这就是短链还原）、**响应头**、**源码**。
- 源码只用 `textContent` 放进 `<pre>`，长了就做虚拟滚动，支持页内搜索、换编码、复制、保存。**绝不用 `v-html` 渲染抓回来的 HTML**：那会让外站内容进到装着 bridge 的 WebView 里。
- 短链还原：先发 HEAD，有些短链服务不支持 HEAD，就退回 GET，`maxBytes` 设成 64KB，拿到目标地址就停。用 JS 或 `<meta refresh>` 跳转的短链跟不过去，只能把 meta refresh 解析出来当最后一跳，并说明这一点。
- **短链生成砍掉**：要依赖第三方短链服务（如 is.gd；它有 API，但条款没读全），用户生成的链接内容我们管不了，国内很多平台还会屏蔽这些域名。性价比太低。
- 权限：INTERNET。隐私：请求从用户手机直接发到目标站，不经过我们的服务器。失败时显示错误类型，并提示「可能是网络受限」。
- 风险：Android 9+ 默认禁止明文 HTTP，`http://` 开头的短链和老网站会失败，要不要全局放开见未决问题。Android 7.0（API 24）缺部分新根证书（比如 Let's Encrypt 的 ISRG Root X1 是 7.1.1 才内置的，推测），需要在 network security config 里补根证书，要在 API 24 真机上测。

### IP 查询（全球）｜P1｜M
- 输入框可以填 IP、域名，或者留空。填域名就先 `native.net.resolve` 解出全部地址，让用户挑一个；留空表示查本机公网 IP。
- 首选数据源 IPinfo Lite（已查证）：免费、不限次数、允许商用，能查国家、大洲、ASN 号、AS 名称和域名，但查不到城市。需要 token；数据是 CC BY-SA 4.0，页面上要写「IP 数据由 IPinfo 提供」。token 写在 APK 里会被人扒出来，但它本来就免费不限量，泄露了损失不大。
- 备用 RDAP：问 IANA 引导表对应的 RIR（五大地址注册机构），能拿到网段归属单位和国家，不用 key。引导表按需拉取，缓存 30 天。
- 想做到国内省市一级，可以按需下载 ip2region 离线库（Apache-2.0/MIT 双许可，v4 库实测 11MB，v6 库 37MB），放 APK 不现实。见未决问题。
- 私网、保留地址本地就能判断，直接提示，不发请求。
- 权限：INTERNET。隐私：要查的 IP 会发给 IPinfo，首次使用时说明，并写进隐私政策。失败时降级：IPinfo 挂了自动切 RDAP，两个都挂就只显示本地能判断的信息。
- 风险：IPinfo 在国内的可达性和速度未知；城市级精度这一块比木函弱。

### Whois｜P2｜M
- 流程：解析出顶级域 → 查 IANA 的 RDAP 引导表（`dns.json`，缓存 7 天）。表里有这个顶级域就走 RDAP（HTTPS 返回 JSON，用 `native.net.http`），结构化显示注册商、注册和到期日期、状态、DNS 服务器；表里没有就走 `native.net.whois` 查 43 端口，显示原文，再用几条正则抽出到期日之类的关键字段。
- 两条路都要留，原因已查证：ICANN 从 2025-01-28 起不再强制 gTLD 提供 43 端口 WHOIS，RDAP 成了唯一必需的协议，不少 gTLD 已经把 43 端口关了；而 IANA 的 RDAP 引导表（2026-09-30 版）里没有 `.cn`、`.io`，这些国家和地区域名还得走 43 端口。
- 权限：INTERNET。隐私：要查的域名会发给对应的注册局。GDPR 之后注册人信息大多是打码的，这不是我们的问题，页面上说一句。
- 风险：有些运营商或公司网络封了 43 端口，要单独提示「43 端口不可达」；注册局有频率限制，同一域名 1 分钟内的结果直接用缓存。为什么 P2：开发者偶尔用，而且要两套协议。

### 网速测试｜建议不做
- 免费的测速服务端，查下来没有既可靠又合规的：
  - Cloudflare 的 `speed.cloudflare.com/__down`、`__up`：开源客户端在用，但我**没找到它对第三方 App 的公开使用条款**；国内访问 Cloudflare 的质量本来就不稳，测出来的数不代表真实带宽（推测）。
  - M-Lab ndt7：官方允许第三方集成，但**每次测试都会把用户的 IP 连同结果公开发布，不能退出**（已查证，M-Lab 隐私政策）。安卓客户端是社区维护的。
  - 自建：要服务器带宽，测一次就要几十 MB 流量，长期的钱从哪来说不清楚。
- 这三条路都跟「轻便、无服务端」冲突，建议不做。如果用户坚持要做，最低成本是「延迟 + 下行」两项，用 Cloudflare 端点，加流量提示和数据来源说明，估计 M 难度、原生约 200 行，见未决问题。

### 清单外说明
ping、DNS 查询、端口扫描、traceroute 都不在清单里，这次不加。以后要加，原生网络模块可以直接复用：DNS 用 `native.net.resolve`，端口探测用 Socket；ping 调系统的 `/system/bin/ping`（选型文档的推测），不引 surge-ping。

## 新增依赖清单

| 名称 | 版本 | 许可证 | 用途 | 层 | 何时需要 |
|---|---|---|---|---|---|
| @noble/hashes | 2.4.0 | MIT | MD5/SHA-1/SHA-2 流式哈希、HMAC，RC4 的 CryptoJS 兼容模式要用 | Web（运行时） | P0 |
| bowser | 2.14.1 | MIT | UA 解析 | Web（运行时） | P2 |
| linux-command | 1.22.0 | MIT | 命令手册数据，只在构建时拷进来 | 构建 | P2 |
| marked | 18.1.1 | MIT | 构建时把 md 预渲染成 HTML，不进运行时 | 构建（devDependency） | P2 |

共 4 个：运行时 2 个，构建时 2 个。P0/P1 阶段只需要 @noble/hashes 一个。

要依赖的外部服务（不是库，但同样需要确认）：

| 服务 | 条款要点 | 用途 |
|---|---|---|
| IPinfo Lite | 免费、不限量、可商用；要 token；数据 CC BY-SA 4.0，要署名 | IP 查询 |
| IANA RDAP 引导表 + 各 RIR / 注册局的 RDAP | 公共协议，不用 key | IP 查询（备用）、Whois |
| 各 WHOIS 服务器（43 端口） | 公共协议，各注册局有频率限制 | Whois（RDAP 查不到时） |

平台能力（0 依赖）：HttpURLConnection、InetAddress、Socket、WebCrypto、TextEncoder/TextDecoder、Web Worker、WebAudio、`crypto.getRandomValues`。

## 对公共基础设施的需求

| 需求 | 用在哪 | 说明 |
|---|---|---|
| `native.clipboard.write` | 全部工具 | 希望支持 `sensitive: true`，让原生设置 `ClipDescription.EXTRA_IS_SENSITIVE`（API 33+），给密码生成器、加解密用 |
| `native.clipboard.read` | ToolIO 的「粘贴」按钮 | 可选，长按输入框也能粘贴 |
| `native.file.pick` | 编解码、哈希、加解密 | 返回缓存路径并能经 PathHandler 读取。哈希可能要处理 GB 级文件，希望能不复制、直接只读暴露（比如流式读 content URI），这个由基础设施决定 |
| `native.file.save` | 编解码、网址探查、ToolIO 大输出 | 保存文本或二进制 |
| `native.share` | ToolIO | 分享文本或文件 |
| Bridge 错误码 | 网络模块 | 新增 `NETWORK`、`CANCELLED` |
| Bridge 通用取消 | 网络模块，以及以后的长任务 | 目前我用 `native.net.cancel {tag}` 自己解决；如果协议层能统一做「按请求 id 取消」，这个方法就可以去掉 |
| Manifest：`INTERNET` | IP 查询、Whois、网址探查 | 普通权限，不用运行时申请，但商店详情页会显示「完全的网络访问权限」 |
| WebView 宿主拦截外站请求 | 全局安全 | 一加 INTERNET，页面就能直接 `fetch` 外网、绕过 bridge。需要在 `shouldInterceptRequest` 里拦掉所有非 `appassets.androidplatform.net` 的请求，并加 CSP `connect-src 'self'` |
| network security config | 网址探查 | 要不要放开明文 HTTP（未决）；给 API 24 补根证书 |
| 隐私政策条目 | 联网工具 | 列出 IPinfo、RDAP/WHOIS 注册局，各自会收到什么数据 |

## 对既定约束的异议
没有要推翻的。有一条建议：bridge 通道 `@JavascriptInterface` 会注入到所有 frame，包括 iframe。现在只要页面不嵌 iframe 就没事，JS 运行器也已经绕开了；但工具一多，迟早有人嵌 iframe（比如预览 HTML）。建议把「换成 WebMessageListener」这件事提前，它能限制来源（`allowedOriginRules`），在协议层把这个口子堵上。

## 未决问题
1. **加不加 INTERNET 权限？** 不加的话，IP 查询、Whois、网址探查（含短链还原）这 4 项都做不了，本类剩 12 项纯本地工具。生活查询那批设计稿（life-fun.md）的结论是不加。所以这里实际是在问：要不要只为开发者这几个工具开网络权限。
2. **网速测试真的不做吗？** 如果要做，用哪个服务端：Cloudflare（没有公开的第三方条款）、M-Lab（会公开用户 IP）、还是自建（要带宽成本）。
3. **IP 查询要不要做到省市？** 默认 IPinfo Lite，只到国家和 ASN。要到国内省市，就得加 ip2region 按需下载（11MB 起），而且要有模型和数据下载的那套管理。
4. **要不要全局放开明文 HTTP？** 放开，`http://` 短链和老网站才能查；但这个设置是整个 App 的，不能只对某一次请求生效。
5. **Linux 命令手册**：全量 615 条（约 0.6MB）还是常用 150 条（约 0.15MB）？或者干脆不做（P2，置信度一般）？
6. **加解密页要不要顺带做 AES**（CryptoJS 兼容模式，WebCrypto 零体积）？做的话这页从 P2 升到 P1 比较合理。
7. **短链生成**：我建议砍，只留还原。用户要是坚持做，得选一家第三方服务（如 is.gd），并接受可用性和内容合规的风险。
