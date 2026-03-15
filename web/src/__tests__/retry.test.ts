import { describe, it, expect, vi } from 'vitest'
import { retryWithBackoff } from '@/utils/retry'

describe('retryWithBackoff', () => {
  it('成功した場合はすぐに結果を返す', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await retryWithBackoff(fn)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('1回失敗して2回目で成功する', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok')
    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('最大リトライ回数を超えたら例外を投げる', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fail'))
    await expect(retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10 }))
      .rejects.toThrow('always fail')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('permission-deniedはリトライしない', async () => {
    const err = new Error('permission-denied')
    ;(err as any).code = 'permission-denied'
    const fn = vi.fn().mockRejectedValue(err)
    await expect(retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10 }))
      .rejects.toThrow('permission-denied')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
