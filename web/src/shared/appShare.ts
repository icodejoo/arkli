import { appIcon, exportApk, type ExportedApk } from '@/native/apps'
import { share, type ShareOptions } from '@/native/system'

/** 分享面板标题（同时作预览里的标题） */
export const APP_SHARE_TITLE = 'Arkli · 体积小、功能多的安卓小工具箱'
/** 下载页：仓库 Releases 列表（模型包也发在这里，故不用 latest）；换固定下载地址只改这里 */
export const APP_DOWNLOAD_URL = 'https://github.com/icodejoo/Arkli/releases'
/** 分享链接时发出的整段文字：文案加下载地址 */
export const APP_SHARE_LINK_TEXT = `Arkli：体积小、功能多的安卓小工具箱。下载：${APP_DOWNLOAD_URL}`
/** 随安装包一起分享的文案：App 名加一句简介 */
export const APP_SHARE_TEXT = 'Arkli：体积小、功能多的安卓小工具箱，来试试看。'
/** 分享出去的 APK 文件名：名字加简介，分享面板与对方收到的文件上都看得到 */
export const APP_SHARE_FILE_NAME = 'Arkli-多功能小工具箱.apk'
/** 安装包的内容类型 */
export const APK_MIME = 'application/vnd.android.package-archive'
/** 导出本应用安装包时用的包名别名（由原生换成真实包名） */
const SELF_PKG = 'self'

/** 预览缩略图边长（像素，原生允许 48~192） */
const THUMB_SIZE = 192

/**
 * 分享文案加下载地址（纯文字），预览带上 App logo。
 *
 * @param send 分享函数，默认走原生桥（测试可注入）
 * @param icon 取本应用图标缓存路径的函数，默认走原生桥；取不到时不带缩略图
 * @returns 是否成功拉起分享面板
 * @example await shareAppLink()
 */
export async function shareAppLink(
  send: (o: ShareOptions) => Promise<boolean> = share,
  icon: (pkg: string, size: number) => Promise<string> = (pkg, size) => appIcon(pkg, size),
): Promise<boolean> {
  const thumb = await icon(SELF_PKG, THUMB_SIZE).catch(() => undefined)
  return send({ text: APP_SHARE_LINK_TEXT, title: APP_SHARE_TITLE, thumb })
}

/**
 * 导出本 App 的安装包并唤起系统分享面板。
 *
 * @param send 分享函数，默认走原生桥（测试可注入）
 * @param exporter 导出函数，默认走原生桥（测试可注入）
 * @returns 是否成功拉起分享面板
 * @example await shareApp()
 */
export async function shareApp(
  send: (o: ShareOptions) => Promise<boolean> = share,
  exporter: (pkg: string, fileName: string) => Promise<ExportedApk> = (pkg, fileName) =>
    exportApk(pkg, undefined, undefined, fileName),
): Promise<boolean> {
  const { path } = await exporter(SELF_PKG, APP_SHARE_FILE_NAME)
  return send({ text: APP_SHARE_TEXT, path, mime: APK_MIME, title: APP_SHARE_TITLE })
}
