---
title: 设备系统与文件类工具落地设计
status: draft
updated: 2026-10-13
summary: 「设备与系统」「文件与清理」分类全部工具的落地方案：原生能力暴露方式、权限、可行性与优先级
---
## TL;DR
- 共 21 项（设备与系统 18 + 文件与清理 3）。P0 4 项、P1 4 项、P2 4 项、建议不做 9 项。砍掉的基本都是现代安卓上要 root/ADB 或已被系统封死的（WiFi 密码、读壁纸、DPI、重启、电量伪装/校准、动画倍率），再加两个含义不明的"氢壁纸"。
- 唯一的危险权限是噪音测量的 `RECORD_AUDIO`（用到才申请）。另外震动器要普通权限 `VIBRATE`，应用管理要在 Manifest 里加一段 `<queries>`。`MANAGE_EXTERNAL_STORAGE`、`QUERY_ALL_PACKAGES`、`READ_MEDIA_*`、悬浮窗、无障碍一个都不碰。
- 决定一：传感器类工具统一走原生 `SensorHub`。用订阅加合帧推送，每个 tick 只发一条消息，不做一问一答。不用 WebView 的 DeviceOrientation 事件，那条路只留给浏览器里调试用。
- 决定二：三个清理工具合成一个「文件夹清理」，用 SAF 让用户授权某个目录后再扫描，大文件、空文件夹、安装包做成三个筛选项，再配一个直达系统「释放空间」页的入口。全程不需要存储权限。
- 不新增任何第三方依赖，全部用平台 API。不涉及 Rust。

## 总览

| 工具 | 层 | 首选方案 | 权限 | 优先级 |
|---|---|---|---|---|
| 尺子 | Web + 原生取 DPI | `native.device.display` 拿 xdpi，页面画刻度，可用银行卡校准 | 无 | P0 |
| 指南针 | Web + 原生传感器 | SensorHub 订阅旋转矢量和磁场，页面算方位 | 无 | P0 |
| 水平仪 | Web + 原生传感器 | SensorHub 订阅重力 | 无 | P1 |
| 量角器 | Web（倾角模式用传感器） | 屏上量角纯 Web，倾角模式复用水平仪数据 | 无 | P1 |
| 噪音测量 | Web + 原生音频 | AudioRecord 算 RMS 转 dB，10Hz 推送 | `RECORD_AUDIO`（运行时） | P1 |
| 震动器 | Web | `navigator.vibrate`，不行再补原生 | `VIBRATE`（普通） | P2 |
| 设备信息 | Web + 原生 | `native.device.info/status/display` + 传感器列表 | 无 | P0 |
| WiFi 密码查看 | — | 10+ 无公开 API，要 root | — | 建议不做 |
| 应用管理 | Web + 原生 | `<queries>` 查可启动应用，详情/打开/跳设置卸载/导出 APK | 无运行时权限 | P2 |
| 获取当前壁纸 | — | 13 起只给默认壁纸，14 起抛异常 | — | 建议不做 |
| DPI 修改 | — | 要 `WRITE_SECURE_SETTINGS`（ADB 授权） | — | 建议不做 |
| 高级重启 | — | 要 root | — | 建议不做 |
| 电量伪装 | — | 要 ADB `dumpsys battery` | — | 建议不做 |
| 系统动画速度调控 | — | 写入要 ADB 授权，改成在设备信息里直达开发者选项 | — | 建议不做 |
| 氢壁纸 | — | 含义不明，推测是联网壁纸源 | — | 建议不做 |
| 原生氢壁纸 | — | 同上 | — | 建议不做 |
| 电量校准 | — | 锂电无需校准，旧做法要 root | — | 建议不做 |
| 时间屏幕/屏幕时钟 | Web | 纯页面，借公共 `native.screen.*` 常亮、全屏、横屏 | 无 | P0 |
| 大文件清理 | 原生 + Web | 合并为「文件夹清理」：SAF 授权目录后扫描，按大小筛 | 无（SAF 逐目录授权） | P1 |
| 空文件/空文件夹清理 | 同上 | 同一工具的筛选项 | 无 | P2 |
| 安装包清理 | 同上 | 同一工具的筛选项；11+ 选不了 Download 根目录，效果打折 | 无 | P2 |

