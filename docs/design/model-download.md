---
title: 本地模型下载管理
status: active
updated: 2026-10-19
summary: native.model.* 的清单格式、下载器安全设计（白名单、逐跳重定向、sha256、路径）、状态机、外部目录导入（真机已验）、验证结果与后续优化；先服务识物 SigLIP2，之后对联 GPT-2、Qwen 复用
---
## TL;DR
- 本地模型（决策 [0005](../decisions/0005-ai-four-layers.md)）一律**按需下载**，由原生 `ModelManager` 统一管：清单随包、下载在后台、断点续传、sha256 校验、用户可删除并看到占用空间。
- **页面只能传模型 id，不能传 URL**。下载地址只来自随包的 `assets/ai/models.json`，防止被页面或注入内容指向任意地址（SSRF、恶意模型）。
- 桥方法契约见 [Bridge 协议](bridge-protocol.md) 的「模型下载管理方法」；代码在 `com.let188.arkli.model`，前端在 `web/src/native/model.ts` 与 `web/src/stores/models.ts`。
- **识物已换 MNN 版（2026-10-15）**：清单里新增 `siglip2-mnn-w8`（`models/siglip2-mnn-w8/model.mnn`，94,775,452 B，sha256 `8af99950…60d5`，release `siglip2-mnn-v1` **待用户上传**），`ClipEnv.modelFile()` 指向它；旧条目 `siglip2-q4_half` 已在 M9（2026-10-16）移入 `retired`。下面的托管说明（`siglip2-q4half-v1` release）是旧 ONNX 版的记录，该 release 不删但清单不再引用。
- **托管位置**：清单里的 URL（`https://github.com/icodejoo/arkli/releases/download/siglip2-q4half-v1/q4_half.onnx`）对应的 release 已于 2026-10-15 发布（公开仓库，Apache-2.0，附许可证文本与 `SHA256SUMS`）。真实链路已实测：302 直接落到 `release-assets.githubusercontent.com`（所以 `DOWNLOAD_HOSTS` 里这个域名要保留），下载后字节数 54,662,805 与 sha256 `6b4ea1ec…217a` 和清单一致。App 内的下载（含 302 与白名单校验）还没在真机上用真实地址走过，之前只用本机 Range 服务验证过下载器。
- **第二个托管模型**：Qwen3.5-0.8B MNN 文本模型（6 个文件，合计 484,349,699 字节）在 release `qwen35-mnn-v1`，来源、sha256 与使用建议见 [Qwen3.5 MNN 模型](../research/qwen35-mnn-model.md)。

## 清单（`app/src/main/assets/ai/models.json`）

随包 JSON，是信任锚。解析失败（任何一项不合法）整份拒绝并退化为空清单，所有 id 都会被桥方法拒绝，不会让应用崩溃。

```json
{
  "schema": 1,
  "retired": [{ "id": "siglip2-q4_half", "dir": "models/siglip2-q4_half" }],
  "models": [{
    "id": "siglip2-mnn-w8",
    "displayName": "本地识物模型（SigLIP2，MNN 版）",
    "version": "1",
    "dir": "models/siglip2-mnn-w8",
    "totalBytes": 94775452,
    "license": "apache-2.0",
    "files": [{
      "name": "model.mnn", "bytes": 94775452, "role": "model",
      "sha256": "8af99950b0fb39c2df90e66d67181eecc4e538617fbfdc0242ee420b36ac60d5",
      "urls": ["https://github.com/icodejoo/arkli/releases/download/siglip2-mnn-v1/model.mnn"]
    }]
  }]
}
```

- `dir` 必须是 `models/<单段名>`，相对 `filesDir`；识物的 `ClipEnv.modelFile()`（`models/siglip2-mnn-w8/model.mnn`）与它一致，有单测盯着。
- `urls` 放在**每个文件**上（不是模型级）：多文件模型各文件的镜像可能不同，也与 [基础设施草案](platform-infrastructure.md) 里“每项含 `urls[]`”一致。按序回退，支持多镜像。
- `totalBytes` 必须等于各文件字节数之和；`sha256` 小写 64 位十六进制；文件名单段、不以点开头、不以 `.part` 结尾；id 与目录不得重复。
- `version` 变了，旧的校验标记失效，状态回到 `unverified`。
- 与草稿的差异：草稿设想的 Ed25519 签名、`minAppVersion`、`kind`、`filesDir/packs/<id>/<version>/` 这次**没做**。清单随 APK 发布，信任锚就是 APK 签名本身；以后要做可更新的远程清单时再加签名。

