export function isSafeExternalUrl(url: string, options: { allowFtp?: boolean } = {}): boolean {
  if (!url || /[\s\u0000-\u001f\u007f]/u.test(url)) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      || (options.allowFtp === true && parsed.protocol === 'ftp:')
  } catch {
    return false
  }
}
