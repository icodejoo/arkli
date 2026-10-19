---
title: 当前状态与待办
status: active
updated: 2026-10-19
summary: 接手入口：做到哪、已拍板什么、验证到什么程度、下一步按顺序做什么、技术债、本机环境与工作约定
---
## TL;DR
- **AI 参数微调步 1~3（2026-10-19，真机已验）**：原生 `AiParams.kt`（`AiParamSpec` / `AiTunable` / 校验 / 桥处理）、`AiParamStore.kt`（SharedPreferences `ai_params`，只存与默认不同的值）、`AiParamDefaults.kt`（dispatch 前补参：显式传参 > 用户设置 > 内置默认）；桥方法 `native.ai.params.get/set/reset`（只主 frame，非法整批 `BAD_PARAMS`），`native.ai.providers` 条目可选 `params`。已声明：Qwen 温度/topK（只作用于 prompt 预设）与回答长度 128/256/512（不影响翻译）、NLLB 束宽（select 带 `optionValues`，存真实值 1/2/4）、对联温度/topK、识物 topK。Web：`aiParamsGet/Set/Reset`、`stores/aiParams.ts`、`ModelParamsPanel.vue` + `ModelParamRow.vue`，接进 `ModelSourcesSheet`（已安装且有 `params` 才显示）；`aiParamsScan.test.ts` 禁止工具页引用参数接口。6 个 Service 有 `settingsKey` 会话指纹钩子，`settingsKey` 指纹已在步 4 接上。**步 4 已完成（2026-10-19，真机待验）**：伪提供者 `mnn`（`AiMnnParams`，`numThread` 1~6 默认 4，session）+ AI 中心“MNN 基础参数”入口（`MnnParamsSheet.vue`）；5 个 Android 后端读它的线程数，Qwen 走包装 config（`QwenConfigWrapper`，不改 JNI）；6 个 Service 的 `settingsKey` 已接指纹。**步 5/6 已完成（2026-10-19，真机待验）**：伪提供者 `mnn` 加 `power` 性能模式（只留均衡/性能；省电与计算精度经真机实测后已去掉，见下）；C ABI 升到 2（`arkli_mnn_config.power`），Rust `MnnConfig::with_power` + UniFFI `mnnSetRuntimeOptions(power)`，5 个后端 `*Load` 前下发；Qwen 走包装 config，另加 session 级 `topP`（0.5~1.0，默认 0.95）与重复惩罚（1.0~1.3，默认 1.1），只对自由问答（混合采样）生效。**新 `libarkli-mnn.so`（73,176 B，sha256 `accbe024…bc2`）尚未上传 release**：`app/build.gradle.kts` 已指向 `mnn-478c10e-v4`，现靠 `.gradle/arkli-mnn` 缓存构建，上传 v4 时要连同 `libMNN.so`、`libsherpa-mnn-jni.so` 三个一起放；**实测结论（2026-10-19，用户已拍板）**：真机实测（STG-AL00，4 大 4 小核，无 fp16，MNN_ARM82=OFF）：性能(High)对均衡(Normal)，Qwen 校对热态约 4.8 s 对 4.8 s、NLLB 约 0.93 s 对 0.94 s，无收益；省电(Low) Qwen 约 10.2 s、NLLB 约 2.1 s，且切回均衡后不恢复（约 9.0 s / 2.1 s），原因是 MNN 线程池全局、重载不重建，Low 把线程绑到小核（Cpus_allowed_list 0-3），Normal 不绑核所以沿用旧绑定，切到 High 会主动绑大核才能恢复；精度高对普通无差别（本构建无 fp16 内核）。故只留均衡/性能两档、精度整项不开放；换有 fp16 的机型或修 MNN 线程池绑核后可再评估。**未做**：步 7 OCR/识物阈值；步 8 抠图 `RefineStrength` 并入。**真机（STG-AL00 debug）**：桥上越界值整批拒绝、原值不动，SharedPreferences 只存改过的键；对联温度设 0 后换 3 个种子输出一致，恢复默认后又发散；NLLB 束宽“精细”同一句约 3.2 s（快速约 0.9 s，且快速档把长句截短了），页面显式传 `numBeams: 1` 时不受用户设置影响；详情弹窗在暗色下渲染正常，点档位出现单项重置、恢复默认清空存储，未安装的 Qwen 不出参数区。**仍未验**：Qwen prompt 温度（设备上没装 Qwen）、识物 topK 实际调用。另记：Qwen3.5 官方非思考推荐值（temperature 1.0 / top_p 1.0 / presence_penalty 2.0）与项目现值（top_p 0.95 / penalty 1.1 / prompt 温度 0.7）不同，是否改回要真机比质量。设计见 [统一 AI 协议](design/ai-protocol.md)「参数调整」与 [调研](research/model-tunable-params.md)。
- **抠图工具上线（2026-10-19，真机已验，未提交）**：新任务 `matting`（`native.ai.matting`，两个提供者 `local-matting-portrait` MODNet fp32 / `local-matting-general` U2Net-p f16）+ 页面 `web/src/tools/matting/`。真机 STG-AL00：1024×683 约 1.1 s，4000×3000 收敛到 3072 约 2.6 s，取消约 0.5 s 生效且可立刻再跑，alpha 与桌面 ORT 对拍均值差 <0.01。Rust 全量、Kotlin 863、web 2298 个测试通过。**模型 release `matting-modnet-mnn-v1` / `matting-u2netp-mnn-v1` 未发布，`models.json` 的 URL 是占位，待用户确认后上传**。**边缘细化（同日，真机已验，未提交）**：输出 RGB 改用 Blur-Fusion 去污染前景色、alpha 过引导滤波与对比度曲线，结果多一个 `refineMs` 字段；pymatting 参考指标 M1 45.9→19.5、M2 13.8→6.4；真机 3072 长边细化约 140~190 ms。详见 [抠图](design/tools/matting.md)「边缘细化」。真机装机提示：设备上的 debug 包已按本机 keystore 重装过，现在 `adb install -r` 可直接覆盖（2026-10-19 复核）。
- **选图页内编辑（2026-10-16，已替代“选完自动跳编辑页”）**：编辑入口改在原生选图页的全屏预览里（铅笔按钮，可还原），多选也支持；所有图片选择默认开启全部模式（裁剪+旋转+形状+套索），`edit` 参数语义改为“允许的模式”，`[]`（`EDIT_NONE`）关闭，编辑后的图不带 sourceHandle，详见 platform-infrastructure.md「选图页内的编辑」。编辑页缩放只动图片、框固定在屏幕上，框允许超出图片，超出部分导出为透明并输出 PNG。下面是各页 edit 参数的历史接入记录：常量在 `shared/image-io.ts`（`EDIT_BASIC`=裁剪+旋转，输出 JPEG；`EDIT_FULL`=再加形状+套索，输出透明 PNG）。EDIT_BASIC：bead-pattern、face-fusion、id-photo、image-base64、image-upscale、image-grid、image-search、image-palette、ocr、colorize、object-count、phantom-tank、qrcode-scan（相册识图）、waste-classify、table-extract。EDIT_FULL（后续流程会先铺底色或保存 PNG，透明安全）：image-frame、meme-maker 底图、qrcode-gen 中间图。多图页（image-compress/stitch/watermark/gif-tool/translate 拍照翻译）、视频页、image-viewer 不接；拍照入口不走编辑页。
- **工具页底部动作栏全量接入（2026-10-16）**：约 60 个工具页的主操作迁到 `shared/BottomActions.vue`（`<bottom-actions>`，必须显式 import）。约定：主按钮 = 生成/转换/识别/查询/复制结果等核心动作，处理中可取消的会把主按钮切成「取消」（danger）；有选图入口的页用 `album`（原相册选图）+ `photo`（新增 `shared/shootPhoto.ts`，有宿主走 `captureCamera`，无宿主退回浏览器选图）；保存/复制/分享等结果动作放默认插槽的图标项（`<i-arkli-save />`）。纯选图页（对象计数、图片查看、取色）用「相册 + 红色主按钮拍照」。第二批又接入 clock-screen、level、protractor、folder-clean、idiom、exchange-rate、text-process、personality-test、reaction-test；仍未接入的是实时计算、纯参考类和 compass 等无主操作页面。新增 `tools/templates.test.ts`：编译所有工具页模板（并要求用了 `<bottom-actions>` 的页必须 import 它）。同时修了 compass / decide / id-photo / solid-gradient 里 tool-card 批量替换留下的标签不配对。浏览器（5173）冒烟 66 页均渲染出动作栏，真机上栏位置、键盘弹起时的表现未验。
- **底部动作栏注册表（2026-10-16）**：`web/src/shared/bottomActions.ts` 的 `BOTTOM_ACTION_REGISTRY` 是内置动作唯一来源（选图 ai/album/photo/paste/import → 编辑 edit/undo/redo/add/selectAll/clear/reset/sample → 输出 copy/save/download/export/share/print → 查看 preview/fullscreen/search/history/favorite/refresh → 播放 play/pause → 其他 settings/help/delete(danger) → main），默认全关。用法：`<bottom-actions :actions="['copy','save']" />` 或 `:actions="{ save: { disabled: busy, text: '保存全部' } }"`，点击发同名事件（`@save`）并统一发 `@action(key)`；旧布尔 props（ai/album/photo/main、mainText 等）仍可用。具名插槽（`#save` 等）整项替换；图标项（不含 ai/main）超过 `maxVisible`（默认 4，0/Infinity 关闭）自动收进「更多」弹层。新增内置项只需在注册表里加一行（key/text/icon/group），事件、插槽、类型自动生成；图标统一用 Lucide（ISC 协议；缺的才用同风格 tabler，MIT）：`curl --ssl-no-revoke -o web/src/assets/icons/<名>.svg https://api.iconify.design/lucide/<名>.svg` 存进 assets/icons（零依赖），注册表写 `icon: 'arkli:<名>'`，再在 `shared/bottomActionIcons.ts` 的映射表加一行 import + 一项（`bottomActions.logic.test.ts` 会查每个 key 都有映射）；页面传 `icon` 字符串仍按 vant 图标名透传。纯函数 `normalizeActions` / `splitCollapsed` 的单测在 `bottomActions.logic.test.ts`（Windows 大小写不敏感，不能叫 bottomActions.test.ts）。
- **Qwen 与翻译支持真取消（2026-10-16）**：Qwen 在 JNI 里用原子标志加自定义输出流，每个 token 检查并把 MNN 状态置 `USER_CANCEL`；NLLB 在 Rust 每个解码步与句子片段前检查 `CancelToken`（`translate_cancel`）；Kotlin 侧 `runCancellable` 在协程取消时调 `backend.cancel()`，桥回 `CANCELLED` 并释放 `AiHeavyGate`。Rust 全量与 Android 单测通过，JNI 用 NDK 28 编译通过；**真机未验**，且 `libarkli-mnn.so` 需重编上传（重编后更新下方 release 清单里它的大小与 sha256）。设计见 [统一 AI 协议](design/ai-protocol.md) 第 7 步。
- **M9 完成（2026-10-16）：ORT 与 sherpa-onnx 整体移除**，全部本地模型走 MNN（识物 `siglip2-mnn-w8`、翻译 `nllb600m-un6-mnn-w6`、语音 sherpa-mnn `asr-zipformer-zh-en-mnn-w8`、OCR `ppocrv6-small-mnn-fp16`、文本 Qwen）。debug APK 57,923,226 → 49,426,775 字节（-8,496,451），`libonnxruntime.so` 与 `libsherpa-onnx-jni.so` 已不在包里；旧模型目录登记进 `models.json` 的 `retired`。明细见 [onnx-to-mnn-migration.md](research/onnx-to-mnn-migration.md) 的“M9 落地情况”。**待办**：M9 后的 `assembleRelease` 体积没测；清单里 MNN 模型与运行库的 release 上传（见下面“待确认”）仍待用户。
- **自转模型单包安装（2026-10-19）**：7 个自转模型各打成一个 zip（`pack.py --zip`），清单改为 `archive` + 解压后 `files`，App 下载后自解压（沿用数据包流程，旧格式仍兼容，启动清扫解压残留），详情弹窗只显示“一个包”的信息。zip 已上传各 release（matting 两个 release 新建），线上回验通过，真机实测见 [模型下载管理](design/model-download.md)「单包安装」。Qwen3.5 是第三方现成权重，未转。**未提交**。
- **对联页重做 + 语料数据包（2026-10-16）**：对联页改为「随机 / 对下联 / 大模型」三模式；73.6 万副语料做成数据包（zip deflate -9，33,070,763 B）按需下载，原生解压并逐文件校验（清单新增 `kind: "pack"`），`native.corpus.couplet.*` 随机访问，前端固定步长置换做不重复随机。真机（STG-AL00 debug）：adb 放 zip 后 `ensure` 约 2 秒解压完成，随机抽取与画布渲染正常。详见 [对联语料库与对联页](design/couplet-corpus.md)。**未验证**：真实 release 下载、对下联与大模型模式的真机效果。
- **协议 v2、文件三件套、联网最小切片、原生图片压缩**已落地并在真机验证；`arkli-ai`（OCR 管线）只做了宿主侧，没进 APK。
- **2026-10-13 盲做冲刺（无真机）**：工具注册表由 25 增到 **90 个**（见 [落地跟踪表](design/rollout-tracker.md)）。新增原生能力：系统能力（剪贴板、分享、设置、Intent、震动、屏幕、设备信息、权限）、提醒与闹钟、系统 TTS、桌面快捷方式、应用管理、`native.net.*`（http/resolve/tcp/whois/speed，含 SSRF 防护）、原生全屏图片预览与自带多选图片页、返回键先关浮层。**这些全部只过了编译与单测，没上真机**，见跟踪表末尾的"待真机验证"清单。
- **底部 tab 导航（2026-10-14）**：首页 / AI / 收藏 / 设置四个根 tab（`van-tabbar` route+replace），tab 之间淡入淡出，进 `/tool/:id` 仍推入、返回回到来的 tab，工具页无底栏；四页 keep-alive 并按路由名还原滚动；`ToolMeta.tags`（`'ai'`）驱动 AI 页，收藏存 localStorage（`stores/favorites.ts`），工具页导航栏右侧星标切换。首页原右上角设置入口已移除（设置现为 tab）。真机 safe-area 与底栏高度待在手机上看。
- **长按图标添加到桌面（2026-10-14）**：首页任意工具长按 500ms → 底部菜单“添加到桌面” → `native.shortcut.pinTool`（`label/icon/route`，路由只认 `/tool/<id>`）。图标用工具 emoji 画在浅灰圆角底上，点桌面图标直达 `#/tool/<id>`（`MainActivity` 改 `singleTop`，冷启动走 `startRoute`，热启动走 `onNewIntent`）。STG-AL00 真机验证：长按弹菜单且不误进页面、系统确认框图标与名称正确、冷/热启动均直达、单实例。已知：从快捷方式冷启动进工具页后按返回直接回桌面（不经首页）。另修闹钟：补声明 `SCHEDULE_EXACT_ALARM`，被拒时降级非精确闹钟。
- **二维码扫码原型（2026-10-14）**：`native.qrcode.scan`（Compose 全屏取景 + CameraX `ImageAnalysis` Y 平面 + zxing-cpp，闪光灯，相机权限）、`native.qrcode.decodeImage`（相册图，选项全开）、web 工具页 `qrcode-scan`；CameraX 1.5.3、zxing-cpp 3.1.1 已获批准。**只过编译与单测，未上真机**。zxing-cpp 3.1.1 由 Kotlin 2.3 编译、会把 kotlin-stdlib 拉到 2.3.20，所以 Kotlin 插件从 2.1.21 升到 2.3.20（`kotlinOptions` 改 `compilerOptions`）。release APK 2,501,582 → 4,917,628 字节（+2.4MB，其中 so 1.75MB 以未压缩存入，dex +0.7MB），口径见 [落地跟踪表](design/rollout-tracker.md)。
- **识物第 1 步：ORT 接入 + `native.ai.classify`（2026-10-14）**：App 里首次有了 ORT。Rust `arkli-ai` 新增 `clip`（PIL 同款抗锯齿 bilinear 缩放 → 归一化 → SigLIP2 `q4_half` 推理 → L2 向量）与 `classify`（182 条英文词表、`softmax(100×余弦)` 按分类聚合、置信度 <0.8 判“拿不准”），经 `arkli-ffi` 的 UniFFI 暴露；Kotlin 新增 `LocalClipProvider`（`local-clip`）、`ClipService`、`AiHeavyGate`（重任务互斥）、桥方法 `native.ai.classify`；web 加 `aiClassifyImage()`（旧 `aiClassify` 与 `image-classify` 页已在第 3 步删除）。**真机 STG-AL00 验证**：裸名 `libonnxruntime.so` 在 APK 进程内从 APK 直接映射并推理成功；8 张图 top-3 物品 id 与 PC 完全一致，余弦差 ≤0.0015，单张约 1.0 s；首次加载约 +0.7 s，进程峰值 RSS +约 107MB。词表随包（`assets/ai/`，生成脚本 `tools/ai-vocab/`），**分类仍是草稿，待对照官方指引核对**。模型文件本步不下载（debug 用 adb 放进 `filesDir/models/siglip2-q4_half/`），第 2 步做下载管理。详见 [桥协议](design/bridge-protocol.md) 的 AI 提供者方法。
- **识物第 2 步：通用模型下载管理 `native.model.*`（2026-10-14）**：随包清单 `assets/ai/models.json`（信任锚，页面只传 id 不传 URL）+ 原生 `ModelManager`/`ModelDownloader`（只用 `HttpURLConnection`，Range 续传、多源回退、逐跳校验重定向、空间 1.2 倍检查、sha256 校验后原子改名、取消保留 `.part`、重试退避、同一模型单任务），桥方法 `list/status/ensure/cancel/remove/verify`（轮询 `status`，无事件推送），前端 `model.ts` 与 `useModelState`；`native.ai.providers` 的 `local-clip` 增 `modelId/downloaded/sizeBytes/downloading`，可用性改为“已安装且校验通过”，`remove` 会先 `clip_unload`。`NetPolicy` 新增独立的 `DOWNLOAD_HOSTS`（`github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`），不进页面 CSP。**测试**：Kotlin 全量 518 个通过（新增 59 个：下载器 25、管理器 17、清单与策略 17），web 138 个文件 1962 个通过，`vue-tsc` 通过。**真机 STG-AL00（debug 包 + 本机 Range 服务 + `adb reverse`）**：中途掉线与取消后均按 `Range` 续传到完整、sha256 与清单一致，服务器忽略 Range 时从头来，篡改 1 字节被 `HASH_MISMATCH` 拒绝，下载后 `native.ai.classify` 跑通，`remove` 后回到未安装并可再次下载；release 包无 debug 钩子、无明文放行。**未验证**：GitHub release 的真实 302 链路（**托管 release 尚未发布，清单里的 URL 是占位**）、移动网络、后台被杀后的续传、空间不足的真机路径（仅单测）。**未做**：多连接分片、前台服务、清单签名。设计见 [模型下载管理](design/model-download.md)。
- **识物第 3 步：Web 工具页 `waste-classify`（2026-10-14）**：替换旧 `image-classify`（旧 `aiClassify`、页面、`native.ai.status` 的前端消费都已删，原生 `native.ai.status` 保留）。流程：未安装→下载引导（计费网络先确认、进度/速度/取消续传、错误码转人话）→选图→识别→顶部大字分类 + top-3 点选采纳（拿不准不给强结论）→易混提示→删除模型。**App 接入完成（待发布模型）**。真机 STG-AL00 走通：删除→下载（本机 Range 服务）→选图→识别→点候选→删除确认；仅相册选图，没有 `native.camera.capture`。词表分类仍是草稿，页面底部固定“仅供参考”小字。
- **模型选择器（2026-10-15）**：带 ai 标签的工具标题栏右上角统一出现模型选择器（`shared/ModelPicker.vue`），四种状态（普通/着色/置灰/loading）、未下载点击即下载并弹可跳转 `/ai` 的提示；`useModelChoice(toolId)` 记忆每工具选择；L2/L4 占位「未接入」，L3 探测不到就隐藏。**只做选择与展示，不改推理引擎**；真机未验证。设计见 [模型选择器](design/model-picker.md)。
- 仍缺：视频压缩/提取音频/转 GIF 的 Media3 替换（平台 API 版已有）；OCR/超分/识别/抠图/融合/上色（页面已做，本地模型方法只有 `native.ai.status` 桩，模型未接入；另有 AI 提供者抽象 `native.ai.providers` / `native.ai.run` 与系统应用交接，见 [0004](decisions/0004-ai-provider-abstraction.md)，真机验证待做）；查字的部首笔画、藏头诗等（缺合规数据）。
- 当前 release APK **1,737,792 字节**（空壳基线 1,220,629）。测试：Kotlin 156、web 38 文件 413 例、`arkli-ai` 49 个单测加 9 个 doctest，全绿。
- **下一步**：系统能力（权限、分享、剪贴板、震动等）→ 联网余下部分 → 视频音频（Media3，要先确认依赖）→ AI 运行时真机复验。见"待办"。
- 仓库 https://github.com/icodejoo/arkli（公开，main，HTTPS 推送）。
- **P0 工具还差 3 项**：视频压缩、视频提取音频、OCR（番茄时钟、二维码扫码原型已做）。

