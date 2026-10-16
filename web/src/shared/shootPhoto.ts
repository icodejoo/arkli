import { showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { cameraItemToPicked, captureCamera, isAlbum, isCancelled } from '@/native/camera'
import { pickImages, type PickedImage } from './image-io'

/** 拍照失败时的兜底提示 */
const SHOOT_FAIL_TEXT = '拍照失败'

/** 可注入的依赖（仅测试用） */
export interface ShootDeps {
  /** 是否有原生宿主 */
  hasHost?: () => boolean
  /** 打开原生相机 */
  capture?: typeof captureCamera
  /** 无宿主时的选图兜底 */
  fallback?: typeof pickImages
  /** 失败提示 */
  toast?: (msg: string) => void
}

/**
 * 底部动作栏「拍照」项的通用实现：有宿主就开原生相机拍一张，无宿主（桌面调试）退回浏览器选图。
 * 用户取消、拍到的不是照片都返回 null；失败会 toast 提示并返回 null，调用方不必再 try/catch。
 *
 * @param deps 依赖注入，仅测试用
 * @returns 拍到（或兜底选到）的一张图；没有结果为 null
 * @example const img = await shootPhoto(); if (img) adopt(img)
 */
export async function shootPhoto(deps: ShootDeps = {}): Promise<PickedImage | null> {
  const { hasHost = isNativeAvailable, capture = captureCamera, fallback = pickImages, toast = showToast } = deps
  try {
    if (!hasHost()) return (await fallback({ multiple: false, max: 1 }))[0] ?? null
    const r = await capture({ modes: ['photo'] })
    if (isCancelled(r) || isAlbum(r) || r.kind !== 'image') return null
    return cameraItemToPicked(r)
  } catch (e) {
    toast((e as { message?: string }).message ?? SHOOT_FAIL_TEXT)
    return null
  }
}
