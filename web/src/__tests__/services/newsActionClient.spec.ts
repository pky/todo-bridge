import { afterEach, describe, expect, it, vi } from 'vitest'
import { newsActionUrl, postNewsAction } from '@/services/newsActionClient'
import { makeAction } from '../fixtures/aiNewsV2'

describe('ニュース管理操作HTTPクライアント', () => {
  afterEach(() => vi.useRealTimers())

  it('渡されたprojectIdから本番とEmulatorのURLを構築する', () => {
    const config = { projectId: 'demo-rertm', emulatorHost: '127.0.0.1', functionsPort: 15001 }
    expect(newsActionUrl({ ...config, isEmulator: false })).toBe('https://asia-northeast1-demo-rertm.cloudfunctions.net/newsAction')
    expect(newsActionUrl({ ...config, isEmulator: true })).toBe('http://127.0.0.1:15001/demo-rertm/asia-northeast1/newsAction')
    expect(newsActionUrl({ ...config, projectId: 'demo-other', isEmulator: false })).toBe('https://asia-northeast1-demo-other.cloudfunctions.net/newsAction')
  })

  it('POSTにBearerとJSONを付け、200の結果を返す', async () => {
    const body = makeAction()
    const result = { operationId: body.operationId, articleId: body.articleId, action: body.action, status: 'applied' }
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }))
    const getIdToken = vi.fn().mockResolvedValue('demo-id-token')
    expect(await postNewsAction(body, { getIdToken, fetchImpl, timeoutMs: 1000 })).toEqual({ kind: 'ok', result })
    expect(getIdToken).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, options] = fetchImpl.mock.calls[0]!
    expect(options?.method).toBe('POST')
    const headers = new Headers(options?.headers)
    expect(headers.get('Authorization')).toBe('Bearer demo-id-token')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(options?.body))).toEqual(body)
  })

  it.each([401, 403, 400, 404, 409, 410, 422, 500, 503])('HTTP %iの適用確度を分類する', async status => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status }))
    const actual = await postNewsAction(makeAction(), { getIdToken: async () => 'demo-id-token', fetchImpl, timeoutMs: 1000 })
    expect(actual).toEqual(status === 401 || status === 403 ? { kind: 'auth', status }
      : status < 500 ? { kind: 'rejected', status } : { kind: 'unknown' })
  })

  it('200でもJSONが壊れていれば適用結果はunknown', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{', { status: 200 }))
    expect(await postNewsAction(makeAction(), { getIdToken: async () => 'demo-id-token', fetchImpl, timeoutMs: 1000 })).toEqual({ kind: 'unknown' })
  })

  it('通信例外はunknownを返し勝手に再送しない', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await postNewsAction(makeAction(), { getIdToken: async () => 'demo-id-token', fetchImpl, timeoutMs: 1000 })).toEqual({ kind: 'unknown' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('タイムアウトでunknownを返す', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('中止', 'AbortError')))
    }))
    const pending = postNewsAction(makeAction(), { getIdToken: async () => 'demo-id-token', fetchImpl, timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toEqual({ kind: 'unknown' })
  })
})