## 接手先读
1. 本文。
2. 决策：[0001 技术栈](decisions/0001-tech-stack.md)、[0002 AI 基座](decisions/0002-ai-inference-base.md)、[0003 Web 优先、固定竖屏、图片与音视频走原生](decisions/0003-web-first-and-native-media.md)（**覆盖了设计里的早期说法，先读**）。
3. [Bridge 协议](design/bridge-protocol.md)（v2，含文件方法与 `native.image.compress`）、[公共基础设施](design/platform-infrastructure.md)（联网白名单、CSP、缓存策略）。
4. [工具落地总览与待决策](design/tools-overview.md)（末尾"落地后的变更"列了已落地依赖）；各分类逐工具方案在 `design/tools/`。

## 已拍板（用户确认）

| 事项 | 结论 |
|---|---|
| 名称与包名 | Arkli；`com.let188.arkli` |
| 三层 | Compose 原生壳 / Rust 核心（UniFFI）/ WebView 里的 Vue 3 SPA |
| 前端 | Vue 3 + Vite + vue-router（hash 路由）+ Pinia + SCSS，TypeScript strict，**Vant 4 按需引入**，路由懒加载 |
| ABI / minSdk | 只发 arm64-v8a；minSdk 24；构建目标 `chrome80`（不得放宽） |
| **固定竖屏** | `MainActivity` 锁 portrait；横屏需求全部作废 |
| **Web 优先** | 页面 JS 与浏览器 API 能做好的只在 web 做 |
| **图片压缩** | 统一原生做，`native.image.compress`；PNG 自写缩色编码器；**不用 Rust**；压缩与转换合并；拼接 App 内走原生 `native.image.stitch`（浏览器保留 Canvas 兜底），九宫格仍在 web Canvas |
| **不引 FFmpeg** | 视频音频走 Media3 Transformer 与平台 API（Media3 是新增依赖，**落地前单独确认**） |
| bridge 通道 | `WebMessageListener`（已落地，取代 `@JavascriptInterface`） |
| INTERNET | 已加；页面出站放行任意 https（2026-10-16 起，原为只放 `api.wikimedia.org`），明文 http 拒绝，脚本仍只允许同源；模型下载白名单另算 |
| AI 基座 | **MNN**（M9，2026-10-16：ORT 与 sherpa-onnx 已整体移除，语音用 sherpa-mnn；见 [0002](decisions/0002-ai-inference-base.md) 的取代说明）；NPU 暂不做 |
| 已批准的新依赖 | CameraX 1.5.3（`camera-core/camera2/lifecycle/view`，2026-10-14 已批准）、`io.github.zxing-cpp:android` 3.1.1（2026-10-14 已批准）、`vant`、`unplugin-vue-components`、`@vant/auto-import-resolver`、`vitest`、`tyme4ts` 1.5.3、`@noble/hashes` 2.4.0、`pinyin-pro` 3.29.5、`kotlinx-coroutines`、JUnit、`org.json`（测试）、`ort`、`whatlang` 0.18.0（2026-10-15 已批准，翻译 auto 语言识别）；二维码生成用 nayuki 单文件（MIT，`web/src/vendor/`） |
| 其余 | tools-overview.md "B. 不反对就按默认执行"整张表，按默认走 |

