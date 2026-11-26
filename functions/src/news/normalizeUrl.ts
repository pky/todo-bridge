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
    params.sort()

    const hostname = u.hostname.replace(/^www\./, '')
    // /index.html と /index.html/ は従来どおり同一視する。
    const pathname = u.pathname.replace(/\/index\.html\/?$/, '')
    const normalizedPath = `${hostname}${pathname}`.replace(/\/$/, '')
    const normalizedSearch = params.toString()

    return normalizedSearch
      ? `${normalizedPath}?${normalizedSearch}`
      : normalizedPath
  } catch {
    return url
  }
}
