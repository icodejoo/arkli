import { describe, expect, it, vi } from 'vitest'

vi.mock('vant', () => ({ showConfirmDialog: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

import { GATE_CANCEL_TEXT, GATE_CONFIRM_TEXT, GATE_TITLE, promptDownloadModel } from './modelGate'
import { AI_CENTER_PATH } from './modelPicker'

describe('promptDownloadModel', () => {
  it('确认：跳转 AI 中心并返回 true，文案正确', async () => {
    const confirm = vi.fn(async () => 'confirm')
    const push = vi.fn()
    expect(await promptDownloadModel({ confirm, push })).toBe(true)
    expect(push).toHaveBeenCalledWith(AI_CENTER_PATH)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: GATE_TITLE, confirmButtonText: GATE_CONFIRM_TEXT, cancelButtonText: GATE_CANCEL_TEXT }))
    expect(GATE_CONFIRM_TEXT).toBe('去下载')
  })
  it('取消：不跳转，返回 false', async () => {
    const push = vi.fn()
    expect(await promptDownloadModel({ confirm: async () => Promise.reject('cancel'), push })).toBe(false)
    expect(push).not.toHaveBeenCalled()
  })
})
