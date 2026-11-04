export interface NewsActionBody {
  schemaVersion: 2
  topic: 'ai'
  feedDate: string
  revision: string
  articleId: string
  action: 'dismiss' | 'readLater'
  operationId: string
}
interface UrlConfig { isEmulator: boolean; emulatorHost: string; functionsPort: number; projectId: string }
export function newsActionUrl(config: UrlConfig): string {
  return config.isEmulator
    ? `http://${config.emulatorHost}:${config.functionsPort}/${config.projectId}/asia-northeast1/newsAction`
    : `https://asia-northeast1-${config.projectId}.cloudfunctions.net/newsAction`
}
export type NewsActionResult = { kind: 'ok'; result: { operationId: string; articleId: string; action: string; status: string } }
  | { kind: 'auth' | 'rejected'; status: number } | { kind: 'unknown' }
export async function postNewsAction(body: NewsActionBody, options: {
  getIdToken: () => Promise<string>; fetchImpl?: typeof fetch; timeoutMs?: number
}): Promise<NewsActionResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<NewsActionResult>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve({ kind: 'unknown' }) }, options.timeoutMs ?? 15_000)
  })
  const send = async (): Promise<NewsActionResult> => {
    try {
      const token = await options.getIdToken()
      if (controller.signal.aborted) return { kind: 'unknown' }
      const response = await (options.fetchImpl ?? fetch)(newsActionUrl({
        isEmulator: import.meta.env.VITE_USE_EMULATOR === 'true',
        emulatorHost: import.meta.env.VITE_EMULATOR_HOST || 'localhost',
        functionsPort: Number(import.meta.env.VITE_FUNCTIONS_EMULATOR_PORT) || 5001,
        projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      }), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
      if (response.status === 401 || response.status === 403) return { kind: 'auth', status: response.status }
      if (response.status >= 400 && response.status < 500) return { kind: 'rejected', status: response.status }
      if (response.status !== 200) return { kind: 'unknown' }
      const result: unknown = await response.json()
      if (!result || typeof result !== 'object' || !('operationId' in result) || result.operationId !== body.operationId
        || !('articleId' in result) || result.articleId !== body.articleId || !('action' in result) || result.action !== body.action
        || !('status' in result) || typeof result.status !== 'string'
        || !(body.action === 'dismiss' ? ['applied'] : ['created', 'already']).includes(result.status)) return { kind: 'unknown' }
      return { kind: 'ok', result: { operationId: body.operationId, articleId: body.articleId, action: body.action, status: result.status } }
    } catch { return { kind: 'unknown' } }
  }
  try { return await Promise.race([send(), timedOut]) }
  finally { clearTimeout(timer) }
}
