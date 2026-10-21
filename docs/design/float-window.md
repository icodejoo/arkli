---
title: 浮窗（微信小程序式 App 内浮窗）
status: draft
updated: 2026-10-21
summary: 第 1 阶段公共基础设施：全局单浮窗、ToolView 保活状态机、圆球与投放区、暂停/忙碌接口、限制与各工具适配清单
---
# 浮窗

状态：draft（第 1 阶段代码、单测与真机验证完成）。

## 产品定稿

1. 全局只有 1 个浮窗。再浮另一个工具时弹确认“已有浮窗「X」，浮起新的会关闭它”，确认后替换，旧实例销毁。
2. 所有工具都能浮；入口只有工具页胶囊“…”分享面板里的“浮窗”（图标 Lucide `picture-in-picture-2`）。
3. 浮起后回到上一页（无历史回首页），出现可拖动圆球（显示工具 emoji 图标），松手吸左右边缘，位置存 localStorage（不可用则只在内存）。除该工具自己的页面外都显示；层级 100，高于底栏/操作栏，低于 Vant 弹层（2000+）。
4. 点圆球 `router.push('/tool/<id>')`，缓存实例重新挂回（状态保留），浮窗状态清空。
5. 拖动时底部中间出现“取消浮窗”投放区，进入后放大变红；在其中松手即关闭浮窗并销毁实例，否则吸边。
6. 不持久化：刷新、重启后没有浮窗。
7. 暂停：浮起期间工具收到 `onDeactivated`，点回来收到 `onActivated`。
8. 有不可暂停任务（busy）时点“浮窗”只 toast“任务进行中，暂时不能浮窗”。

## 缓存方案

- `App.vue` 外层 `keep-alive` 的 include 加入 `ToolView`：离开工具页时 ToolView 实例不卸载，只停用。
- ToolView 内部不再用一个 keep-alive，而是 `ToolStage`：对 `live` 列表里的每个 id 各放一个独立 `keep-alive`，只有前台那个渲染内容（`ToolHost`，同时给子树注入工具 id）。把 id 从 `live` 去掉，对应实例就被卸载（触发 `onBeforeUnmount`）。
- `live` 由 `useLiveTools`（`shared/floatLive.ts`，纯函数 `reconcileLive`）维护：
  - 进入工具页（激活或 id 变化）：当前 id 入列；如果它正是浮窗工具，`restore()` 清空浮窗；非浮窗的历史实例最多保留 3 个（取色器 → 颜色助手再返回仍保留状态），前台与浮窗永不被挤。
  - 离开工具页：`current = null`，等 App 在离开转场结束（`notifyToolPageLeft`）后再裁剪，只留浮窗，避免动画中途内容消失。
  - 浮窗被关闭或替换：旧浮窗立即从 `live` 去掉（它正在前台则保留）。

### 状态机

```
未浮起 --点浮窗(确认后)--> 已浮起(A 停用存活, 圆球显示)
已浮起 --点圆球/任何方式进入 /tool/A--> 未浮起(A 前台, 恢复)
已浮起 --投放区松手--> 未浮起(A 销毁)
已浮起(A) --在 B 里浮 B(确认)--> 已浮起(B), A 销毁
已浮起(A) --打开 B 再离开--> 已浮起(A), B 离开转场后销毁
刷新/重启 --> 未浮起（不持久化）
```

深链/刷新直接进 `/tool/A`：浮窗状态本来就是空的，行为与以前一致。

## 暂停与忙碌接口（`shared/useFloatPause.ts`）

```ts
// 持有计时器、音频、传感器、相机的工具：浮起时停，回来时恢复
useFloatPause({ pause: () => ctx.suspend(), resume: () => ctx.resume() })
// 有不可暂停任务时汇报（用 BottomActions 的 mainLoading 的页面已自动汇报）
useFloatBusy(() => recording.value)
```

