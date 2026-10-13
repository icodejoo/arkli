---
title: 图片类工具落地设计
status: draft
updated: 2026-10-13
summary: 「图片」分类全部工具的落地方案：层归属、所用库、bridge 方法、体积与优先级
---
## TL;DR
- 覆盖功能清单「图片」分类全部 21 项：P0 5 项、P1 7 项、P2 7 项、建议不做 2 项（以图搜图、B 站封面获取）。
- **WebView 的 Canvas 当图片编解码器**：JPG/PNG/WebP 的解码、缩放、绘制、编码全在 Web 做，零体积；Rust 只管 Canvas 做不了的（GIF 编解码、PNG 调色板量化、视觉模型），而且 Rust 只吃 PNG/GIF，不引入 `image` 全家桶。
- 二维码扫码走原生（CameraX + zxing-cpp），相册识别也用同一个 zxing-cpp，不再加 Rust 二维码库。
- APK 增量约 1.5–2.5MB（大头是 zxing-cpp 0.73MB deflate 和 CameraX，推测），不含 AI 运行时；证件照模型约 25MB，按需下载。

## 总览

| # | 工具 | 层 | 首选方案 | APK 增量 | 优先级 |
|---|---|---|---|---|---|
| 1 | 二维码工具 | 组合：Web 生成 + 原生扫码 | nayuki 生成；CameraX + zxing-cpp 识别 | ~1.2–1.7MB | P0 |
| 2 | 文字转图 | Web | Canvas 排版，系统字体 | ~0 | P1 |
| 3 | 图片压缩 | Web（PNG 量化走 Rust） | Canvas 重编码 + 质量二分；color_quant | ~0 | P0 |
| 4 | 图片拼接 | Web | Canvas，超限分段导出 | ~0 | P0 |
| 5 | 九宫格切图 | Web | Canvas + 共用裁剪框 | ~0 | P0 |
| 6 | GIF 合成/分解 | Web + Rust | Rust `gif` + `png` | ~0.2–0.4MB 未压缩（推测） | P1 |
| 7 | 取色器 | Web | Canvas 取像素 + 自写 median-cut | ~0 | P1 |
| 8 | 图片格式转换 | Web | Canvas 出 JPG/PNG/WebP，BMP/ICO 自写封装 | ~0 | P0 |
| 9 | 图片水印 | Web | Canvas | ~0 | P1 |
| 10 | 图片转 Base64 | Web | FileReader / atob | ~0 | P1 |
| 11 | 纯色图制作 | Web（与 12 合并） | Canvas | ~0 | P2 |
| 12 | 渐变图生成器 | Web（与 11 合并） | Canvas 渐变 API | ~0 | P2 |
| 13 | 表情包制作 | Web（GIF 走 Rust） | Canvas 编辑器，不做模板库 | ~0 | P2 |
| 14 | 以图搜图 | — | 用通用分享替代 | 0 | 建议不做 |
| 15 | 幻影坦克（隐藏图） | Web | JS 像素运算 | ~0 | P1 |
| 16 | 图片提取表格 | Web + Rust（复用 OCR） | OCR 框 + 行列聚类；后续 SLANet | 0（模型另算） | P2 |
| 17 | 图片查看器 | Web | 共用预览组件 + EXIF | ~0 | P2 |
| 18 | 带壳截图 | Web | Canvas 画通用外壳，不带品牌机框 | ~0 | P2 |
| 19 | 证件照生成 | Web + Rust（ORT） | YuNet 人脸 + MODNet 抠图 | ~0（模型 ~25MB 下载） | P1 |
| 20 | 拼豆图纸生成 | Web | 网格降采样 + Lab 最近色 | ~0 | P2 |
| 21 | B 站封面获取 | — | 暂不做 | 0 | 建议不做 |

## 共用部件

### Web：`web/src/tools/image/_shared/`
所有 Web 图片工具走同一条"选图 → 处理 → 预览 → 保存"管线，单个工具只写"处理"那一步。