## 共用部件

### 1. SensorHub（原生传感器管理器）
负责注册监听、合帧和生命周期，被指南针、水平仪、量角器、设备信息复用。

- **订阅**：`native.sensor.subscribe`
  - params：`{ sensors: ["rotationVector","gravity","magneticField","accelerometer","light","pressure"], hz: 20, mode: "latest" | "batch", batchMs: 200 }`
  - 返回：`{ sub: "s1", available: { rotationVector: true, magneticField: false, ... } }`
- **退订**：`native.sensor.unsubscribe { sub }`。另有 `native.sensor.list`，返回 `[{ type, name, vendor, maxHz, power }]`，设备信息页会用。
- **事件** `sensor.data`：
  - latest 模式下每 tick 只发一条：`{ sub, t, d: { rotationVector: [x,y,z,w], magneticField: [x,y,z] } }`。
  - batch 模式下每 `batchMs` 发一条：`{ sub, d: { gravity: [[t,x,y,z], ...] } }`，给要画曲线的场景用。
  - 数值保留 3 位小数。合帧之后单条消息在 200 字节以内，batch 模式在 200ms、50Hz 下也不到 4KB。
- **事件** `sensor.accuracy`：`{ sub, sensor, level: 0..3 }`。指南针据此提示用户画 8 字校准。
- **合帧机制**：传感器回调只往"最新值槽"里写，不排队。一个 Handler 定时器按 `hz` 节拍，把所有订阅的最新值打成一条 `evaluateJavascript`。不管订了几个传感器，每 tick 都只有一次跨层调用。
- **采样率**：`hz ≤ 15` 时用 `SENSOR_DELAY_UI`，其余用 `SENSOR_DELAY_GAME`，上限 60Hz。Android 12 起超过 200Hz 才需要 `HIGH_SAMPLING_RATE_SENSORS`，我们碰不到这条线（推测，按 12 行为变更文档的印象，未抓原文）。
- **计算放哪**：原生只转发原始数组。方位角、倾角、屏幕旋转补偿都在页面 JS 里算，计算量很小，也符合"壳不写业务计算"。
- **生命周期**：
  - Activity `onPause` 时注销全部监听，`onResume` 时按现有订阅恢复。安卓 9 起后台应用本来也收不到连续型传感器数据。
  - WebView 重载或渲染进程崩溃时清空所有订阅。
  - 页面侧用 `useSensor()` 组合式函数封装，`onUnmounted` 时自动退订。
- **浏览器调试**：不在 Arkli 容器里时，`useSensor()` 退回 `deviceorientation`/`devicemotion` 或模拟数据，只为开发方便，不进正式路径。
- **体积**：约 200 行 Kotlin，R8 后 dex 增量 <20KB（推测）。

### 2. 设备信息采集器（`native.device.*`）
- `native.device.info`：静态快照，进页面调一次。字段包括：
  - 厂商、品牌、型号、`Build.DEVICE`
  - 安卓版本、SDK、安全补丁（API 23+）
  - SoC：`Build.SOC_MANUFACTURER/SOC_MODEL`，API 31+，老版本退回读 `/proc/cpuinfo` 的 Hardware 行
  - ABI、核数、各核最大频率：读 `/sys/devices/system/cpu/cpu*/cpufreq/cpuinfo_max_freq`，部分 ROM 被 SELinux 拦，读不到就留空（推测）
  - 内核版本、总内存、总存储
  - 鸿蒙标识：华为机反射 `com.huawei.system.BuildEx`，失败就忽略（推测）
- `native.device.status`：动态数据，页面可见时每 2 秒轮询一次。不做成事件，频率低，问答就够。字段包括：
  - 电量、充电状态、健康、温度、电压，来自 `ACTION_BATTERY_CHANGED` 粘性广播，无需权限
  - 循环次数 `EXTRA_CYCLE_COUNT`，推测 API 34+，只查到绑定库元数据
  - 可用内存、可用存储
  - 温控状态 `PowerManager.getCurrentThermalStatus`（API 29+）
