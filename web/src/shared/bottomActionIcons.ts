/// <reference types="unplugin-icons/types/vue" />
import type { Component } from 'vue'
import IconAi from '~icons/arkli/ai'
import IconAudioLinesAnim from '~icons/arkli/audio-lines-anim'
import IconCamera from '~icons/arkli/camera'
import IconCheckCheck from '~icons/arkli/check-check'
import IconCircleHelp from '~icons/arkli/circle-help'
import IconClipboardPaste from '~icons/arkli/clipboard-paste'
import IconCopy from '~icons/arkli/copy'
import IconCpuAi from '~icons/arkli/cpu-ai'
import IconDownload from '~icons/arkli/download'
import IconEllipsis from '~icons/arkli/ellipsis'
import IconEraser from '~icons/arkli/eraser'
import IconEye from '~icons/arkli/eye'
import IconFileInput from '~icons/arkli/file-input'
import IconFileOutput from '~icons/arkli/file-output'
import IconHistory from '~icons/arkli/history'
import IconImages from '~icons/arkli/images'
import IconLightbulb from '~icons/arkli/lightbulb'
import IconMaximize from '~icons/arkli/maximize'
import IconMic from '~icons/arkli/mic'
import IconPause from '~icons/arkli/pause'
import IconPencil from '~icons/arkli/pencil'
import IconPlay from '~icons/arkli/play'
import IconPlus from '~icons/arkli/plus'
import IconPrinter from '~icons/arkli/printer'
import IconRedo2 from '~icons/arkli/redo-2'
import IconRefreshCw from '~icons/arkli/refresh-cw'
import IconRotateCcw from '~icons/arkli/rotate-ccw'
import IconSave from '~icons/arkli/save'
import IconSearch from '~icons/arkli/search'
import IconSettings from '~icons/arkli/settings'
import IconShare2 from '~icons/arkli/share-2'
import IconStar from '~icons/arkli/star'
import IconTrash2 from '~icons/arkli/trash-2'
import IconUndo2 from '~icons/arkli/undo-2'
import { CUSTOM_ICON_PREFIX } from './bottomActions'

/**
 * 自定义图标名（`arkli:xxx`）→ 图标组件。图标文件在 assets/icons（Lucide，ISC）；
 * 新增内置项时：curl api.iconify.design 存一个 svg，在这里加一行即可。
 */
export const BOTTOM_ACTION_ICON_MAP: Readonly<Record<string, Component>> = {
  'arkli:ai': IconAi,
  'arkli:audio-lines-anim': IconAudioLinesAnim,
  'arkli:camera': IconCamera,
  'arkli:check-check': IconCheckCheck,
  'arkli:circle-help': IconCircleHelp,
  'arkli:clipboard-paste': IconClipboardPaste,
  'arkli:copy': IconCopy,
  'arkli:cpu-ai': IconCpuAi,
  'arkli:download': IconDownload,
  'arkli:ellipsis': IconEllipsis,
  'arkli:eraser': IconEraser,
  'arkli:eye': IconEye,
  'arkli:file-input': IconFileInput,
  'arkli:file-output': IconFileOutput,
  'arkli:history': IconHistory,
  'arkli:images': IconImages,
  'arkli:lightbulb': IconLightbulb,
  'arkli:maximize': IconMaximize,
  'arkli:mic': IconMic,
  'arkli:pause': IconPause,
  'arkli:pencil': IconPencil,
  'arkli:play': IconPlay,
  'arkli:plus': IconPlus,
  'arkli:printer': IconPrinter,
  'arkli:redo-2': IconRedo2,
  'arkli:refresh-cw': IconRefreshCw,
  'arkli:rotate-ccw': IconRotateCcw,
  'arkli:save': IconSave,
  'arkli:search': IconSearch,
  'arkli:settings': IconSettings,
  'arkli:share-2': IconShare2,
  'arkli:star': IconStar,
  'arkli:trash-2': IconTrash2,
  'arkli:undo-2': IconUndo2,
}

/**
 * 按图标名取自定义图标组件；vant 图标名或未登记的返回 undefined。
 *
 * @param icon 图标名，如 `arkli:copy`
 * @returns 图标组件或 undefined
 * @example resolveActionIcon('arkli:copy') // 组件
 */
export function resolveActionIcon(icon: string | undefined): Component | undefined {
  return icon?.startsWith(CUSTOM_ICON_PREFIX) ? BOTTOM_ACTION_ICON_MAP[icon] : undefined
}