| 部件 | 职责 |
|---|---|
| `pickImages()` | 调 `native.file.pick` 选图，拿到缓存路径和可读 URL、宽高、mime、字节数 |
| `loadBitmap(url, opts)` | `createImageBitmap(..., { imageOrientation: 'from-image' })`，按 EXIF 摆正；超过像素上限先缩 |
| `encodeCanvas(canvas, { mime, quality, targetBytes })` | 包一层 `toBlob`；给了 `targetBytes` 就对 quality 二分，二分到底仍超标再按比例缩边 |
| `writeAndSave(blobs, opts)` | 二进制写入缓存目录，再调 `native.file.save` 存相册；批量时一次调用 |
| `ImagePreview.vue` | 双指缩放/拖动、前后对比滑杆、显示尺寸与体积 |
| `CropBox.vue` | 固定比例裁剪框（九宫格、证件照、拼豆、表情包共用），内部用 cropperjs |
| `BatchQueue` | 批处理串行执行（并发 1，防爆内存），出进度和可取消 |
| `color.ts` | HEX/RGB/HSL/CMYK/Lab 互转、色差；和开发者类的「颜色转换」共用 |
| `quantize.ts` | median-cut 调色板提取（取色器、拼豆限色共用） |
| 常量 | `MAX_CANVAS_SIDE`、`MAX_CANVAS_PIXELS`，先按单边 16384、总像素 6400 万保守取值，真机实测后调 |

要点：
- Chromium 的 Canvas 有尺寸上限（单边约 32767、面积约 2.68 亿像素），移动端内存不够时会更早失败、且常常是静默出空白图（推测）。所以一律先查尺寸再画，超限就提示或自动分段，不要等出了空图再说。
- Canvas 重编码会丢掉全部 EXIF。好处是顺手去掉了 GPS 等隐私信息，坏处是拍摄信息也没了。v1 接受这个结果，界面上写明"导出图不含拍摄信息"。
- 不引 pica：缩放用 `imageSmoothingQuality = 'high'`，缩小超过一半时逐级减半，画质够用。
- HEIC/HEIF 交给原生在选图时转成 JPEG（见文末的公共需求），Web 只处理 JPG/PNG/WebP/GIF/BMP，AVIF 看 WebView 版本（推测 Chromium 85+ 支持解码）。

### Rust：`core/crates/arkli-image`（新 crate）
- 只依赖 `gif`、`png`、`color_quant`，不引 `image`、`fast_image_resize`、`oxipng`、`jpeg-encoder`。理由：JPEG/WebP 编解码和缩放 Canvas 已经免费提供，Rust 再带一套就是为同一件事付两次体积。选型文档推荐的 `image` 系先不用；如果 AI 类的 OCR 方案确定要引 `image`，再回头评估要不要让本 crate 改用它。
- 约定：Web 和 Rust 之间的像素只用 PNG 文件交换（GIF 本身除外）。Rust 读 PNG、写 PNG，从不碰 JPEG。
- 大任务逐帧流式处理：GIF 解码一帧写一帧，不把整个动图读进内存。
- 长任务经原生转成 `image.progress` 事件（`{ task, percent }`）推给页面，支持取消。
- 视觉模型（人脸检测、人像抠图）不在本 crate，放到和 OCR 共用的视觉推理 crate（由 AI 类方案定义，复用 sherpa-onnx 自带的那份 ORT），本文只定义方法。

### 原生：本类只新增两个模块
- `native.qrcode.*`：扫码页（Compose + CameraX）和相册图识别，都用 zxing-cpp。
- `native.image.exif`：用平台 `android.media.ExifInterface` 读 EXIF，零依赖。

## 逐工具方案