- `native.device.display`：xdpi、ydpi、densityDpi、density、分辨率、刷新率及可选刷新率、HDR 能力。
- 页面自己能拿的就不走 bridge：WebView 版本取 `navigator.userAgent`，GPU 型号取 WebGL 的 `WEBGL_debug_renderer_info`（推测仍可用）。
- **刻意不采**：IMEI、序列号、Android ID、MAC、已装应用数。10+ 拿不到，或者在国内隐私合规里算"收集个人信息"，没必要惹麻烦。

### 3. 系统设置直达（`native.settings.open`）
- params：`{ page: "developer" | "display" | "storage" | "wifi" | "about" | "appDetails", pkg? }`，原生侧走白名单映射到 Intent。
  - `storage` 用 `StorageManager.ACTION_MANAGE_STORAGE`（API 25+），24 退回 `Settings.ACTION_INTERNAL_STORAGE_SETTINGS`。
  - `appDetails` 用 `ACTION_APPLICATION_DETAILS_SETTINGS`。
- 开发者选项没打开时，部分 ROM 会抛 `ActivityNotFoundException` 或直接闪退。这时捕获异常，返回 `NOT_READY`，页面提示"去关于手机连点版本号"，并改跳 `about` 页。
- 其他分类（如网络类）多半也会用到，可以考虑升格为公共设施。

### 4. 页面侧封装
`web/src/native/` 下加 `device.ts`、`sensor.ts`、`storage.ts`、`apps.ts`、`audio.ts`，只做类型和薄封装。各工具页只 import 自己用到的那个，跟着各自的路由 chunk 懒加载。

## 逐工具方案

### 尺子｜P0｜S
- **方案**：页面按 `mm = cssPx × devicePixelRatio / xdpi × 25.4` 画刻度。支持横竖屏，提供 cm 和 inch 两种刻度。
- **校准**：不少机型上报的 xdpi 是按密度档位凑的整数（推测），所以必须带校准：把银行卡（85.60mm）或一元硬币（25mm）放在屏上对齐，算出修正系数，存 localStorage。
- **Bridge**：`native.device.display`。
- **体积**：Web chunk 约 5KB gzip（推测）。**权限**：无。
- **风险与测试**：在 STG-AL00 上用实物尺比对；曲面屏、挖孔屏的边缘区域不要画刻度。

### 指南针｜P0｜M
- **方案**：订阅 `rotationVector` + `magneticField`，hz=20。页面用旋转矩阵算方位角，并按 `screen.orientation` 补偿屏幕旋转。
- **干扰与校准**：磁场模长偏离 25~65μT 时提示"附近有磁干扰"；`sensor.accuracy` ≤1 时提示画 8 字校准。
- **只给磁北**：真北要磁偏角，`GeomagneticField` 需要经纬度，就得申请定位权限，不做。可以让用户手动填磁偏角。
- **缺传感器时**：没有旋转矢量（低端机常见）就用加速度计加磁场自己合成；连磁力计都没有，就提示设备不支持。
- **Bridge**：`native.sensor.subscribe/unsubscribe`，事件 `sensor.data`、`sensor.accuracy`。
- **体积**：Web 约 6KB（推测），原生共用 SensorHub。**权限**：无。
- **风险与测试**：华为机磁力计会弹系统校准提示，看看会不会和我们的提示叠在一起；用手机自带指南针做对照。

### 水平仪｜P1｜S
- **方案**：订阅 `gravity`（没有就用 `accelerometer` 低通），hz=30。平放时显示圆形气泡，立起时显示条形，提供"以当前为零点"校准。
- **Bridge**：同上。**体积**：Web 约 5KB（推测）。**权限**：无。
- **风险与测试**：在桌面上转 180° 读数应当对称，不对称就是零点偏了，提示用户校准。

### 量角器｜P1｜S
- **方案**：屏上量角纯 Web，两条可拖动的边加读数，角度和尺寸无关，不用 DPI。倾角模式（手机边缘贴着物体测角度）直接复用水平仪的数据和组件。
- **不做**：相机叠加量角，要加相机权限，体验收益也不大。
- **Bridge**：倾角模式才用 `native.sensor.*`。**权限**：无。

