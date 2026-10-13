---
title: 生活、效率与趣味类工具落地设计
status: draft
updated: 2026-10-13
summary: 「生活查询」「效率与记录」「趣味与决策」分类全部工具的落地方案：数据来源、存储、提醒、体积与优先级
---
## TL;DR
- 覆盖清单三类共 25 项：P0 6 项、P1 7 项、P2 3 项、建议不做 9 项。生活查询 8 项里 6 项建议不做，原因都是同一个：找不到能商用、稳定、免费的数据源。
- 依赖外部服务的有 7 项（快递、历史上的今天、油价、新闻、淘宝券、直链、对联），全部不做或降级成"本地识别 + 跳外部浏览器"。**这三类工具一个都不需要加 INTERNET 权限**，也不用动 Rust 层。
- 体积增量预计 0.1MB 量级（13 个 Web chunk 加两份小数据集）；如果做藏头诗，要再加约 0.6 到 1.5MB 诗句数据（推测），这一项单独拍板。
- 两个关键决定：① 记录类数据统一存 IndexedDB，用一个导出/导入的 JSON 备份兜底（Manifest 里 `allowBackup=false`，系统不会替我们备份）；② 番茄钟、通知自己共用一套原生"闹钟 + 通知"封装，**不用前台服务**，精确闹钟拿不到权限就退回非精确闹钟。

## 总览

| 工具 | 层 | 首选方案 | 数据来源 | 体积增量 | 优先级 |
|---|---|---|---|---|---|
| 快递查询（含 Lite） | Web + 外部浏览器 | 本地识别单号所属公司，跳官方查询页 | 自编单号规则表 | ~5KB | P2 |
| 垃圾分类查询 | Web | 本地词典检索 | 自编词典（按官方指引整理） | ~25KB | P1 |
| 历史上的今天 | — | 不做 | 维基 CC BY-SA，国内不可达 | — | 建议不做 |
| 手机号归属地查询 | — | 不做 | 没有可商用的号段库 | — | 建议不做 |
| 邮编查询 | — | 不做 | 没有许可证清晰的数据 | — | 建议不做 |
| 油价查询 | — | 不做 | 无免费官方接口 | — | 建议不做 |
| 每日新闻 | — | 不做 | 需新闻资质 | — | 建议不做 |
| 淘宝优惠券 | — | 不做 | 需淘宝联盟账号，导购合规 | — | 建议不做 |
| 番茄时钟 | Web + 原生 | 页面算时间，原生闹钟 + 倒计时通知 | 无 | ~6KB + 原生少量 | P0 |
| 极简记账 | Web | IndexedDB + JSON/CSV 导出 | 用户数据 | ~10KB | P1 |
| 画板（绘画板） | Web | Canvas 笔画栈，导出 PNG | 无 | ~6KB | P1 |
| 记分牌（含多人） | Web | 纯 Web，状态存 localStorage | 无 | ~4KB | P1 |
| 通知自己 | Web + 原生 | 复用闹钟 + 通知封装 | 无 | ~3KB | P1 |
| 网页转应用 | 原生 | 桌面固定快捷方式，点开走外部浏览器 | 无 | ~3KB + 原生少量 | P2 |
| 直链提取 | — | 不做 | 依赖网盘私有接口 | — | 建议不做 |
| 指尖轮盘 | Web | 多点触控 + 随机引擎 | 无 | ~4KB | P1 |
| 自定义抽签 | Web | 随机引擎，共用"随机决策"chunk | 无 | 合计 ~8KB | P0 |
| 做个决定 | Web | 同上，转盘形态 | 无 | （同上） | P0 |
| 抛硬币 | Web | 同上 | 无 | （同上） | P0 |
| 掷骰子 | Web | 同上 | 无 | （同上） | P0 |
| 手持弹幕 | Web + 屏幕控制 | CSS transform 滚动 | 无 | ~4KB | P0 |
| 反应力测试 | Web | pointerdown + performance.now | 无 | ~3KB | P1 |
| MBTI 测试 | — | 不做 | 题库无可商用来源，MBTI 是商标 | — | 建议不做 |
| 对联生成 | — | 不做 | 现成对联库为 AGPL；无本地生成模型 | — | 建议不做 |
| 藏头诗生成 | Web | 从古诗库"集句"，不生成 | chinese-poetry（MIT） | 0.6~1.5MB（推测） | P2 |

体积列都是推测：Vue 单文件工具 gzip 后一般几 KB，等第一批工具实测后回填。

