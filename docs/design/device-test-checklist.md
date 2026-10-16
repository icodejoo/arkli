---
title: 真机验证清单
status: active
updated: 2026-10-13
summary: 盲做阶段（无真机）攒下的全部待验证项，按风险排序、按模块分组，可直接照着在 STG-AL00 或其他真机上逐条测
---
## 用法
- 机型：华为 STG-AL00（Android 12，Chromium 114 WebView）为主；有条件再加一台 Android 13+/14 与一台非华为机。
- 每项都是"盲做阶段只过了编译与单测"的内容。通过打 ✅，不通过在后面记现象。调试入口见 [status.md](../status.md) "调试入口"。
- 构建：`cd web && pnpm build:app` → `.\gradlew.bat assembleDebug` → 装机。

## 一、最高风险（先测）
1. **视频压缩**（`video-compress`）：解码器 Surface 直连编码器 Surface 是否可用；时间戳是否正确；不从 0 开始的视频；奇数宽高；90°/180°/270° 旋转视频方向；HEVC/HDR/10-bit 源；华为编码器码率范围；输出是否比源大的提示。
2. **`native.net.*` 联网工具**：`web-source`、`short-link`、`ip-lookup`、`whois`、`speed-test`、`bilibili-cover`、`exchange-rate` 逐个跑通；`HttpURLConnection` 重定向与 TLS；各运营商 DNS；真实 whois 服务器格式（Verisign 类是否要 `domain xxx` 前缀）；取消时建连阶段连接是否断开；内网地址是否被拒（试 `http://192.168.x.x`、`http://169.254.169.254`）。
3. **提醒与闹钟**（`pomodoro`、`notify-self`）：API 33+ 通知权限弹窗；`setAlarmClock` 在华为自启动/电池优化下是否准时；重启后提醒失效（按设计）。
4. **文件夹清理**（`folder-clean`）：SAF 授权（含 Download、根目录限制）；数万节点遍历耗时；删除后相册/媒体库是否刷新。

## 二、原生全屏预览与选图（本会话前半）
- 原生预览：双指缩放、拖动、双击放大/还原（超长图 1080×20000，用 debug 命令 `previewtest`）、放大后高清局部位置是否对齐、单击/返回键关闭。
- 自带多选图片页：滑动流畅度（数千张）、权限弹窗、拒绝后回退系统选择器、点选序号与返回顺序。
- 返回键先关浮层：预览、尺子"间距对比"、农历弹窗、各 `van-popup`/Dialog；`beforeClose` 被绕过的影响。

## 三、系统能力（`native.system.*`）
- 剪贴板：敏感标记在 API 33+ 预览中是否隐藏；Android 10+ 后台读取为 null；12+ 读取提示。
- 分享：FileProvider 授权；图片/zip/txt/wav 在微信、相册等目标是否能收到；缓存目录外文件是否被拒。
- `settings.open` 11 个页面在华为/小米 ROM 上是否存在；`developer` 未开启时的表现。
- `intent.open` 各 scheme；`processText` 有/无翻译应用。
- 翻译页「拍照翻译」：拍照与相册多选、逐张进度与取消、译文叠层位置与字号、查看文本弹窗、OCR 或翻译模型缺失时的提示条（见 model-picker.md 末节）。
- 震动：API 26+ waveform、`repeat`、`cancel`、无马达；`vibrator` 工具节奏与强度近似体感。
- 屏幕：`keepAwake`、`brightness -1` 恢复、`immersive` 退出后布局。
- 设备信息：鸿蒙标识（`BuildEx`）、传感器列表、特性键名、刷新率/电压/温度单位；`ruler` 的 `ydpi` 换算误差（华为 ydpi 可能不准，保留手动校准）。
- 权限：33 前后分支、永久拒绝返回、`not_declared` 路径。

## 四、其他原生
- **文字转语音**：STG-AL00 是否有中文语音数据；`synthesizeToFile` 的 wav；单次文本上限。
- **网页转应用**：华为桌面是否支持固定快捷方式及图标。
- **应用管理**：`<queries>` 在各 ROM 列出多少应用；导出 APK 耗时；应用图标渲染。
- **噪音测量**：16kHz 采样支持、静音/AGC 对读数影响、被占用时行为；数值仅供参考（未校准）。
- **获取壁纸**：各 Android 版本与动态壁纸的表现；API 33+ 是否只给默认壁纸。
- **视频提取音频**（仅 AAC）、**视频转 GIF**（取帧速度、旋转视频帧尺寸）。