## 已完成与证据

### 原生与协议
- **协议 v2**：挂起式 handler、会话与取消、`native.hello` 能力探测、`app.pause/resume`、渲染进程崩溃后重建。真机验证崩溃重建（会话 1→2、挂起请求被取消、旧事件不串）。
- **文件三件套**：`native.file.pick/save/openWrite/write/closeWrite` 与 `/files/` 路径响应（Range、防穿越、`nosniff` 加 CSP sandbox、可执行类 mime 降级）。真机验证 24MB 分块写入 sha256 一致、Range 206、MediaStore 保存、选图（系统文档选择器）。
- **联网切片**：`NetPolicy` 白名单（含子域伪装、`@` 技巧、端口、punycode 等绕过用例单测）、appassets 的 HTML 响应加 CSP 头、首帧深色脚本外置 `web/public/theme-init.js`。真机验证维基 200、`example.com` 与明文被拦。
- **原生图片压缩**：JPEG、WebP（Android 12 用 `WEBP_LOSSY`）、PNG 无损与缩色；质量、最长边、目标体积（二分）、保留 EXIF、批量、`image.progress` 事件、取消并清理半成品。真机：12MP JPEG q80 约 0.6s；12MP 无损 PNG 11.7s、产物 19.9MB（比原图大）。
- **原生图片拼接与覆盖原图（2026-10-14）**：`native.image.stitch`（Kotlin 布局与 web `stitchLayout` 对拍，PNG 按行编码，逐张解码即回收，画布上限 4000 万像素）、`native.file.pick` 的 `keepSource`/`sourceHandle`、`native.file.overwrite`、`native.file.discard`、`native.cache.stats`/`native.cache.clear`、启动与 `onDestroy` 清拼图遗留。真机 STG-AL00（Android 12）验证：3 张 4000×3000 拼 3600 万像素 JPEG/PNG 成功、取消无残留、discard 越界整体拒绝、clear 跳过活跃写句柄、启动清理只删 `stitch_*`。**覆盖原图结论：选图器 URI 只读（`Media is read-only`），必须走 MediaStore `createWriteRequest`（系统确认框），已端到端验证；API 33+ 真 Photo Picker URI、API 29 及以下、自带多选页 URI 没验证**，详见 [Bridge 协议](design/bridge-protocol.md)「native.file.overwrite」。新增错误码 `FORMAT_MISMATCH`，前端 `BridgeErrorCode` 已补。
- **拼接 PNG 编码提速（2026-10-14）**：真机 2 张 1200 万像素原图纵拼 3072×8192，编码 136s → 4.1s（总 ~137s → ~4.8s），成品 19.4MB → 20.5MB，与旧输出逐像素一致，WebView 可显示；改为流式写出（`.part` 随编码增长），`image.progress` 新增 `phase`/`percent`（节流）；`native.image.compress` 的 PNG 仍用 `PngTuning.BEST`，未变。详见 [Bridge 协议](design/bridge-protocol.md)。
- **图片拼接前端改接原生（2026-10-14）**：App 内选图带 `keepSource`，拼接走 `native.image.stitch`，结果列表只显示缩略图（新增 `shared/NativeResultList.vue`，不动 `ImageResultList`），点击走 `native.image.preview`；结果下方可“压缩”（复用 `native.image.compress`，格式与成品一致）；拼接与压缩结果各有“保存并覆盖原图”（覆盖 images[0]，二次确认，格式不一致前端禁用）；重拼、改图、页面卸载都会 `native.file.discard` 旧产物。`native/cache.ts` 封装缓存统计与清理，**拼接默认 JPEG、PNG 慢提示（阈值 2000 万像素）、百分比进度**已接入（`image-stitch/logic.ts`：`pngSlowHint`、`stitchPercent`），真机 2 张 4000×3000 随机噪点图纵拼 PNG（4000×6000）验证了默认选中 JPEG、切 PNG 出现提示、按钮 0%→100% 逐步递增、缩略图正常；顺带发现 vant 按钮 `loading` 时会隐藏文字，进度文案改用 `loading-text` 才显示。JPEG 单条 percent 事件只在单测里验证，真机没单独测。**设置页**：首页标题右侧“设置”入口 → `/settings`（`views/SettingsView.vue`，逻辑在 `views/settingsCache.ts`），目前只有“缓存”卡片（占用 + 确认后清理 + toast + 刷新，无宿主显示“仅 App 内可用”）。真机（STG-AL00）验证了 拼接、缩略图、压缩、原生预览调用、覆盖流程到确认框与错误提示（假句柄，得到“原图句柄已失效”）、卸载清理；**没验证**真实选图器与系统授权框的完整覆盖。已验证“出结果后改格式单选”修正（覆盖仍按成品格式禁用、压缩仍是 PNG 无损）与设置页缓存统计和清理（造了 300KB 文件，清后 0 B）。
- **评审修复**：取消先于协程体补发 `CANCELLED`、权限与选图槽位启动失败必释放、`closeWrite` 严格校验、图片拷贝上限 128MB、wakelock 竞态、指南针卸载后不再监听、DB 候选按得分计数；`bridge.ts` 超时后通知原生取消。
- **调试入口**（仅 debug 源集，release 不含）：`adb shell am broadcast -a com.let188.arkli.debug.CMD --es cmd <命令>`。命令：`crash` `hello` `ping` `state` `sleep` `ticker` `cancel` `filepick` `filesave` `writetest` `writeopen` `rangetest` `videotest` `listcache` `securitytest` `nettest` `imgprep` `imgrun` `exifdump` `imglist` `nav` `rpc`（`--es method --es params [--es id]`，任意调一个 bridge 方法，结果看 `DBGMSG`）`previewtest`（生成 1080×20000 长图并打开原生预览，日志含底图/局部解码耗时）。日志过滤 `adb logcat | grep -E "ArkliDebug|DBGMSG|DBGNET"`。