## 共用部件

### 1. 本地存储层 `web/src/shared/store/`
- **kv**：localStorage 存小状态（抽签选项、记分牌、番茄钟进行中的状态、各工具设置）。键名统一 `arkli:<工具id>:<键>`，值一律 JSON。自写，约 40 行。
- **db**：IndexedDB 存记录（账目、番茄钟完成记录）。用 `idb` 8.0.4 做薄封装：全 App 一个库 `arkli`，每个工具一个 object store，版本升级脚本集中在一个文件里，避免各工具各自 `onupgradeneeded` 打架。
- **backup**：统一导出/导入。导出格式 `{ app: "arkli", schema: 1, exportedAt, tools: { ledger: [...], pomodoro: [...] } }`，导出走 `native.file.save`（SAF 让用户选位置），导入走 `native.file.pick`。各工具只需实现 `exportData()` / `importData(json)` 两个函数。
- **数据会不会丢**：
  - 卸载、"清除数据"必丢，和原生文件一样。
  - "清除缓存"不会删 IndexedDB/localStorage（推测：WebView 存储在 `app_webview/` 下，不在 cache 目录，需真机验证）。
  - Chromium 在存储紧张时可能清掉非持久化 origin 的数据（推测）。启动时调一次 `navigator.storage.persist()`，WebView 是否生效未知。
  - `allowBackup=false`，系统云备份不管我们。所以记账这类数据**必须**有导出：记录满 50 条或距上次导出超过 30 天，在工具页顶部提示一次。
  - 存储按 origin 隔离，origin 就是 `https://appassets.androidplatform.net`。**这个域名以后不能改**，改了数据就全"丢"了（旧数据还在，只是读不到）。只改路径不影响。
- 为什么不放原生文件：记录量小，IndexedDB 够用，还能少设计一组 `native.store.*` 方法。要是以后真机上出现被系统清理的情况，再加原生落盘。

### 2. 提醒与通知封装（原生，`app/.../notify/`）
番茄钟和通知自己共用。原生只负责"到点发通知"，时间怎么算、文案是什么都由页面给。

| 方法 | params | data |
|---|---|---|
| `native.alarm.schedule` | `{ id, at, title, text, tool }`，`at` 为毫秒时间戳 | `{ exact: bool }`，告诉页面这次是不是精确闹钟 |
| `native.alarm.cancel` | `{ id }` | `{}` |
| `native.alarm.status` | 无 | `{ canExact: bool, notifyAllowed: bool }` |
| `native.alarm.openExactSettings` | 无 | `{}`，跳系统"闹钟和提醒"授权页 |
| `native.notify.post` | `{ id, title, text, ongoing?, countdownTo?, tool }` | `{}` |
| `native.notify.cancel` | `{ id }` | `{}` |
| 事件 `alarm.fired` | — | `{ id }`，App 在前台时推给页面 |

- 实现：`AlarmManager`。`canScheduleExactAlarms()` 为真用 `setExactAndAllowWhileIdle`，否则退回 `setAndAllowWhileIdle`，Doze 下可能晚几分钟。Android 14 起新装应用默认拿不到 `SCHEDULE_EXACT_ALARM`，没授权就调精确接口会抛 `SecurityException`（已查证，Android 14 行为变更页）。`USE_EXACT_ALARM` 只给闹钟/日历类应用，我们不申请。
- 倒计时通知用 `NotificationCompat` 的 `setUsesChronometer` + `setChronometerCountDown`（API 24 起，推测）。通知栏自己走秒，不需要后台进程。
- **不用前台服务**：Android 14 起前台服务要声明类型，番茄钟只能填 `specialUse`，上架 Play 要写理由；`shortService` 只有约 3 分钟。闹钟加倒计时通知已经够用。
- 通知渠道两个：`timer`（高重要性，带声音和震动）、`memo`（默认重要性）。点通知用 `PendingIntent` 打开 Arkli 并带上 `tool`，壳负责把 SPA 路由到对应工具。
- 已排的闹钟记在原生 SharedPreferences 里。是否开机恢复见"未决问题"。
- 依赖：`NotificationCompat`、`ShortcutManagerCompat` 都在 androidx.core 里，现有 `activity-compose` 会间接带进来（推测，以依赖树为准），预计不新增依赖。

