文档索引：docs/README.md

# Arkli 项目约定

- 一个安卓小工具聚合 App：体积小、功能多。名字取自 arca（箱子）+ kli（工具）。
- 三层架构：Compose 原生壳 / Rust 核心库 / WebView 里的 Vue SPA。分工见 docs/design/architecture.md。
- 沿用本目录现有命名：Kotlin 包 `com.let188.arkli`，Rust crate 前缀 `arkli-`，前端目录 `web/`。
- 每个方法、属性、函数、类都写简短中文注释；公共 API 要有参数、返回值、示例。
- 同一字面量出现两次以上提取常量；新函数/模块要有单测。
- 颜色选择一律用 `web/src/shared/ColorPicker.vue`（`<color-picker v-model="hex" label="…" />`），禁止直接写原生 `<input type="color">`：Android WebView 里它只弹 8 色小框。`color-picker.test.ts` 会扫描拦截。
- AI 模型的下载、取消、删除、校验只归 AI 中心；模型选择器只负责触发下载；业务工具页只读状态、只使用和展示（状态一律读 `web/src/stores/models.ts`，由原生推送实时更新，禁止轮询或自行调 native.model.*）（未就绪时只提示先下载，不指定入口位置），不得出现 ensure/cancel/remove/verify、下载进度、下载错误文案等代码。详见 docs/design/model-picker.md。
- 所有模型在引入时都必须支持取消：推理在解码步/分段等循环里检查取消令牌，取消后抛 `CancellationException`（桥上回 `CANCELLED`），并保证取消后下一次调用能正常跑、会话不残留。新模型要带“取消后可再生成”的单测，并上真机实测取消延迟。只有一次前向、没有循环可插检查点的模型（如 CLIP 识物）无法中途打断，要在文档里写明。已有做法见 `docs/design/ai-protocol.md`。
- 拍照、录视频、相册选图/选视频一律用原生自带组件（`captureCamera` / `native.file.pick` 的自带选择页），禁止系统选择器、系统相机意图和 WebView 的 `<input type=file capture>`；Web 端 `<input type=file>` 只作无宿主（桌面调试）的兜底。
- 模型选择器 `<model-picker>` 一律用默认插槽（组件自带的 AI 图标按钮），不要传自定义触发器插槽，除非用户明确指定。
- 只改了 `web/` 下前端代码时，不要 `build:app`、重装 APK、重启 App，直接用 web 的 HMR 热更新（用户常开着 `pnpm dev:device`，5173 端口，先 `curl` 确认在不在；在就只改文件，页面没连上 vite 时只 `location.reload()` 一次）。只有改了 Kotlin、manifest、原生资源才重新装机。详见 docs/status.md 的「真机热更新」。
- `<van-notice-bar>` 一律写 `wrapable :scrollable="false"`（多行显示、不滚动）。注意 prop 名是 `wrapable`，写成 `wrap-able` 无效；`vant-usage.test.ts` 会拦截。
- 引入新第三方依赖前先问用户，待确认清单在 docs/status.md。
