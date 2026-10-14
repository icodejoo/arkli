// Linux 手册：全部命令汇总
import { ARCH_CMDS, DISK_CMDS, NET_CMDS } from './data-net'
import { FILE_CMDS, TEXT_CMDS } from './data-files'
import { PKG_CMDS, SHELL_CMDS } from './data-misc'
import { FIND_CMDS, PERM_CMDS, PROC_CMDS } from './data-sys'
import type { LinuxCmd } from './types'

export { CATEGORIES } from './types'
export type { Category, LinuxCmd } from './types'

/** 全部命令，按分类顺序排列 */
export const COMMANDS: LinuxCmd[] = [...FILE_CMDS, ...TEXT_CMDS, ...FIND_CMDS, ...PERM_CMDS, ...PROC_CMDS, ...NET_CMDS, ...ARCH_CMDS, ...DISK_CMDS, ...PKG_CMDS, ...SHELL_CMDS]