### Rust
- `core/crates/arkli-ai`：PP-OCR 管线的纯逻辑（预处理、DB 后处理、CTC、取消与进度）、provider 探测、推理后端 trait；MNN 后端与翻译引擎在 `mnn-backend` 特性后（M9 起 `ort` 依赖与 `ort-backend` 已删）。`arkli-core` 仍零依赖。**识物（`clip` 编码器 + `classify` 分类，纯函数）已经经 `arkli-ffi` 的 UniFFI 接入并进 APK，真机裸名 dlopen 已在 APK 进程内复验；OCR 管线 M8（2026-10-16）已改经 `GraphSession` 用 MNN fp16 模型并经 UniFFI 导出 `ocr_load/ocr_recognize/ocr_cancel/ocr_unload`，桌面真库对拍通过，真机耗时与内存没复验，见 [ONNX→MNN 迁移](research/onnx-to-mnn-migration.md) 的 M8。**
- **本地翻译 NLLB 接入（2026-10-15）**：Rust `arkli-ai::translate`（当时 feature `ort-backend`，M9 起改为只剩 `mnn-backend`，移植自 Cisox snow-translator，只留 m2m100 路径：清单、分词含 null charsmap 修补、分句、束搜索、全角标点后处理）+ UniFFI `translate_load/translate_run/translate_unload` + Kotlin `local-nllb` 提供者与桥方法 `native.ai.translate`（`TranslateService`/`AiTranslatePolicy`，走 `AiHeavyGate`，删除模型前 `addReleaseHook` 释放）+ `models.json` 新条目 `nllb600m-un6-ccm-int4`（6 个文件 404,501,627 字节，sha256 已在宿主机与设备上各校验一次）。新依赖只加了 `tokenizers 0.23.2`（`default-features=false, features=["fancy-regex"]`，用户已批准）与 `serde`/`serde_json`（均为其传递依赖，optional，随 `ort-backend`）；`ort` 仍是 `=2.0.0-rc.14`，没引 ndarray，没用补丁分支。`OrtBackend::load` 改成进程内共享环境、幂等（rc.14 一个进程只许建一次环境，识物与翻译共用）。**证据**：宿主机（onnxruntime 1.28.2）`cargo test -p arkli-ai --features ort-backend`：126 通过，真实模型 ignored 测试 zh-CN→en / en→zh-CN / en→fr 通过，与 Cisox `nllb_parity.json` 夹具对拍 9/9 译文逐字一致（ja 两对不在本包语言内，跳过）；`./gradlew :app:testDebugUnitTest` 575 通过。**真机（STG-AL00，Android 12）**：sherpa 自带 ORT 1.28.2 能加载 MatMulNBits int4 模型；模型加载 2.8 秒，首句总耗时 4.8 秒（含加载），后续短句 1.4~2.0 秒，两句长文本 beams=4 约 5.0 秒；进程 RSS 基线约 237MB，翻译后 577MB（峰值 616MB），卸载后 513MB。`libarkli_ffi.so`（arm64 release）510,912 → 3,315,600 字节，gzip -9 237,143 → 1,239,468（+2.8MB 原始 / +1.0MB 压缩，主要是 tokenizers 与 regex 的 Unicode 表）。

### Web（25 个工具，id 见 `web/src/tools/registry.ts`）
- 文本与计算：金额转大写、进制转换、单位换算、时间计算器、日期计算器、亲戚关系计算器、阳历/阴历互转、中文转拼音。
- 开发者：Base64、哈希计算（MD5/SHA）、密码生成器、颜色转换、二维码生成。
- 图片：图片压缩（含转换）、图片拼接、九宫格切图。
- 设备：尺子、指南针、时间屏幕、手持弹幕、设备信息（只含 web 能取到的部分）。
- 趣味：抛硬币（3D 翻转带阴影与景深）、掷骰子、自定义抽签、做个决定。
- **阳历/阴历**：1–9999 年；1582 年前按儒略历推算；宜忌平铺，点击弹出 140 项通俗释义（10 条权威来源不足，标"待核对"）；"历史上的今天"取维基百科 On This Day（CC BY-SA，已标注来源）。
- **尺子**：竖直贴屏幕长边（可靠左或右），0.5px 游标线，实时读数预览，彩虹七色轮换加彩虹盘取色，标记不限数量、可隐藏；“间距对比”弹窗里用 SVG 按位置排出所有标记，点选任意两条看间距。

### 文档
决策 0001–0003、六份分类设计、总览、基础设施、两份 spike、开源库选型；索引在 [README.md](README.md)。

## 待办（按顺序）

### 1. 系统能力
`native.permission.*`（落地后把 `native.file.save` 在 API 24~28 的临时权限申请改走它）、`native.share`、`native.clipboard.*`（`sensitive: true`）、`native.screen.*`、`native.haptic.vibrate`、`native.settings.open`、`native.intent.*`、`native.camera.capture`。抛硬币与掷骰子的音效和震动、设备信息里的电池、存储、品牌型号也依赖它（建议 `native.device.info/status/display`，有了 `xdpi` 尺子可免校准）。

### 2. 联网余下部分
`native.net.*`（http、resolve、whois，超时、2MB 上限、手动跳转、取消）、`native.pack.*`（词典与数据包；模型部分已落地为 `native.model.*`，没做签名，见 [模型下载管理](design/model-download.md)）、汇率接口逐个实测 CORS 后加入白名单、`network_security_config` 放行回环 `127.0.0.1`。