### 3. 随机引擎 `web/src/shared/random.ts`
抽签、做决定、硬币、骰子、指尖轮盘共用。自写约 60 行：`crypto.getRandomValues` 取随机数；`int(min, max)` 用拒绝采样消除取模偏差；`pick` / `weightedPick` / `shuffle`（Fisher–Yates）/ `draw(n, { replace })`。没必要引库，单测覆盖分布均匀（大样本卡方检验）和边界。原则是**先定结果再播动画**，动画只是表演。

### 4. 数据集加载器 `web/src/shared/dataset.ts`
垃圾分类词典、快递单号规则、藏头诗句库共用。数据放 `web/public/data/<名字>.v<版本>.json`，随 assets 打进 APK（AAPT 会 deflate 压缩），运行时同源 `fetch` 加载，内存缓存。数据只随 App 版本更新，不做在线下发，所以不需要联网。自写约 30 行。

### 5. 短音效与震动
硬币、骰子、反应力测试、番茄钟页内提示音用 Web Audio 的 `OscillatorNode` 现场合成，不带音频文件。震动走公共基础设施 `native.haptic.vibrate`（`navigator.vibrate` 在 WebView 里是否可用、要不要 VIBRATE 权限没核实，推测可用，但走 bridge 更稳）。

## 逐工具方案

### 生活查询

**快递查询（含 Lite 版）**｜Web｜P2｜S
- 快递公司官方开放接口要商户账号，快递100 等聚合接口收费，没有合规的免费源（推测，未逐家核对）。所以不做真正的"查轨迹"。
- 降级做法：输入或粘贴单号 → 本地规则表识别可能的快递公司（顺丰 `SF` 开头、京东 `JD` 开头等，规则表自编，准确率推测，允许给出多个候选）→ 一键复制单号、跳官方查询页（`native.intent.openUrl` 交给外部浏览器，不需要 INTERNET）。最近查过的单号存 kv。
- Bridge：无专属方法；用到公共的 `native.intent.openUrl`、`native.clipboard.read/write`。
- 风险：单号规则会变，识别错了用户会觉得是 bug，界面要写"可能是"。价值偏低，排 P2。

**垃圾分类查询**｜Web｜P1｜S
- 数据：GitHub 上没搜到许可证清晰的垃圾分类词库（只有 GPL 的小程序和无许可证的爬虫数据）。改为**自编词典**：按各地公开的分类投放指南整理 1000 到 2000 条常见物品（规模推测），字段 `{ name, alias[], cat, tip }`。政府公开指南能否直接整理复用没有法律定论（推测），所以是"参考整理"，不是照搬原文。
- 分类以国家标准的四类为准：可回收物、有害垃圾、厨余垃圾、其他垃圾（标准号 GB/T 19095-2019，推测，落地前核对）。另放一张城市别名表，比如上海叫湿垃圾、干垃圾，用户选一次城市存 kv。
- 检索：完全匹配 → 别名 → 包含匹配。如果文本类工具已经引入 pinyin-pro，再加拼音首字母搜索，否则不加。查不到时给四类的判断口诀，并写明"以当地规定为准"。
- 体积：词典约 60KB 原文，gzip 后约 20 到 25KB（推测）。
- 测试：词典去重、分类字段合法的数据校验脚本；搜索命中率抽样。

**历史上的今天**｜建议不做
- 查到的最好来源是维基百科 onthisday 接口（`zh.wikipedia.org/api/rest_v1/feed/onthisday/events/MM/DD` 已实测可用），但：国内访问不了；单日响应约 335KB；内容是 CC BY-SA，政治类条目上国内商店审核风险高。
- 退路：从维基整理一份离线精选包（每天 10 条左右，约 300KB 原文，推测），署名并按 CC BY-SA 分发数据本身。人工筛选成本高，首版不做，放未决问题。

**手机号归属地查询**｜建议不做
- 两个主流开源号段库：xluohome/phonedata 是 GPL-3.0（数据停在 2023-02），ls0f/phone 没有许可证（数据停在 2023-12），都不能用于闭源商用（已查证，GitHub API）。另外携号转网让号段判断本身就不准。没有合规数据，不做。

**邮编查询**｜建议不做
- 没找到许可证清晰的邮编数据集。行政区划有 modood/Administrative-divisions-of-China（WTFPL，可用），但它不带邮编（推测，没逐文件核对）。用户需求也弱，不做。

**油价查询**｜建议不做
- 各地发改委按调价窗口发布，没有免费的官方接口；第三方聚合接口要么收费要么来源不明。为一个低频工具加 INTERNET 权限、外加自建服务，不划算。

