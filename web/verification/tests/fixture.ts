import { test as base } from '@e2e-dev/web'
import { expect } from 'e2e'

const firestore = 'http://127.0.0.1:18080/v1/projects/demo-rertm/databases/(default)/documents'
const auth = 'http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1'
export const itemKey = 'verification-security'
export const itemTitle = '検証用セキュリティ更新の確認'

type FirestoreValue = { stringValue: string } | { booleanValue: boolean }
  | { integerValue: string } | { mapValue: { fields: Record<string, FirestoreValue> } }

function value(input: unknown): FirestoreValue {
  if (typeof input === 'string') return { stringValue: input }
  if (typeof input === 'boolean') return { booleanValue: input }
  if (typeof input === 'number') return { integerValue: String(input) }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('検証データの型が不正です')
  return { mapValue: { fields: Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, value(entry)])) } }
}

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, init)
  // 応答本文に含まれるEmulator認証トークンを失敗ログへ出さない。
  if (!response.ok) throw new Error(`専用Emulatorへの要求が失敗しました (${response.status})`)
  return await response.json()
}

async function seedDocument(path: string, document: Record<string, unknown>): Promise<void> {
  await request(`${firestore}/${path}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(document).map(([key, entry]) => [key, value(entry)])) }),
  })
}

export async function readResolved(uid: string): Promise<Record<string, unknown>> {
  const result = await request(`${firestore}/users/${uid}/newsState/mobileActionItems`, {
    headers: { Authorization: 'Bearer owner' },
  })
  const fields = result.fields as Record<string, { mapValue?: { fields?: Record<string, unknown> } }> | undefined
  return fields?.resolved?.mapValue?.fields ?? {}
}

export const test = base.extend<{ demoUser: { uid: string; blockedRequests: string[] } }>({
  demoUser: async ({ browser, app }, use) => {
    const account = await request(`${auth}/accounts:signUp?key=test-api-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
    })
    const { localId: uid, idToken, refreshToken } = account
    if (typeof uid !== 'string' || typeof idToken !== 'string' || typeof refreshToken !== 'string') {
      throw new Error('Auth Emulatorの匿名ユーザーを準備できませんでした')
    }
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date())
    await seedDocument('topics/mobile/meta/actionItems', { items: { [itemKey]: {
      key: itemKey, title: itemTitle, titleJa: itemTitle,
      url: 'https://example.test/security-update', summaryJa: '検証用の架空の記事です',
      platform: 'ios', sourceName: '検証用公式情報', sourceTier: 'official', isOfficial: true,
      importantLevel: 'urgent', actionRequired: true, actionType: 'security',
      publishedAt: Date.now(), firstSeenDate: date,
    } } })
    await seedDocument(`users/${uid}/newsState/mobileActionItems`, { resolved: {} })

    if (!app.baseUrl) throw new Error('検証アプリのURLがありません')
    const allowed = new Set([new URL(app.baseUrl).origin, 'http://127.0.0.1:18080', 'http://127.0.0.1:19099'])
    const blockedRequests: string[] = []
    await browser.route('**/*', async (route) => {
      const destination = new URL(route.request.url)
      if (allowed.has(destination.origin)) await route.continue()
      else { blockedRequests.push(destination.origin); await route.abort() }
    })
    await browser.addInitScript(({ uid, idToken, refreshToken }) => {
      // responsive.spec.ts と同じUI認証に、同一UIDのEmulator SDK認証を補う。
      localStorage.setItem('mock-auth-state', JSON.stringify({
        user: { uid, displayName: '検証ユーザー', photoURL: null }, loading: false, error: null,
      }))
      localStorage.setItem('mock-lists-data', '[]')
      localStorage.setItem('mock-tasks-data', '[]')
      localStorage.setItem('firebase:authUser:test-api-key:[DEFAULT]', JSON.stringify({
        uid, emailVerified: false, isAnonymous: true, providerData: [],
        stsTokenManager: { accessToken: idToken, refreshToken, expirationTime: Date.now() + 3_600_000 },
        apiKey: 'test-api-key', appName: '[DEFAULT]',
      }))
    }, { uid, idToken, refreshToken })
    try {
      await use({ uid, blockedRequests })
      expect(blockedRequests).toEqual([])
    } finally {
      // アカウントも文書も、所有するEmulatorの停止時にメモリごと破棄する。
      await browser.unrouteAll()
    }
  },
})
