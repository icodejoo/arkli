/**
 * 通用原生相机封装：拍照、录像、相册入口与临时产物清理。
 * 对应原生 `native.camera.*`，契约见 docs/design/bridge-protocol.md。
 *
 * 产物只在缓存目录 `cache/pick/cam/` 下，不进系统相册；页面用完调用 {@link clearCamera} 清掉。
 * 无宿主时抛 {@link NativeUnavailableError}。
 */
import { call as bridgeCall } from './bridge'
import { requireNative, type CallFn } from './system'
import { isNativeAvailable } from './bridge'
import { pickImages, pickImagesOrCamera, type PickedImage, type PickImagesOptions } from '@/shared/image-io'

/** 原生缓存路径在页面里的同源前缀 */
const FILES_URL_PREFIX = '/files/'

/** 方法名常量 */
export const CAMERA_METHODS = {
  capture: 'native.camera.capture',
  clear: 'native.camera.clear',
} as const

/** 拍摄模式 */
export type CameraMode = 'photo' | 'video' | 'album'

/** 相机入参 */
export interface CameraOptions {
  /** 开启的能力，至少一项、不重复，默认 ['photo'] */
  modes?: CameraMode[]
  /** 初始镜头朝向，默认 back */
  facing?: 'back' | 'front'
  /** 录像最长秒数，默认 60 */
  maxDurationSec?: number
  /** 是否显示前后镜头切换，默认 true */
  lensSwitch?: boolean
}

/** 拍摄产物 */
export interface CameraItem {
  /** 产物种类 */
  kind: 'image' | 'video'
  /** 缓存相对路径，如 cache/pick/cam/cam_xx.jpg */
  path: string
  /** 文件名 */
  name: string
  /** MIME */
  mime: string
  /** 字节数 */
  size: number
  /** 摆正后的宽 */
  width: number
  /** 摆正后的高 */
  height: number
  /** 视频时长（毫秒），仅视频有 */
  durationMs?: number
}

/** 拍摄结局：成功产物、用户取消、选相册 */
export type CameraResult = CameraItem | { cancelled: true } | { album: true }

/**
 * 判断结果是不是用户取消。
 *
 * @param r 拍摄结局
 * @returns 是否取消
 */
export function isCancelled(r: CameraResult): r is { cancelled: true } {
  return 'cancelled' in r && r.cancelled === true
}

/**
 * 判断结果是不是「去相册选」。
 *
 * @param r 拍摄结局
 * @returns 是否选相册
 */
export function isAlbum(r: CameraResult): r is { album: true } {
  return 'album' in r && r.album === true
}

/**
 * 打开原生全屏相机。等待用户操作，不设超时；无相机权限抛 `PERMISSION_DENIED`，参数非法抛 `BAD_PARAMS`。
 *
 * @param opts 相机入参，省略时只开拍照
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 产物、取消或选相册
 * @example const r = await captureCamera({ modes: ['photo', 'album'] })
 */
export async function captureCamera(opts: CameraOptions = {}, call: CallFn = bridgeCall): Promise<CameraResult> {
  requireNative(CAMERA_METHODS.capture)
  return call<CameraResult>(CAMERA_METHODS.capture, { ...opts }, { timeoutMs: 0 })
}

/**
 * 清空相机临时产物目录；失败不抛（清理是尽力而为）。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 删除的文件数，失败为 0
 * @example await clearCamera()
 */
export async function clearCamera(call: CallFn = bridgeCall): Promise<number> {
  try {
    requireNative(CAMERA_METHODS.clear)
    const res = await call<{ cleared: boolean; count: number }>(CAMERA_METHODS.clear, {})
    return res.count
  } catch {
    return 0
  }
}

/**
 * 把拍到的照片转成选图结果的形状，可直接走原有识别流程。
 *
 * @param item 拍摄产物（kind 须为 image）
 * @returns 选图项；产物文件由 {@link clearCamera} 统一清理，所以 release 为空操作
 * @example const img = cameraItemToPicked(r)
 */
export function cameraItemToPicked(item: CameraItem): PickedImage {
  return {
    name: item.name,
    mime: item.mime,
    size: item.size,
    width: item.width,
    height: item.height,
    url: FILES_URL_PREFIX + item.path,
    path: item.path,
    release: () => undefined,
  }
}

/** pickOrCapture 可注入的依赖（仅测试用） */
export interface PickOrCaptureDeps {
  /** 打开相机 */
  capture?: (opts: CameraOptions) => Promise<CameraResult>
  /** 带拍照按钮的相册选图 */
  pick?: typeof pickImagesOrCamera
  /** 无宿主时的选图兜底 */
  fallback?: typeof pickImages
  /** 是否有原生宿主 */
  hasHost?: () => boolean
}

/**
 * 统一「选取」：默认进拍照，拍照界面可去相册，相册里点拍照图标又回拍照；两边互通，只有在拍照界面取消才退出。
 * 无宿主时退回浏览器 input 选图。视频产物忽略（回到拍照）。
 *
 * @param opts 选图入参（onFailed 等）；camera 字段由本函数控制
 * @param deps 依赖注入，仅测试用
 * @returns 选到的一张图；用户在拍照界面取消返回 null
 * @example const img = await pickOrCapture({ onFailed: (f) => console.warn(f) })
 */
export async function pickOrCapture(
  opts: Omit<PickImagesOptions, 'camera' | 'multiple'> = {},
  deps: PickOrCaptureDeps = {},
): Promise<PickedImage | null> {
  const { capture = (o: CameraOptions) => captureCamera(o), pick = pickImagesOrCamera, fallback = pickImages, hasHost = isNativeAvailable } = deps
  if (!hasHost()) return (await fallback({ ...opts, multiple: false }))[0] ?? null
  for (;;) {
    const r = await capture({ modes: ['photo', 'album'] })
    if (isCancelled(r)) return null
    if (isAlbum(r)) {
      const got = await pick({ ...opts, multiple: false, camera: true })
      if (got.images.length) return got.images[0]
      continue
    }
    if (r.kind === 'image') return cameraItemToPicked(r)
  }
}