## 数据包（`kind: "pack"`，2026-10-16）

下载一个压缩包、由原生解压的条目（首个用例：`couplet-corpus`，见 [对联语料库](couplet-corpus.md)）。清单：`"kind": "pack"` + `archive`（`name` 必须以 `.zip` 结尾，带 `bytes`/`sha256`/`urls`）+ `files`（**解压后**的文件，带 `bytes`/`sha256`，**不得带 `urls`**）；`totalBytes` 仍等于解压文件之和。

- 下载：沿用逐文件的续传、多源、逐跳重定向、sha256 校验把 zip 落到模型目录；已有的 zip（下载完或 adb 放入）校验通过就直接用。
- 解压（`PackExtractor`）：只解清单里列出的文件，压缩包里有清单外条目、目录、重复条目、声明长度不符、写超均报 `UNPACK_FAILED`；每个文件边写边算 sha256，不符报 `HASH_MISMATCH` 并删 `.part`，通过才原子改名；成功后删 zip。阶段名 `unpack`。
- 空间：压缩包剩余字节 ×1.2 加上待解出文件字节。
- 状态：`totalBytes`/`downloadedBytes` 以压缩包字节算（用户关心的下载量），`diskBytes` 含解压文件与压缩包；`installed` 由解压文件的校验标记判定。`remove` 同时清掉 zip 与 `.part`；`native.model.sources` 的 `files` 只列压缩包。
- adb 模拟“已下载”：`scripts/device-push-models.sh` 对只含 `.zip` 的目录推送后触发 `native.model.ensure`。

## 单包安装（自转模型，2026-10-19）

我们自己转换的 7 个模型（识物、NLLB、语音、OCR v6、对联 GPT-2、MODNet、U2Net-p）改为**一个 zip 包**：清单里 `archive`（`name` 为 `<id>-<version>.zip`，带 `bytes`/`sha256`/`urls`）+ `files`（解压后各文件的 `bytes`/`sha256`，不带 `urls`），`kind` 缺省即可（`archive` 对任意模型可选，数据包 `kind:"pack"` 仍必须有）。**解压后的目录布局与旧的逐文件安装完全一致**，各 Service 的加载代码未动。旧格式（只有 `files[]` 带 `urls`）仍能解析与安装。第三方现成模型（Qwen3.5）、已退役项保持旧格式。

- 流程沿用数据包：多镜像续传下载 zip（0 到约 90%，`download`）→ 整包 sha256（`verify`）→ 空间预检（压缩包剩余 ×1.2 + 待解出字节，不足报 `NO_SPACE`，不发请求）→ 解压（`unpack`，IO 线程，响应取消）→ 逐文件边写边算 sha256，对上才从 `.part` 原子改名 → 写完成标记 → 删 zip。
- 安全：解压只认清单里的文件名，其余条目（含 `..`、绝对路径、目录）、重复条目、声明长度不符、写超一律 `UNPACK_FAILED`；条目数与总解压大小被清单封顶。**与最初设想的差异**：没有单独的“临时目录再整体 rename”，而是逐文件 `.part` + 原子改名，完成标记最后写；没标记即不算就绪，所以半途被杀不会被当成已安装，且避免同分区多一份拷贝。
- 迁移：旧多文件已装用户的文件名、sha 与完成标记不变，清单切包后仍判 `installed`，不重下（真机实测，见下）。
- 残留：取消只保留 `.zip.part`（续传）；`ModelManager.sweepResidue()` 每次启动清扫一次：解压中被杀的 `<文件>.part` 一律删，模型已就绪时遗留的 zip 与 `.zip.part` 也删，未就绪的 zip 保留供下次直接解压。
- 打包：`scripts/mnn/pack.py <目录> --tag <tag> --zip <输出目录> --apply app/src/main/assets/ai/models.json`，zip 可复现（条目按名排序、时间戳固定）；deflate 收益 <3% 的条目用 stored（只有 NLLB 的 3 个小文件命中，权重 deflate 能省 3%~9%）。
- 线上（release 新增资产，旧资产未动）：`siglip2-mnn-w8-1.zip` 86,502,640 B；`nllb600m-un6-mnn-w6-1.zip` 385,862,916 B；`asr-zipformer-zh-en-mnn-w8-1.zip` 155,227,742 B；`ppocrv6-small-mnn-fp16-1.zip` 13,102,305 B；`couplet-gpt2-mnn-w6-1.zip` 91,288,958 B；`matting-modnet-mnn-fp32-1.zip` 24,039,813 B；`matting-u2netp-mnn-f16-1.zip` 2,173,631 B（两个 matting release 为本次新建）。均用 aria2c 从线上重下，大小与 sha256 和清单一致。
- 真机实测（STG-AL00，debug 包，真实 GitHub 链路）：OCR 总 2.2 s；对联总 10.1 s（下载 9.0、校验 0.2、解压 0.85），峰值 PSS 355MB；NLLB 续传 23.5 s + 校验 0.4 + 解压 1.5，峰值目录占用 749MB（zip + 解压后），峰值 PSS 494MB（基线 428MB）。取消后只留 `.zip.part`，续传到完成；解压中途 force-stop 后重启，不联网、2.3 s 完成；人造残留重启即清；伪造 300GB 包得到 `NO_SPACE`；旧布局的两个抠图模型仍 `installed` 且 provider `available`。

