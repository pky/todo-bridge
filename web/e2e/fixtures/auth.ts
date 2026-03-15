import { test as base, Page } from '@playwright/test'

// モックユーザー情報
const mockUser = {
  uid: 'test-user-123',
  email: 'test@example.com',
  displayName: 'Test User',
  photoURL: null,
}

// 認証状態をモックするフィクスチャ
export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    // Firebaseの認証状態をローカルストレージにモック設定
    await page.addInitScript((user) => {
      // PiniaストアをモックするためのlocalStorage設定
      const authState = {
        user: user,
        loading: false,
        error: null,
      }
      localStorage.setItem('mock-auth-state', JSON.stringify(authState))

      // windowにモックフラグを設定
      ;(window as any).__MOCK_AUTH__ = true
      ;(window as any).__MOCK_USER__ = user
    }, mockUser)

    await use(page)
  },
})

export { mockUser }
