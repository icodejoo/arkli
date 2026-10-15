import type { Component } from 'vue'

/** 工具元信息 */
export interface ToolMeta {
  /** 工具唯一标识，用于路由 `/tool/:id` */
  id: string
  /** 展示名称 */
  name: string
  /** 一句话简介 */
  description: string
  /**
   * 可选标签，用于聚合页筛选；目前只有 `'ai'`（AI 页展示所有带该标签的工具）。
   * @example tags: ['ai']
   */
  tags?: string[]
  /** 懒加载组件，每个工具会被打成独立 chunk */
  load: () => Promise<{ default: Component }>
}

/** AI 工具的标签值，AI 页按它筛选 */
export const TAG_AI = 'ai'

/**
 * 工具注册表。新增工具：在 `src/tools/<id>/` 下建 index.vue，再在此处加一行。
 */
export const tools: ToolMeta[] = [
  {
    id: 'bridge-probe',
    name: 'Bridge 探针',
    description: '检测与原生/Rust 的通信是否正常',
    load: () => import('./bridge-probe/index.vue'),
  },
  { id: 'money-upper', name: '金额转大写', description: '金额转中文财务大写', load: () => import('./money-upper/index.vue') },
  { id: 'base-convert', name: '进制转换', description: '2/8/10/16 及任意进制互转，支持补码', load: () => import('./base-convert/index.vue') },
  { id: 'unit-convert', name: '单位换算', description: '长度、面积、质量、温度等 13 类单位换算', load: () => import('./unit-convert/index.vue') },
  { id: 'time-calc', name: '时间计算器', description: '时分秒加减、时间差与时长换算', load: () => import('./time-calc/index.vue') },
  { id: 'date-calc', name: '日期计算器', description: '日期间隔与日期加减推算', load: () => import('./date-calc/index.vue') },
  { id: 'lunar-convert', name: '阳历/阴历互转', description: '阳历与农历互转，含干支、生肖、节气', load: () => import('./lunar-convert/index.vue') },
  { id: 'kinship', name: '亲戚关系计算器', description: '拼出关系链，算出该怎么称呼', load: () => import('./kinship/index.vue') },
  { id: 'coin-flip', name: '抛硬币', description: '正反面随机，可连抛并统计', load: () => import('./coin-flip/index.vue') },
  { id: 'dice', name: '掷骰子', description: '1~10 颗骰子，4~100 面可选', load: () => import('./dice/index.vue') },
  { id: 'lottery', name: '自定义抽签', description: '输入选项，随机抽出 N 个', load: () => import('./lottery/index.vue') },
  { id: 'decide', name: '做个决定', description: '转盘帮你拿主意', load: () => import('./decide/index.vue') },
  { id: 'base64', name: 'Base64 编解码', description: '文本与 Base64 互转，支持 URL 安全', load: () => import('./base64/index.vue') },
  { id: 'password-gen', name: '密码生成器', description: '自定义长度与字符集，一次可生成多个', load: () => import('./password-gen/index.vue') },
  { id: 'color-convert', name: '颜色助手', description: 'HEX、RGB、HSL 互转，含对比度与配色', load: () => import('./color-convert/index.vue') },
  { id: 'ruler', name: '尺子', description: '厘米/英寸刻度，可用银行卡校准', load: () => import('./ruler/index.vue') },
  { id: 'compass', name: '指南针', description: '读取方向传感器，显示方位与度数', load: () => import('./compass/index.vue') },
  { id: 'clock-screen', name: '时间屏幕', description: '全屏大字时钟，数字/翻页，可显示农历', load: () => import('./clock-screen/index.vue') },
  { id: 'danmaku', name: '手持弹幕', description: '全屏滚动文字，LED 屏效果', load: () => import('./danmaku/index.vue') },
  { id: 'device-info', name: '设备信息', description: '屏幕、系统、硬件、网络与特性探测', load: () => import('./device-info/index.vue') },
  { id: 'image-compress', name: '图片压缩', description: '压缩与格式转换，JPEG、WebP、PNG，可批量', load: () => import('./image-compress/index.vue') },
  { id: 'image-stitch', name: '图片拼接', description: '多图纵向或横向拼成一张长图', load: () => import('./image-stitch/index.vue') },
  { id: 'image-grid', name: '九宫格切图', description: '把图片切成 2×2、3×3 等多张', load: () => import('./image-grid/index.vue') },
  { id: 'hash', name: '哈希计算', description: 'MD5、SHA-1、SHA-256、SHA-512，支持文件', load: () => import('./hash/index.vue') },
  { id: 'pinyin', name: '中文转拼音', description: '带声调、数字声调、首字母，多音字提示', load: () => import('./pinyin/index.vue') },
  { id: 'qrcode-scan', name: '二维码识别', description: '扫码或相册识图，识别全部二维码与条码', load: () => import('./qrcode-scan/index.vue') },
  { id: 'qrcode-gen', name: '二维码生成', description: '自定义纠错、颜色与尺寸，导出 PNG', load: () => import('./qrcode-gen/index.vue') },
  { id: 'text-process', name: '文字处理', description: '正则提取、查找替换、去重排序、全半角、统计', load: () => import('./text-process/index.vue') },
  { id: 'word-split', name: '拆分选词', description: '把句子拆成词，点选后拼起来复制', load: () => import('./word-split/index.vue') },
  { id: 'fancy-text', name: '花样文字', description: '上标下标、小型大写、圈号等样式一键复制', load: () => import('./fancy-text/index.vue') },
  { id: 'random-number', name: '随机数', description: '自定范围、个数、去重、小数位的随机数', load: () => import('./random-number/index.vue') },
  { id: 'summarize', name: '文章摘要', description: '抽取式摘要，挑出最有代表性的几句', load: () => import('./summarize/index.vue') },
  { id: 'level', name: '水平仪', description: '气泡看平放，条形看立放，可校准', load: () => import('./level/index.vue') },
  { id: 'protractor', name: '量角器', description: '屏上拖射线量夹角，也能测手机倾角', load: () => import('./protractor/index.vue') },
  { id: 'vibrator', name: '震动器', description: '预设或自定义节奏，调强度震动', load: () => import('./vibrator/index.vue') },
  { id: 'rc4', name: 'RC4 加解密', description: '文本 RC4 加解密，Base64 或十六进制', load: () => import('./rc4/index.vue') },
  { id: 'morse', name: '摩斯电码', description: '文本与摩斯互转，可调速度音调播放', load: () => import('./morse/index.vue') },
  { id: 'scoreboard', name: '记分牌', description: '2 到 8 人加减分，可撤销，自动保存', load: () => import('./scoreboard/index.vue') },
  { id: 'reaction-test', name: '反应力测试', description: '等变绿再点，五轮取平均', load: () => import('./reaction-test/index.vue') },
  { id: 'finger-roulette', name: '指尖轮盘', description: '多指按住，选一个、排先手或分队', load: () => import('./finger-roulette/index.vue') },
  { id: 'image-base64', name: '图片转 Base64', description: '图片转 Base64 文本，也能粘贴还原成图', load: () => import('./image-base64/index.vue') },
  { id: 'image-palette', name: '取色器', description: '提取图片主色，点图取任意位置颜色', load: () => import('./image-palette/index.vue') },
  { id: 'image-watermark', name: '图片水印', description: '给图片加文字水印，支持定位和满屏平铺', load: () => import('./image-watermark/index.vue') },
  { id: 'solid-gradient', name: '纯色渐变图', description: '生成纯色图和渐变图，自定义尺寸导出', load: () => import('./solid-gradient/index.vue') },
  { id: 'phantom-tank', name: '幻影坦克', description: '合成白底显表图、黑底显里图的隐藏图', load: () => import('./phantom-tank/index.vue') },
  { id: 'image-viewer', name: '图片查看器', description: '看图片尺寸、相机参数、拍摄时间，GPS 默认折叠', load: () => import('./image-viewer/index.vue') },
  { id: 'image-frame', name: '带壳截图', description: '给截图套手机壳、浏览器窗口或卡片', load: () => import('./image-frame/index.vue') },
  { id: 'text-image', name: '文字转图', description: '文字排成图片，自动换行分页', load: () => import('./text-image/index.vue') },
  { id: 'bead-pattern', name: '拼豆图纸', description: '图片转拼豆图纸，带色号和用量表', load: () => import('./bead-pattern/index.vue') },
  { id: 'gif-tool', name: 'GIF 合成/分解', description: '多图合成动图，GIF 拆成逐帧图', load: () => import('./gif-tool/index.vue') },
  { id: 'meme-maker', name: '表情包制作', description: '图上加字，可导出抖动、闪烁 GIF', load: () => import('./meme-maker/index.vue') },
  { id: 'mortgage', name: '房贷计算器', description: '等额本息、等额本金、组合贷，附逐月还款表', load: () => import('./mortgage/index.vue') },
  { id: 'periodic-table', name: '元素周期表', description: '118 个元素，搜索、点开看详情', load: () => import('./periodic-table/index.vue') },
  { id: 'http-status', name: 'HTTP 状态码', description: '70 条中文释义，按码或关键字搜', load: () => import('./http-status/index.vue') },
  { id: 'cidr-calc', name: 'CIDR 计算器', description: '网段、掩码、可用主机、子网划分，支持 IPv6', load: () => import('./cidr-calc/index.vue') },
  { id: 'js-runner', name: 'JS 运行器', description: '在 Worker 里跑代码，看输出，超时自动终止', load: () => import('./js-runner/index.vue') },
  { id: 'ua-parser', name: 'UA 解析', description: '解析浏览器、系统和设备，可粘贴任意 UA', load: () => import('./ua-parser/index.vue') },
  { id: 'sketchpad', name: '画板', description: '手指涂画，撤销重做，保存成图片', load: () => import('./sketchpad/index.vue') },
  { id: 'ledger', name: '记账', description: '记收支，按月看分类占比，可导出备份', load: () => import('./ledger/index.vue') },
  { id: 'express-track', name: '快递识别', description: '识别单号属于哪家快递，跳官网查询', load: () => import('./express-track/index.vue') },
  { id: 'waste-sort', name: '垃圾分类', description: '查物品该扔哪个桶，按上海四分类', load: () => import('./waste-sort/index.vue') },
  { id: 'wifi-qr', name: 'WiFi 二维码', description: '输入 WiFi 信息生成可扫码连接的二维码', load: () => import('./wifi-qr/index.vue') },
  { id: 'sys-helper', name: '系统调试助手', description: '按参数生成 ADB 命令，可一键复制', load: () => import('./sys-helper/index.vue') },
  { id: 'personality-test', name: '人格倾向测试', description: '28 道原创题，测出十六型人格倾向', load: () => import('./personality-test/index.vue') },
  { id: 'couplet', name: '对联生成', description: '自编对联库，可筛选，还能手写对联导出图', load: () => import('./couplet/index.vue') },
  { id: 'image-search', name: '以图搜图', description: '选图后分享，并跳转各搜图站入口', load: () => import('./image-search/index.vue') },
  { id: 'typing-board', name: '打字板', description: '全屏大字静止显示，自适应字号可闪烁', load: () => import('./typing-board/index.vue') },
  { id: 'translate', name: '翻译', description: '文字转交已装的翻译应用，没有就给网页入口', load: () => import('./translate/index.vue') },
  { id: 'linux-manual', name: 'Linux 指令手册', description: '约 137 条常用命令中文速查，可搜索，示例一键复制', load: () => import('./linux-manual/index.vue') },
  { id: 'web-source', name: '网页源码', description: '抓取网址源码，只当文本显示', load: () => import('./web-source/index.vue') },
  { id: 'short-link', name: '短链还原', description: '逐跳追踪短链，列出跳转链', load: () => import('./short-link/index.vue') },
  { id: 'ip-lookup', name: 'IP 查询', description: '查 IP 或域名的国家与运营商', load: () => import('./ip-lookup/index.vue') },
  { id: 'whois', name: 'Whois 查询', description: '域名注册信息，RDAP 优先', load: () => import('./whois/index.vue') },
  { id: 'speed-test', name: '网速测试', description: '测 TCP 延迟与下行速率', load: () => import('./speed-test/index.vue') },
  { id: 'bilibili-cover', name: 'B 站封面', description: '提取并保存 B 站视频封面', load: () => import('./bilibili-cover/index.vue') },
  { id: 'exchange-rate', name: '汇率换算', description: '约 30 种币种，支持缓存与手动汇率', load: () => import('./exchange-rate/index.vue') },
  { id: 'ocr', name: '文字识别', description: '图片转文字，逐行复制（需本地模型）', tags: [TAG_AI], load: () => import('./ocr/index.vue') },
  { id: 'image-upscale', name: '图像放大', description: '2×/4× 超分，前后对比（需本地模型）', tags: [TAG_AI], load: () => import('./image-upscale/index.vue') },
  { id: 'waste-classify', name: '垃圾分类识别', description: '拍照或选图，识别垃圾属于哪一类', tags: [TAG_AI], load: () => import('./waste-classify/index.vue') },
  { id: 'object-count', name: '对象计数', description: '数图里有几个物体，可点击修正', tags: [TAG_AI], load: () => import('./object-count/index.vue') },
  { id: 'id-photo', name: '证件照', description: '裁剪换底色，纯色背景可自动抠图', load: () => import('./id-photo/index.vue') },
  { id: 'table-extract', name: '图片转表格', description: '识别表格，复制 TSV/CSV，也能粘贴文字拆表', load: () => import('./table-extract/index.vue') },
  { id: 'face-fusion', name: '人脸融合', description: '两张脸按比例合成（需本地模型）', tags: [TAG_AI], load: () => import('./face-fusion/index.vue') },
  { id: 'colorize', name: '黑白上色', description: '给黑白照上色（需本地模型）', tags: [TAG_AI], load: () => import('./colorize/index.vue') },
  { id: 'pomodoro', name: '番茄时钟', description: '专注休息轮换，到点系统提醒', load: () => import('./pomodoro/index.vue') },
  { id: 'notify-self', name: '通知自己', description: '立即或定时给自己发通知', load: () => import('./notify-self/index.vue') },
  { id: 'tts', name: '文字转语音', description: '朗读文字，可存成音频分享', load: () => import('./tts/index.vue') },
  { id: 'web-shortcut', name: '网页转应用', description: '把网址添加到桌面', load: () => import('./web-shortcut/index.vue') },
  { id: 'app-manager', name: '应用管理', description: '查看应用信息、导出安装包', load: () => import('./app-manager/index.vue') },
  { id: 'char-lookup', name: '查字', description: '看读音、Unicode 码点和字节编码', load: () => import('./char-lookup/index.vue') },
  { id: 'idiom', name: '成语查询', description: '内置精选成语，支持拼音搜索与接龙', load: () => import('./idiom/index.vue') },
  { id: 'folder-clean', name: '文件夹清理', description: '找出大文件、空文件、安装包并删除', load: () => import('./folder-clean/index.vue') },
  { id: 'noise-meter', name: '噪音测量', description: '测环境分贝，附近 60 秒曲线', load: () => import('./noise-meter/index.vue') },
  { id: 'wallpaper-viewer', name: '获取壁纸', description: '读取系统壁纸，可预览保存', load: () => import('./wallpaper-viewer/index.vue') },
  { id: 'video-audio', name: '视频提取音频', description: '把视频里的声音存成 m4a', load: () => import('./video-audio/index.vue') },
  { id: 'video-gif', name: '视频转 GIF', description: '截取一段视频，合成 GIF', load: () => import('./video-gif/index.vue') },
  { id: 'video-compress', name: '视频压缩', description: '降低码率，给视频瘦身（不改分辨率）', load: () => import('./video-compress/index.vue') },
]

/**
 * 按 id 查工具。
 *
 * @param id 工具 id
 * @returns 工具元信息；不存在时为 undefined
 * @example
 * findTool('bridge-probe')?.name // 'Bridge 探针'
 */
export function findTool(id: string): ToolMeta | undefined {
  return tools.find((t) => t.id === id)
}