## 外部目录导入（2026-10-19）

release 包不可调试、没有 `run-as`，手机又常常没网，所以加一个不需要权限的外部入口：`/sdcard/Android/data/<包名>/files/import/<模型id>/`（即 `getExternalFilesDir(null)/import/<id>/`，adb 与部分文件管理器可直接写）。**先打开一次 App 再放**：该目录由 App 启动时自己创建（adb 先建的属主不同，App 读不到）。

- 放什么：清单里该模型的文件，单包模型放 zip、多文件模型放各文件（或已解压文件）；清单外的文件不复制，目录名不在清单里的整个忽略并记日志。
- 时机：App 启动时在后台 IO 线程扫一次（排在 `sweepResidue` 之后）；AI 中心打开（`native.model.list`）时若导入目录非空也扫一次，免重启。导入任务全局互斥（一次只处理一个模型），且与下载、删除、校验共用按模型的任务表，同一模型已在处理或已安装则跳过。
- 动作（`ModelManager.scanImports`）：复制到 `files/models/<id>/`（先写 `.imp` 再原子改名，外部与内部是不同分区所以不用 rename；空间按 1.2 倍预检，不足报 `NO_SPACE`），随后走与下载同一套校验与解压（zip 整包 sha256 + 解压逐文件 sha256，已解压文件逐个 sha256）。**不跳过 sha 校验，导入全程不联网**。状态沿用 `downloading` 加 `verify`/`unpack` 阶段，Web 侧没有新状态。
- 成功：写完成标记，删除 `import/<id>/`。失败（校验不过、空间不足、读写出错）：删掉已复制进私有目录的文件，导入目录原样保留，错误码按现有的推送（校验不过为 `HASH_MISMATCH`）；同一进程内不自动重试，改好文件后重启 App 再扫。
- 脚本：`MODE=import PKG=com.let188.arkli scripts/device-push-models.sh [库目录] [模型 id ...]`，会先拉起 App、等 `import` 目录出现、推文件、重启 App 触发扫描。
- **真机已验**：release 包（新签名，旧 10-17 release 已卸载重装）导入全部 9 个模型（asr、couplet-corpus、couplet-gpt2、matting×2、nllb、ppocrv6、qwen35、siglip2），约 10 秒内完成，AI 中心显示 installed（见 [状态](../status.md)）。

## 退役模型回收（`retired`）

清单顶层可选字段 `retired: [{ "id": "...", "dir": "models/<单段名>" }]`，表示已退役、设备上应当回收的旧模型目录（换格式或换模型后，用户机上遗留的旧文件靠它清掉）。