### 3. 长任务与视频音频
`native.task.*`、前台服务（API 35+ 声明 `mediaProcessing`）、通知封装、闹钟（番茄钟）。视频压缩、提取音频走 Media3 Transformer 与平台 `MediaExtractor/Muxer`，**先问用户确认 Media3 依赖**。

### 4. AI 运行时真机复验
（M8 起 OCR 管线已接 UniFFI 并改走 MNN，不再与 sherpa 共用 ORT，待真机复验速度与内存；下面是更早的待办原文）`arkli-ai` 的 OCR 管线经 UniFFI 接入（`CancelToken` 做 Object、进度做 callback interface；识物那部分已接，见上）；与 sherpa 共用同一份 ORT（裸名 dlopen 已在 APK 进程里复验，sherpa JNI 同进程共用未测）；通道顺序 BGR/RGB、cls 模型输入尺寸（v5 未核实）、默认参数在 1080×2400 截图上的检出率、耗时与内存；每次升级 sherpa 加一条 OCR 端到端回归；NNAPI 默认关。模型文件来源（约 21.5MB，ModelScope RapidAI）与托管位置待定。PNG 解码 `png` crate 未批准，输入暂由原生解码成像素。

### 5. 其余 P0
OCR 工具页（依赖 4）。二维码扫码原型已做，待真机验证。

### 5b. AI 四层与模型（决策见 [0005](decisions/0005-ai-four-layers.md)）
- **全部任务完成后，找一台有点积（`asimddp`）和 fp16（`fphp`）的手机复测** MNN 的速度（0002 已在 M9 改为被 MNN 取代；Rust ort 与 ORT 已删）（见 [端侧 LLM 对比](research/on-device-llm-comparison.md)）。
- 对联 GPT-2 int4 在 Android 真机上跑通并实测速度、对联工具页接入（下载、解码、上联 ≤14 字、拦截英文数字括号、等长约束）；垃圾分类识物工具页接入（第 1 步“ORT 接入 + `native.ai.classify`”与第 2 步模型下载管理已做；剩第 3 步 Web 页；SigLIP2 `q4_half`，54.7MB 按需下载，词表向量只用英文；q4f16 在 STG-AL00 上 SIGILL，**fp16 留到高端机再实测**；真机测试文件保留）；L4 在线 OpenAI 先出方案（密钥存储、`native.net` 加 POST 与流式）；AI 页“模型配置”占位入口接管理功能。
- 设备上 `/data/local/tmp/qwenspike/`（约 641MB）是探测残留，用户尚未说清理。
- （已解决，见下一条）翻译：真机上模型卸载后 RSS 仍比基线高约 275MB（ORT arena 与映射页未完全归还），需要时可评估 `trim_after_request` 或进程级回收；`libarkli_ffi.so` 体积 +2.8MB 是否值得继续瘦身（如换更小的分词实现）待定；`core/scripts/build-android.ps1` 读 `core	arget\debug` 里的 dll 生成 Kotlin 绑定，本机设了 `CARGO_TARGET_DIR` 时读到的是旧 dll，绑定会缺新函数，需改脚本按 `cargo metadata` 取 target 目录（这次是手动用 `C:\cargo-target\cisox\debugrkli_ffi.dll` 重生成的）。

### 5c. 翻译源语言 auto 与返回键回收（2026-10-15）
- **auto 源语言**：`native.ai.translate` 的 `src` 可传 `'auto'`（`tgt` 不可以），结果多 `detectedSrc: string[]`、`unrecognized: boolean`，语义见 [bridge-protocol](design/bridge-protocol.md) 的 `native.ai.translate`。实现：Rust `arkli-ai::translate::detect`（`whatlang` 按句识别，限定模型支持的语言；映射表 whatlang→应用码带单测，`Cmn`→`zh-CN`）；引擎对不可识别句子原样输出；UniFFI `TranslateResult` 加 `detected`/`unrecognized`；Kotlin `AiTranslatePolicy` 放行 auto。
- **新依赖 `whatlang 0.18.0`**（用户已批准）：`default-features=false`，optional，挂在 `ort-backend` 下（M9 起挂 `mnn-backend`），纯 Rust、MIT、无模型文件。`libarkli_ffi.so`（arm64 release）3,315,704 → 3,568,072 字节（+252,368），gzip -9 1,238,504 → 1,309,147（+70,643）。
- **证据**：`cargo test -p arkli-ai -p arkli-ffi --features arkli-ai/ort-backend` 137 + 8 通过（6 个 ignored 为真模型）；真模型 ignored 测试 `真实模型自动识别源语言` 通过；`./gradlew :app:testDebugUnitTest` 通过。真机（STG-AL00）四类输入：法语 `Bonjour le monde. Comment ça va ?` → `detectedSrc=["fr"]`；中文 `你好，世界。` → `["zh-CN"]`；中英混排 `Hello world. 你好世界。`→fr 得 `["en","zh-CN"]`；`😀😀😀`、网址 → 原样、`[]`、`unrecognized=true`；`src==tgt`、`tgt=auto`、不支持语言仍 `BAD_PARAMS`。
- **识别的已知局限（待用户知悉）**：whatlang 对短句置信度整体偏低，阈值靠实测定（`MIN_CONFIDENCE=0.04`、`FOREIGN_CONFIDENCE=0.1`，依据写在 `detect.rs` 常量注释）；单词级输入（如 `Hello`、`Hola`）常判不出而原样输出，很短的非支持语言句（如 `Ich liebe dich.`、`Guten Tag…`）可能被当成最像的支持语言翻译。繁体与简体无法区分。
- **返回键回收实测**（STG-AL00，`/proc/<pid>/status` VmRSS）：冷启动基线 182,908 kB；warmup 后 525,624 kB；返回键退到桌面后 30 秒 208,252 kB（基线 +25MB，同一进程）；再从桌面图标回来翻译正常（自动重新加载，总耗时 3.5 s）；Home 键退后台 30 秒后 558,148 kB（未卸载，证明 Home 不回收）。第二次返回键退出 20 秒后 198,016 kB。`ArkliAi` 日志在 logcat 里没抓到（缓冲仅 256KiB，被 Chromium 控制台刷掉），以内存数据为证。

### 6. 工具与前端小项
- 手持弹幕、时间屏幕固定竖屏后体验受限，**是否页面内旋转 90° 模拟横屏待用户定**。
- 图片压缩：大图选 PNG 时给"又慢又大"的提示（待定）；PNG 缩色是否按真实照片再调参。
- 彩虹盘只选色相，没有亮度调节；预设黄色在白底上对比度偏低。
- `formatError` 对 `{code:'', message}` 或无 `code` 的对象会输出 `[object Object]`（已知小 bug，未修）；`markUsed` 不校验 id。
- Vant 图标字体的 `at.alicdn.com` 回退被 CSP 拒绝，console 有一条无害噪音；字体内嵌约 34KB（gzip）。
- 各工具里有重复的局部样式，可抽共用组件。
- **AI 预热与回收（本轮，原生侧）**：新增 `native.ai.warmup` / `native.ai.unload`（契约见 [桥协议](design/bridge-protocol.md)「AI 提供者方法」），退出与内存告急时 `AiRecycle` 兜底卸载。内存残留的根因是 bionic scudo 不把 ORT 释放的堆页还给系统，卸载末尾加 `mallopt(M_PURGE)`（`arkli-ffi/src/mem.rs`，只安卓生效）后残留由约 +300MB 降到约 +24MB。测量口径：STG-AL00、Android 12，`run-as` 读 `/proc/<pid>/status` 的 VmRSS/RssAnon/RssFile 与 `smaps_rollup` 的 Pss，卸载后等 30 秒再量（5 秒与 30 秒无差别）。
  - 数据（VmRSS MB / RssAnon MB / PSS MB）：冷启动基线 193 / 98 / 130；warmup 后 530 / 416 / 466；翻译 3 句后 562 / 387 / 506；卸载（无 purge）495 / 381 / 436；卸载（有 purge）223 / 106 / 158，差值 +30 / +8 / +28；两模型（翻译+识物）都加载 604，finish 触发回收后 217（基线 193，+24）；回收后再次启动 226。无 purge 的残留 100% 是匿名页（RssFile 回到 112MB 与基线 93MB 只差 ORT 库与 tokenizers 的代码页，约 20MB，可回收）。
  - 耗时：冷加载首句 4.5 s（含加载 2.7 s），预热后首句 1.9 s，之后 1.9~2.6 s；purge 前后翻译耗时无变化（1.9/2.0/2.6 s）。`local-clip` 预热 0.56 s。
  - 验收阈值建议：卸载后 VmRSS ≤ 基线 +30MB、PSS ≤ 基线 +30MB（实测 +24~30MB，贴着线，剩余部分是文件映射的 .so 代码页与 Java 堆增长，不是模型）。没有做的缓解：`cpu_arena=false`、`trim_after_request`、`madvise`——purge 已达标，不再引入；独立进程（`:ai`）因此不需要，评估见汇报。
  - **已决定并落地（2026-10-15）**：按返回键退到桌面也释放：`MainActivity.exitToHome()` 在 `moveTaskToBack` 前调 `AiRecycle.releaseAll("back-exit")`（代价是下次回来首次翻译重新加载约 2.7 s）；Home 键、最近任务切走仍不卸载。实测见下方“翻译源语言 auto”条。`onTrimMemory` 只在 Activity 上监听，Activity 被系统销毁后（进程仍缓存）收不到，要补收则需自定义 `Application`；另外 `speech`（语音识别）会话不在本轮回收范围。

