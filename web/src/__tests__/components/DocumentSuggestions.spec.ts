import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import DocumentSuggestions from '@/components/documents/DocumentSuggestions.vue'
import type { DocumentSuggestion } from '@/types'

function createSuggestion(overrides: Partial<DocumentSuggestion> = {}): DocumentSuggestion {
  const timestamp = { toMillis: () => 1 } as DocumentSuggestion['updatedAt']
  return {
    id: 'suggestion-1',
    type: 'calendar_event',
    status: 'pending',
    title: '予定：5月15日',
    value: {
      date: null,
      dateText: '5月15日',
      yearAmbiguous: true,
      time: '13:45',
    },
    pageNumber: 1,
    sourceExcerpt: '日にち：5月15日 時間：13時45分',
    confidence: 0.72,
    generatedByVersion: 1,
    acceptedBy: null,
    acceptedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  }
}

describe('DocumentSuggestions', () => {
  it('保存済みOCRからの候補再抽出を通知する', async () => {
    const wrapper = mount(DocumentSuggestions, {
      props: {
        suggestions: [createSuggestion()],
        loading: false,
        error: null,
        savingIds: [],
        reanalyzing: false,
      },
    })

    const reanalyzeButton = wrapper.findAll('button').find(
      (button) => button.text() === '候補を再抽出'
    )
    await reanalyzeButton?.trigger('click')
    expect(wrapper.emitted('reanalyze')).toHaveLength(1)
  })

  it('年なし日付の推定値を入力欄へ表示して確認を促す', () => {
    const wrapper = mount(DocumentSuggestions, {
      props: {
        suggestions: [createSuggestion({
          value: {
            date: '2026-05-15',
            dateText: '5月15日',
            yearAmbiguous: true,
            inferredYear: 2026,
            time: '13:45',
          },
        })],
        loading: false,
        error: null,
        savingIds: [],
        reanalyzing: false,
      },
    })

    expect(wrapper.get('input[type="date"]').element.value).toBe('2026-05-15')
    expect(wrapper.text()).toContain('年の記載がないため2026年と推定しました')
  })

  it('根拠を表示し、修正した予定候補を採用できる', async () => {
    const wrapper = mount(DocumentSuggestions, {
      props: {
        suggestions: [createSuggestion()],
        loading: false,
        error: null,
        savingIds: [],
        reanalyzing: false,
      },
    })

    expect(wrapper.text()).toContain('信頼度 72%')
    expect(wrapper.text()).toContain('日にち：5月15日 時間：13時45分')
    expect(wrapper.text()).toContain('年が書類から確定できません')

    await wrapper.get('input[type="date"]').setValue('2026-05-15')
    const acceptButton = wrapper.findAll('button').find(
      (button) => button.text() === 'Google Calendarに登録'
    )
    await acceptButton?.trigger('click')

    expect(wrapper.emitted('registerCalendar')?.[0]).toEqual([
      'suggestion-1',
      {
        title: '予定：5月15日',
        value: {
          date: '2026-05-15',
          dateText: '5月15日',
          yearAmbiguous: false,
          time: '13:45',
        },
      },
    ])
  })

  it('既存候補の根拠に時刻範囲があれば終了時刻を補完する', async () => {
    const wrapper = mount(DocumentSuggestions, {
      props: {
        suggestions: [createSuggestion({
          sourceExcerpt: '日にち：5月15日 時間:13時45分~14時45分',
        })],
        loading: false,
        error: null,
        savingIds: [],
        reanalyzing: false,
      },
    })

    const timeInputs = wrapper.findAll('input[type="time"]')
    expect(timeInputs[0].element.value).toBe('13:45')
    expect(timeInputs[1].element.value).toBe('14:45')

    const acceptButton = wrapper.findAll('button').find(
      (button) => button.text() === 'Google Calendarに登録'
    )
    await acceptButton?.trigger('click')
    expect(wrapper.emitted('registerCalendar')?.[0]?.[1]).toMatchObject({
      value: { endTime: '14:45' },
    })
  })

  it('登録済みの予定候補にも再登録ボタンを表示し、根拠ページを通知する', async () => {
    const wrapper = mount(DocumentSuggestions, {
      props: {
        suggestions: [createSuggestion({
          status: 'accepted',
          value: {
            date: '2026-05-15',
            dateText: '5月15日',
            time: '13:45',
            calendarEventId: 'legacy-event-id',
          },
        })],
        loading: false,
        error: null,
        savingIds: [],
        reanalyzing: false,
      },
    })

    expect(wrapper.text()).toContain('採用済み')
    const registerButton = wrapper.findAll('button').find(
      (button) => button.text() === 'Google Calendarに再登録'
    )
    await registerButton?.trigger('click')
    expect(wrapper.emitted('registerCalendar')?.[0]?.[0]).toBe('suggestion-1')
    const openPageButton = wrapper.findAll('button').find(
      (button) => button.text() === '1ページを開く'
    )
    await openPageButton?.trigger('click')

    expect(wrapper.emitted('openPage')?.[0]).toEqual([1])
  })

  it('操作先のない旧情報候補は表示しない', () => {
    const wrapper = mount(DocumentSuggestions, {
      props: {
        suggestions: [createSuggestion({
          type: 'field',
          title: '場所：中央公民館',
          value: { fieldType: 'location', text: '中央公民館' },
        })],
        loading: false,
        error: null,
        savingIds: [],
        reanalyzing: false,
      },
    })

    expect(wrapper.text()).toContain('Todoや予定にできる候補は見つかりませんでした')
    expect(wrapper.text()).not.toContain('場所：中央公民館')
  })
})