**每日新闻**｜建议不做
- 在国内提供新闻需要互联网新闻信息服务许可（推测，以法规原文为准），内容源也要授权，跟工具箱定位不符。

**淘宝优惠券**｜建议不做
- 本质是导购返利，要淘宝联盟账号和服务端，合规和商店审核都麻烦，也和"轻便"无关。

### 效率与记录

**番茄时钟**｜Web + 原生｜P0｜M
- 页面：显示进度环，可设专注/短休/长休时长和轮数。状态 `{ phase, endAt, remainingMs, round }` 存 kv，**以 `endAt` 为准**，回到页面时重新算剩余时间，不依赖 JS 定时器在后台跑。
- 开始：`native.alarm.schedule({ at: endAt })`，同时 `native.notify.post({ ongoing: true, countdownTo: endAt })` 挂一条倒计时常驻通知。暂停：取消闹钟，记下剩余时间。到点：原生发响铃通知，前台时页面收到 `alarm.fired` 切下一阶段。
- 完成记录写 IndexedDB 的 `pomodoro` store，页面上只做"今天几个、本周几个"的统计，不画图表。
- 权限：`POST_NOTIFICATIONS`（Android 13+ 运行时申请，走 `native.permission.request`）；精确闹钟可选，`status` 返回 `canExact=false` 时提示"可能晚几分钟，去开启"，按钮调 `openExactSettings`。
- 风险：国产 ROM 划掉后台后闹钟可能被杀，要引导用户加电池白名单；测试用 `adb shell dumpsys deviceidle force-idle` 模拟 Doze，并在 MIUI/ColorOS/鸿蒙各测一台。

**极简记账**｜Web｜P1｜M
- 字段 `{ id, amountCents, kind: in|out, category, note, ts }`。金额存整数"分"，不用浮点。分类给 10 个左右默认项，可自定义（存 kv）。
- 视图：按月列表、月收支合计、分类占比。占比用 CSS 横条自己画，不引图表库。
- 存储：IndexedDB `ledger` store，以 `ts` 建索引。导出 JSON（可再导入）和 CSV（带 UTF-8 BOM，Excel 直接打开），统一走 backup 部件。
- 不做：预算、多账本、同步、图片附件。
- 测试：金额解析（"12.3"、"0.05"、负数、超长）、跨月边界、导出再导入数据一致。

**画板（绘画板）**｜Web｜P1｜S
- 清单写的是"屏幕涂画"，有可能是指在其他 App 上面的悬浮涂画（要 `SYSTEM_ALERT_WINDOW`），这一点不确定。悬浮形态**不做**，只做应用内画板。
- Canvas + Pointer Events，支持笔、橡皮、颜色、粗细、撤销/重做。撤销用笔画列表重绘，不存位图快照，省内存。压感用 `pointer.pressure`，没有就当 0.5。
- 导出 PNG：`canvas.toBlob` → 分块 base64 走页面上行通道写进缓存目录 → `native.file.save` 或 `native.share`。草稿（笔画 JSON）存 IndexedDB，只留最近一张。
- 风险：高分屏大画布占内存，画布按 `devicePixelRatio` 封顶 2 倍。

**记分牌（含多人）**｜Web｜P1｜S
- 2 到 8 人，每人名字、颜色、分数；加减步长可设（1/5/10）；保留操作历史，支持撤销。两人模式提供"面对面"布局，一半区域旋转 180°。
- 状态存 kv，杀掉 App 后能恢复。开着时保持亮屏（`native.screen.keepOn`）。

**通知自己**｜Web + 原生｜P1｜S
- 清单里说"机制不明"，可能是推送。这里按纯本地理解：写一条文字，立即发到通知栏（可选常驻，当便签用），或者定一个时间再发。
- 立即发：`native.notify.post`；定时：`native.alarm.schedule`，和番茄钟同一套封装。历史记录最近 20 条存 kv，方便再发一次。
- 跨设备推送（发到电脑、发到别的手机）不做，那要服务端。

