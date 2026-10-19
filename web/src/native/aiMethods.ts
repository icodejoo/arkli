/**
 * `native.ai.*` 的方法名常量。单独成文件、没有副作用，注册表等轻量模块可以直接引用而不必拉进整个 ai.ts。
 *
 * @example AI_METHODS.translate // 'native.ai.translate'
 */
export const AI_METHODS = {
  status: 'native.ai.status',
  providers: 'native.ai.providers',
  invoke: 'native.ai.invoke',
  run: 'native.ai.run',
  ocr: 'native.ai.ocr',
  couplet: 'native.ai.couplet',
  matting: 'native.ai.matting',
  upscale: 'native.ai.upscale',
  classify: 'native.ai.classify',
  matte: 'native.ai.matte',
  fuse: 'native.ai.fuse',
  colorize: 'native.ai.colorize',
  translate: 'native.ai.translate',
  warmup: 'native.ai.warmup',
  unload: 'native.ai.unload',
  /** 获取提供者的可调参数定义与当前生效值 */
  paramsGet: 'native.ai.params.get',
  /** 设置提供者的可调参数值 */
  paramsSet: 'native.ai.params.set',
  /** 重置提供者的可调参数为默认值 */
  paramsReset: 'native.ai.params.reset',
} as const
