import { describe, expect, it } from 'vitest'
import { COMMANDS } from './data'
import { countByCategory, isDanger, scoreCommand, searchCommands } from './logic'
import { c, CAT_FILE, CATEGORIES } from './types'

/** 必须带危险标记的命令 */
const MUST_DANGER = ['rm', 'chmod', 'chown', 'dd', 'mkfs', 'fdisk', 'userdel', 'shutdown']

describe('命令数据校验', () => {
  it('数量足够', () => {
    expect(COMMANDS.length).toBeGreaterThanOrEqual(110)
  })
  it('命令名不重复', () => {
    const names = COMMANDS.map((x) => x.name)
    expect(new Set(names).size).toBe(names.length)
  })
  it('分类合法，且每类至少有命令', () => {
    const cats = new Set<string>(CATEGORIES)
    for (const x of COMMANDS) expect(cats.has(x.cat)).toBe(true)
    const cnt = countByCategory(COMMANDS)
    for (const k of CATEGORIES) expect(cnt[k]).toBeGreaterThan(0)
  })
  it('每条有作用、语法与至少 1 个示例', () => {
    for (const x of COMMANDS) {
      expect(x.brief.length, x.name).toBeGreaterThan(0)
      expect(x.syntax.length, x.name).toBeGreaterThan(0)
      expect(x.examples.length, x.name).toBeGreaterThanOrEqual(1)
      for (const [cmd, note] of x.examples) {
        expect(cmd.length, x.name).toBeGreaterThan(0)
        expect(note.length, x.name).toBeGreaterThan(0)
      }
    }
  })
  it('选项条目格式正确且不超过 9 条', () => {
    for (const x of COMMANDS) {
      expect(x.options.length, x.name).toBeLessThanOrEqual(9)
      for (const [o, d] of x.options) {
        expect(o.length, x.name).toBeGreaterThan(0)
        expect(d.length, x.name).toBeGreaterThan(0)
      }
    }
  })
  it('危险命令都有说明，高危命令必须标记', () => {
    for (const x of COMMANDS) if (x.danger !== undefined) expect(x.danger.length, x.name).toBeGreaterThan(10)
    for (const n of MUST_DANGER) {
      const x = COMMANDS.find((y) => y.name === n)
      expect(x, n).toBeDefined()
      expect(isDanger(x!), n).toBe(true)
    }
  })
})

describe('scoreCommand', () => {
  const cmd = c(CAT_FILE, 'rm', '删除文件', 'rm x', [], [['rm a', '删']], { aliases: ['delete'] })
  it('各档得分递增', () => {
    expect(scoreCommand(cmd, 'rm')).toBe(0)
    expect(scoreCommand(cmd, 'delete')).toBe(1)
    expect(scoreCommand(cmd, 'r')).toBe(2)
    expect(scoreCommand(cmd, 'm')).toBe(3)
    expect(scoreCommand(cmd, 'dele')).toBe(4)
    expect(scoreCommand(cmd, '删除')).toBe(5)
    expect(scoreCommand(cmd, 'zzz')).toBe(Infinity)
  })
})

describe('searchCommands', () => {
  it('空关键词返回全部，保持原顺序', () => {
    const r = searchCommands(COMMANDS, '  ')
    expect(r.length).toBe(COMMANDS.length)
    expect(r[0]).toBe(COMMANDS[0])
  })
  it('精确匹配排第一', () => {
    expect(searchCommands(COMMANDS, 'ls')[0].name).toBe('ls')
    expect(searchCommands(COMMANDS, 'tar')[0].name).toBe('tar')
    expect(searchCommands(COMMANDS, 'ss')[0].name).toBe('ss')
  })
  it('前缀优先于包含', () => {
    const r = searchCommands(COMMANDS, 'ch').map((x) => x.name)
    expect(r.indexOf('chmod')).toBeLessThan(r.indexOf('touch'))
  })
  it('忽略大小写，可按别名与作用搜', () => {
    expect(searchCommands(COMMANDS, 'LS')[0].name).toBe('ls')
    expect(searchCommands(COMMANDS, '删除').map((x) => x.name)).toContain('rm')
    expect(searchCommands(COMMANDS, 'ifconfig')[0].name).toBe('ifconfig')
  })
  it('分类筛选', () => {
    const r = searchCommands(COMMANDS, '', '网络')
    expect(r.length).toBeGreaterThan(0)
    for (const x of r) expect(x.cat).toBe('网络')
    expect(searchCommands(COMMANDS, 'ls', '网络').length).toBe(0)
  })
  it('无结果返回空数组', () => {
    expect(searchCommands(COMMANDS, 'qwertyuiop')).toEqual([])
  })
})

describe('isDanger / countByCategory', () => {
  it('isDanger 依据 danger 字段', () => {
    expect(isDanger(c(CAT_FILE, 'a', 'b', 'c', [], [['x', 'y']]))).toBe(false)
    expect(isDanger(c(CAT_FILE, 'a', 'b', 'c', [], [['x', 'y']], { danger: '会出事' }))).toBe(true)
  })
  it('countByCategory 求和等于总数', () => {
    const cnt = countByCategory(COMMANDS)
    expect(Object.values(cnt).reduce((a, b) => a + b, 0)).toBe(COMMANDS.length)
  })
})
