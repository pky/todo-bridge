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
  it('根拠を表示し、修正した予定候補を採用できる', async () => {
    const wrapper = mount(DocumentSuggestions, {
      props: {
        suggestions: [createSuggestion()],
        loading: false,
        error: null,
        savingIds: [],
      },
    })

    expect(wrapper.text()).toContain('信頼度 72%')
    expect(wrapper.text()).toContain('日にち：5月15日 時間：13時45分')
    expect(wrapper.text()).toContain('年が書類から確定できません')

    await wrapper.get('input[type="date"]').setValue('2026-05-15')
    const acceptButton = wrapper.findAll('button').find(
      (button) => button.text() === '予定候補として採用'
    )
    await acceptButton?.trigger('click')

    expect(wrapper.emitted('save')?.[0]).toEqual([
      'suggestion-1',
      {
        title: '予定：5月15日',
        value: {
          date: '2026-05-15',
          dateText: '5月15日',
          yearAmbiguous: false,
          time: '13:45',
        },
        status: 'accepted',
      },
    ])
  })

  it('採用済み候補に採用ボタンを重ねて表示せず、根拠ページを通知する', async () => {
    const wrapper = mount(DocumentSuggestions, {
      props: {
        suggestions: [createSuggestion({ status: 'accepted' })],
        loading: false,
        error: null,
        savingIds: [],
      },
    })

    expect(wrapper.text()).toContain('採用済み')
    expect(wrapper.text()).not.toContain('予定候補として採用')
    await wrapper.get('button').trigger('click')

    expect(wrapper.emitted('openPage')?.[0]).toEqual([1])
  })
})
