import Anthropic from '@anthropic-ai/sdk'
import { runClaudeBatches } from './claudeBatchRunner'
import type { ClaudeMessagesClient, ClaudeRequestParams } from './claudeClient'
import { normalizeTags } from './tagNormalizer'

export interface TriageInput { id: string; sourceName: string; title: string; description: string; domain: string }
export interface TriageResult { id: string; relevant: boolean; importance: 'high' | 'normal' | 'low'; tags: string[] }
export interface AiTriageConfig { model: string; effort: 'low' | 'medium' | 'high'; dailyMaxRequests: number }

const BATCH_SIZE = 30

const SYSTEM_PROMPT = `あなたは開発者向け AI ニュースの仕分け担当です。渡された記事それぞれについて判定して JSON で返してください。

relevant: 生成 AI、LLM、機械学習、AI を使った開発ツールが記事の主題なら true。AI に触れているだけの記事は false。
importance:
- high: 主要モデルや主要ツールのリリース、重要な研究成果、開発者の実務に直結する変更
- normal: 実践的な解説、事例、検証記事
- low: 宣伝、言及程度、内容の薄い記事、まとめ記事の転載
tags: 記事を代表する技術キーワードを3〜5個。英小文字とハイフンで書く（例: llm、claude-code、rag）。日本語記事にも付ける。

タイトルと説明文とドメインだけで判断する。渡された記事の id をそのまま返し、すべての記事について1件ずつ返す。`

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
        required: ['id', 'relevant', 'importance', 'tags'],
        properties: {
          id: { type: 'string' },
          relevant: { type: 'boolean' },
          importance: { type: 'string', enum: ['high', 'normal', 'low'] },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

export function getAiTriageConfig(env: Record<string, string | undefined>): AiTriageConfig {
  const effortRaw = env.CLAUDE_AI_TRIAGE_EFFORT
  const effort = effortRaw === 'low' || effortRaw === 'medium' || effortRaw === 'high' ? effortRaw : 'low'
  const max = Number.parseInt(env.CLAUDE_AI_TRIAGE_DAILY_MAX_REQUESTS ?? '', 10)
  return {
    model: env.CLAUDE_AI_TRIAGE_MODEL || 'claude-haiku-5-5',
    effort,
    dailyMaxRequests: Number.isFinite(max) && max >= 0 ? max : 10,
  }
}

export function buildTriageRequest(inputs: TriageInput[], config: AiTriageConfig): ClaudeRequestParams {
  const content = inputs
    .map(
      (i) =>
        `<article id="${i.id}">\n<source>${i.sourceName}</source>\n<domain>${i.domain}</domain>\n<title>${i.title}</title>\n<description>${i.description}</description>\n</article>`
    )
    .join('\n')
  return {
    model: config.model,
    max_tokens: 8000,
    output_config: { effort: config.effort, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateItem(raw: unknown): TriageResult | null {
  if (!isRecord(raw)) return null
  const { id, relevant, importance, tags } = raw
  if (typeof id !== 'string') return null
  if (typeof relevant !== 'boolean') return null
  if (importance !== 'high' && importance !== 'normal' && importance !== 'low') return null
  if (!Array.isArray(tags) || !tags.every((t): t is string => typeof t === 'string')) return null
  return { id, relevant, importance, tags: normalizeTags(tags) }
}

export function parseTriageResponse(
  message: Anthropic.Beta.BetaMessage,
  expectedIds: string[]
): { results: TriageResult[]; missingIds: string[] } {
  const allMissing = { results: [] as TriageResult[], missingIds: [...expectedIds] }
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
  const found = new Map<string, TriageResult>()
  for (const raw of articles) {
    const item = validateItem(raw)
    if (!item || !expected.has(item.id) || found.has(item.id)) continue
    found.set(item.id, item)
  }
  const results: TriageResult[] = []
  const missingIds: string[] = []
  for (const id of expectedIds) {
    const r = found.get(id)
    if (r) results.push(r)
    else missingIds.push(id)
  }
  return { results, missingIds }
}

export async function triageAiArticles(
  inputs: TriageInput[],
  deps: { client: ClaudeMessagesClient | null; config: AiTriageConfig; deadlineAt?: number; now?: () => number }
): Promise<{ results: Map<string, TriageResult>; pendingIds: string[]; requestCount: number }> {
  const { client, config, deadlineAt, now } = deps
  return runClaudeBatches(inputs, {
    client,
    batchSize: BATCH_SIZE,
    dailyMaxRequests: config.dailyMaxRequests,
    deadlineAt,
    now,
    logPrefix: 'aiTriage',
    buildRequest: (batch) => buildTriageRequest(batch, config),
    parseResponse: parseTriageResponse,
  })
}
