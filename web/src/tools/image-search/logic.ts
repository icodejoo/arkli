// 以图搜图：分享图片的三级降级（原生分享 → 浏览器分享 → 保存图片）与站点入口打开
// 原生分享使用 @/native/system 的 share；该模块不可用或失败时回退，不会让页面报错
import { isNativeAvailable } from '@/native/bridge'
import { share, type ShareOptions } from '@/native/system'
import { saveBlob, writeBlobToCache } from '@/shared/image-io'
import { SEARCH_SITES, type SearchSite } from './data'

/** 分享结果：已分享 / 已改为保存 / 用户取消 */
export type ShareOutcome = 'shared' | 'saved' | 'cancelled'

/** 可注入的外部能力，便于单测 */
export interface ShareDeps {
  /** 是否在 Arkli 容器内 */
  isNative: () => boolean
  /** 把 Blob 写进原生缓存，返回缓存相对路径 */
  writeCache: (blob: Blob, name: string) => Promise<string>
  /** 原生分享，返回是否拉起面板 */
  nativeShare: (options: ShareOptions) => Promise<boolean>
  /** 浏览器 navigator（可缺省） */
  nav?: Pick<Navigator, 'share' | 'canShare'> | undefined
  /** 保存图片 */
  save: (blob: Blob, name: string) => Promise<unknown>
}

/** 默认依赖：连真实模块 */
const defaultDeps = (): ShareDeps => ({
  isNative: isNativeAvailable,
  writeCache: (b, n) => writeBlobToCache(b, n),
  nativeShare: (o) => share(o),
  nav: typeof navigator === 'undefined' ? undefined : navigator,
  save: saveBlob,
})

/** 判断是否为用户取消（浏览器分享取消会抛 AbortError） */
function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError'
}

/**
 * 分享一张图片：容器内走原生分享面板；否则试浏览器 Web Share；都不行就保存图片。
 *
 * @param blob 图片内容
 * @param name 文件名（含扩展名）
 * @param deps 外部能力，默认连真实模块，仅测试注入
 * @returns shared 已拉起分享；saved 已改为保存（调用方应提示用户去相册里找）；cancelled 用户取消
 * @example
 * const r = await shareImage(blob, 'a.png')
 * if (r === 'saved') showToast('已保存，请到相册选这张图')
 */
export async function shareImage(blob: Blob, name: string, deps: ShareDeps = defaultDeps()): Promise<ShareOutcome> {
  if (deps.isNative()) {
    try {
      const path = await deps.writeCache(blob, name)
      if (await deps.nativeShare({ path, mime: blob.type || undefined, title: '分享图片' })) return 'shared'
    } catch {
      // 原生分享失败，走保存兜底
    }
  } else if (deps.nav && typeof deps.nav.share === 'function' && typeof File !== 'undefined') {
    const file = new File([blob], name, { type: blob.type })
    if (!deps.nav.canShare || deps.nav.canShare({ files: [file] })) {
      try {
        await deps.nav.share({ files: [file] })
        return 'shared'
      } catch (e) {
        if (isAbort(e)) return 'cancelled'
      }
    }
  }
  await deps.save(blob, name)
  return 'saved'
}

/**
 * 校验站点清单：全部 https、地址合法、无查询串与锚点（避免拼接图片信息）。
 *
 * @param sites 站点清单，默认用内置清单
 * @returns 不合规站点的名称列表；空数组表示全部合规
 * @example invalidSites() // []
 */
export function invalidSites(sites: ReadonlyArray<SearchSite> = SEARCH_SITES): string[] {
  return sites
    .filter((s) => {
      try {
        const u = new URL(s.url)
        return u.protocol !== 'https:' || u.search !== '' || u.hash !== ''
      } catch {
        return true
      }
    })
    .map((s) => s.name)
}

/**
 * 在外部打开站点入口页（宿主里会走外部浏览器）。
 *
 * @param url 入口页地址，必须是 https
 * @param open 打开函数，默认 window.open，仅测试注入
 * @returns 是否发起了打开；非 https 地址返回 false
 * @example openSite('https://tineye.com/')
 */
export function openSite(url: string, open: (u: string, target: string, features: string) => unknown = (u, t, f) => window.open(u, t, f)): boolean {
  if (!/^https:\/\//i.test(url)) return false
  open(url, '_blank', 'noopener')
  return true
}

/**
 * 给选中的图片起一个分享用文件名：保留原名，没有扩展名时按 MIME 补。
 *
 * @param name 原文件名
 * @param mime 图片 MIME
 * @returns 带扩展名的文件名
 * @example shareName('photo', 'image/png') // 'photo.png'
 */
export function shareName(name: string, mime: string): string {
  if (/\.[A-Za-z0-9]{2,5}$/.test(name)) return name
  const ext = mime.split('/')[1] || 'jpg'
  return `${name || 'image'}.${ext === 'jpeg' ? 'jpg' : ext}`
}