- **L2 本地文本模型：MNN + Qwen3.5-0.8B（2026-10-15）**：用户拍板改 0002，L2 用 MNN（见 [0002 修订](decisions/0002-ai-inference-base.md)）。新增 `native/mnn/`（JNI 封装 `arkli_mnn_jni.cpp`、`CMakeLists.txt`、`build.sh`，钉死 MNN 提交 `478c10e…`），Kotlin 侧 `MnnNative` / `QwenService` / `LocalQwenProvider`（`local-qwen`，任务 `prompt`/`summarize`/`proofread`/`rewrite`）/ `AiQwenPolicy`，接入 `AiModule`、`AiRecycle`、`native.ai.warmup/unload`；清单新增 `qwen35-0.8b-mnn-q4`；`fetchMnnRuntime` 构建时取 release `mnn-478c10e-v1` 的两个 so 并校验 sha256。**测试**：新增 23 个 Kotlin 单测（策略 9、服务与提供者 14）全过，`ai` 包既有测试无回归。**真机 STG-AL00 验证**：桥 → `local-qwen` → JNI → MNN 跑通，加载约 3.1 s、解码约 17 tok/s；**内存**基线 PSS 约 160MB → 加载后约 950MB → 卸载后约 163MB（+3MB，过 +30MB 验收线）。踩坑：首版卸载后只释放 15MB，原因是 MNN 全局执行器的缓存与分配器空闲页没还，`nativeDestroy` 里加 `Executor::gc(FULL)` 与 `mallopt(M_PURGE)` 后解决。**未验证**：App 内经真实 release 链路下载（测试时手机没有网络，改为把已知一致的文件拷进 App 目录，再由 App 做 sha256 校验）；前端页面（目前只有桥方法，没有 UI）；低内存机型；流式输出与取消（目前一次返回整段，最多 256 token）。**质量**：0.8B 会一本正经地说错（自我介绍说成“7B”、西湖介绍里有编造的景点），界面接入时要有提示。

**下载地址的单一来源是 `models.json`**（2026-10-16）：AI 中心（`/ai`）的「下载地址」面板经只读桥方法 `native.model.sources` 从原生读取，界面不重复硬编码；用户可点击下载，也可查看地址在别处下载后手动放入再「校验」。设计见 [模型下载管理](design/model-download.md)。**只过单测与编译，未上真机。**

## 待上传 release 总清单（用户执行上传；字节数、sha256 以 `models.json` 与 `app/build.gradle.kts` 的 `mnnLibs` 为准，已逐项核对）

**抠图（2026-10-19，未发布）**：release `matting-modnet-mnn-v1`（`modnet512_fp32.mnn` 25,886,772 B、`NOTICE.txt`、`LICENSE-Apache-2.0.txt`）与 `matting-u2netp-mnn-v1`（`u2netp_f16.mnn` 2,394,164 B、同名两个说明文件），源文件在 `native/mnn/.work/convert/out/` 与 `scripts/mnn/data/matting-*/`，字节与 sha256 见 `models.json`。

全部上传到公开仓库 `icodejoo/arkli`。上传前对应下载会失败；上传后按 302 与 sha256 复核。构建所需的三个 so 上传前靠本机 `.gradle/arkli-mnn` 缓存。

**`mnn-478c10e-v2`**（运行库，三个都要放，下载前缀相同）

| 文件 | 字节 | sha256 |
|---|---|---|
| `libMNN.so`（与 v1 相同，不变） | 4,899,952 | `9cc1ff8b8b039431913a37ad1853dfa51162b41ae8b90927507204397096a353` |
| `libarkli-mnn.so` | 71,592 | `b4c9bf34e2d72867a8b265fcedd5f14435cf1d994a7ee2af0253445c88c09f40` |
| `libsherpa-mnn-jni.so` | 2,690,520 | `aa79262fa17431bf513c7c4ac9855df02d09c1fe364396c0d8032df652a0c339` |

**`siglip2-mnn-v1`**（识物，1 个文件）

| 文件 | 字节 | sha256 |
|---|---|---|
| `model.mnn` | 94,775,452 | `8af99950b0fb39c2df90e66d67181eecc4e538617fbfdc0242ee420b36ac60d5` |

**`nllb-mnn-v1`**（翻译，12 个文件，共 392,177,035 B；`model.json` 是 `num_beams=1` 的可信版，复现方法见 `scripts/mnn/README.md`）

| 文件 | 字节 | sha256 |
|---|---|---|
| `LICENSE-CC-BY-NC-4.0.txt` | 19,347 | `41003d4a74749c0220e33dd415042164b5a1093ed401f36277234f772d22d3d0` |
| `NOTICE.txt` | 2,136 | `a4188346a1266d3d9547558f08ef8893a9d077c3772b4aa6934457bafd52f4a3` |
| `cross_kv.mnn` | 28,784 | `8a860332b7dab8c63e0d5b1a405d98bae1cc3156a85113a301fb8ab7b6422ab8` |
| `cross_kv.mnn.weight` | 19,170,960 | `8236984b2cebaac9104599553a2e916a3d67f0cb1ef55bcc03b77aefe914126e` |
| `decoder_step.mnn` | 624,080 | `09e231235a3938d40c86d7a9bcb09db096669c927613c036f4b2f1a44e838f5d` |
| `decoder_step.mnn.weight` | 186,455,862 | `ca32acd63cd3d6d129cac220f673d4c2c4b7b88ac2b0d20953908d67dd1a66d5` |
| `embed.i8` | 63,279,104 | `d1dc9511201a86481b84dfd3404e6c919da2fdb57b41482b22d6ce13324bef23` |
| `embed.scale` | 247,184 | `7e49a46dedb9a5bed0669a905b538ea451b8d139fb793c451d1cfee346d42591` |
| `encoder.mnn` | 380,896 | `497f3e7cd5e6ae1de396d4fc17b803e0cd2b1d946fea66a0fc5cbc569cb0479f` |
| `encoder.mnn.weight` | 118,985,648 | `dafaee96b607b9c93532b53ab92f4e557eae6a7c9bc86e61e6a7288451e3c135` |
| `model.json` | 1,218 | `1db584251cde24fc8570f393f019ede6e7c6d58225b40ed0e71c330e16a14d36` |
| `tokenizer.json` | 2,981,816 | `d93881797f945c189dd89a9fee75764e8a8d564e780fc66dac30c0d3747044f2` |

**`asr-mnn-v1`**（语音，4 个文件，共 168,813,626 B）

| 文件 | 字节 | sha256 |
|---|---|---|
| `decoder.mnn` | 10,603,880 | `bf91f6513a4d05b3c1c4f06c034e51caddda8d503caba3ad6250bd016950e018` |
| `encoder.mnn` | 155,527,912 | `982314ac18794997a4e5d0ae8ff52bfcbf0299503caed8256fe469cab6b7af8f` |
| `joiner.mnn` | 2,623,028 | `47b490b2ae3abb402f54a35183ec07cd50bde180b5c55f12dd5241a116bba2e9` |
| `tokens.txt` | 58,806 | `b818a60878b9aae978cbb8ad594acbd403d76d1af2e31ef4197c84e2dbdba27c` |

**`ocr-mnn-v1`**（文字识别，6 个文件，共 11,438,043 B）

| 文件 | 字节 | sha256 |
|---|---|---|
| `LICENSE-Apache-2.0.txt` | 11,376 | `3840c5c0c61c294264d2dd77b8777be6ddd90121ef4e0e64abcd22edea581d6e` |
| `NOTICE.txt` | 1,555 | `9eb926caa8f5415e75a0b612a423cd30e86741ce10554101a1fdf26b2b9b7cb0` |
| `cls.mnn` | 516,824 | `58ac0a454c0414352e41450220f4249d7c542eef3dbcf62290756a0815480d7c` |
| `det.mnn` | 2,411,040 | `73d519a359883d440efce876a52691d2afa064ccdb5120f4c1cedff1a9d7d319` |
| `ppocr_keys.txt` | 74,012 | `d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b` |
| `rec.mnn` | 8,423,236 | `9350d716fa78ae220736e3141ec89382367b3bf01d0592c379bec5db31437c18` |

