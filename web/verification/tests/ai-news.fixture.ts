import { test as base } from '@e2e-dev/web'
import { expect } from 'e2e'

const auth = 'http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1'
const storage = 'http://127.0.0.1:19199'
const actionOrigin = 'http://127.0.0.1:15001'
const actionPath = '/demo-rertm/asia-northeast1/newsAction'
export const dismissTitle = '架空の推論モデル公開'
export const readLaterTitle = '架空の評価ツール更新'

interface ActionBody {
  schemaVersion: 2
  topic: 'ai'
  feedDate: string
  revision: string
  articleId: string
  action: 'dismiss' | 'readLater'
  operationId: string
}

async function emulatorJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init)
  // 認証応答本文にはトークンがあるため、失敗時も本文をログへ出さない。
  if (!response.ok) throw new Error(`専用Emulatorの準備に失敗しました (${response.status})`)
  return response.json()
}

function parseAction(value: unknown): ActionBody {
  if (typeof value !== 'object' || value === null) throw new Error('管理操作の本文がありません')
  const body = value as Record<string, unknown>
  if (body.schemaVersion !== 2 || body.topic !== 'ai' || typeof body.feedDate !== 'string'
    || typeof body.revision !== 'string' || typeof body.articleId !== 'string'
    || (body.action !== 'dismiss' && body.action !== 'readLater')
    || typeof body.operationId !== 'string') throw new Error('管理操作の本文が不正です')
  return { schemaVersion: 2, topic: 'ai', feedDate: body.feedDate, revision: body.revision,
    articleId: body.articleId, action: body.action, operationId: body.operationId }
}

export const test = base.extend<{ aiDemo: { actions: ActionBody[]; storageGets: string[] } }>({
  aiDemo: async ({ app, browser }, use) => {
    const account = await emulatorJson(`${auth}/accounts:signUp?key=test-api-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
    })
    const { localId: uid, refreshToken } = account
    if (typeof uid !== 'string' || typeof refreshToken !== 'string') throw new Error('検証ユーザーを準備できません')
    await emulatorJson(`${auth}/projects/demo-rertm/accounts:update`, {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify({ newsRole: 'curator' }) }),
    })
    const refreshed = await emulatorJson('http://127.0.0.1:19099/securetoken.googleapis.com/v1/token?key=test-api-key', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    })
    const idToken = refreshed.id_token
    if (typeof idToken !== 'string') throw new Error('検証用claimを取得できません')
    const feedDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date())
    const feed = {
      schemaVersion: 2, topic: 'ai', feedDate, generatedAt: new Date().toISOString(), revision: 'a'.repeat(64), totalCount: 2,
      articles: [
        { id: 'demo-dismiss', title: dismissTitle, sourceName: '架空技術通信', summary: '興味なし操作の検証用記事です', publishedAt: null, url: 'https://example.test/dismiss' },
        { id: 'demo-read-later', title: readLaterTitle, sourceName: '架空技術通信', summary: 'あとで読む操作の検証用記事です', publishedAt: null, url: 'https://example.test/read-later' },
      ],
    }
    // 画面キャッシュには注入せず、認証付きStorage SDKが読む原本をEmulatorへ置く。
    // Storage Emulator は application/json の本文を先に読み込みアップロードが終わらないため、octet-stream で送る。
    await emulatorJson(`${storage}/v0/b/demo-rertm.appspot.com/o?name=news%2Fv2%2Fai%2Flatest.json&uploadType=media`, {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/octet-stream' }, body: JSON.stringify(feed),
    })
    if (!app.baseUrl) throw new Error('検証アプリのURLがありません')
    const appOrigin = new URL(app.baseUrl).origin
    const allowed = new Set([appOrigin, 'http://127.0.0.1:19099', storage, actionOrigin])
    const blocked: string[] = []
    const actions: ActionBody[] = []
    const storageGets: string[] = []
    await browser.route('**/*', async route => {
      const url = new URL(route.request.url)
      if (!allowed.has(url.origin)) { blocked.push(url.origin); await route.abort(); return }
      if (url.origin === actionOrigin) {
        if (url.pathname !== actionPath) throw new Error('管理操作先のパスが不正です')
        const headers = { 'Access-Control-Allow-Origin': appOrigin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST' }
        if (route.request.method === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return }
        if (route.request.method !== 'POST' || !/^Bearer \S+$/.test(route.request.headers.authorization ?? '')) throw new Error('管理操作の認証ヘッダがありません')
        const body = parseAction(JSON.parse(route.request.postData ?? 'null'))
        expect(body).toMatchObject({ schemaVersion: 2, topic: 'ai', feedDate, revision: feed.revision })
        expect(body.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
        actions.push(body)
        // 現行runnerはFunctionsを起動しない。ここはHTTP/UI境界の成功応答を検証する。
        await route.fulfill({ status: 200, headers, json: { operationId: body.operationId, articleId: body.articleId, action: body.action,
          status: body.action === 'dismiss' ? 'applied' : 'created' } })
        return
      }
      if (url.origin === storage && route.request.method === 'GET') storageGets.push(url.pathname)
      await route.continue()
    })
    await browser.addInitScript(({ uid, idToken, refreshToken }) => {
      localStorage.setItem('mock-auth-state', JSON.stringify({ user: { uid, displayName: '検証ユーザー', photoURL: null }, newsRole: 'curator', loading: false, error: null }))
      localStorage.setItem('mock-lists-data', '[]')
      localStorage.setItem('mock-tasks-data', '[]')
      localStorage.setItem('firebase:authUser:test-api-key:[DEFAULT]', JSON.stringify({
        uid, emailVerified: false, isAnonymous: true, providerData: [],
        stsTokenManager: { accessToken: idToken, refreshToken, expirationTime: Date.now() + 3_600_000 },
        apiKey: 'test-api-key', appName: '[DEFAULT]',
      }))
    }, { uid, idToken, refreshToken })
    try {
      await use({ actions, storageGets })
      expect(blocked).toEqual([])
    } finally {
      await browser.unrouteAll()
    }
  },
})
