/**
 * 二维码识别封装：取景扫码、相册图识别。
 * 对应原生 `native.qrcode.*`，契约见 docs/design/tools/image.md「二维码工具」。
 *
 * 原生用 zxing-cpp，识别全部码种（二维码与常见条码），一帧里有多个码时全部返回。
 * 无宿主时抛 {@link NativeUnavailableError}。
 */
import { call as bridgeCall } from './bridge'
import { requireNative, type CallFn } from './system'

/** 方法名常量 */
export const QRCODE_METHODS = {
  scan: 'native.qrcode.scan',
  decodeImage: 'native.qrcode.decodeImage',
} as const

/** 一个识别结果 */
export interface QrResult {
  /** 解码文本 */
  text: string
  /** 码种名称，如 `QR_CODE`、`EAN_13`、`DATA_MATRIX` */
  format: string
  /** 原始字节的 base64（无换行） */
  bytes: string
}

/** 取景扫码的结果 */
export interface QrScanResult {
  /** 用户是否取消（按返回键） */
  cancelled: boolean
  /** 这一帧里的全部码；取消时为空 */
  results: QrResult[]
}

/**
 * 打开全屏取景扫码页，识别到码即返回。没有相机授权时原生会先申请，被拒以 `PERMISSION_DENIED` 拒绝。
 * 等待用户操作，不设超时。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 是否取消与识别到的全部码
 * @example const { cancelled, results } = await scanQr()
 */
export async function scanQr(call: CallFn = bridgeCall): Promise<QrScanResult> {
  requireNative(QRCODE_METHODS.scan)
  const r = await call<QrScanResult>(QRCODE_METHODS.scan, {}, { timeoutMs: 0 })
  return { cancelled: r.cancelled === true, results: r.results ?? [] }
}

/**
 * 识别缓存里的一张图片（选图后得到的 `cache/pick/...` 路径），解码选项全开，慢但识别率高。
 *
 * @param path 缓存相对路径，如 `PickedImage.path`
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 识别到的全部码，没识别到为空数组
 * @example const codes = await decodeQrImage(img.path!)
 */
export async function decodeQrImage(path: string, call: CallFn = bridgeCall): Promise<QrResult[]> {
  requireNative(QRCODE_METHODS.decodeImage)
  const r = await call<{ results: QrResult[] }>(QRCODE_METHODS.decodeImage, { path })
  return r.results ?? []
}