**网页转应用**｜原生｜P2｜S
- 清单描述是"把网页做成安卓 App"，木函那边真的在手机上打 APK（推测）。手机上打包要模板 APK 加签名，体积和兼容性都麻烦，且清单里提到不适用 Android 8.0，说明本身就脆弱。**不生成 APK**。
- 轻量做法：填名字、网址、选图标（`native.file.pick` 选图片，或用首字母生成图标）→ `ShortcutManagerCompat.requestPinShortcut` 在桌面放一个快捷方式，点开用 `ACTION_VIEW` 交给默认浏览器。
- Bridge：`native.shortcut.pin { label, url, iconPath }` → `{ requested: bool }`。
- 局限：本质只是"带图标的书签"，没有独立窗口。要做独立窗口，得加 INTERNET 权限和一个专门加载外站的 WebView Activity（必须和工具 SPA 的 WebView 隔离，不能注入 bridge），放未决问题。
- 风险：部分国产 ROM 要用户手动开"创建桌面快捷方式"权限，失败时给引导文案。

**直链提取**｜建议不做
- 依赖网盘的私有接口，随时会失效，而且有违反网盘服务条款的风险。唯一来源是一篇旧文，大概率木函也已下线。

### 趣味与决策

**自定义抽签 / 做个决定 / 抛硬币 / 掷骰子**｜Web｜P0｜S
- 四项共用一个"随机决策"chunk 和随机引擎，首页仍按清单列成四个入口，路由到同一 chunk 的不同标签页，省得重复打包。
- 自定义抽签：多套签表（存 kv），可设权重、一次抽几支、抽过是否放回，带历史。
- 做个决定：转盘。用 SVG 画扇形，先由引擎定结果，再算目标角度做减速动画。选项超过 12 个时文字改成图例。
- 抛硬币：CSS 3D 翻转，可连续抛 N 次并统计正反次数。
- 掷骰子：1 到 6 颗，面数可选 4/6/8/10/12/20，显示总和；摇一摇触发不做（要传感器 bridge，不值）。
- 测试：引擎分布检验；不放回抽取抽到用尽时的提示。

**指尖轮盘**｜Web｜P1｜S
- 多人手指按在屏幕上，用 Touch Events 跟踪每个触点画光圈；触点数稳定 2 秒后由引擎选一个人，高亮加震动（`native.haptic.vibrate`）。
- 风险：部分 ROM 三指下滑是截屏手势，会抢触摸；各机型最大触点数不同（一般 5 点以上，推测）。真机要测 3 到 5 指。

**手持弹幕**｜Web｜P0｜S
- 输入文字，选字号、颜色、背景、速度，全屏横向滚动。用 `transform: translateX` 加 `requestAnimationFrame` 滚动，走合成层，不用 `left`。可选闪烁、霓虹描边。
- 需要原生配合：横屏（`native.screen.setOrientation`）、沉浸全屏（`native.screen.fullscreen`）、常亮（`native.screen.keepOn`）、可选调亮度（`native.screen.setBrightness`）。退出时全部恢复。
- 最近用过的文案存 kv。测试：长文本、emoji、低端机上是否掉帧。

**反应力测试**｜Web｜P1｜S
- 等随机 1.5 到 4 秒变色，用户点击，用 `pointerdown` 的 `event.timeStamp` 减去变色那一帧的时间（在 `requestAnimationFrame` 回调里记）。抢跑判负。5 次取平均，最好成绩存 kv。
- 说明：结果包含屏幕刷新和触控采样延迟，只适合和自己比，不同手机之间不可比，页面上写明。

**MBTI 测试**｜建议不做
- MBTI 是 The Myers-Briggs Company 的商标，官方题库有版权（推测）。常见的开源替代 OEJTS，官网没写许可证，只说"仅供教育或娱乐"；第三方实现称其题项是 CC BY-NC-SA 4.0（未在官网核实），不能商用。
- 退路：自己写题库，叫"16 型性格小测"，不出现 MBTI 字样。写题和校验题目效度的成本不小，首版不做，放未决问题。

**对联生成**｜建议不做
- 现成对联库 wb14123/couplet-dataset（70 万条）是 AGPL-3.0，不能用（已查证）。"生成"要语言模型，sherpa-onnx 不做文本生成，再引入 LLM 推理违反 0002 决策，体积也不轻便。服务端 AI 不做。

**藏头诗生成**｜Web｜P2｜M
- 不生成，做**集句**：从古诗库里挑首字匹配、字数一致（五言或七言）的现成诗句拼成一首，标注每句出处。这样没有 AI 生成内容的合规问题，也不需要模型。
- 数据：chinese-poetry（MIT，已查证）。构建期脚本抽五言/七言单句，按首字建索引，每字每种句式最多留 20 句，优先名篇。全唐诗原文是繁体（推测），构建时用 opencc-js 转简体，opencc-js 只作 devDependency，不进运行时包。
- 体积：0.6 到 1.5MB gzip（推测，需构建后实测）。超过 1MB 就再砍句数，或者干脆不做。
- 局限：不管押韵和平仄，读起来是"拼"的。可以加一条"同一首诗的句子优先、尾字同韵母优先"的简单打分（韵母用 pinyin-pro，前提是文本类已引入）。