### 噪音测量｜P1｜M
- **方案**：
  - 原生用 `AudioRecord` 采 PCM16 单声道 44.1k。音源先探测 `UNPROCESSED`（`AudioManager.getProperty(PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED)`），不支持就退到 `VOICE_RECOGNITION`，这个通常不开自动增益（推测）。
  - 每 100ms 算一次 RMS 转成 dBFS，推给页面。页面加上校准偏移换算成近似 dB(A)，画实时值、最大、平均和曲线。
- **为什么不用 Web 的 getUserMedia**：WebView 的权限要绕 `WebChromeClient`，关自动增益和降噪的约束也不一定生效（推测），测出来不准。
- **Bridge**：
  - `native.audio.meter.start { hz: 10 }` → `{ sess, sampleRate, source }`
  - 事件 `audio.level { sess, t, dbfs }`
  - `native.audio.meter.stop { sess }`
  - 未授权时返回 `PERMISSION_DENIED`，页面先调公共的 `native.permission.request`。
- **体积**：Kotlin 约 120 行，Web 约 6KB（推测）。
- **权限**：
  - `RECORD_AUDIO` 是运行时危险权限，进工具点"开始"时才申请。11+ 有单次授权，12+ 状态栏会亮麦克风指示点，属正常现象。
  - 国内商店要求"使用时申请，并说明用途"，隐私政策里要写上（推测，按工信部 164 号文的常见口径）。
- **兼容**：`onPause` 必须停录，安卓 9 起后台应用本来也拿不到麦克风。
- **风险与测试**：各机麦克风灵敏度差异很大，界面上标明"仅供参考，非专业声级计"，并提供手动偏移；用手机自带分贝仪或另一部手机对照。

### 震动器｜P2｜S
- **方案**：
  - 页面直接调 `navigator.vibrate(pattern)`，Manifest 加 `VIBRATE`（普通权限，安装即授予）。Cordova 文档写明安卓 WebView 原生支持 Vibration API，但首次调用前用户必须点过页面（已查证）。
  - 预设几种节奏，"持续"模式用定时器循环触发；`visibilitychange` 隐藏时立刻停。
- **兜底**：只有 Web 方案在 STG-AL00 上失效时，才补 `native.vibrate.play { timings, amplitudes?, repeat }`。26+ 用 `VibrationEffect.createWaveform`，24~25 用旧 API，31+ 用 `VibratorManager`。默认不写。
- **权限**：`VIBRATE`。
- **风险与测试**：系统关掉"触感反馈"或开了勿扰时，部分 ROM 会吞掉震动（推测），要测；值本来就不高，所以放 P2。

### 设备信息｜P0｜M
- **方案**：按分组卡片展示四块：硬件、系统、屏幕、电池/内存/存储；再加一个传感器列表。
  - 数据来自 `native.device.info/status/display` 和 `native.sensor.list`。
  - 支持一键复制或分享纯文本，走公共的 `native.clipboard.write`、`native.share`。
  - 底部放"系统设置直达"：开发者选项、显示、存储、关于手机。被砍掉的"动画速度调控"就靠这里替代。
- **另一种方案**：动画倍率可以免权限读 `Settings.Global.ANIMATOR_DURATION_SCALE`，只展示当前值，不提供修改。
- **体积**：Kotlin 约 200 行，Web 约 10KB（推测）。**权限**：无。
- **风险与测试**：`/proc` 和 `/sys` 是否可读各 ROM 不一，读失败要留空，不能抛错；鸿蒙机上要同时显示安卓 API 级别和鸿蒙版本。

### WiFi 密码查看｜建议不做
- **原因**：
  - 安卓 10 起 `WifiManager.getConfiguredNetworks()` 对普通应用返回空列表，10 以前也拿不到 PSK 明文（推测，长期公认行为，未抓原文）。
  - 木函原版也是 root 才能用。
- **零成本替代**：系统设置里"分享 WLAN"会显示带密码的二维码（10+ 原生支持，各 ROM 入口名不同）。在二维码工具里放一句提示："截图后用二维码识别查看密码"。不单独做工具。

