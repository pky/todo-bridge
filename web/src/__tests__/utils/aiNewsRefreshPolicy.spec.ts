import { describe, expect, it } from 'vitest'
import { canManualRefresh, decideAutoFetch, refreshPeriodKey } from '@/utils/aiNewsRefreshPolicy'

const at = (value: string) => Date.parse(`2026-11-${value}+09:00`)
const state = (overrides = {}) => ({ periodKey: '2026-11-03', attemptsInPeriod: 0,
  lastAttemptAt: null, lastSuccessAt: at('02T09:00:00'), feedDate: '2026-11-02',
  generationPending: true, nextAutoAttemptAt: null, ...overrides })

describe('AIニュースの08:00 JST更新予算', () => {
  it.each([
    ['03T07:59:59.999', '2026-11-02'], ['03T08:00:00', '2026-11-03'],
    ['03T23:59:59', '2026-11-03'], ['04T00:00:00', '2026-11-03'], ['04T08:00:00', '2026-11-04'],
  ])('%sの期間は%s', (time, key) => expect(refreshPeriodKey(at(time))).toBe(key))

  it('キャッシュのない初回は予算超過でも取得する', () => {
    expect(decideAutoFetch(state({ lastSuccessAt: null, feedDate: null, attemptsInPeriod: 3 }), at('03T09:00:00')).fetch).toBe(true)
  })

  it('初回を含め3試行、2回目は30分後、3回目はさらに2時間後', () => {
    expect(decideAutoFetch(state(), at('03T08:00:00')).fetch).toBe(true)
    const once = state({ attemptsInPeriod: 1, lastAttemptAt: at('03T08:00:00'), nextAutoAttemptAt: at('03T08:30:00') })
    expect(decideAutoFetch(once, at('03T08:29:59'))).toEqual({ fetch: false, nextAttemptAt: at('03T08:30:00') })
    expect(decideAutoFetch(once, at('03T08:30:00')).fetch).toBe(true)
    const twice = state({ attemptsInPeriod: 2, lastAttemptAt: at('03T08:30:00'), nextAutoAttemptAt: at('03T10:30:00') })
    expect(decideAutoFetch(twice, at('03T10:29:59'))).toEqual({ fetch: false, nextAttemptAt: at('03T10:30:00') })
    expect(decideAutoFetch(twice, at('03T10:30:00')).fetch).toBe(true)
    const exhausted = state({ attemptsInPeriod: 3, lastAttemptAt: at('03T10:30:00') })
    expect(decideAutoFetch(exhausted, at('03T10:30:01'))).toEqual({ fetch: false, nextAttemptAt: at('04T08:00:00') })
    expect(decideAutoFetch(exhausted, at('04T00:00:00')).fetch).toBe(false)
    expect(decideAutoFetch(exhausted, at('04T08:00:00')).fetch).toBe(true)
  })

  it('バックオフより次の08:00が早ければ新期間で再評価する', () => {
    const pending = state({ attemptsInPeriod: 2, lastAttemptAt: at('04T07:00:00'), nextAutoAttemptAt: at('04T09:00:00') })
    expect(decideAutoFetch(pending, at('04T07:30:00'))).toEqual({ fetch: false, nextAttemptAt: at('04T08:00:00') })
    expect(decideAutoFetch(pending, at('04T08:00:00')).fetch).toBe(true)
  })

  it.each([[1, 30], [2, 120]])('試行%i後の次回時刻が未保存でも%i分の間隔を守る', (attemptsInPeriod, minutes) => {
    const lastAttemptAt = at('03T09:00:00')
    const expected = lastAttemptAt + minutes * 60_000
    const pending = state({ attemptsInPeriod, lastAttemptAt, nextAutoAttemptAt: null })
    expect(decideAutoFetch(pending, expected - 1)).toEqual({ fetch: false, nextAttemptAt: expected })
    expect(decideAutoFetch(pending, expected).fetch).toBe(true)
  })

  it('当日0件も取得済みとして自動取得を止める', () => {
    // 件数を状態に渡さないため、記事の有無に左右されないことも検証する。
    const complete = state({ feedDate: '2026-11-03', generationPending: false, lastSuccessAt: at('03T08:00:00'), attemptsInPeriod: 1 })
    expect(decideAutoFetch(complete, at('03T11:00:00')).fetch).toBe(false)
    expect(decideAutoFetch({ ...complete, feedDate: '2026-11-04' }, at('03T11:00:00')).fetch).toBe(false)
  })

  it('前日分を正常取得してもgenerationPendingなら再試行する', () => {
    const previous = state({ attemptsInPeriod: 1, lastSuccessAt: at('03T08:00:00'), lastAttemptAt: at('03T08:00:00'), nextAutoAttemptAt: at('03T08:30:00') })
    expect(decideAutoFetch(previous, at('03T08:29:00')).fetch).toBe(false)
    expect(decideAutoFetch(previous, at('03T08:30:00')).fetch).toBe(true)
  })

  describe('キャッシュなしの試行上限', () => {
    const empty = (overrides = {}) => state({ lastSuccessAt: null, feedDate: null, generationPending: false, ...overrides })

    it('最初の1回は期間内でも取得する', () => {
      expect(decideAutoFetch(empty({ attemptsInPeriod: 0 }), at('03T09:00:00')).fetch).toBe(true)
      expect(decideAutoFetch(empty({ periodKey: '2026-11-02', attemptsInPeriod: 3, lastAttemptAt: at('02T20:00:00') }), at('03T08:00:00')).fetch).toBe(true)
    })

    it('失敗後の2回目は30分後、3回目はさらに2時間後で、3回を超えない', () => {
      const once = empty({ attemptsInPeriod: 1, lastAttemptAt: at('03T08:00:00'), nextAutoAttemptAt: at('03T08:30:00') })
      expect(decideAutoFetch(once, at('03T08:29:59'))).toEqual({ fetch: false, nextAttemptAt: at('03T08:30:00') })
      expect(decideAutoFetch(once, at('03T08:30:00')).fetch).toBe(true)
      const twice = empty({ attemptsInPeriod: 2, lastAttemptAt: at('03T08:30:00'), nextAutoAttemptAt: at('03T10:30:00') })
      expect(decideAutoFetch(twice, at('03T10:29:59'))).toEqual({ fetch: false, nextAttemptAt: at('03T10:30:00') })
      expect(decideAutoFetch(twice, at('03T10:30:00')).fetch).toBe(true)
      const exhausted = empty({ attemptsInPeriod: 3, lastAttemptAt: at('03T10:30:00') })
      expect(decideAutoFetch(exhausted, at('03T23:00:00'))).toEqual({ fetch: false, nextAttemptAt: at('04T08:00:00') })
      expect(decideAutoFetch(exhausted, at('04T08:00:00')).fetch).toBe(true)
    })
  })

  it('手動更新は60秒未満で拒否し、境界から許可する', () => {
    const now = at('03T09:00:00')
    expect(canManualRefresh(null, now)).toBe(true)
    expect(canManualRefresh(now, now + 59_999)).toBe(false)
    expect(canManualRefresh(now, now + 60_000)).toBe(true)
  })
})
