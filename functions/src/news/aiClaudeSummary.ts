import Anthropic from '@anthropic-ai/sdk'
import { runClaudeBatches } from './claudeBatchRunner'
import type { ClaudeMessagesClient, ClaudeRequestParams } from './claudeClient'

export interface SummaryInput { id: string; title: string; text: string }
export interface SummaryResult { id: string; titleJa: string; summaryJa: string }
export interface AiSummaryConfig { model: string; effort: 'low' | 'medium' | 'high'; dailyMaxRequests: number }

const BATCH_SIZE = 10

const SYSTEM_PROMPT = `あなたは開発者向け AI ニュースの翻訳と要約の担当です。渡された英語記事それぞれについて、日本語のタイトルと3行以内の日本語要約を JSON で返してください。
記事に書かれていないことを推測で補わない。製品名、モデル名、固有名詞は原文の表記を残す。
渡された記事の id をそのまま返し、すべての記事について1件ずつ返す。`

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['articles'],
  properties: {
    articles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'titleJa', 'summaryJa'],
        properties: {
          id: { type: 'string' },
          titleJa: { type: 'string' },
          summaryJa: { type: 'string' },
        },
      },
    },
  },
}

export function getAiSummaryConfig(env: Record<string, string | undefined>): AiSummaryConfig {
  const effortRaw = env.CLAUDE_AI_SUMMARY_EFFORT
  const effort = effortRaw === 'low' || effortRaw === 'medium' || effortRaw === 'high' ? effortRaw : 'low'
  const max = Number.parseInt(env.CLAUDE_AI_SUMMARY_DAILY_MAX_REQUESTS ?? '', 10)
  return {
    model: env.CLAUDE_AI_SUMMARY_MODEL || 'claude-sonnet-5-5',
    effort,
    dailyMaxRequests: Number.isFinite(max) && max >= 0 ? max : 10,
  }
}

export function buildSummaryRequest(inputs: SummaryInput[], config: AiSummaryConfig): ClaudeRequestParams {
  const content = inputs
    .map((i) => `<article id="${i.id}">\n<title>${i.title}</title>\n<text>${i.text}</text>\n</article>`)
    .join('\n')
  return {
    model: config.model,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: config.effort, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateItem(raw: unknown): SummaryResult | null {
  if (!isRecord(raw)) return null
  const { id, titleJa, summaryJa } = raw
  if (typeof id !== 'string') return null
  if (typeof titleJa !== 'string' || titleJa.trim() === '') return null
  if (typeof summaryJa !== 'string' || summaryJa.trim() === '') return null
  return { id, titleJa, summaryJa }
}

export function parseSummaryResponse(
  message: Anthropic.Beta.BetaMessage,
  expectedIds: string[]
): { results: SummaryResult[]; missingIds: string[] } {
  const allMissing = { results: [] as SummaryResult[], missingIds: [...expectedIds] }
  if (message.stop_reason !== 'end_turn') return allMissing

  let articles: unknown
  try {
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
    const parsed: unknown = JSON.parse(text)
    articles = isRecord(parsed) ? parsed.articles : undefined
  } catch {
    return allMissing
  }
  if (!Array.isArray(articles)) return allMissing

  const expected = new Set(expectedIds)
  const found = new Map<string, SummaryResult>()
  for (const raw of articles) {
    const item = validateItem(raw)
    if (!item || !expected.has(item.id) || found.has(item.id)) continue
    found.set(item.id, item)
  }
  const results: SummaryResult[] = []
  const missingIds: string[] = []
  for (const id of expectedIds) {
    const r = found.get(id)
    if (r) results.push(r)
    else missingIds.push(id)
  }
  return { results, missingIds }
}

export async function summarizeAiArticles(
  inputs: SummaryInput[],
  deps: { client: ClaudeMessagesClient | null; config: AiSummaryConfig; deadlineAt?: number; now?: () => number }
): Promise<{ results: Map<string, SummaryResult>; pendingIds: string[]; requestCount: number }> {
  const { client, config, deadlineAt, now } = deps
  return runClaudeBatches(inputs, {
    client,
    batchSize: BATCH_SIZE,
    dailyMaxRequests: config.dailyMaxRequests,
    deadlineAt,
    now,
    logPrefix: 'aiSummary',
    buildRequest: (batch) => buildSummaryRequest(batch, config),
    parseResponse: parseSummaryResponse,
  })
}