- 解析宽松：缺省为空；不是数组按空处理；不合法的条目（id 或目录不合规）直接丢弃，不影响整份清单。
- 回收时机：`ModelModule.install` 之后在后台、排在 `AiHeavyGate` 之后执行，每个进程一次；不阻塞启动，失败只记日志。
- 规则（`ModelPolicy.retiredDirsToDelete`）：目录必须是 `models/<单段名>`；与现行条目的 `dir` 重名则跳过；只删设备上实际存在的目录。删除前再规范化路径，确认目标是 `filesDir/models` 的直接子目录（防路径穿越、符号链接逃逸）。
- 退役条目不在现行清单里，没有下载入口、也没有会话在用，所以不额外判断下载状态；往里加条目时不要复用现行条目的目录。
- **当前已登记（M9，2026-10-16）**：`siglip2-q4_half`（旧识物 ONNX）、`nllb600m-un6-ccm-int4`（旧翻译 ONNX）、`asr-zipformer-zh-en-int8`（旧语音，此前手动放置）、`ppocrv5-mnn-fp16`（OCR v5，被 v6 取代）。有单测 `ModelRetiredTest.shippedManifest_retiresOldOnnxDirs` 盯着。

## 下载器安全设计

| 威胁 | 做法 |
|---|---|
| 页面或注入内容让原生去下任意地址 | 方法只收 `id`，且必须在清单里；多余字段（如 `url`）被忽略；URL 只来自随包清单 |
| 清单 URL 或重定向指向非预期主机 | `NetPolicy.isAllowedDownload`：https、无 userinfo、端口缺省或 443、主机精确命中 `DOWNLOAD_HOSTS`（`github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`）。**初始 URL 与每一跳重定向目标都校验**，最多 5 跳，`https→http` 降级一律拒绝。下载白名单与页面出站策略**分开**：页面出站虽放行任意 https，下载器仍只认这几个主机 |
| 下载内容被替换或损坏 | 完成后对 `.part` 算 sha256，不一致删除 `.part` 并报 `HASH_MISMATCH`；通过才原子改名（`renameTo`，同分区）到目标文件。续传拼出来校验失败，会在同一源上从头再来一次（可能是旧 `.part` 坏了） |
| 服务器给的长度对不上 | `Content-Length`/`Content-Range` 与清单不符报 `SIZE_MISMATCH`，不重试，换下一源 |
| 磁盘写满 | 下载前检查可用空间 ≥ **待下载字节的 1.2 倍**（有 `.part` 时只算剩余部分），不够报 `NO_SPACE`，不发任何请求 |
| 路径穿越、泄露磁盘路径 | 目标目录与文件名在清单解析时校验；桥返回值不含任何路径，页面只拿 id、字节数、状态 |
| 删除误伤 | 只删清单列出的文件、对应 `.part` 与校验标记，不递归，目录里别的东西保留 |
| 同一模型并发下载 | 管理器的任务表按 id `putIfAbsent`，同一时刻只有一个任务；重复 `ensure` 幂等返回当前状态 |

**debug 才有的口子**：`ModelDebugHooks.urlOverride`（`app/src/main/.../ModelModule.kt`）非 null 时，用它替换下载源并放行 `http://127.0.0.1:<端口>`。**只有 `app/src/debug` 的调试广播 `modelurl` 会写它**，release 里没有任何写入点；覆盖只换 URL，清单里的 sha256 与字节数照常校验。debug 另有 `network_security_config` 放行 `127.0.0.1` 明文，release 的配置是全局禁止明文。

## 下载地址的展示与手动下载（`native.model.sources`）

- **单一来源是 `models.json`**：界面不硬编码任何地址，AI 中心通过只读桥方法 `native.model.sources`（参数 `{ id }`）向原生取。返回 `{ id, dir, files:[{ name, bytes, sha256, urls }], releasePages:[…] }`，纯函数在 `ModelPolicy.sourcesJson` / `releasePageOf`（单测 `ModelSourcesTest`）。
- **脱敏与白名单**：每个地址先过 `NetPolicy.isAllowedDownload`（不放行回环明文）再 `NetPolicy.redact`（去掉查询串与片段），所以带 token 的地址不会回显；只读清单，debug 的 `urlOverride` 不参与，永远不回显。`dir` 是相对 filesDir 的目录，不含绝对路径。
- **release 页面**由 `https://github.com/<o>/<r>/releases/download/<tag>/<文件>` 推出 `https://github.com/<o>/<r>/releases/tag/<tag>`，去重；推不出的地址不给页面。
- **不改变下载行为**：只读，不触碰下载器与状态机。
- 界面（AI 中心 `/ai` 的「本地模型」）：每个模型有「点击下载」「下载地址」，未校验时有「校验」。面板列出文件名、大小、sha256（可复制）、全部镜像地址（可点开，走 `native.intent.open` kind `url`，无宿主 `window.open`；可复制）与 release 页面，并说明手动放置：下载后原样放进 `files/<dir>/`，再点「校验」。该目录在应用私有区，普通文件管理器访问不到，需 adb（debug 包 `run-as`）。

