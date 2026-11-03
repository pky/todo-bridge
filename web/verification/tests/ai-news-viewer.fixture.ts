import { test as base } from '@e2e-dev/web'
import { expect } from 'e2e'
import { dismissTitle, readLaterTitle } from './ai-news.fixture'
export { dismissTitle, readLaterTitle } from './ai-news.fixture'

const auth = 'http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1'
const storage = 'http://127.0.0.1:19199'
const actionOrigin = 'http://127.0.0.1:15001'
const actionPath = '/demo-rertm/asia-northeast1/newsAction'

async function emulatorJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init)
  // 認証応答本文にはトークンがあるため、失敗時も本文をログへ出さない。
  if (!response.ok) throw new Error(`専用Emulatorの準備に失敗しました (${response.status})`)
  return response.json()
}

export const test = base.extend<{ viewerDemo: { actions: string[]; storageGets: string[]; accessValidations: string[] } }>({
  viewerDemo: async ({ app, browser }, use) => {
    const account = await emulatorJson(`${auth}/accounts:signUp?key=test-api-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
    })
    const { localId: uid, refreshToken } = account
    if (typeof uid !== 'string' || typeof refreshToken !== 'string') throw new Error('検証ユーザーを準備できません')
    await emulatorJson(`${auth}/projects/demo-rertm/accounts:update`, {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify({ newsRole: 'viewer' }) }),
    })
    const refreshed = await emulatorJson('http://127.0.0.1:19099/securetoken.googleapis.com/v1/token?key=test-api-key', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    })
    const idToken = refreshed.id_token
    if (typeof idToken !== 'string') throw new Error('検証用claimを取得できません')
    // トークン自体は表示せず、Emulatorが発行したclaimの種類だけ確認する。
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString())
    expect(claims.newsRole).toBe('viewer')
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
    const allowed = new Set([appOrigin, 'http://127.0.0.1:19099', storage, actionOrigin, 'http://127.0.0.1:18080'])
    const blocked: string[] = []
    const accessValidations: string[] = []
    const actions: string[] = []
    const storageGets: string[] = []
    await browser.route('**/*', async route => {
      const url = new URL(route.request.url)
      if (!allowed.has(url.origin)) { blocked.push(url.origin); await route.abort(); return }
      if (url.origin === actionOrigin) {
        const headers = { 'Access-Control-Allow-Origin': appOrigin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST' }
        if (route.request.method === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return }
        if (url.pathname.endsWith('/validateCurrentUserAccess')) {
          accessValidations.push(route.request.method)
          // viewerを既存アプリの許可ユーザーに偽装せず、誤った経路は権限拒否で可視化する。
          await route.fulfill({ status: 403, headers, json: { error: { status: 'PERMISSION_DENIED', message: '検証用の既存アプリ利用拒否' } } })
          return
        }
        if (url.pathname !== actionPath) throw new Error('想定外のFunctions要求です')
        // 本文の成否にかかわらず、禁止されるPOSTをすべて記録する。
        if (route.request.method === 'POST') actions.push(url.pathname)
        await route.fulfill({ status: 403, headers, json: { error: 'viewerの管理操作は拒否' } })
        return
      }
      if (url.origin === storage && route.request.method === 'GET') storageGets.push(url.pathname)
      await route.continue()
    })
    await browser.addInitScript(({ uid, idToken, refreshToken }) => {
      // mock-auth-stateはclaim判定を迂回するため使用せず、Firebase SDKの通常認証を通す。
      localStorage.setItem('firebase:authUser:test-api-key:[DEFAULT]', JSON.stringify({
        uid, emailVerified: false, isAnonymous: true, providerData: [],
        stsTokenManager: { accessToken: idToken, refreshToken, expirationTime: Date.now() + 3_600_000 },
        apiKey: 'test-api-key', appName: '[DEFAULT]',
      }))
    }, { uid, idToken, refreshToken })
    try {
      await use({ actions, storageGets, accessValidations })
    } finally {
      await browser.unrouteAll()
      expect(actions).toEqual([])
      expect(blocked).toEqual([])
    }
  },
})