## 五、Web 工具（浏览器 API 在 WebView 里的行为）
- **传感器**：`level`/`protractor`/`compass` 坐标轴方向（`tiltFromGravity` 的 `invert`）、倒置/横屏读数。
- **触摸**：`finger-roulette` 三指以上、三指截屏手势抢触摸、`pointercancel`；`sketchpad`、`protractor`、`id-photo`、`meme-maker` 的 `touch-action: none` 是否挡住页面滚动；`image-upscale` 对比滑块与纵向滚动。
- **音频**：`morse` 的 `AudioContext` 自动播放（可能要 `mediaPlaybackRequiresUserGesture=false`）；`coin-flip`/`dice` 音效音量音色。
- **Worker**：`js-runner` Blob Worker 能否创建、死循环 5 秒强杀、离开页面终止。
- **存储**：`ledger` IndexedDB 持久化（杀进程后）、导入用 `<input type=file>` 能否弹选择器；`scoreboard` 的 localStorage。
- **文件**：`text-process` 打开大文件、下载在宿主内是否有反应；`table-extract` 的 CSV 经 `saveBlob` 能否保存非图片文件。
- **GIF**：`gif-tool` 的 `ImageDecoder` 逐帧是否已合成完整画面、300 帧大 GIF 内存与耗时；原生预览对 GIF 是否播放。
- **图片工具**：`image-base64` 大图（>5MB）；`image-palette` 点击坐标换算；`image-watermark` 旋转平铺盖满四角；`solid-gradient` 4K 导出耗时与预览一致性；`phantom-tank` 在白/黑底下实际效果与微信/QQ 发原图表现；`image-viewer` 系统选图是否保留 EXIF/GPS；`image-frame` 4000×8000 长截图内存；`text-image` 的 `measureText` 换行与绘制一致；`bead-pattern` 24px 小格色号可读性。
- **浏览器能力**：`word-split` 的 `Intl.Segmenter`；`fancy-text` 的 Unicode 字形是否缺字；`typing-board` 常亮回退。
- 通用：复制在 WebView 里的权限（`copyText` 回退）；`window.open` 是否走外部浏览器（`express-track`、`translate`、`image-search`）。

## 六、数据人工核对（不需要真机）
- 元素周期表 104~118 号质量数与电子排布；垃圾分类 407 条（塑料袋、旧鞋、白炽灯、外卖餐盒、猪大骨/鸡骨、蛋壳）；快递单号规则（韵达最不确定）；成语 872 条读音与释义（差强人意、夜不能寐、天网恢恢等）；对联 73 副句中平仄；Linux 手册 `unzip -O`、`nc`、`shred`；宜忌释义 123 条（见 status.md）。

## 七、真机验证记录（STG-AL00 / Android 12）
2026-10-14 首次连上真机，已验证（✅）与发现的问题：
- ✅ 启动无崩溃；96 个工具页逐个跳转，渲染全部正常、零控制台报错（`nav` + 截图 + logcat 自动筛查）。
- ✅ 设备信息：原生分组可用，鸿蒙标识为"是"（品牌 harmony）、SDK 31、CPU ABI 等字段齐全。
- ✅ 尺子：有宿主时自动按 `ydpi` 换算，提示"已按屏幕物理密度自动换算"。
- ✅ 文字识别：模型未就绪的缺口提示正常显示。
- ✅ 文件夹清理：SAF 授权、扫描（大文件/空文件/空文件夹）、勾选、删除前二次确认弹窗均可用；**系统不允许选存储根目录和 Download 本身**（Android 11+），已在页面补提示。
- 🔧 **发现并修复：WebView 的 `vh` 全为 0**。根因：WebView 默认 `layout_height=wrap_content`，Chromium 的 `AwLayoutSizer` 因此把主文档布局高度强制置 0。症状：确认弹窗消息只显示一行、各工具 `max-height: 60vh` 的预览框塌缩、时钟字号为 0、指尖轮盘触摸区高度为 0。修复：`ArkliPage` 初始化时显式设 `MATCH_PARENT`，修复后 `100vh=756px`。
- 🔧 文件夹清理把空文件夹的"大小"算成 3.4KB（目录项大小），已改为文件夹恒为 0 并补单测。
- 备注：Chrome 99 不支持 `dvh/svh`，项目只用 `vh`。debug 构建已开 WebView 远程调试（CDP），方法见记忆 `project-webview-matchparent`。
- 其余清单项仍待测（尤其视频压缩、`native.net.*`、提醒闹钟）。