## 状态机

`state`：`absent`（未安装，可能留有 `.part`）→ `downloading`（`phase` 为 `download` 或 `verify`）→ `installed`；另有 `unverified`（文件齐全但没有有效校验标记，如 adb 手动放进去的）与 `corrupt`（有文件长度不对）。

- **校验标记**：`<dir>/.arkli-model.json` 记录版本与各文件的（长度，修改时间），下载或 `verify` 通过后写入。`installed` = 文件齐全且指纹与标记吻合；这样每次探测只做 `stat`，不用重算 54MB 的 sha256。文件被改动或替换，指纹对不上就回到 `unverified`。
- `ensure`：`installed`/`downloading` 直接返回；`unverified` 只做校验（已有文件算 sha，通过即装好，不通过删除重下）；其余启动下载，有 `.part` 就用 `Range: bytes=<.part 长度>-` 续传。`.part` 的长度就是“已下载字节”的记录，不另存。
- **取消**（`cancel`、协程取消）不删 `.part`；失败（网络、校验）也保留或按规则清理，原因记在 `error`，下次 `ensure` 清除。`remove` 才清理全部。
- **续传判定**（`ModelPolicy.decideRange`）：200 视为服务器不支持 Range，截断 `.part` 从头来；206 要求 `Content-Range` 起点等于请求偏移、终点是文件末尾、总长（若给了）等于清单；416 且偏移等于总长视为已完整，否则丢弃 `.part` 重来。
- **重试**：同一源上连续 3 次无进展的失败才换源（有进展则计数重置），累计重试硬上限 12 次；退避 1、2、4、8 秒封顶。4xx（除 408/429）、白名单拒绝、长度不符不重试，直接换源。超时 20 秒。
- **进度**：下载在管理器自己的协程作用域里，**不随页面会话关闭而取消**；页面重载后 `status` 接着看。事件推送是会话级的（`ctx.emit` 页面关了就丢），所以页面启动时用 `native.model.list` 取一次快照，之后靠 `model.changed` 事件实时更新：管理器有一个进程级监听者，由最新会话的桥安装；进度按 300 毫秒节流，状态切换即时推送。前端由 `useModelsStore` 统一接收。
- **删除时释放会话**：`ModelManager.addReleaseHook`，识物登记了 `ClipService.unload()`（排在 `AiHeavyGate` 后，不打断正在进行的识别），再删文件。

## 已验证（真机 STG-AL00，debug 包 + 本机 Range 服务 + `adb reverse`）

见 [状态](../status.md) 与会话汇报：断点续传（取消后续传、中途掉线自动续传）、服务器忽略 Range 时从头来、sha256 篡改被拒、`native.ai.providers` 状态变化、下载后 `native.ai.classify` 跑通、`remove` 后恢复为未安装并可再次下载。**GitHub release 的真实 302 链路没有验证**（release 尚未发布），`release-assets.githubusercontent.com` 是按 GitHub 2025 年起的新行为预先加进白名单的，发布后要实测一次真实重定向的落点主机。

## 未做与后续

- **多连接分片**：用户在菲律宾，单连接慢、多连接可叠加。当前每个文件单连接。后续可做 aria2 式多段并发（按 Range 切成 4~8 段并行写入同一 `.part` 的不同偏移，需要每段独立的续传记录），属下一步优化。
- **前台服务**：下载跑在应用进程的协程里，应用被系统杀掉就停（`.part` 保留，重开后 `ensure` 续传）。大模型（Qwen）下载时间长，需要时再接前台服务与通知。
- 清单签名与远程更新、模型版本升级时自动清理旧版本、`pack.progress` 事件推送（`native.pack.*` 规划里的）。
- 补镜像。（真实 302 链路已随单包安装实测通过。）
