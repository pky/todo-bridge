export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    const params = new URLSearchParams(u.search)
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
    ]

    for (const key of trackingParams) {
      params.delete(key)
    }

    const normalizedPath = `${u.hostname}${u.pathname}`.replace(/\/$/, '')
    const normalizedSearch = params.toString()

    return normalizedSearch
      ? `${normalizedPath}?${normalizedSearch}`
      : normalizedPath
  } catch {
    return url
  }
}
