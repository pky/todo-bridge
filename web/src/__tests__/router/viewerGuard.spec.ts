import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import router from '@/router'

const state = reactive({ accessMode: 'newsViewer', isAuthenticated: true, loading: false, initAuth: vi.fn() })
vi.mock('@/stores/auth', () => ({ useAuthStore: () => state }))

// 実際に登録されたルートとガードを使い、遷移先の画面だけを描画対象外にする。
for (const route of router.getRoutes()) {
  if (route.components) route.components.default = { template: '<div />' }
}
describe('viewerの実ルーター遷移', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    state.accessMode = 'newsViewer'
    state.isAuthenticated = true
    state.loading = false
    await router.replace('/news/ai')
  })
  it.each(['/', '/import', '/settings', '/documents', '/news', '/news/mobile'])('%sへのviewer遷移はnews-aiに戻る', async (path) => {
    await router.push(path)
    expect(router.currentRoute.value.name).toBe('news-ai')
  })
  it('viewerはnews-aiに留まれる', async () => {
    await router.push('/news/ai')
    expect(router.currentRoute.value.name).toBe('news-ai')
  })
  it('認証済みviewerのloginはnews-aiへ進む', async () => {
    await router.push('/login')
    expect(router.currentRoute.value.name).toBe('news-ai')
  })
  it.each(['/', '/import', '/settings', '/documents', '/news', '/news/mobile', '/news/ai'])('fullは%sへ遷移できる', async (path) => {
    state.accessMode = 'full'
    await router.push(path)
    expect(router.currentRoute.value.path).toBe(path)
  })
  it('認証済みfullのloginは従来どおりhomeへ進む', async () => {
    state.accessMode = 'full'
    await router.push('/login')
    expect(router.currentRoute.value.name).toBe('home')
  })
  it('未認証ならnews-aiもloginへ進む', async () => {
    state.isAuthenticated = false
    await router.push('/login')
    await router.push('/news/ai')
    expect(router.currentRoute.value.name).toBe('login')
  })
})