**`couplet-mnn-v1`**（**已上传并逐个核对 sha256 与清单一致**；对联，7 个文件，共 97,149,159 B；**许可证无法确认可再分发，风险自负**，`models.json` 的 `license` 字段已如实标注，NOTICE 随包；本机产物在 `E:\workspaces\arkli-models\couplet-gpt2-mnn\`）

| 文件 | 字节 | sha256 |
|---|---|---|
| `NOTICE.txt` | 3,147 | `ceaa7daf30e0dc6ccc2c91dab5aa98c9940c03cdb6e3ebdd191219a8e2e9f9ad` |
| `UER-py_LICENSE_Apache-2.0.txt` | 11,357 | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| `couplet-clean-dataset_LICENSE_MIT.txt` | 1,068 | `e5ba66a650e1701d75ba5706af41b6dfaca7297c97ae8c93d7458db9c90d1e05` |
| `model.json` | 1,449 | `d9986046c4a906046f705256228eb4e440048fb3f08fdbc240c063f2a12202e2` |
| `model.mnn` | 289,464 | `57219ebd5bbed80140437396b8bbb85dba5991e7c5b20f0d39db4012ec29173e` |
| `model.mnn.weight` | 96,733,158 | `93f3c05e50b9b8860cbf8c92c4b0b556578a04111e1a94bc6fba3b7e7cdddd71` |
| `vocab.txt` | 109,516 | `3db3f345cf52a1102831aa1fe7ddeb031dd5f117412f91ad11645c4e71fc8f4b` |

**`couplet-corpus-v1`**（对联语料库，数据包，1 个文件；**待用户上传**；本机产物 `E:\workspaces\arkli-models\couplet-corpus\couplet-corpus.zip`，zip 为 deflate，解压后 5 个文件共 64,961,472 B，清单里逐个登记了 sha256）

| 文件 | 字节 | sha256 |
|---|---|---|
| `couplet-corpus.zip` | 33,070,763 | `f2b9ffdd9f5cc44592b70e98735af60be8feb88c5b9cb6fb09a9d83c47489e23` |

> 待确认：`siglip2-mnn-v1`、`asr-mnn-v1` 目前不带 LICENSE/NOTICE（NLLB、OCR 带）。上游均为 Apache-2.0，第 4(a) 条要求再分发时随附许可证副本，建议补上后再上传（清单要同步加文件）。

## 待用户拍板 / 未知
- **对联语料的分类与横批质量未过线**（`scripts/couplet/README.md` holdout：首选分类 82.2%<85%、任一合理 88.7%<90%、挽联召回 90.6%<95%、横批贴切 56.7%<80%）。后续方案三选一或组合，**待用户定**：（a）人工标注 2000~3000 条做有监督分类；（b）引入分词/成语词典（如 jieba + 成语库）做特征；（c）用大模型离线打标签并生成/挑选横批再蒸馏。页面现已上线随机模式并标注“横批与分类是推导值”。
- **挽联判定门槛 4.5 还是 3.5**：4.5（当前）holdout 召回 29/32、误隐藏约 3.4%；3.5 召回 31/32、误隐藏约 8.9%。**待用户定**。
- **对联语料库许可证**：语料来自 couplet 数据集，上游 MIT / AGPL 链条存疑；用户已决定风险自负，release `couplet-corpus-v1` 上传前请再确认，作者若不允许要删除 release。**待用户确认**。
- **开源协议**还没选（仓库无 LICENSE）：GPL 类依赖（如 libimagequant）会牵连整个 App，选协议要早于引入这类依赖。
- 模型与数据包托管位置（识物 `q4_half.onnx` 已于 2026-10-15 发布到 GitHub release `siglip2-q4half-v1`（公开仓库），真实下载链路已实测：302 直接落到 `release-assets.githubusercontent.com`，下载后 sha256 与清单一致；后续考虑补镜像，单连接在菲律宾偏慢）；Qwen3.5-0.8B 的 MNN 文本模型已于 2026-10-15 发布到 GitHub release `qwen35-mnn-v1`（公开仓库，6 个文件合计 484,349,699 字节，真实链路已实测，溯源见 [Qwen3.5 MNN 模型](research/qwen35-mnn-model.md)）；拼豆色号表数据来源；国内商店对按需下载 so 的规则（没查到原文）。
- （**M9 已删：ORT 与 sherpa-onnx 不再随包，本条仅作历史**）AI 运行时（ORT + sherpa JNI，arm64 约 27MB 未压缩）是否随包：**ORT 已随包**（只带 `libonnxruntime.so` 22.25MB，不带 sherpa JNI；release APK 4,917,752 → 27,643,404 字节，gzip -9 3,309,480 → 11,605,440），是否改为按需下载 ORT 等复议；sherpa JNI 等接 sherpa 能力时再定（**2026-10-15 语音转文字已接入 sherpa JNI**：`fetchOrtRuntime` 同时从同一 AAR 取 `libsherpa-onnx-jni.so`（4.77MB，gzip -9 约 1.96MB）与 Kotlin API `classes.jar`（239KB，gzip -9 约 222KB），仅 arm64-v8a，与 Rust 共用同一份 `libonnxruntime.so`，已随包，待用户确认）。**新增构建步骤待确认**：Gradle 任务 `fetchMnnRuntime`（2026-10-15 新增，构建时从 release `mnn-478c10e-v1` 下载约 4.9MB 的两个 so 并校验 sha256，缓存在 `.gradle/arkli-mnn/`）；Gradle 任务 `fetchOrtRuntime` 构建时从 GitHub 下载 50MB 的 sherpa AAR 并校验 sha256，缓存在 `.gradle/arkli-ort/`。
- 高通、华为运行库再分发许可（NPU 暂搁置）。
- **对联 GPT-2 的 release（`couplet-gpt2-v1`，公开仓库）许可证无法确认可再分发**：用户决定不向作者确认、风险自负；作者若不允许要删除 release（见 [对联 GPT-2](research/couplet-gpt2-onnx.md)）。
- ~~端侧 LLM 的 tokenizer：引入 `tokenizers` 还是自写 BPE~~：**已解决（2026-10-15）**，L2 改用 MNN，分词与聊天模板用 MNN 自带的，不引入也不自写。
- `ArkliPage` 里 `bridge` 字段先于 `binarySupported` 初始化，`native.hello` 的 `features.binary` 可能一直是 false（只会永远走 base64 兜底，不出错但慢）：修不修待定。
- 宜忌释义 123 条非"待核对"条目是通俗改写，没有逐条对权威黄历核过，正式上线前建议找懂行的人过一遍。
- **NLLB MNN 版 release `nllb-mnn-v1` 待用户上传（M6c）**：12 个文件（清单、字节数、sha256 见 [onnx-to-mnn-migration.md](research/onnx-to-mnn-migration.md) 的 M6c 一节），`models.json` 的 `nllb600m-un6-mnn-w6` 已指向 `https://github.com/icodejoo/arkli/releases/download/nllb-mnn-v1/<文件名>`；上传前下载会失败，上传后按 302 与 sha256 复核。旧条目 `nllb600m-un6-ccm-int4` 已在 M9（2026-10-16）移出清单并登记进 `retired`。
- **识物 MNN 版 release `siglip2-mnn-v1` 待用户上传**：1 个文件 `model.mnn`（94,775,452 B），`models.json` 的 `siglip2-mnn-w8` 已指向它；清单见上方“待上传 release 总清单”。
- **语音 MNN 版待用户上传（M7）**：（a）`mnn-478c10e-v2` 要放三个 so（`libMNN.so`、`libarkli-mnn.so`、新增的 `libsherpa-mnn-jni.so` 2,690,520 B，sha 见 [onnx-to-mnn-migration.md](research/onnx-to-mnn-migration.md) 的 M7 一节）；（b）release `asr-mnn-v1` 的 4 个文件（`encoder.mnn`/`decoder.mnn`/`joiner.mnn`/`tokens.txt`，共 168,813,626 B）；`models.json` 已首次加入 `asr-zipformer-zh-en-mnn-w8`，上传前设备下载会失败，上传后按 302 与 sha256 复核。旧手动目录 `asr-zipformer-zh-en-int8` 已在 M9 登记进 `retired`。sherpa-mnn JNI 真机能否跑通是最高风险项，待真机清单在该节末尾。
- **对联 MNN 版 release `couplet-mnn-v1`：已上传并核对**（7 个文件、共 97,149,159 B，sha256 与清单一致；`models.json` 已登记 `couplet-gpt2-mnn-w6`，license 如实写“无法确认可再分发，风险自负”）。引擎与协议已接入（`native.ai.couplet` / `local-couplet`），页面已在 2026-10-16 重做（见 [对联语料库与对联页](design/couplet-corpus.md)），对下联与大模型模式的真机速度、质量未测。详见 [对联评估](research/couplet-gpt2-onnx.md) 第 9 节。
- **文字识别升级 PP-OCRv6 small，release `ocr-mnn-v2` 待用户上传**：6 个文件 `det.mnn`（4,967,972 B）、`rec.mnn`（10,648,948 B）、`cls.mnn`（516,824 B，与 v5 包同一个文件）、`ppocr_keys.txt`（74,947 B）、`NOTICE.txt`（1,693 B）、`LICENSE-Apache-2.0.txt`（11,376 B），sha256 见 `models.json` 的 `ppocrv6-small-mnn-fp16` 与 [onnx-to-mnn-migration.md](research/onnx-to-mnn-migration.md) 的“M8 升级 PP-OCRv6 small”一节；本机产物在 `E:\workspacesrkli-models\ppocrv6-small-mnn-fp16\`（`scripts/device-push-models.sh` 可直接推）。Kotlin 的 `OcrService.MODEL_ID` / `OCR_MODEL_DIR` 已指向它；旧 `ppocrv5-mnn-fp16` 已在 M9 移出清单并登记进 `retired`。
- **（旧）文字识别 MNN 版 release `ocr-mnn-v1` 待用户上传（M8）**：6 个文件 `det.mnn`、`rec.mnn`、`cls.mnn`、`ppocr_keys.txt`、`NOTICE.txt`、`LICENSE-Apache-2.0.txt`（字节数、sha256 见 [onnx-to-mnn-migration.md](research/onnx-to-mnn-migration.md) 的 M8 一节，`models.json` 已登记 `ppocrv5-mnn-fp16`），上传前下载会失败；另请确认 ModelScope 模型页的许可证标注（上游 PaddleOCR / RapidOCR 仓库均为 Apache-2.0）。真机验收（1080×2400 ≤ 2.2 s、峰值 RSS ≤ 210MB）待做。
- **（已随 M9 退役，无需再托管）翻译模型托管待定（旧 ONNX 版）**：`nllb600m-un6-ccm-int4` 解压后的 6 个单文件还没上传到 release，`models.json` 里的 URL 是占位 `https://github.com/icodejoo/Cisox/releases/download/models/<文件名>`，上传后要核对 URL、字节数与 sha256（`encoder.onnx_data` 158,297,088 字节、`decoder.onnx_data` 229,598,080 字节，单文件需小于 GitHub release 2GB 上限）。
- **翻译模型授权说明待在下载界面落地**：权重是 CC-BY-NC-4.0（仅限非商业、不用于生产部署），需在 AI 中心下载界面展示署名、来源与修改说明，文案见 [bridge-protocol 的“本地翻译模型授权”](design/bridge-protocol.md)；App 若商用发布需换模型或另获授权。
- **翻译模型的质量局限（已知，未处理）**：词表裁剪后个别生僻字会被静默丢掉，如 “lazy”→“惰的”（缺“懒”）、“sunny”→“阳光明的”（缺“媚”），宿主机与真机一致，是模型本身的问题；短句偶有离谱结果（`Good morning.` en→es 得 `- ¿Qué pasa?`）。是否在界面提示、或换更大词表/更高精度的包，待用户定。