- `pause` 与 `resume` 严格交替：重复停用不重复 pause，首次挂载的激活不 resume。停用后若被销毁，只走 `onBeforeUnmount`，不会 resume。
- 注意：工具之间互跳（A → B，A 仍保活）同样会触发 A 的 pause，回来 resume，这是想要的行为。
- busy 按来源计数，同一工具多个来源互不覆盖；组件卸载自动撤销。

## 限制

- 工具页的滚动位置不保存（回到浮窗工具时从顶部开始，页面内部滚动容器不受影响）。
- 被停用的工具子树里的 teleport 内容随之收起；弹层类内容如在浮起时仍显示，行为取决于工具，适配时检查。
- 没接 `useFloatPause` 的工具浮起后计时器等仍在后台跑，所以第 2 阶段必须按下表逐个接。
- 所有页面（含 AI 中心）共用同一个圆球位置。

## 适配清单（第 2 阶段待接，grep 扫描结果，接入时再逐个确认）

共 21 个工具，按 `web/src/tools/<id>/` 下源码的特征扫出：

| 工具 id | 持有的资源 | 建议的 pause / resume | 可能 busy |
|---|---|---|---|
| pomodoro | setInterval 计时，keepAwake/闹钟 | 暂停：停 tick、释放唤醒锁（闹钟按已有逻辑保留）；恢复：按剩余时间重算并重开 tick | 否 |
| white-noise | AudioContext、setInterval 定时关闭 | 暂停：ctx.suspend 与计时；恢复：resume | 否 |
| notify-self | setInterval | 停/开轮询 | 否 |
| roll-call | setInterval 滚动 | 停/开滚动 | 否 |
| dice | setInterval 动画、音效 | 停动画 | 否 |
| coin-flip | 音效 | 停音效 | 否 |
| morse | 音频播放 | 停止播放 | 播放中可视为 busy |
| minesweeper | setInterval 计时 | 暂停计时，恢复继续 | 否 |
| device-info | setInterval 刷新（仅开启“每 3 秒自动刷新”时；实测无传感器订阅） | 【已接入】`createPausableInterval`：暂停清定时器，恢复若原先开着则重开并立刻刷新一次 | 否 |
| compass | deviceorientation / deviceorientationabsolute 订阅、屏幕常亮 | 【已接入】`session.pause/resume`：暂停取消订阅并释放常亮，恢复重订并重新常亮 | 否 |
| level | devicemotion 订阅 | 【已接入】`createPausableListener`：暂停取消订阅，恢复重订；校准零点、锁定读数在组件状态里不丢 | 否 |
| protractor | devicemotion 订阅（仅“倾角”模式） | 【已接入】`createPausableListener`：暂停取消订阅（不清锁定读数），恢复仅在暂停前正在监听时重订 | 否 |
| noise-meter | 原生麦克风采样、requestAnimationFrame 重绘 | 【已接入】`createPauseGate`（串行化）：暂停取消订阅、取消 rAF、`stopNoise` 释放麦克风，统计与折线保留；恢复重订并继续累计；授权弹窗期间被暂停则推迟到恢复再启动 | 测量中主按钮 loading 自动汇报 busy（测量中浮窗被拦，只能经导航离开触发暂停；若要测量中也能浮，需 BottomActions 提供不汇报 busy 的开关） |
| ruler | requestAnimationFrame | 停 rAF | 否 |
| sketchpad | requestAnimationFrame | 停 rAF | 否 |
| meme-maker | requestAnimationFrame | 停 rAF | 导出中可 busy |
| speech-to-text | 语音识别会话、setInterval 计时 | 【已接入】`sttPausePlan`：识别不能无损暂停，录音中经导航离开时直接收尾保留文本（启动中则启动完立即收尾），恢复不自动重录 | 录音中主按钮 loading 自动汇报 busy，不能浮起 |
| waste-classify | 无常驻相机预览（`captureCamera` 原生拍照页）；识别期间 500ms 忙碌计时（finally 清除） | 【已核实无需暂停】仅加 `useFloatBusy(() => busy)`：CLIP 单次前向不可打断，识别中不能浮起 | 识别中 busy |
| bead-pattern | 无常驻相机预览（`captureCamera` 原生拍照页），无计时器 | 【已核实无需接入】生成中由主按钮 loading 自动汇报 busy | 生成中 busy（自动） |
| image-palette | 无常驻相机预览（`captureCamera` 原生拍照页）；长按取色仅 400ms 瞬时计时 | 【已核实无需接入】解析中由主按钮 loading 自动汇报 busy | 解析中 busy（自动） |
| translate | 无常驻相机预览；已有 `onDeactivated` 取消翻译 + `useModelWarmup` 离开卸载模型/回来重热 | 【已接入】无需新增暂停；加 `useFloatBusy(() => photoBusy)`，拍照翻译处理中不能浮起（停用会中止它） | 文字翻译（主按钮 loading 自动）、拍照翻译处理中 |

