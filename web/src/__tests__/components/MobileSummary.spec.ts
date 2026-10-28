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

  it('中身のない値の行は表示しない', () => {
    const wrapper = mount(MobileSummary, {
      props: {
        summary: {
          overview: '概要文',
          target: '記載なし',
          deadline: '期限なし',
          action: '対応不要',
        },
      },
    })

    const text = wrapper.text()
    expect(text).toContain('概要: 概要文')
    expect(text).not.toContain('対象:')
    expect(text).not.toContain('期限:')
    expect(text).not.toContain('やること:')
  })

  it('空文字の行は表示しない', () => {
    const wrapper = mount(MobileSummary, {
      props: {
        summary: {
          overview: '概要文',
          target: '',
          deadline: '2026-11-30',
          action: '更新する',
        },
      },
    })

    expect(wrapper.text()).not.toContain('対象:')
  })

  it('対象とやることは2行で省略する', () => {
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

    const findLine = (label: string) =>
      wrapper.findAll('*').filter((el) => el.text().includes(label)).pop()
    expect(findLine('対象:')?.classes()).toContain('line-clamp-2')
    expect(findLine('やること:')?.classes()).toContain('line-clamp-2')
  })
})
