import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileSummary from '@/components/MobileSummary.vue'

describe('MobileSummary', () => {
  it('mobileSummary を4行で表示する', () => {
    const wrapper = mount(MobileSummary, {
      props: {
        summary: {
          overview: '概要文',
          target: 'iOS 27',
          deadline: '2026-11-30',
          action: '更新する',
        },
      },
    })

    const text = wrapper.text()
    const lines = ['概要: 概要文', '対象: iOS 27', '期限: 2026-11-30', 'やること: 更新する']
    const positions = lines.map((line) => text.indexOf(line))
    positions.forEach((pos) => expect(pos).toBeGreaterThanOrEqual(0))
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})