### 1. 二维码工具｜组合｜M｜P0
- 生成（Web）：把 nayuki QR-Code-generator 的 TypeScript 单文件直接放进仓库（MIT，不走 npm），拿到模块矩阵后用 Canvas 自己画：前景/背景色、圆点/圆角码点、中心 Logo（自动把纠错级别提到 H）、边距；导出 PNG，另外拼 SVG 字符串导出矢量。内置文本、网址、WiFi、名片几种内容模板。条码（EAN/Code128）生成 v1 不做。
- 扫码（原生）：Compose 全屏取景，CameraX `ImageAnalysis` 把 Y 平面喂给 zxing-cpp，支持 QR/DataMatrix/常见一维码，带闪光灯和变焦。
- 相册识别（原生）：同一个 zxing-cpp 解 Bitmap，所以不再引 Rust 的 rqrr/rxing。
- 结果页回到 Web：网址点了才打开（先确认），WiFi 码只展示 SSID 和密码并提供复制，v1 不做自动连接。
- Bridge：
  - `native.qrcode.scan` `{ formats?: string[] }` → `{ cancelled: boolean, results: [{ text, format }] }`
  - `native.qrcode.decode` `{ path }` → `{ results: [{ text, format, points }] }`
- 体积：zxing-cpp arm64 so 实测 1.75MB 未压缩 / 0.73MB deflate（已查证，下载 3.1.1 AAR 量的）；CameraX core+camera2+lifecycle+view 四个 1.5.3 AAR 合计约 1.96MB，经 R8 后 dex 增量未知（推测 0.5–1MB）。CameraX 以后能给其他相机类工具共用。
- 权限：CAMERA（运行时申请）；离线。
- 风险/测试：低端机上的帧率和发热；反色码、小码、强反光；扫码页返回键和 WebView 路由的配合。

### 2. 文字转图｜Web｜S｜P1
- Canvas 排版：中文按字断行，加简单的标点禁则（句号逗号不出现在行首）；可调字号、行距、内边距、背景色/渐变（复用 12 的组件）。只用系统字体，不打包字体。正文太长超过 `MAX_CANVAS_SIDE` 就分成多张导出。
- Bridge：只用公共的保存/分享。体积约 0；离线。
- 测试：emoji、长英文单词、全角半角混排时的断行。

### 3. 图片压缩｜Web（PNG 量化走 Rust）｜S/M｜P0
- 三种模式：质量滑杆；目标体积（如"压到 200KB 以内"，由 `encodeCanvas` 二分）；限制最长边。可批量，列表显示压缩前后体积和比例。
- 输出格式：保持原格式或转 JPEG/WebP。PNG 用 Canvas 重编码基本压不小，所以给 PNG 提供"有损压缩到 256 色"：调 Rust，用 `color_quant`（NeuQuant）量化后输出索引色 PNG，效果接近 TinyPNG。没有选 libimagequant（pngquant 的核心），因为它是 GPL-3.0/商业双许可。
- Bridge：`rust.image.pngQuantize` `{ path, colors?: 2..256, dither?: boolean }` → `{ path, bytes }`
- 体积：Canvas 部分 0；量化复用 GIF 已经引入的 `color_quant` 和 `png`，不再新增依赖。离线。
- 风险/测试：超大图（1 亿像素级）超出 Canvas 上限；带透明的 PNG 转 JPEG 时用白底填充；目标体积二分的上限次数（定为 8 次）。

### 4. 图片拼接｜Web｜M｜P0
- 竖拼、横拼、网格三种；宽度统一（以最窄或指定宽度为准）、间距、边框、背景色；拖动排序。
- 超出 Canvas 上限时，先提示"缩小宽度"或"自动分成 N 段导出"，v1 不做 Rust 流式拼接，后面真有需求再加。
- 截图去重叠（自动识别并去掉重复的状态栏/导航栏、相邻截图的重叠区）放到 P2 子功能：在缩小后的灰度图上按行做哈希匹配，用 JS 就能做。
- Bridge：只用公共的。体积约 0；离线。
- 测试：10 张 1080×2400 截图竖拼（总高 24000 像素）在 4GB 内存机型上能不能成功出图。

### 5. 九宫格切图｜Web｜S｜P0
- 规格：3×3、2×2、1×3、3×1、2×3；先用 `CropBox` 按目标比例框选，再均分导出 N 张，文件名带序号；提供"朋友圈效果"预览。
- Bridge：`native.file.save` 一次批量保存。体积约 0；离线。
- 测试：保存后在相册里的排列顺序（相册按时间排序，要控制写入时间或顺序）。

