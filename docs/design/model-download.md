---
title: 本地模型下载管理
status: active
updated: 2026-10-14
summary: native.model.* 的清单格式、下载器安全设计（白名单、逐跳重定向、sha256、路径）、状态机、验证结果与后续优化；先服务识物 SigLIP2，之后对联 GPT-2、Qwen 复用
---
## TL;DR
- 本地模型（决策 [0005](../decisions/0005-ai-four-layers.md)）一律**按需下载**，由原生 `ModelManager` 统一管：清单随包、下载在后台、断点续传、sha256 校验、用户可删除并看到占用空间。
- **页面只能传模型 id，不能传 URL**。下载地址只来自随包的 `assets/ai/models.json`，防止被页面或注入内容指向任意地址（SSRF、恶意模型）。
- 桥方法契约见 [Bridge 协议](bridge-protocol.md) 的「模型下载管理方法」；代码在 `com.let188.arkli.model`，前端在 `web/src/native/model.ts` 与 `web/src/stores/models.ts`。
- **托管位置**：清单里的 URL（`https://github.com/icodejoo/arkli/releases/download/siglip2-q4half-v1/q4_half.onnx`）对应的 release 已于 2026-10-15 发布（公开仓库，Apache-2.0，附许可证文本与 `SHA256SUMS`）。真实链路已实测：302 直接落到 `release-assets.githubusercontent.com`（所以 `DOWNLOAD_HOSTS` 里这个域名要保留），下载后字节数 54,662,805 与 sha256 `6b4ea1ec…217a` 和清单一致。App 内的下载（含 302 与白名单校验）还没在真机上用真实地址走过，之前只用本机 Range 服务验证过下载器。

## 清单（`app/src/main/assets/ai/models.json`）

随包 JSON，是信任锚。解析失败（任何一项不合法）整份拒绝并退化为空清单，所有 id 都会被桥方法拒绝，不会让应用崩溃。

```json
{
  "schema": 1,
  "models": [{
    "id": "siglip2-q4_half",
    "displayName": "本地识物模型（SigLIP2）",
    "version": "1",
    "dir": "models/siglip2-q4_half",
    "totalBytes": 54662805,
    "license": "apache-2.0",
    "files": [{
      "name": "q4_half.onnx", "bytes": 54662805, "role": "model",
      "sha256": "6b4ea1ecba627b754df325d86cc971620ac961b47d81310a3c0659827dff217a",
      "urls": ["https://github.com/icodejoo/arkli/releases/download/siglip2-q4half-v1/q4_half.onnx"]
    }]
  }]
}
```

- `dir` 必须是 `models/<单段名>`，相对 `filesDir`；识物的 `ClipEnv.modelFile()`（`models/siglip2-q4_half/q4_half.onnx`）与它一致，有单测盯着。
- `urls` 放在**每个文件**上（不是模型级）：多文件模型各文件的镜像可能不同，也与 [基础设施草案](platform-infrastructure.md) 里“每项含 `urls[]`”一致。按序回退，支持多镜像。
- `totalBytes` 必须等于各文件字节数之和；`sha256` 小写 64 位十六进制；文件名单段、不以点开头、不以 `.part` 结尾；id 与目录不得重复。
- `version` 变了，旧的校验标记失效，状态回到 `unverified`。
- 与草稿的差异：草稿设想的 Ed25519 签名、`minAppVersion`、`kind`、`filesDir/packs/<id>/<version>/` 这次**没做**。清单随 APK 发布，信任锚就是 APK 签名本身；以后要做可更新的远程清单时再加签名。

## 下载器安全设计

| 威胁 | 做法 |
|---|---|
| 页面或注入内容让原生去下任意地址 | 方法只收 `id`，且必须在清单里；多余字段（如 `url`）被忽略；URL 只来自随包清单 |
| 清单 URL 或重定向指向非预期主机 | `NetPolicy.isAllowedDownload`：https、无 userinfo、端口缺省或 443、主机精确命中 `DOWNLOAD_HOSTS`（`github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`）。**初始 URL 与每一跳重定向目标都校验**，最多 5 跳，`https→http` 降级一律拒绝。白名单与页面出站的 `ALLOWED_HOSTS`、CSP 的 `connect-src` **分开**，页面自己仍连不上这些主机 |
| 下载内容被替换或损坏 | 完成后对 `.part` 算 sha256，不一致删除 `.part` 并报 `HASH_MISMATCH`；通过才原子改名（`renameTo`，同分区）到目标文件。续传拼出来校验失败，会在同一源上从头再来一次（可能是旧 `.part` 坏了） |
| 服务器给的长度对不上 | `Content-Length`/`Content-Range` 与清单不符报 `SIZE_MISMATCH`，不重试，换下一源 |
| 磁盘写满 | 下载前检查可用空间 ≥ **待下载字节的 1.2 倍**（有 `.part` 时只算剩余部分），不够报 `NO_SPACE`，不发任何请求 |
| 路径穿越、泄露磁盘路径 | 目标目录与文件名在清单解析时校验；桥返回值不含任何路径，页面只拿 id、字节数、状态 |
| 删除误伤 | 只删清单列出的文件、对应 `.part` 与校验标记，不递归，目录里别的东西保留 |
| 同一模型并发下载 | 管理器的任务表按 id `putIfAbsent`，同一时刻只有一个任务；重复 `ensure` 幂等返回当前状态 |

**debug 才有的口子**：`ModelDebugHooks.urlOverride`（`app/src/main/.../ModelModule.kt`）非 null 时，用它替换下载源并放行 `http://127.0.0.1:<端口>`。**只有 `app/src/debug` 的调试广播 `modelurl` 会写它**，release 里没有任何写入点；覆盖只换 URL，清单里的 sha256 与字节数照常校验。debug 另有 `network_security_config` 放行 `127.0.0.1` 明文，release 的配置是全局禁止明文。

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
- 托管位置确认后，替换清单 URL、补镜像，并实测一次真实重定向。
