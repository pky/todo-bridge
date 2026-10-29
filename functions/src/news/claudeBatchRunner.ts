import Anthropic from '@anthropic-ai/sdk'
import type { ClaudeMessagesClient, ClaudeRequestParams } from './claudeClient'

export interface BatchRunnerDeps<TInput extends { id: string }, TResult extends { id: string }> {
  client: ClaudeMessagesClient | null
  batchSize: number
  dailyMaxRequests: number
  reserveRequest?: () => Promise<boolean>
  deadlineAt?: number
  now?: () => number
  logPrefix: string
  buildRequest: (batch: TInput[]) => ClaudeRequestParams
  parseResponse: (message: Anthropic.Beta.BetaMessage, expectedIds: string[]) => { results: TResult[]; missingIds: string[] }
}

export async function runClaudeBatches<TInput extends { id: string }, TResult extends { id: string }>(
  inputs: TInput[],
  deps: BatchRunnerDeps<TInput, TResult>
): Promise<{ results: Map<string, TResult>; pendingIds: string[]; requestCount: number }> {
  const { client, deadlineAt, batchSize, dailyMaxRequests, logPrefix } = deps
  const now = deps.now ?? Date.now
  const expired = (): boolean => deadlineAt !== undefined && now() >= deadlineAt
  const results = new Map<string, TResult>()
  const pending: string[] = []
  let requestCount = 0

  if (!client) return { results, pendingIds: inputs.map((i) => i.id), requestCount }

  // Returns ids that were not processed. Never throws.
  const send = async (batch: TInput[]): Promise<string[]> => {
    const ids = batch.map((i) => i.id)
    if (expired()) {
      pending.push(...ids)
      return []
    }
    if (deps.reserveRequest) {
      let reserved = false
      let reservationTimer: ReturnType<typeof setTimeout> | undefined
      try {
        const reservation = deps.reserveRequest()
        reserved = deadlineAt === undefined
          ? await reservation
          : await Promise.race([
            reservation,
            new Promise<boolean>(resolve => {
              reservationTimer = setTimeout(() => resolve(false), Math.max(deadlineAt - now(), 1))
            }),
          ])
      } catch (err) {
        console.warn(`[${logPrefix}] reservation failed name=${err instanceof Error ? err.name : 'unknown'}`)
      } finally {
        if (reservationTimer !== undefined) clearTimeout(reservationTimer)
      }
      if (!reserved || expired()) {
        pending.push(...ids)
        return []
      }
    }
    const remaining = deadlineAt === undefined ? undefined : deadlineAt - now()
    // AbortSignal.timeout のタイマーはイベントループを維持しないため、締め切りまで確実に発火するタイマーを自前で持つ
    const controller = remaining === undefined ? undefined : new AbortController()
    const abortTimer = controller === undefined || remaining === undefined
      ? undefined
      : setTimeout(() => controller.abort(new DOMException('deadline exceeded', 'TimeoutError')), Math.max(remaining, 1))
    const signal = controller?.signal
    requestCount++
    try {
      const message = await client.create(deps.buildRequest(batch), signal ? { signal } : undefined)
      const usage = message.usage
      console.log(
        `[${logPrefix}] usage input_tokens=${usage.input_tokens} output_tokens=${usage.output_tokens} cache_read_input_tokens=${usage.cache_read_input_tokens ?? 0} articles=${batch.length}`
      )
      const parsed = deps.parseResponse(message, ids)
      for (const r of parsed.results) results.set(r.id, r)
      return parsed.missingIds
    } catch (err) {
      if (signal?.aborted || expired()) {
        console.warn(`[${logPrefix}] request aborted by deadline articles=${batch.length}`)
        pending.push(...ids)
        return []
      }
      const status = err instanceof Anthropic.APIError ? err.status : undefined
      console.warn(
        `[${logPrefix}] request failed name=${err instanceof Error ? err.name : 'unknown'} status=${status ?? 'n/a'} articles=${batch.length}`
      )
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        pending.push(...ids)
        return []
      }
      return ids
    } finally {
      if (abortTimer !== undefined) clearTimeout(abortTimer)
    }
  }

  const missing: string[] = []
  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize)
    if (requestCount >= dailyMaxRequests || expired()) {
      pending.push(...batch.map((b) => b.id))
      continue
    }
    missing.push(...(await send(batch)))
  }

  const byId = new Map(inputs.map((i) => [i.id, i]))
  for (const id of missing) {
    const item = byId.get(id)
    if (!item || requestCount >= dailyMaxRequests || expired()) {
      pending.push(id)
      continue
    }
    pending.push(...(await send([item])))
  }

  return { results, pendingIds: pending, requestCount }
}