### 6. GIF 合成/分解｜Web + Rust｜M｜P1
- 合成：Web 先把每张输入图按统一尺寸（适应/填充）画好，写成 PNG 帧 → Rust 用 `gif` 编码（每帧走 `Frame::from_rgba_speed` 做 NeuQuant 量化）→ 页面里直接用 `<img>` 预览 → 保存。支持帧间隔、循环次数、倒放、调速。
- 分解：Rust 解码，自己按帧处置方式（disposal）合成完整画面，每帧写一个 PNG → Web 列出缩略图，可以勾选导出。
- 上限常量：最多 300 帧、最长边 800 像素，超出先提示缩小。
- Bridge：
  - `rust.image.gifEncode` `{ frames: string[], delayMs: number | number[], loop?: number, speed?: 1..30 }` → `{ path, bytes }`
  - `rust.image.gifDecode` `{ path, maxFrames? }` → `{ width, height, loop, frames: [{ path, delayMs }] }`
- 没选的方案：gifski（AGPL）；WebCodecs `ImageDecoder`（零体积，但老 WebView 和国产 ROM 不一定有，推测）；JS 的 gifenc（2021 年后没更新）。音视频类的「视频转 GIF」也可以复用 `gifEncode`。
- 体积：`gif` + `weezl` + `png` + `color_quant` 约 0.2–0.4MB 未压缩（推测，等体积基线脚本实测）。离线。
- 测试：带透明的 GIF、隔行扫描 GIF、各种 disposal 方式；200 帧 GIF 分解时的峰值内存。

### 7. 取色器｜Web｜S｜P1
- 图片取色：点按位置弹出放大镜（Canvas 放大采样），显示 HEX/RGB/HSL/CMYK，一键复制；自动提取主色调色板（median-cut，在 100×100 的缩略图上算）。
- 屏幕取色（从别的 App 上取色）**建议不做**：要 MediaProjection 录屏授权和悬浮窗权限，成本和打扰都大。替代做法：用户先截图，再在这里打开截图取色。
- 没用 colorthief：median-cut 算法公开成熟，自写约 80 行；拼豆的"限色"也要复用同一份量化代码，自写更方便共享。
- Bridge：`native.clipboard.write`。体积约 0；离线。

### 8. 图片格式转换｜Web｜S｜P0
- 和图片压缩共用一个页面骨架，两个入口。输出 JPG/PNG/WebP 用 Canvas；BMP 和 ICO 是简单的容器格式，JS 自己拼文件头（各约 40 行，没必要为此引库）；单帧 GIF 调 `rust.image.gifEncode`。
- 不支持输出 AVIF/HEIC：没有轻量编码器（ravif 依赖 rav1e，体积和端上速度都不划算，推测）。
- 输入的 HEIC 由原生选图时转成 JPEG。体积约 0；离线。
- 测试：透明图转 JPG 的底色；ICO 多尺寸（16/32/48/256）在 Windows 资源管理器里能不能正常显示。

### 9. 图片水印｜Web｜S｜P1
- 文字水印（字体大小、颜色、透明度、旋转、平铺间距）和图片水印（PNG Logo），位置有九宫格定位和满屏平铺两种；可批量。
- 内置"证件复印件"模板：满屏斜排"仅供 XX 使用"，这是国内很常见的用法。
- 体积约 0；离线。测试：竖图和横图上平铺密度是否一致；批量 20 张时的内存。

### 10. 图片转 Base64｜Web｜S｜P1
- 图片转文本：读文件得到 data URL，可选是否带 `data:` 前缀。文本转图片：粘贴后解码、预览、保存。
- 大文本：1MB 的图片编码后约 1.33MB，超过 bridge 单条 256KB 的限制，Android 剪贴板也有 Binder 大小上限（推测约 1MB）。所以超过 500KB 就提示"改存成 .txt"，复制走公共剪贴板方法里的"大文本经文件路径"能力。
- Bridge：`native.clipboard.write` / `native.clipboard.read`。体积约 0；离线。