## 技术债与风险
- **发版前必须处理 spike 代码**：`app/src/main/kotlin/com/let188/arkli/spike/`、`assets/spike/`、`res/xml/spike_network_security_config.xml`（未被引用的遗留文件），以及清单里 `exported=true` 的 `.spike.SpikeActivity`。移除或挪进 `debug` 源集。
- `/files/` 的 Range 响应依赖 Chromium 114 对拦截流"再 skip 一次"的行为（用流头垫虚拟前缀兼容），换内核可能表现不同，已写进协议文档，**别的机型要复测**。
- **没在真机验证的**：HEIC 转 JPEG、API 24~28 的存储权限分支、API 24~27 的图片解码回退、手指拖动尺子游标的手感、`touch-action: none` 对页面滚动的影响、Chrome 80 内核上的 3D 抛硬币与 `createImageBitmap` 选项、深色首帧、指南针与时间屏幕常亮在华为 WebView 上的表现、文件哈希里 `<input type=file>` 在 WebView 里的选择器。
- 古代农历（尤其 1900 年前）是库的推算值，可能与历史上实际颁行的历差一天或一个月，界面已写"仅供参考"。
- R8 的 keep 规则偏宽（JNA 与 uniffi 整包）。
- release 用 debug keystore 签名，仅限本机验证，上架前换正式签名（密钥不进仓库）。
- 提交 `a48553c`（feat(tools) 新增 18 个工具）的标题误写成"17 个"，未改写历史。
- 推送前按约定要跑的 diff-simplify 这批没跑。

## 本机环境与命令
- Windows，Node 24、JDK 21（`E:\sdk\jdk\openjdk-21.0.5+11`）、`ANDROID_HOME=E:\sdk\android`（platforms 35/36、build-tools 36.0.0、NDK 28.2.13676358）、Rust（含各 Android target）、cargo-ndk 4.1.2、pnpm。
- 真机：序列号 `7NQBB23606003715`，华为 STG-AL00，Android 12，arm64，高通 SM6225；系统没有 Photo Picker，选图走 androidx 回退的文档选择器。
- 构建 Rust 并生成绑定：`pwsh E:\workspaces\arkli\core\scripts\build-android.ps1`（必须 PowerShell 7；生成物不入库）。
- 前端：`cd web; pnpm dev --host 127.0.0.1` → http://127.0.0.1:5173/assets/web/ ，**hash 路由**，如 `#/tool/ruler`；`pnpm build:app` 构建并同步进 assets（产物不入库）；`pnpm test`、`pnpm exec vue-tsc --noEmit`。
- 真机热更新（仅 debug 包）：先装一次 debug 包，之后 `cd web; pnpm dev:device`（= `adb reverse tcp:5173 tcp:5173` + 固定 5173 端口的 vite），手机上的页面就走电脑的 vite，改前端保存即热更新（HMR）。原理：debug 源集的 `DevServerProxy` 把 `/assets/web/*` 转给 `127.0.0.1:5173`，页面来源仍是 appassets，通道与 CSP 不变；连不上开发服务器自动退回包内 assets，日志 `adb logcat -s ArkliDebug`。release 里没有这套代码（主代码只留一个空的 `DevAssetHook`）。改 Kotlin 仍要重新编译装机。
- 测试：`.\gradlew.bat testDebugUnitTest`（Kotlin）、`cd core; cargo test --workspace`、`cd web; pnpm test`。
- 打包与装机：`.\gradlew.bat assembleRelease` / `assembleDebug`；`adb -s 7NQBB23606003715 install -r <apk>`；拉起应用用 `adb -s 7NQBB23606003715 shell monkey -p com.let188.arkli -c android.intent.category.LAUNCHER 1`（**别用 `am start -n`**：它的 Intent 没有 LAUNCHER 分类，之后点桌面图标会被当成新启动，新开一个实例，看起来像"后台回来就重启"）。
- Windows 上 `curl` 访问 https 会因 schannel 吊销检查失败，加 `--ssl-no-revoke`。
- git 提示 LF/CRLF 转换的 warning 是正常的；`gradle wrapper` 在带构建脚本的目录里会卡住，要在空目录生成再拷回；origin 用 HTTPS。

## 工作约定（这个项目里用过的做法）
- 任务由 sonnet 子代理产出，主会话复审并**自己复跑测试**、核实外部事实（版本、体积、许可证、文献引文）；子代理只写自己的文件，共享文件（`registry.ts`、`toolIcons.ts`、文档索引）由主会话统一改；多个子代理并行时按目录划界，不并行跑会清空产物目录的构建、不并行占真机。
- antigravity（`mcp__antigravity__ask_antigravity`）此前每次都报"模型名无效"，没给出过实质结论，调研与开发直接用 sonnet 子代理。
- 提交前自查调试残留（`console.log`、`debugger`、`TODO`）；按功能分组、指定路径 `git add`，别用 `git add .`；push 前先看 `git status`。
- UI 反馈要按"元素、方向、位置"说清楚；尺子的数字方向、游标线长度改过多次，现版本是最终状态。

## 用户自己要核实
- ARKLI 商标检索（USPTO / WIPO / 中国商标网，第 9、42、35 类）。
- 注册 arkli.app / arkli.dev，GitHub 组织或账号变体；国内安卓应用市场同名检索。
- 隐私政策：联网工具会向 IPinfo、RDAP/WHOIS 注册局、汇率接口、**维基媒体（历史上的今天，会发月日与 IP）**发送什么数据；噪音测量要 `RECORD_AUDIO`。

## 构建变体（2026-10-16）

三种构建用不同的 applicationId 与应用名，可同机并存、互不覆盖；数据目录和已下载的模型也各自独立（换变体要重新下载或重推模型）。

| 变体 | applicationId | 应用名 | 说明 |
|---|---|---|---|
| debug | `com.let188.arkli.debug` | Arkli Debug | 可调试，带调试广播与探针；`run-as`、CDP 调试、`scripts/device-push-models.sh` 都针对它 |
| profile | `com.let188.arkli.profile` | Arkli Profile | release 同款混淆与签名，不可调试，清单声明 `profileable`，用于性能与体积评估 |
| release | `com.let188.arkli` | Arkli | 正式包；目前用 debug keystore 签名，仅供本机验证 |

构建命令：`./gradlew :app:assembleDebug|assembleProfile|assembleRelease --offline`。`namespace` 仍是 `com.let188.arkli`（代码与资源包名不变）；FileProvider 等 authority 已用 `${applicationId}` 拼接，所以不会冲突。