### 应用管理｜P2｜M
- **方案**：
  - Manifest 加 `<queries>`，内容是 `MAIN` + `LAUNCHER` 的 intent。这样 11+ 能看到所有带桌面图标的应用，不用 `QUERY_ALL_PACKAGES`。看不到的只有没图标的系统组件，工具箱用不着。
  - 功能只做这几样：列表加搜索、详情、打开应用、跳系统应用详情页（卸载、清缓存都由用户在那里点）、导出 base.apk。
  - 卸载不自己发 `ACTION_DELETE`，这样就省了 `REQUEST_DELETE_PACKAGES`。
  - 不显示应用占用空间：那要 `PACKAGE_USAGE_STATS` 特殊授权。
- **Bridge**：
  - `native.apps.list { system: false }` → `[{ pkg, label, ver, updated }]`。200 个应用约 30KB，在 256KB 以内。
  - `native.apps.icon { pkg }` → `{ path }`：图标渲染成 96px PNG 放 `cache/apps/`，滚到哪个才取哪个。
  - `native.apps.detail { pkg }` → 版本、target/minSdk、安装和更新时间、APK 大小、安装来源（30+）、签名 SHA-256、申请的权限列表。
  - `native.apps.launch { pkg }`；跳详情页用 `native.settings.open { page: "appDetails", pkg }`。
  - `native.apps.exportApk { pkg }` → `{ path }`：先复制到缓存，再交给公共的 `native.file.save`。split APK 只导 base，并给出提示。
- **体积**：Kotlin 约 200 行，Web 约 8KB（推测）。**权限**：无运行时权限。
- **商店风险**：
  - Play：`<queries>` 不受 `QUERY_ALL_PACKAGES` 政策约束。但政策写明"能用更窄的可见性完成就不得申请"，我们本来就走窄路（已查证）。
  - 国内：读取应用列表在合规检查里算敏感行为，必须在隐私政策里写明，进工具时先弹说明；小米、OPPO 等可能还有自家的"读取应用列表"开关（推测，没查到原文）。这是放 P2 的主要原因。
- **风险与测试**：鸿蒙机上的元服务、分身应用怎么显示；导出 APK 的大小和校验要对得上。

### 获取当前壁纸｜建议不做
- 安卓 13 起 `WallpaperManager.getDrawable()` 对没有 `READ_WALLPAPER_INTERNAL`（系统私有）或 `MANAGE_EXTERNAL_STORAGE` 的应用只返回系统默认壁纸，14 起官方文档写明会直接抛 `SecurityException`（已查证）。
- 12 及以下靠 `READ_EXTERNAL_STORAGE` 还能拿到。也就是说测试机 STG-AL00 上能用，新机上全坏，很容易误判，所以直接砍。

### DPI 修改｜建议不做
要 `WRITE_SECURE_SETTINGS`，只能用户自己 ADB `pm grant`，还得走隐藏 API。改坏了可能导致界面错乱，普通用户难以恢复。

### 高级重启｜建议不做
重启、进 Recovery、进 Bootloader 要 `REBOOT`（签名级）或 root，第三方应用做不了。

### 电量伪装｜建议不做
`dumpsys battery set level` 只能在 ADB 或 root 下执行。这个功能本身价值低，还容易被拿去骗人（伪造电量截图），砍。

### 系统动画速度调控｜建议不做
写 `Settings.Global` 的动画倍率要 ADB 授予 `WRITE_SECURE_SETTINGS`。开发者选项里本来就有这个设置，所以在设备信息页做"直达开发者选项"和"显示当前倍率"就够了。

### 氢壁纸、原生氢壁纸｜建议不做
- 功能清单里的说明是"具体不明"。推测是联网壁纸源。
- 做它要加 `INTERNET`、找有版权的图源、跑服务端，跟"轻便"正面冲突。如果用户知道它到底是什么，可以再评估。

### 电量校准｜建议不做
- 锂电池不需要"校准"。老办法是删 `batterystats.bin`，要 root，而且只影响统计，不影响电池本身。
- 电池健康、温度、循环次数（34+）已经在设备信息里展示了。