### 11–12. 纯色图制作 / 渐变图生成器｜Web｜S｜P2（合并成一个工具）
- 一个页面两个模式。尺寸预设取当前屏幕分辨率（`screen.width × devicePixelRatio`，不用走 bridge）和常见比例。渐变支持线性、径向、锥形（`createConicGradient` 需要 Chromium 99+，老版本退回 JS 逐像素计算）。
- "设为壁纸"不做（还得加权限，用户在相册里设就行）。体积约 0；离线。

### 13. 表情包制作｜Web（GIF 走 Rust）｜M｜P2
- 只做"在图上加字/贴图"的编辑器：带描边的上下标题字、emoji 贴纸（用系统 emoji 字体，零素材）、裁剪。GIF 表情先 `gifDecode`，每帧叠字，再 `gifEncode`。
- **不做模板素材库**：木函需要额外下载约 4MB 素材，而表情包素材的肖像权和版权来源说不清，自己维护也费劲。
- 体积约 0；离线。风险：GIF 每帧重绘的耗时。

### 14. 以图搜图｜建议不做
- 没有稳定免费的搜图 API；网页搜图要上传表单，WebView 又禁止访问外链；把用户照片传给第三方还得补隐私告知。
- 替代：预览组件里放一个"分享"按钮（`native.share`），用户可以直接把图交给已安装的 Google Lens、百度、淘宝拍立淘等 App。

### 15. 幻影坦克（隐藏图）｜Web｜S｜P1
- 灰度版算法：表图 A 映射到亮区 `A' = A/2 + 128`，里图 B 映射到暗区 `B' = B/2`；输出像素 `α = 1 − (A' − B')/255`，`gray = B'/α`。用 JS 在 ImageData 上逐像素计算，1200 万像素也在 1 秒左右（推测）。必须输出 PNG。
- 页面上能切换白底/黑底预览。彩色版效果有限、算法也更复杂，放到 P2。
- 体积约 0；离线。风险：微信、QQ 发送时会压缩、去透明，要提醒"发原图"；实测几个主流聊天软件的表现。

### 16. 图片提取表格｜Web + Rust（复用 OCR）｜L｜P2
- 依赖 AI 类的 OCR（`rust.ocr.recognize` 返回文字框）。v1 不加模型：在 Web 里按 y 方向重叠把文字框聚成行、按 x 方向间隙分列，适合线框清楚、没有合并单元格的简单表格。输出 TSV（复制后能直接粘贴进 WPS/Excel）和 CSV（加 UTF-8 BOM，防止 Excel 里中文乱码）。
- v2 再考虑 RapidTable 的 SLANet-plus ONNX（Apache-2.0，已查证；模型约 7MB，推测）处理合并单元格。xlsx 输出不做。
- Bridge：v1 不新增方法。体积：APK 约 0；OCR 模型按 AI 类方案按需下载。离线（模型下载时需要联网）。
- 风险：效果完全受 OCR 质量影响；倾斜拍摄的表格要先做透视矫正（AI 类方案里有没有，待对齐）。

### 17. 图片查看器｜Web｜S｜P2
- 直接用共用的 `ImagePreview.vue`，加一个信息面板：尺寸、体积、格式、EXIF（相机型号、拍摄时间、GPS）。不注册系统的"打开方式"，免得占用户的默认看图应用。这条只有单来源，原版具体形态不清楚。
- Bridge：`native.image.exif` `{ path }` → `{ fields: { [tag: string]: string } }`（用平台 ExifInterface，零依赖）。体积约 0；离线。

### 18. 带壳截图｜Web｜S/M｜P2
- 用 Canvas 画通用外壳（圆角边框、挖孔/刘海/无刘海几种样式、机身颜色、阴影），背景复用渐变组件。**不带具体品牌机型的外框图片**：素材一般要几 MB，而且有商标和素材授权的问题。
- 这条只有单来源（旧文），原版形态可能已经变了。体积约 0；离线。