## 新增依赖清单

| 名称 | 版本 | 许可证 | 用途 | 层 |
|---|---|---|---|---|
| idb | 8.0.4（npm，2026-10-06 更新） | ISC | IndexedDB 薄封装，存储层共用 | Web |
| chinese-poetry 数据 | 仓库 master（2026-06-17 推送） | MIT | 藏头诗集句的诗句来源，仅 P2 做时引入，构建期处理后只带裁剪结果 | 数据（构建期） |
| opencc-js | 1.4.2（选型清单已列） | MIT AND Apache-2.0 | 构建期把诗句转简体，devDependency，不进 APK | 构建脚本 |

- 原生侧预计不新增：`NotificationCompat`、`ShortcutManagerCompat` 来自 androidx.core，现有依赖间接带入（推测）。
- 垃圾分类词典、快递单号规则是自编数据，不算第三方依赖。
- 如果用户不想加 `idb`，可以自写 IndexedDB 封装，约 80 行，代价是事务和版本升级的边界情况要自己测。

## 对公共基础设施的需求

这里只列名字，具体设计由公共基础设施文档负责。

| 方法 | 用到的工具 |
|---|---|
| `native.permission.request`（POST_NOTIFICATIONS） | 番茄时钟、通知自己 |
| `native.file.save`（SAF 另存为） | 极简记账、画板、统一备份导出 |
| `native.file.pick` | 统一备份导入、网页转应用（选图标） |
| 页面 → 原生的大数据上行通道（如分块写缓存文件） | 画板导出 PNG、网页转应用图标 |
| `native.share` | 画板 |
| `native.clipboard.read` / `write` | 快递查询 |
| `native.intent.openUrl`（交给外部浏览器） | 快递查询 |
| `native.screen.keepOn` / `setOrientation` / `fullscreen` / `setBrightness` | 手持弹幕、记分牌 |
| `native.haptic.vibrate` | 指尖轮盘、硬币/骰子、反应力测试 |
| 通知点击后路由到指定工具（壳的 deep link） | 番茄时钟、通知自己 |

本文自带的专属方法：`native.alarm.*`、`native.notify.*`（见共用部件第 2 节）、`native.shortcut.pin`。如果公共基础设施那边也打算做通知，建议合并到一处，以本文的方法表为起点。

新增 Manifest 权限：`POST_NOTIFICATIONS`、`SCHEDULE_EXACT_ALARM`（可选，用户在系统设置里授予）。**不需要** INTERNET、前台服务、悬浮窗、存储权限。

## 对既定约束的异议
无。

两点补充说明，不算异议：
- architecture.md 写"要前台服务 → 原生"，番茄钟按这条本该做成前台服务。这里改用闹钟加通知，原因见共用部件第 2 节。
- bridge 协议规定"大数据只传缓存目录里的文件路径"，但没有定义页面怎么把字节写进缓存目录。画板导出依赖这一条，需要公共基础设施补上。

## 未决问题
1. **生活查询 6 项不做**：可以接受吗？做了，这个分类就只剩垃圾分类和快递（降级版）两个入口，首页可以考虑把分类合并。
2. **藏头诗要不要做**：多出 0.6 到 1.5MB 数据换一个趣味工具。建议先不做，等体积基线出来再定。
3. **历史上的今天 / MBTI 的退路**：分别是"维基离线精选包，要人工审核内容"和"自编题库"。都要持续投入内容，要不要排期？
4. **定时"通知自己"要不要开机恢复**：恢复需要 `RECEIVE_BOOT_COMPLETED` 权限和一个开机广播接收器。不加的话，重启后定时提醒就丢了，番茄钟倒无所谓。
5. **网页转应用要不要做独立窗口版**：要做就得加 INTERNET 权限和一个隔离的外站 WebView。不做的话，这个工具只是桌面书签。
6. **`idb` 引库还是自写**：默认引 `idb`（约 1KB gzip，推测）。
7. **垃圾分类词典谁来整理**：1000 到 2000 条，按哪几个城市的指南为准？建议先做国家四分类加上海、北京两地的别名。