### 时间屏幕/屏幕时钟｜P0｜S
- **方案**：纯 Web，提供数字、翻页两种样式，可选秒、日期、农历（农历复用别的工具引入的 tyme4ts，本工具不单独引）。
  - 进页面时用公共设施做三件事：常亮（`keepAwake`）、沉浸全屏（`immersive`）、可选横屏锁定（`orientation`）；退出时全部恢复。
  - 字体用系统字体加 `font-variant-numeric: tabular-nums`，不打包字体。
- **防烧屏**：每分钟让整体偏移几个像素，提供"夜间变暗"。变暗用公共的 `native.screen.brightness`，只改窗口亮度，不需要权限。
- **权限**：无。
- **兼容**：
  - targetSdk 35 在 15 上强制 edge-to-edge，全屏要处理刘海区。
  - 16 起 target 36 的应用在大屏（≥600dp）上方向锁定会被忽略（推测），横屏锁只当"建议"。
- **风险与测试**：长时间常亮时的发热和耗电；华为"智能息屏"会不会无视常亮标志。

### 文件夹清理（合并：大文件清理 P1、空文件/空文件夹清理 P2、安装包清理 P2）｜M

**为什么合并、为什么用 SAF**
- 全盘扫描要 `MANAGE_EXTERNAL_STORAGE`。Play 只允许核心用途是文件管理、备份、杀毒等的应用申请（已查证），工具箱基本过不了审。
- `READ_MEDIA_*` 只能看到媒体文件，Play 还有照片视频权限政策要申报。APK、空目录这类非媒体文件在 10+ 本来就看不到。
- 所以三个工具共用一套 SAF 实现：用户选一个目录授权，我们扫描后按筛选项列出结果。清单上的三个名字保留为三个入口卡片，进去是同一页，只是默认筛选项不同。

**流程**
1. 用户选目录：走公共的 `native.file.pickDir`，拿持久授权。常用目录给出建议：DCIM、Movies、Pictures、Download/WeiXin 这类 Download 子目录。
2. 扫描：原生用 `DocumentsContract.buildChildDocumentsUriUsingTree` 加一次性投影（ID、MIME、SIZE、LAST_MODIFIED）逐层查询。不用 androidx `DocumentFile`，它每个属性都要一次 IPC，很慢。
3. 筛选：大于阈值的文件；大小为 0 的文件和没有子项的目录；`.apk` 文件（标出版本，已安装的同包版本可对比，复用应用管理的数据）。
4. 删除：用户勾选后删除，`DocumentsContract.deleteDocument`。空目录自底向上删，删完子项后父目录变空的也一并处理。

**Bridge**
- `native.storage.overview` → `{ total, free }`：26+ 用 `StorageStatsManager`，24~25 用 `StatFs`。
- `native.storage.scan { tree, filters: ["large","empty","apk"], minSize, maxDepth }` → `{ scan }`。
  - 进度事件 `storage.scan.progress { scan, scanned, found }`，最多每秒 4 次。
  - 完成事件 `storage.scan.done { scan, resultPath }`。结果可能超过 256KB，所以写到缓存 JSON，页面经 PathHandler 读。
- `native.storage.cancel { scan }`。
- `native.storage.delete { scan, ids: [...] }` → `{ deleted, failed: [{ id, reason }] }`。原生侧校验 id 必须出现在这次扫描结果里、并且属于已授权的目录，不信任页面传来的任意 URI。
- 另配入口 `native.settings.open { page: "storage" }`，直达系统"释放空间"，零成本补上 SAF 覆盖不到的部分。

**其他**
- 不涉及 Rust：瓶颈在 ContentProvider 的 IPC，不在计算。
- 体积：Kotlin 约 250 行，Web 约 10KB（推测）。
- 权限：无 Manifest 权限。11+ 选不了存储根目录、Download 根目录、`Android/data`（已查证）。安装包大多下在 Download 根目录，所以"安装包清理"在 11+ 上效果有限，界面要如实说明，这也是它定 P2 的原因。24~29 可以选根目录，覆盖更全。
- 商店风险：低，因为没有申请存储权限。
- 风险与测试：
  - 华为、鸿蒙的目录选择器是自家实现，测能否选 DCIM、能否持久授权（推测有差异）。
  - 一万个以上文件的目录要测扫描耗时和取消。
  - 删除不可撤销，页面必须二次确认并显示总大小。