### 19. 证件照生成｜Web + Rust（ORT）｜L｜P1
- 流程：拍照或选图 → `rust.image.faceDetect` 找人脸 → Web 按规格（一寸 295×413、二寸 413×579、小一寸 260×378 等，300dpi）算出建议裁剪框，用户在 `CropBox` 里微调 → Web 按目标尺寸的 2 倍裁好，写成 PNG → `rust.image.portraitMatte` 输出 alpha 蒙版 PNG → Web 合成红/蓝/白底 → 导出 JPEG（JS 改写 JFIF 头，把 DPI 写成 300）→ 可选排版成 6 寸相纸。
- 模型（按需下载，经 `native.model.ensure`）：人脸用 YuNet（opencv_zoo，MIT，约 0.2MB，大小是推测）；抠图用 MODNet 或 HivisionIDPhotos 的 hivision_modnet（仓库都是 Apache-2.0，fp32 24.7MB，已查证；HivisionIDPhotos 说 hivision_modnet 更适合纯色换底）。int8 版能小到多少、精度掉多少，都要实测。RMBG-1.4、BiRefNet 太大（176MB/224MB），不考虑。
- 美颜、换装不做。
- Bridge：
  - `rust.image.faceDetect` `{ path }` → `{ faces: [{ x, y, w, h, score, landmarks: number[] }] }`
  - `rust.image.portraitMatte` `{ path, model?: string }` → `{ maskPath }`
  - 模型没下载时返回 `NOT_READY`。
- 体积：APK 约 0（前提是 ORT 随包，见 0002 的待定事项）；模型约 25MB；运行时内存估计 200–400MB（推测，MODNet 输入 512）。
- 权限：选图不需要权限；拍照走系统相机 Intent（不加 CAMERA 权限的用法）；下载模型时联网。
- 风险/测试：头发丝边缘和浅色衣服配白底；各地证件规格不一致（规格表放数据文件，方便改）；MODNet 权重的许可是看仓库整体声明推出来的，上线前要读一遍原文。

### 20. 拼豆图纸生成｜Web｜M｜P2
- 流程：`CropBox` 裁剪 → 选网格（29/58 每板或自定义）→ 每格取均值 → 在 Lab 空间里找色板中最近的颜色（可选 Floyd–Steinberg 抖动、限制颜色数复用 `quantize.ts`）→ 画出图纸（网格线、每 29 格一条板界、色号）→ 生成用量清单 → 导出 PNG。
- 色板数据（Perler/Hama/Artkal/国产品牌的色号和 RGB）没有找到官方开放的数据，来源待定；v1 先给一个通用色板，加上用户自定义色板。只有单来源。
- 体积：约 0（色板 JSON 几 KB）；离线。

### 21. B 站封面获取｜建议不做
- 要调非官方接口（`api.bilibili.com/x/web-interface/view`，现在不签名能不能用属于推测），风控说变就变；封面有版权；Web 跨域还得靠 `native.http.fetch`。
- 如果联网查询类工具上线后 `native.http.fetch` 已经有了，这条可以按 P2、S 补上：解析 BV/av 号和 b23.tv 短链 → 取 `pic` → 预览 → 保存。

## 新增依赖清单

| 名称 | 版本 | 许可证 | 用途 | 层 |
|---|---|---|---|---|
| zxing-cpp（`io.github.zxing-cpp:android`） | 3.1.1 | Apache-2.0 | 扫码、相册图识别 | 原生 |
| CameraX（camera-core / camera2 / lifecycle / view） | 1.5.3 | Apache-2.0（AndroidX，推测） | 扫码取景 | 原生 |
| nayuki QR-Code-generator（TS 单文件，放进仓库） | 仓库当前版 | MIT（README 声明，上线前读 LICENSE） | 二维码生成 | Web |
| cropperjs | 2.3.0 | MIT | 共用裁剪框（只在需要的工具里懒加载） | Web |
| gif | 0.14.2 | MIT OR Apache-2.0 | GIF 编解码（会带上 weezl） | Rust |
| color_quant | 1.1.x（gif 的可选特性要求 ^1.1；最新是 2.0.0） | MIT | NeuQuant 量化：GIF、PNG 有损压缩 | Rust |
| png | 0.18.1 | MIT OR Apache-2.0 | PNG 读写（会带上 fdeflate、flate2、miniz_oxide、crc32fast） | Rust |
| YuNet 模型（2023mar） | — | MIT | 证件照人脸定位（下载，不进 APK） | 模型 |
| MODNet / hivision_modnet 模型 | — | Apache-2.0 | 证件照抠图（下载，不进 APK） | 模型 |

