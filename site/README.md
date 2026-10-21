# site/：深链接落地页与 App Links 验证文件

这个目录的内容要原样发布到 **GitHub Pages 用户站点** 仓库 `icodejoo/icodejoo.github.io` 的根目录（站点根即 `https://icodejoo.github.io/`）。本仓库只负责准备文件，不自动部署。

```
site/
├─ .nojekyll                  # 关掉 Jekyll，否则以点开头的 .well-known 不会被发布
├─ 404.html                   # 落地页：承接 /arkli/t/<工具id> 的所有路径
├─ .well-known/assetlinks.json  # Android App Links 验证文件
└─ arkli/t/tools.json         # 工具 id -> 名称，由脚本生成，落地页用来显示名称
```

## 链接格式

- 对外：`https://icodejoo.github.io/arkli/t/<工具id>`（App Links，已装 App 且验证通过时直接进 App）
- 兜底：`arkli://tool/<工具id>`（落地页的“用 Arkli 打开”按钮用它）

## 为什么用 404.html

GitHub Pages 没有服务端路由，`/arkli/t/ruler` 没有对应文件，会回退到站点根的 `404.html`，浏览器地址栏保持原路径，页面脚本读 `location.pathname` 取出工具 id。代价：这些落地页的 HTTP 状态码是 404（用户看不出来，页面照常运行；配合 `noindex` 也不会被搜索引擎收录）。另外根 `404.html` 同时是整个 `icodejoo.github.io` 站点的 404 页，路径不匹配 `/arkli/t/<id>` 时显示通用的“Arkli 小工具箱”页。

## 部署步骤（需用户确认后再做）

1. 在 GitHub 建仓库 `icodejoo/icodejoo.github.io`（仓库名必须是这个，才是用户站点），Pages 选 main 分支根目录。
2. 先重新生成工具名映射（注册表有增减时都要做）：`cd web && node scripts/export-tools.mjs`
3. 把本目录内容（含以点开头的 `.nojekyll`、`.well-known/`）复制到该仓库根目录，提交并推送。
4. 验证文件线上可达：`curl -i https://icodejoo.github.io/.well-known/assetlinks.json` 应为 200，且 Content-Type 为 JSON（GitHub Pages 会按扩展名给 `application/json`）。
5. 手机上让系统重新验证：`adb shell pm verify-app-links --re-verify com.let188.arkli`，再用 `adb shell pm get-app-links com.let188.arkli` 看 `icodejoo.github.io` 是否为 `verified`。

## assetlinks.json 说明

- 包名：`com.let188.arkli`（release）与 `com.let188.arkli.debug`（debug，装机验证用）；profile 包不列。
- 指纹：本机 `~/.android/debug.keystore` 的 SHA-256（`keytool -list -v -keystore ~/.android/debug.keystore -storepass android` 读出）。目前 debug 与 release 共用这把 keystore，所以指纹相同。
- **换签名必须同步更新此文件**：上架换正式签名后，把新证书的 SHA-256 加进 `sha256_cert_fingerprints`（可同时保留旧的），重新部署，否则 App Links 验证失败、链接只会走浏览器/选择框。Play 应用签名则要用 Play 控制台里的“应用签名密钥证书”指纹。
