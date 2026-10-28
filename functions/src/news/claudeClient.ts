import Anthropic from '@anthropic-ai/sdk'
import type { RequestOptions } from '@anthropic-ai/sdk/internal/request-options'

export type ClaudeRequestParams = Anthropic.Beta.MessageCreateParamsNonStreaming
export interface ClaudeMessagesClient {
  create(params: ClaudeRequestParams, options?: RequestOptions): Promise<Anthropic.Beta.BetaMessage>
}

export const CLAUDE_REQUEST_TIMEOUT_MS = 120000
export const CLAUDE_MAX_RETRIES = 1

export function createClaudeMessagesClient(apiKey: string | undefined): ClaudeMessagesClient | null {
  if (!apiKey) return null
  const sdk = new Anthropic({ apiKey, timeout: CLAUDE_REQUEST_TIMEOUT_MS, maxRetries: CLAUDE_MAX_RETRIES })
  return { create: (params, options) => sdk.beta.messages.create(params, options) }
}
