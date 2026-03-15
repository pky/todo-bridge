import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import NewsHubView from '@/views/NewsHubView.vue'

const loadMobileAlertCountMock = vi.hoisted(() => vi.fn())
const pushMock = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}))

vi.mock('@/stores/news', () => ({
  useNewsStore: () => ({
    mobileAlertSummary: {
      urgent: 0,
      review: 0,
    },
    loadMobileAlertCount: loadMobileAlertCountMock,
  }),
}))

describe('NewsHubView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadMobileAlertCountMock.mockResolvedValue(undefined)
  })

  it('Todoに戻るボタンからホームへ遷移できる', async () => {
    const wrapper = mount(NewsHubView, {
      global: {
        stubs: {
          RouterLink: {
            props: ['to'],
            template: '<a><slot /></a>',
          },
        },
      },
    })

    await wrapper.get('button').trigger('click')

    expect(pushMock).toHaveBeenCalledWith({ name: 'home' })
  })
})