## 新增依赖清单
无。全部使用平台 API：SensorManager、AudioRecord、BatteryManager、PackageManager、DocumentsContract、StorageStatsManager、WallpaperManager（不用）、Vibrator，以及 WebView 内置的 Vibration API。

Manifest 新增项（不是依赖，但需要确认）：`android.permission.RECORD_AUDIO`、`android.permission.VIBRATE`、`<queries>`（LAUNCHER intent）。

## 对公共基础设施的需求
- `native.permission.request` / `native.permission.check`：噪音测量要 `RECORD_AUDIO`，含"永久拒绝后跳设置"的分支。
- `native.file.pickDir`：SAF 目录树选择，并持久化授权（`takePersistableUriPermission`），返回一个不透明 token，页面拿不到真实 URI。
- `native.file.save`：导出 APK。
- `native.share`、`native.clipboard.write`：设备信息的复制和分享。
- `native.screen.keepAwake`、`native.screen.immersive`、`native.screen.orientation`、`native.screen.brightness`：时间屏幕要用，手持弹幕、打字板也会用。
- `native.settings.open`：本文在共用部件第 3 节先定了一版，如果升格为公共设施，以公共版为准。
- **异步处理器**：现在的 `BridgeHandler.handle` 是同步返回，权限申请、目录选择、扫描都要等用户或 IO，需要支持挂起处理器或先回 ack、再用事件回传结果。
- **订阅类事件约定**：事件的 data 带 `sub` 或 `sess` 字段区分订阅；原生按"页面会话"自动清理订阅，WebView 重载或崩溃时会话号递增。
- **生命周期事件**：`app.pause` / `app.resume` 推给页面。WebView 里的 `visibilitychange` 不一定靠谱（推测）。
- **缓存目录只读路径**：PathHandler 暴露 `cache/`，用来读扫描结果和应用图标；另外要有定期清理缓存的策略。
- **通道性能**：30Hz 的 `evaluateJavascript` 在低端机上预计可以接受（推测）。如果真机掉帧，就把事件通道提前换成 WebMessagePort，协议里已经留了这个余地。

## 对既定约束的异议
无。上面两条协议扩展（事件带 `sub`、异步处理器）不改变现有协议格式，只是补充约定。

## 未决问题（需要用户拍板）
1. 9 项"建议不做"是否全部同意？其中获取壁纸、WiFi 密码在竞品里有，砍掉后在二维码工具里留一句提示，可以吗？
2. 应用管理要不要做？它在国内要写进隐私政策并在进入时说明，是 P2 里合规成本最高的一个。
3. 噪音测量会是 Arkli 第一个危险权限（`RECORD_AUDIO`），首批上线要不要带它？带的话，隐私政策需要先准备好。
4. 清理类合并成「文件夹清理」一个页面、三个入口卡片，这个形态行不行？还是三个入口干脆合成一个？
5. 如果以后单出国内渠道包，大文件清理要不要额外申请 `READ_MEDIA_IMAGES/VIDEO` 做"全相册大文件"？Play 包不建议申请。
6. 传感器统一走原生 SensorHub、不用 WebView 的 DeviceOrientation 事件，是否同意？代价是多约 200 行 Kotlin，换来跨 ROM 行为一致，还能拿到校准精度和磁场强度。

参考来源（已查证项）：[WallpaperManager 文档](https://developer.android.com/reference/android/app/WallpaperManager)、[AOSP：U 及以上读壁纸方法变更](https://android.googlesource.com/platform/frameworks/base/+/b55648924c6d)、[SAF 目录访问限制](https://developer.android.com/training/data-storage/shared/documents-files)、[Play 全部文件访问政策](https://support.google.com/googleplay/android-developer/answer/10467955)、[Play QUERY_ALL_PACKAGES 政策](https://support.google.com/googleplay/android-developer/answer/10158779)、[Cordova 震动插件说明](https://cordova.apache.org/docs/en/9.x/reference/cordova-plugin-vibration/)。
