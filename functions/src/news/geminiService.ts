// functions/src/news/geminiService.ts
import { GoogleGenerativeAI } from '@google/generative-ai'

let genAI: GoogleGenerativeAI | null = null

function getClient(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set')
    genAI = new GoogleGenerativeAI(apiKey)
  }
  return genAI
}

export interface SummarizeResult {
  titleJa: string
  summaryJa: string
  tags: string[]
}

const MODEL_NAME = 'gemini-2.5-flash-lite'

const TAG_ALIASES: Record<string, string> = {
  'chat gpt': 'chatgpt',
  'chat-gpt': 'chatgpt',
  'claude code': 'claude-code',
  'github copilot': 'github-copilot',
  'microsoft copilot': 'copilot',
  'open ai': 'openai',
  'gpt-4': 'gpt',
  'gpt-4o': 'gpt',
  'gpt-5': 'gpt',
}

function normalizeTag(tag: string): string {
  const normalized = tag
    .trim()
    .toLowerCase()
    .replace(/[._/]+/g, '-')
    .replace(/\s+/g, ' ')

  return TAG_ALIASES[normalized] ?? normalized.replace(/\s+/g, '-')
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []

  const seen = new Set<string>()
  const normalizedTags: string[] = []

  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const normalized = normalizeTag(tag)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    normalizedTags.push(normalized)
  }

  return normalizedTags
}

export async function summarizeArticle(
  title: string,
  content: string
): Promise<SummarizeResult> {
  const model = getClient().getGenerativeModel({ model: MODEL_NAME })

  const prompt = `以下の記事を日本語で要約し、記事を代表する技術・AI関連のタグ（キーワード）を抽出してください。日本語以外の言語の場合は日本語に翻訳して要約すること。

タイトル、要約、そして抽出したタグ（3〜5個の配列）を以下のJSON形式で返してください:
{
  "titleJa": "日本語タイトル（日本語以外の言語の場合は翻訳）",
  "summaryJa": "3行以内の簡潔な日本語要約",
  "tags": ["LLM", "RAG", "生成AI", "Python"]
}

タイトル: ${title}
内容: ${content.slice(0, 2000)}`

  const result = await model.generateContent(prompt)
  const text = result.response.text()

  // JSONを抽出（マークダウンコードブロックに包まれている場合を考慮）
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    // フォールバック: タイトルをそのまま使い、内容の先頭を要約とする
    return { titleJa: title, summaryJa: content.slice(0, 100), tags: [] }
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { titleJa: string; summaryJa: string; tags?: string[] }
    return {
      titleJa: parsed.titleJa || title,
      summaryJa: parsed.summaryJa || '',
      tags: normalizeTags(parsed.tags),
    }
  } catch {
    return { titleJa: title, summaryJa: content.slice(0, 100), tags: [] }
  }
}
