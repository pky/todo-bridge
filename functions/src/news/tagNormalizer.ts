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

export function normalizeTags(tags: unknown): string[] {
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