分类汇总：计时器/动画 12（含 pomodoro、minesweeper、dice、roll-call、notify-self 等）、音频 4（white-noise、morse、coin-flip、dice）、传感器 4（compass、level、protractor、device-info）、相机 4（bead-pattern、image-palette、translate、waste-classify）、麦克风/语音 2（noise-meter、speech-to-text）、rAF 4（meme-maker、noise-meter、ruler、sketchpad）；同一工具可属多类。

## 真机验证记录（2026-10-21，STG-AL00，debug 包 + vite HMR，CDP 驱动 + adb 真实触摸）

样本 pomodoro（临时接了 `useFloatPause` 记日志，已还原）。截图在 `E:/workspaces/arkli-verify/float/`。

| 步骤 | 结果 |
|---|---|
| 打开工具、改专注分钟（输入状态） | 通过（01、02） |
| 胶囊“…”面板含“浮窗”，5 个一行（5 + 3） | 通过（03） |
| 点浮窗：回首页、出现番茄圆球，日志 `setup, pause` | 通过（04） |
| 拖动吸边：吸到左边缘，位置存 localStorage | 通过（05） |
| 拖动时底部出现“取消浮窗”，进入后放大变红；松手关闭，日志 `unmount` | 通过（06，暗色 14、15） |
| 点圆球回原工具：路由 `/tool/pomodoro`、圆球消失，日志 `setup, pause, resume`（无第二次 setup，状态保留） | 通过（07） |
| 浮 pomodoro 后在 dice 里浮 dice：弹“已有浮窗「番茄时钟」，浮起新的会关闭它”，确认后 pomodoro `unmount`，圆球变掷骰子 | 通过（08~10） |
| busy 时点浮窗：toast“任务进行中，暂时不能浮窗”，不浮起 | 通过（11；busy 用 store 注入，BottomActions 自动汇报由单测覆盖） |
| 暗色：面板、圆球、投放区可读 | 通过（12~15） |

内存 `TOTAL PSS`（KB）：打开工具 985,117 → 浮起 988,368 → 取回 991,766 → 替换后 989,290 → 暗色关闭后 991,327。多轮浮起、关闭、替换后只有约 +6MB 的缓慢漂移，没有随次数线性增长。

真机发现并修复的问题：圆球默认纵向位置在模块初始化时用 `innerHeight` 计算，WebView 刚加载时它可能还很小，圆球贴在顶部（y≈67）。改为渲染时再按当时屏高算默认值，复测 y=475。

## 文件

`stores/float.ts`、`shared/floatLive.ts`、`shared/ToolStage.ts`、`shared/ToolHost.ts`、`shared/useFloatPause.ts`、`shared/floatBall.ts`、`shared/FloatBall.vue`；改动：`App.vue`、`views/ToolView.vue`、`shared/pinToolSheet.ts`、`shared/shareSheetIcons.ts`、`shared/BottomActions.vue`。
