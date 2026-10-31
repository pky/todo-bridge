import { describe, expect, it } from 'vitest'
import type { MobileActionItem, MobileActionItemState } from '@/types'
import {
  isActionItemOverdue,
  selectResolvedActionItems,
  selectUnresolvedActionItems,
} from '@/utils/mobileActionItems'

const DAY_MS = 24 * 60 * 60 * 1000
const BASE = Date.UTC(2026, 9, 1)

function item(key: string, overrides: Partial<MobileActionItem> = {}): MobileActionItem {
  return {
    key,
    url: `https://example.com/${key}`,
    titleJa: `項目 ${key}`,
    title: `Item ${key}`,
    platform: 'ios',
    sourceName: 'Example',
    isOfficial: false,
    importantLevel: 'reference',
    actionRequired: false,
    publishedAt: BASE,
    firstSeenDate: '2026-10-01',
    ...overrides,
  } as MobileActionItem
}

const toRecord = (items: MobileActionItem[]) => Object.fromEntries(items.map((entry) => [entry.key, entry]))
const keys = (items: MobileActionItem[]) => items.map((entry) => entry.key)

describe('selectUnresolvedActionItems', () => {
  it('未処理の項目を件数上限なしで全件返す', () => {
    const items = toRecord(Array.from({ length: 8 }, (_, i) => item(`k${i}`, { importantLevel: 'urgent' })))
    expect(selectUnresolvedActionItems(items, {})).toHaveLength(8)
  })

  it('done と dismissed の項目は除外する', () => {
    const items = toRecord([item('a'), item('b'), item('c')])
    const resolved: Record<string, MobileActionItemState> = {
      a: { state: 'done', at: BASE },
      b: { state: 'dismissed', at: BASE },
    }
    expect(keys(selectUnresolvedActionItems(items, resolved))).toEqual(['c'])
  })

  it('getImportanceRank 相当の点数の降順に並べる', () => {
    // urgent+security = 12+4 = 16、review+official = 6+4 = 10、actionRequired+sdk = 8+5 = 13
    const items = toRecord([
      item('review-official', { importantLevel: 'review', isOfficial: true }),
      item('urgent-security', { importantLevel: 'urgent', actionType: 'security' }),
      item('action-sdk', { actionRequired: true, actionType: 'sdk_requirement' }),
    ])
    expect(keys(selectUnresolvedActionItems(items, {}))).toEqual(['urgent-security', 'action-sdk', 'review-official'])
  })

  it('requiredByDate がある項目は4点加算される', () => {
    // urgent+beta = 14、urgent+requiredByDate = 16。加算が無ければ beta が先になる
    const items = toRecord([
      item('urgent-beta', { importantLevel: 'urgent', actionType: 'beta' }),
      item('urgent-deadline', { importantLevel: 'urgent', requiredByDate: '2026-12-31' }),
    ])
    expect(keys(selectUnresolvedActionItems(items, {}))).toEqual(['urgent-deadline', 'urgent-beta'])
  })

  it('同点なら requiredByDate が近い順、無いものは後ろ', () => {
    // 3件とも16点にそろえる。far / near: urgent 12 + requiredByDate 4。none: urgent 12 + security 4
    const items = toRecord([
      item('none', { importantLevel: 'urgent', actionType: 'security' }),
      item('far', { importantLevel: 'urgent', requiredByDate: '2027-01-31' }),
      item('near', { importantLevel: 'urgent', requiredByDate: '2026-11-15' }),
    ])
    expect(keys(selectUnresolvedActionItems(items, {}))).toEqual(['near', 'far', 'none'])
  })

  it('点数と requiredByDate が同じなら publishedAt の新しい順', () => {
    const items = toRecord([
      item('older', { importantLevel: 'urgent', publishedAt: BASE - 2 * DAY_MS }),
      item('newer', { importantLevel: 'urgent', publishedAt: BASE }),
      item('middle', { importantLevel: 'urgent', publishedAt: BASE - DAY_MS }),
    ])
    expect(keys(selectUnresolvedActionItems(items, {}))).toEqual(['newer', 'middle', 'older'])
  })

  it('項目が空なら空配列', () => {
    expect(selectUnresolvedActionItems({}, {})).toEqual([])
  })
})

describe('selectResolvedActionItems', () => {
  it('処理済みの項目だけを at の新しい順で返す', () => {
    const items = toRecord([item('a'), item('b'), item('c'), item('d')])
    const resolved: Record<string, MobileActionItemState> = {
      a: { state: 'done', at: BASE + 1 },
      b: { state: 'dismissed', at: BASE + 3 },
      c: { state: 'done', at: BASE + 2 },
    }
    expect(keys(selectResolvedActionItems(items, resolved))).toEqual(['b', 'c', 'a'])
  })

  it('集約に無いキーの状態は返さない', () => {
    const items = toRecord([item('a')])
    const resolved: Record<string, MobileActionItemState> = {
      a: { state: 'done', at: BASE },
      gone: { state: 'done', at: BASE + 5 },
    }
    expect(keys(selectResolvedActionItems(items, resolved))).toEqual(['a'])
  })
})

describe('isActionItemOverdue', () => {
  it('requiredByDate が today より前なら true', () => {
    expect(isActionItemOverdue(item('a', { requiredByDate: '2026-10-30' }), '2026-10-31')).toBe(true)
  })

  it('requiredByDate が today と同じなら false（境界）', () => {
    expect(isActionItemOverdue(item('a', { requiredByDate: '2026-10-31' }), '2026-10-31')).toBe(false)
  })

  it('requiredByDate が today より後なら false', () => {
    expect(isActionItemOverdue(item('a', { requiredByDate: '2026-11-01' }), '2026-10-31')).toBe(false)
  })

  it('requiredByDate が無ければ false', () => {
    expect(isActionItemOverdue(item('a'), '2026-10-31')).toBe(false)
  })
})

describe('集約に無いキーの状態を表示から除外する', () => {
  it('古い状態を保持したまま、集約にある未処理と処理済みだけを返す', () => {
    const items = toRecord([item('a'), item('b'), item('c')])
    const resolved: Record<string, MobileActionItemState> = {
      a: { state: 'done', at: BASE },
      b: { state: 'dismissed', at: BASE + 1 },
      gone: { state: 'done', at: BASE + 2 },
    }
    expect(keys(selectUnresolvedActionItems(items, resolved))).toEqual(['c'])
    expect(keys(selectResolvedActionItems(items, resolved))).toEqual(['b', 'a'])
    expect(resolved).toEqual({
      a: { state: 'done', at: BASE },
      b: { state: 'dismissed', at: BASE + 1 },
      gone: { state: 'done', at: BASE + 2 },
    })
  })

  it('集約が空なら古い状態があっても両一覧と件数は空になる', () => {
    const resolved: Record<string, MobileActionItemState> = { a: { state: 'done', at: BASE } }
    expect(selectUnresolvedActionItems({}, resolved)).toEqual([])
    expect(selectResolvedActionItems({}, resolved)).toEqual([])
    expect(selectUnresolvedActionItems({}, resolved)).toHaveLength(0)
    expect(selectResolvedActionItems({}, resolved)).toHaveLength(0)
    expect(resolved).toEqual({ a: { state: 'done', at: BASE } })
  })
})