不在本文新增、但会用到的：ORT 和 `ort` crate（AI 基座，由 AI 类方案负责）、OCR 模型（AI 类）、SLANet-plus（P2 以后再说）。平台 API（ExifInterface、ImageDecoder/BitmapFactory、MediaStore）不算新依赖。

## 对公共基础设施的需求

| 名字 | 本类需要它做到的事 |
|---|---|
| 页面二进制写入缓存（如 `native.file.write`） | **最关键的一条**：Canvas 产出的 Blob（几 MB）要能写进缓存目录拿到路径。现在协议只规定"大数据走文件路径"，没规定页面怎么把文件写进去（可以分块，也可以用 WebMessage 的 ArrayBuffer，由公共方案定） |
| `native.file.pick` | 多选、按 image/* 过滤（Photo Picker，不需要权限）；返回缓存路径和 PathHandler 可读 URL、宽高、mime、字节数；HEIC/HEIF 自动转 JPEG（平台解码，API 28+，24–27 的机型给出明确提示）；可选 `maxPixels` 预缩 |
| `native.file.save` | 批量存到 `Pictures/Arkli`（API 29+ 走 MediaStore 不需要权限，24–28 需要存储写权限）；CSV/TXT 存到 Download；保持写入顺序 |
| `native.share` | 分享缓存里的文件或文本 |
| `native.clipboard.write` / `read` | 超过 256KB 的大文本走文件路径 |
| `native.permission.request` | CAMERA |
| `native.model.ensure` | 按 manifest 名称下载并校验模型，推送进度事件 |
| 打开外链（如 `native.intent.view`） | 扫码得到的网址经用户确认后用系统浏览器打开 |
| 系统相机拍照（如 `native.camera.capture`） | 证件照拍照，走 Intent，不申请 CAMERA |
| 长任务的进度事件和取消 | Rust 的 GIF、抠图任务需要；同时统一"用户取消"怎么表示（现有错误码里没有 CANCELLED） |
| 缓存清理策略 | GIF 帧、中间 PNG 用完就删，退出工具时整体清理 |
| `native.http.fetch` | 只在 B 站封面以后要做时才需要 |

## 对既定约束的异议
- **zxing-cpp 放在原生层调用**：按"计算下沉 Rust"的规则，识别算法本该在 Rust 里。但相机帧本来就在 Kotlin 层，每帧经 UniFFI 拷到 Rust 是白白多一次复制；选型文档推荐的也是 zxing-cpp + Kotlin；而且一个库能同时管扫码和相册识别。建议把这件事明确为"调用现成的识别库不算原生写业务计算"，请确认。
- 其余约束没有异议。补充一点：本类用 Canvas 代替 Rust `image` 做编解码，和选型文档的推荐不一样，但不违反架构约束（规则 3/4 本来就允许计算放 Web）。

## 未决问题（需要拍板）
1. **扫码相机方案**：CameraX（省事，AAR 合计约 2MB，R8 后的实际增量未知）还是自写 Camera2（零依赖，约 400 行，国产 ROM 兼容性有风险），或者 v1 只支持"拍照/相册识别"（零依赖，但不是实时扫码）？默认选 CameraX。
2. **证件照**要等 0002 里"ORT 随包还是按需下载"定下来；另外是否接受第一次使用时下载约 25MB 的抠图模型？
3. **裁剪框**用 cropperjs（成熟，打包后多大未知，推测 gzip 后几十 KB）还是自写一个固定比例框（约 150 行）？默认用 cropperjs，懒加载。
4. 以图搜图、B 站封面获取砍掉；屏幕取色不做——是否同意？
5. 合并：纯色和渐变合成一个工具；压缩和格式转换共用一个页面；图片查看器并进预览组件——是否同意？
6. 拼豆色板的数据从哪来（各品牌色号表没找到官方开放数据）？
7. 导出目录定成 `Pictures/Arkli`，文件名按 `工具名_时间戳_序号` 命名，可以吗？
